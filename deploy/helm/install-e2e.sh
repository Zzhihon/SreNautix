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

log "安装测试通过"
