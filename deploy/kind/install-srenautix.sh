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

# 服务签名密钥只生成一次，之后沿用集群中的 Secret
if ! k -n "$ns" get secret srenautix-service-signing >/dev/null 2>&1; then
  log "生成服务签名密钥"
  openssl genpkey -algorithm ed25519 -out "$work/private.pem"
  openssl pkey -in "$work/private.pem" -pubout -out "$work/public.pem"
  k -n "$ns" create secret generic srenautix-service-signing \
    --from-file=private.pem="$work/private.pem" --from-file=public.pem="$work/public.pem"
  rm -f "$work/private.pem" "$work/public.pem"
fi

args=(-f "$KIND_DIR/values/srenautix.yaml")
if [[ -n "${SRENAUTIX_VERSION:-}" ]]; then
  args+=(--set "image.hub.tag=$SRENAUTIX_VERSION" --set "image.spoke.tag=$SRENAUTIX_VERSION")
fi
if [[ -n "${SRENAUTIX_LLM_SECRET:-}" ]]; then
  k -n "$ns" create secret generic srenautix-llm --from-file=api_key="$SRENAUTIX_LLM_SECRET" \
    --dry-run=client -o yaml | k apply -f -
  args+=(--set secrets.llm.existingSecret=srenautix-llm)
fi
if [[ "$chart" == oci://* ]]; then
  args+=(--version "${SRENAUTIX_CHART_VERSION:?使用 OCI chart 时需要 SRENAUTIX_CHART_VERSION}")
fi

log "安装 SreNautix（${chart}）"
helm --kube-context "$KUBE_CONTEXT" upgrade --install srenautix "$chart" --namespace "$ns" "${args[@]}" --wait --timeout 15m
k -n "$ns" get pods -o wide
