#!/usr/bin/env bash
# 安装测试：在 Kind 上用 values-standard.yaml 实际安装 chart，要求全部角色、PostgreSQL 与 MinIO 的 Pod 都 Ready，
# 并且 gateway 的准入自检通过、熔断开关处于冻结状态。
# 只渲染或 dry-run 发现不了"角色读到的配置缺项""端口与探针对不上""挂载的文件不存在"这类问题，这里让每个进程真正启动。
#
# 用法：deploy/helm/install-e2e.sh
# 环境变量：
#   SKIP_BUILD=1    不构建镜像，使用已经存在的 srenautix.local/srenautix:e2e 与 srenautix.local/srenautix-spoke:e2e
#   KEEP_CLUSTER=1  结束后保留 Kind 集群（默认删除）
# 依赖：docker、kind、helm、kubectl、openssl、jq、yq
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
chart_dir="$repo_root/deploy/helm/srenautix"
# shellcheck source=deploy/kind/versions.env
source "$repo_root/deploy/kind/versions.env"
cluster=srenautix-install
ctx="kind-${cluster}"
ns=srenautix
work="$repo_root/.scratch/install-e2e"
hub_image=srenautix.local/srenautix:e2e
spoke_image=srenautix.local/srenautix-spoke:e2e
busybox=$(yq -e '.images[] | select(.name == "busybox") | .newName + "@" + .digest' "$repo_root/deploy/kind/images/kustomization.yaml")
rm -rf "$work"
mkdir -p "$work"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
k() { kubectl --context "$ctx" "$@"; }

