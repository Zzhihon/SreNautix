#!/usr/bin/env bash
# 删除 Kind 集群，并清理 Kind 节点镜像与本次运行留下的场景记录。
# 用法：deploy/kind/down.sh [--keep-images]
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require kind docker
if kind get clusters | grep -qx "$CLUSTER_NAME"; then
  log "删除 Kind 集群 $CLUSTER_NAME"
  kind delete cluster --name "$CLUSTER_NAME"
fi
if [[ "${1:-}" != "--keep-images" ]]; then
  # 节点镜像约 1 GiB；按 digest 删除，不影响其他版本
  if docker image inspect "$KIND_NODE_IMAGE" >/dev/null 2>&1; then
    log "删除节点镜像 $KIND_NODE_IMAGE"
    docker image rm "$KIND_NODE_IMAGE" >/dev/null
  fi
fi
rm -rf "$REPO_ROOT/.scratch/kind-scenarios" "$REPO_ROOT/.scratch/kind-srenautix"
