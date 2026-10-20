#!/usr/bin/env bash
# 在 Kind 集群上安装 SreNautix（standard 配置，gateway 冻结），告警经 AlertmanagerConfig 送到 server。
# 由 up.sh 调用，也可以单独执行以升级。环境变量同 up.sh。
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require kubectl helm openssl
chart=${SRENAUTIX_CHART:-"$REPO_ROOT/deploy/helm/srenautix"}
ns=srenautix
work="$REPO_ROOT/.scratch/kind-srenautix"
mkdir -p "$work"

k create namespace "$ns" --dry-run=client -o yaml | k apply -f -

# 服务签名密钥只生成一次，之后沿用集群中的 Secret；gateway 信任的公钥由同一把私钥推导
if ! k -n "$ns" get secret srenautix-service-signing >/dev/null 2>&1; then
  log "生成服务签名密钥"
  openssl genpkey -algorithm ed25519 -out "$work/private.pem"
  k -n "$ns" create secret generic srenautix-service-signing --from-file=private.pem="$work/private.pem"
  rm -f "$work/private.pem"
fi
k -n "$ns" get secret srenautix-service-signing -o jsonpath='{.data.private\.pem}' | base64 -d >"$work/private.pem"
pub=$(openssl pkey -in "$work/private.pem" -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n')
rm -f "$work/private.pem"
printf 'version: 1\nkeys:\n  - {use: service, key_id: default, public_key: %s}\n' "$pub" >"$work/approver-keys.yaml"

# 模型密钥：没有提供时 worker 仍然启动，阶段 B 的模型调用失败，事件只出阶段 A
if [[ -n "${SRENAUTIX_LLM_SECRET:-}" ]]; then
  k -n "$ns" create secret generic srenautix-llm --from-file=api_key="$SRENAUTIX_LLM_SECRET" \
    --dry-run=client -o yaml | k apply -f -
elif ! k -n "$ns" get secret srenautix-llm >/dev/null 2>&1; then
  k -n "$ns" create secret generic srenautix-llm --from-literal=api_key=kind-no-model-configured
fi

args=(-f "$KIND_DIR/values/srenautix.yaml" --set-file "roles.gateway.approverKeys.content=$work/approver-keys.yaml")
hub_image=""
if [[ -n "${SRENAUTIX_LOCAL_IMAGES:-}" ]]; then
  # 本地构建并 kind load 的镜像（kind-e2e）：srenautix.local/srenautix:<标签>、srenautix.local/srenautix-spoke:<标签>
  args+=(--set "image.hub.repository=srenautix.local/srenautix" --set "image.hub.tag=$SRENAUTIX_LOCAL_IMAGES"
    --set "image.hub.pullPolicy=Never" --set "image.spoke.repository=srenautix.local/srenautix-spoke"
    --set "image.spoke.tag=$SRENAUTIX_LOCAL_IMAGES" --set "image.spoke.pullPolicy=Never")
  hub_image="srenautix.local/srenautix:$SRENAUTIX_LOCAL_IMAGES"
elif [[ -n "${SRENAUTIX_VERSION:-}" ]]; then
  args+=(--set "image.hub.tag=$SRENAUTIX_VERSION" --set "image.spoke.tag=$SRENAUTIX_VERSION")
fi

# Kind 的用户领域包 kind-shop（deploy/kind/gitops/srenautix/packs/kind-shop）：子目录中的文件以 <子目录>__<文件名> 为键
pack_dir="$KIND_DIR/gitops/srenautix/packs/kind-shop"
if [[ -f "$pack_dir/pack.yaml" ]]; then
  pack_args=()
  while IFS= read -r f; do
    rel=${f#"$pack_dir"/}
    pack_args+=("--from-file=${rel//\//__}=$f")
  done < <(find "$pack_dir" -type f ! -name README.md | sort)
  k -n "$ns" create configmap kind-shop "${pack_args[@]}" --dry-run=client -o yaml | k apply -f - >/dev/null
  args+=(--set-json 'packs.userConfigMaps=[{"configMap":"kind-shop","pack":"kind-shop"}]')
fi

# 录制回放的模型服务（SRENAUTIX_LLM_REPLAY=1，kind-e2e）：worker 的路由指向它，镜像与 hub 相同
if [[ "${SRENAUTIX_LLM_REPLAY:-}" == 1 ]]; then
  [[ -n "$hub_image" ]] || die "SRENAUTIX_LLM_REPLAY=1 需要 SRENAUTIX_LOCAL_IMAGES（llm-replay 使用同一个 hub 镜像）"
  args+=(-f "$KIND_DIR/values/srenautix-replay.yaml")
  sed "s|HUB_IMAGE|$hub_image|" "$KIND_DIR/llm-replay.yaml" | k apply -f - >/dev/null
  k -n "$ns" rollout status deployment/llm-replay --timeout=300s
fi
if [[ "$chart" == oci://* ]]; then
  # 发布的 chart 在注解中带有镜像的构建提交
  args+=(--version "${SRENAUTIX_CHART_VERSION:?使用 OCI chart 时需要 SRENAUTIX_CHART_VERSION}")
else
  args+=(--set "codeSha=${SRENAUTIX_CODE_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}")
fi

log "安装 SreNautix（${chart}）"
helm --kube-context "$KUBE_CONTEXT" upgrade --install srenautix "$chart" --namespace "$ns" "${args[@]}" --wait --timeout 15m
k -n "$ns" get pods -o wide
