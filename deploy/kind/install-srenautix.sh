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
if [[ -n "${SRENAUTIX_VERSION:-}" ]]; then
  args+=(--set "image.hub.tag=$SRENAUTIX_VERSION" --set "image.spoke.tag=$SRENAUTIX_VERSION")
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
