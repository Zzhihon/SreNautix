#!/usr/bin/env bash
# 在 Kind 集群中部署本地 Git 服务 gitlocal（由 up.sh 调用，也可以单独执行以重建）：
#   - 构建镜像 srenautix.local/gitlocal:e2e（deploy/docker/gitlocal.Dockerfile，内含 kind/gitops 的初始内容）并载入集群；
#   - 生成 GitHub App 的密钥对与管理员令牌（只生成一次，之后沿用集群中的 Secret）：
#       gitlocal/gitlocal-app      公钥（gitlocal 校验 App JWT）
#       gitlocal/gitlocal-admin    管理员令牌（人工身份 kind-operator）
#       srenautix/srenautix-github-app  app-id、installation-id、slug、private-key.pem（SreNautix 的 server 与 gateway 使用）
#   - 部署 Deployment 与 Service（deploy/kind/gitlocal/kind.yaml）。
# 环境变量：SKIP_BUILD=1 使用已经载入集群的镜像
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

require docker kind kubectl openssl
image=srenautix.local/gitlocal:e2e
work="$REPO_ROOT/.scratch/kind-gitlocal"
mkdir -p "$work"

if [[ "${SKIP_BUILD:-}" != 1 ]]; then
  log "构建 $image"
  docker build -q -f "$REPO_ROOT/deploy/docker/gitlocal.Dockerfile" -t "$image" "$REPO_ROOT" >/dev/null
fi
kind load docker-image --name "$CLUSTER_NAME" "$image" >/dev/null

for ns in gitlocal srenautix; do
  k create namespace "$ns" --dry-run=client -o yaml | k apply -f - >/dev/null
done
if ! k -n srenautix get secret srenautix-github-app >/dev/null 2>&1; then
  log "生成 GitHub App 的密钥对"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$work/app.pem" 2>/dev/null
  k -n srenautix create secret generic srenautix-github-app --from-literal=app-id=1 --from-literal=installation-id=1 \
    --from-literal=slug=srenautix-kind --from-file=private-key.pem="$work/app.pem" >/dev/null
fi
k -n srenautix get secret srenautix-github-app -o jsonpath='{.data.private-key\.pem}' | base64 -d >"$work/app.pem"
openssl pkey -in "$work/app.pem" -pubout -out "$work/public.pem"
rm -f "$work/app.pem"
k -n gitlocal create secret generic gitlocal-app --from-file=public.pem="$work/public.pem" --dry-run=client -o yaml | k apply -f - >/dev/null
if ! k -n gitlocal get secret gitlocal-admin >/dev/null 2>&1; then
  k -n gitlocal create secret generic gitlocal-admin --from-literal=token="$(openssl rand -hex 20)" >/dev/null
fi
rm -rf "$work"

k apply -f "$KIND_DIR/gitlocal/kind.yaml" >/dev/null
# 镜像标签不变时 Deployment 不会滚动；重建的镜像需要重启 Pod 才生效
for d in gitlocal gitlocal-invariants; do
  k -n gitlocal rollout restart "deployment/$d" >/dev/null
  k -n gitlocal rollout status "deployment/$d" --timeout=300s
done
gitlocal_api GET /_test/repos/kind/gitops/refs | jq -e '.main' >/dev/null || die "gitlocal 上没有 kind/gitops 的 main"
log "gitlocal 就绪：http://gitlocal.gitlocal.svc:3000/kind/gitops.git"