diagnose() {
  log "安装测试失败，收集诊断信息到 $work"
  k get pods -A -o wide >"$work/pods.txt" 2>&1 || true
  k -n "$ns" describe pods >"$work/describe.txt" 2>&1 || true
  k -n "$ns" get events --sort-by=.lastTimestamp >"$work/events.txt" 2>&1 || true
  k -n "$ns" get clusters.postgresql.cnpg.io -o yaml >"$work/pg-cluster.yaml" 2>&1 || true
  k -n "$ns" get jobs,pvc,secrets -o wide >"$work/jobs-pvc-secrets.txt" 2>&1 || true
  k -n cnpg-system logs deployment/cnpg-cloudnative-pg --tail=300 >"$work/cnpg-operator.log" 2>&1 || true
  yq '.status' "$work/pg-cluster.yaml" >&2 || true
  for p in $(k -n "$ns" get pods -o name 2>/dev/null); do
    k -n "$ns" logs "$p" --all-containers --tail=300 >"$work/$(basename "$p").log" 2>&1 || true
    k -n "$ns" logs "$p" --all-containers --previous --tail=300 >"$work/$(basename "$p").previous.log" 2>&1 || true
  done
  tail -n 40 "$work"/*.log >&2 || true
}
cleanup() {
  local rc=$?
  ((rc == 0)) || diagnose
  if [[ "${KEEP_CLUSTER:-}" != 1 ]]; then
    kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

if [[ "${SKIP_BUILD:-}" != 1 ]]; then
  log "构建两个镜像"
  epoch=$(git -C "$repo_root" log -1 --format=%ct)
  docker build -f "$repo_root/deploy/docker/srenautix.Dockerfile" --build-arg "SOURCE_DATE_EPOCH=$epoch" -t "$hub_image" "$repo_root"
  docker build -f "$repo_root/deploy/docker/srenautix-spoke.Dockerfile" -t "$spoke_image" "$repo_root"
fi

log "创建 Kind 集群 ${cluster}（${KIND_NODE_IMAGE}）"
kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
kind create cluster --name "$cluster" --image "$KIND_NODE_IMAGE" --wait 120s
kind load docker-image --name "$cluster" "$hub_image" "$spoke_image"

log "安装 CNPG operator 与最小 Prometheus"
helm repo add cnpg https://cloudnative-pg.github.io/charts --force-update >/dev/null
helm --kube-context "$ctx" install cnpg cnpg/cloudnative-pg --version "$CNPG_CHART_VERSION" \
  --namespace cnpg-system --create-namespace --wait --timeout 10m
k apply -f "$chart_dir/ci/install/prometheus.yaml"
k -n monitoring rollout status deployment/prometheus --timeout=300s

log "准备安装方提供的凭证：服务签名密钥、模型密钥、本地管理员"
k create namespace "$ns"
openssl genpkey -algorithm ed25519 -out "$work/private.pem"
k -n "$ns" create secret generic srenautix-service-signing --from-file=private.pem="$work/private.pem"
# 审批人公钥文件中的服务公钥：Ed25519 公钥 32 字节的 base64url（不带填充）
pub=$(openssl pkey -in "$work/private.pem" -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n')
rm -f "$work/private.pem"
printf 'version: 1\nkeys:\n  - {use: service, key_id: default, public_key: %s}\n' "$pub" >"$work/approver-keys.yaml"
k -n "$ns" create secret generic srenautix-llm --from-literal=api_key=install-e2e-not-a-real-key
admin_password=$(openssl rand -hex 16)
hash=$(printf '%s' "$admin_password" | docker run --rm -i "$hub_image" admin hash-password)
totp=$(openssl rand 20 | base32 | tr -d '=\n')
k -n "$ns" create secret generic srenautix-local-admin --from-literal=password_hash="$hash" --from-literal=totp_secret="$totp"
# server 的 GitHub App（假凭证，私钥随机生成）：只验证挂载路径与 server 读取私钥
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$work/github-app.pem" 2>/dev/null
k -n "$ns" create secret generic srenautix-github-app --from-literal=app-id=1 --from-literal=installation-id=1 \
  --from-literal=slug=srenautix-install-e2e --from-file=private-key.pem="$work/github-app.pem"
github_key_sha=$(sha256sum "$work/github-app.pem" | cut -d' ' -f1)
rm -f "$work/github-app.pem"

log "安装 SreNautix（values-standard.yaml）"
helm --kube-context "$ctx" install srenautix "$chart_dir" --namespace "$ns" \
  -f "$chart_dir/ci/base/required.yaml" -f "$chart_dir/values-standard.yaml" -f "$chart_dir/ci/install/values.yaml" \
  --set-file roles.gateway.approverKeys.content="$work/approver-keys.yaml" \
  --wait --timeout 15m

log "等待全部 Pod Ready"
k -n "$ns" wait pod --for=condition=Ready --timeout=600s \
  -l 'app.kubernetes.io/component in (server,worker,reader,gateway,audit-store)'
k -n "$ns" wait pod --for=condition=Ready --timeout=300s -l cnpg.io/cluster=srenautix-pg
for role in server worker reader gateway; do
  ready=$(k -n "$ns" get deployment "srenautix-$role" -o jsonpath='{.status.readyReplicas}')
  [[ "${ready:-0}" -ge 1 ]] || { log "srenautix-$role 没有就绪的副本"; exit 1; }
  log "srenautix-${role}：${ready} 个副本就绪"
done
# 之后 server 不应再有读取 worker 事件流失败的日志（启动时 worker 尚未就绪的重试不计入）
ready_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

log "检查 gateway 的准入自检与熔断开关（从 monitoring 命名空间读取指标）"
deadline=$((SECONDS + 180))
while true; do
  metrics=$(k -n monitoring run "metrics-probe-$RANDOM" --image="$busybox" --restart=Never --rm -i --quiet -- \
    wget -qO- "http://srenautix-gateway.$ns.svc:9090/metrics" 2>/dev/null || true)
  selfcheck=$(awk '$1 == "srenautix_admission_selfcheck_ok" {print $2}' <<<"$metrics")
  frozen=$(awk '$1 == "srenautix_gateway_frozen" {print $2}' <<<"$metrics")
  if [[ "$selfcheck" == 1 && "$frozen" == 1 ]]; then
    log "准入自检通过，gateway 处于冻结状态"
    break
  fi
  ((SECONDS < deadline)) || { log "gateway 指标：selfcheck=${selfcheck:-无} frozen=${frozen:-无}"; exit 1; }
  sleep 10
done

log "检查 gateway 的 downward API 环境变量与选主 Lease（身份为 Pod 名）"
gateway_pod=$(k -n "$ns" get pod -l app.kubernetes.io/component=gateway -o jsonpath='{.items[0].metadata.name}')
for var in POD_NAME:metadata.name NODE_NAME:spec.nodeName; do
  path=$(k -n "$ns" get pod "$gateway_pod" -o json |
    jq -r --arg name "${var%%:*}" '.spec.containers[0].env[] | select(.name == $name) | .valueFrom.fieldRef.fieldPath // empty')
  [[ "$path" == "${var#*:}" ]] || { log "gateway 的 ${var%%:*} 应来自 fieldRef ${var#*:}，实际为 ${path:-未注入}"; exit 1; }
done
deadline=$((SECONDS + 120))
until [[ "$(k -n "$ns" get lease srenautix-gateway -o jsonpath='{.spec.holderIdentity}' 2>/dev/null)" == "$gateway_pod" ]]; do
  ((SECONDS < deadline)) || { log "Lease srenautix-gateway 的持有者不是 $gateway_pod"; exit 1; }
  sleep 5
done
log "gateway ${gateway_pod} 持有 Lease srenautix-gateway"

log "检查 server 挂载的 GitHub App 凭证"
mounted=$(k -n "$ns" exec deploy/srenautix-server -c server -- /nodejs/bin/node -e \
  "const fs = require('node:fs'), c = require('node:crypto'), d = '/etc/srenautix/secrets/github-app/';
   for (const f of ['app-id', 'installation-id', 'slug']) fs.accessSync(d + f, fs.constants.R_OK);
   process.stdout.write(c.createHash('sha256').update(fs.readFileSync(d + 'private-key.pem')).digest('hex'));")
[[ "$mounted" == "$github_key_sha" ]] || { log "server 挂载的 GitHub App 私钥与 Secret 不一致：${mounted:-读取失败}"; exit 1; }
k -n "$ns" get configmap srenautix-server-config -o jsonpath='{.data.config\.yaml}' |
  grep -q 'private_key_file: /etc/srenautix/secrets/github-app/private-key.pem' ||
  { log "server 配置中没有 GitHub App 私钥路径"; exit 1; }
log "server 的 GitHub App 凭证已挂载，配置指向挂载路径"

# server 与 worker 双向连通（chart 的 NetworkPolicy 打开）：worker 主动访问 server 认领任务、上报路由；
# server 主动拉取 worker 的 /v1/events（研判事件）与 /v1/runs/*（运行明细）。docs/install 中有完整的连通矩阵
log "检查 NetworkPolicy 生效：monitoring 命名空间的 Pod 连不上 worker 的 API"
probe=$(k -n monitoring run "np-probe-$RANDOM" --image="$busybox" --restart=Never --rm -i --quiet -- \
  wget -q -T 5 -O /dev/null "http://srenautix-worker.$ns.svc:8080/v1/events" 2>&1 || true)
[[ "$probe" == *"timed out"* ]] || { log "monitoring 中的 Pod 能连上 worker 的 API（NetworkPolicy 没有生效）：$probe"; exit 1; }

log "检查 server 能读取 worker 的事件流（server 主动发起，worker:8080）"
k -n "$ns" exec deploy/srenautix-server -c server -- /nodejs/bin/node -e \
  "const t = require('node:fs').readFileSync('/etc/srenautix/secrets/worker-client/token', 'utf8').trim();
   fetch('http://srenautix-worker.$ns.svc:8080/v1/events?after=worker:0&limit=1', { headers: { authorization: 'Bearer ' + t } })
     .then(async (r) => { if (r.status !== 200) { console.error('HTTP ' + r.status + ' ' + (await r.text())); process.exit(1); } })
     .catch((e) => { console.error(e.cause?.code ?? e.message); process.exit(1); });" ||
  { log "server 读取 worker 的 /v1/events 失败"; exit 1; }

log "注入一条告警，等待阶段 B 的研判经 worker 事件流回到 server"
# 模型端点在测试环境中不可达（ci/base/required.yaml 的示例路由），worker 的模型调用失败后研判以 stage_a_only 或 failed 结束；
# 这里检查的是 server→worker 的认领、worker→server 的事件回传与 server 读取运行明细这条链路，不检查模型的结论
jq '.alerts[0].startsAt = (now - 30 | floor | todate)' \
  "$repo_root/apps/srenautix/test/fixtures/alertmanager/webhook-v4-alertmanager-0.34.1.json" |
  k -n "$ns" exec -i deploy/srenautix-server -c server -- /nodejs/bin/node -e \
    "const fs = require('node:fs'), body = fs.readFileSync(0, 'utf8');
     const t = fs.readFileSync('/etc/srenautix/secrets/ingest/alertmanager', 'utf8').trim();
     fetch('http://127.0.0.1:8080/v1/ingest/alertmanager', { method: 'POST', body,
       headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' } })
       .then(async (r) => { if (r.status !== 200) { console.error('HTTP ' + r.status + ' ' + (await r.text())); process.exit(1); } })
       .catch((e) => { console.error(e.message); process.exit(1); });" ||
  { log "告警接入失败"; exit 1; }
deadline=$((SECONDS + 300))
until run=$(k -n "$ns" exec srenautix-pg-1 -c postgres -- psql -U postgres -d srenautix -tAc \
  "SELECT run_id || ' ' || state FROM server.research_runs WHERE state IN ('completed', 'failed', 'stage_a_only') LIMIT 1" 2>/dev/null) &&
  [[ -n "$run" ]]; do
  ((SECONDS < deadline)) || { log "5 分钟内 server 没有收到 worker 的研判结果"; exit 1; }
  sleep 5
done
run_id=${run%% *}
log "研判 ${run_id} 已回到 server：${run#* }"

log "经 server 读取运行明细（server 向 worker 取 /v1/runs/${run_id}）"
k -n "$ns" exec deploy/srenautix-worker -c worker -- /nodejs/bin/node -e \
  "const t = require('node:fs').readFileSync('/etc/srenautix/secrets/service-token/token', 'utf8').trim();
   fetch('http://srenautix-server.$ns.svc:8080/v1/runs/$run_id', { headers: { authorization: 'Bearer ' + t } })
     .then(async (r) => {
       const text = await r.text();
       if (r.status !== 200) { console.error('HTTP ' + r.status + ' ' + text); process.exit(1); }
       const d = JSON.parse(text);
       if (!Array.isArray(d.steps) || !Array.isArray(d.evidence) || !Array.isArray(d.llm_calls)) { console.error(text.slice(0, 500)); process.exit(1); }
       console.error('steps=' + d.steps.length + ' evidence=' + d.evidence.length + ' llm_calls=' + d.llm_calls.length);
     })
     .catch((e) => { console.error(e.message); process.exit(1); });" ||
  { log "经 server 读取运行明细失败"; exit 1; }

log "本地管理员登录控制台（口令 + TOTP），读取事件与条件列表（chart 默认的 local-admin 绑定）"
# 口令与 TOTP 密钥经标准输入传入，TOTP 按 RFC 6238（SHA1、6 位、30 秒）在 server 容器中计算
printf '{"password":"%s","totp_secret":"%s"}' "$admin_password" "$totp" |
  k -n "$ns" exec -i deploy/srenautix-server -c server -- /nodejs/bin/node -e \
    "const c = require('node:crypto'), { password, totp_secret } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
     const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
     for (const ch of totp_secret.replace(/=+\$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
     const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
     const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
     const h = c.createHmac('sha1', key).update(counter).digest(), o = h[h.length - 1] & 15;
     const code = String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
     const base = 'http://127.0.0.1:8080';
     (async () => {
       const login = await fetch(base + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ username: 'admin', password, totp: code }) });
       if (login.status !== 200) throw new Error('login HTTP ' + login.status + ' ' + (await login.text()));
       const cookie = login.headers.get('set-cookie').split(';')[0];
       for (const path of ['/v1/incidents', '/v1/conditions']) {
         const r = await fetch(base + path, { headers: { cookie, accept: 'application/json' } });
         const text = await r.text();
         if (r.status !== 200) throw new Error(path + ' HTTP ' + r.status + ' ' + text.slice(0, 300));
         console.error(path + '：200');
       }
     })().catch((e) => { console.error(e.message); process.exit(1); });" ||
  { log "本地管理员登录后读取事件或条件列表失败"; exit 1; }

failures=$(k -n "$ns" logs deploy/srenautix-server -c server --since-time="$ready_at" | grep -c '读取 worker 事件流失败' || true)
[[ "$failures" == 0 ]] || { log "全部 Pod 就绪之后 server 有 ${failures} 条读取 worker 事件流失败的日志"; exit 1; }
log "server 与 worker 双向连通，研判经事件流回到 server"

log "安装测试通过"
