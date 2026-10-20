#!/usr/bin/env bash
# 在 Kind 上运行 gateway 的不变量测试（test/invariants）。每个不变量使用一个新建的 Kind 集群：
#   1. 按 deploy/kind/versions.env 固定的 Kind 与节点镜像创建集群，kube-apiserver 开启审计日志；
#   2. 删除 kube-controller-manager 与 kube-scheduler 的静态 Pod：测试中的夹具按控制器的方式写入 status，
#      不能被真实控制器覆盖；未调度的 Pod 不会被 kubelet 接管；
#   3. 以 USE_EXISTING_CLUSTER=true 运行该不变量的测试，审计日志从宿主机目录读取；
#   4. 删除集群。
# 不变量 8 默认运行 1000 轮（SRENAUTIX_INVARIANT8_ROUNDS）。
# 需要：docker、go、envsubst；SRENAUTIX_TEST_BIN（含 prometheus）与 SRENAUTIX_MINIO_BIN（.github/scripts/install-test-binaries.sh）。
# 不变量 12 设置 SRENAUTIX_TEST_GITHUB_API 时使用该地址的 Git 服务（Kind 中的本地 Git 服务，实现 /_test 控制接口，
# 不校验 App JWT 的签名），否则使用进程内的同一实现。
# 用法：test/invariants/kind/run.sh [不变量编号 ...]，例如 run.sh 08 10；不带参数时运行全部。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
# shellcheck source=../../../deploy/kind/versions.env
source "$root/deploy/kind/versions.env"
: "${SRENAUTIX_TEST_BIN:?需要 SRENAUTIX_TEST_BIN}"
: "${SRENAUTIX_MINIO_BIN:?需要 SRENAUTIX_MINIO_BIN}"
export SRENAUTIX_INVARIANT8_ROUNDS=${SRENAUTIX_INVARIANT8_ROUNDS:-1000}

kind=(go run "sigs.k8s.io/kind@${KIND_VERSION}")
work="$root/.scratch/kind-invariants"
mkdir -p "$work"

invariants=("$@")
if [[ ${#invariants[@]} -eq 0 ]]; then
  invariants=(02 03 04 05 07 08 10 11 12)
fi

for n in "${invariants[@]}"; do
  name="srenautix-inv-$n"
  dir="$work/$n"
  rm -rf "$dir"
  mkdir -p "$dir/audit"
  export AUDIT_DIR="$dir/audit" POLICY_FILE="$here/audit-policy.yaml"
  envsubst <"$here/kind-config.yaml" >"$dir/kind-config.yaml"
  "${kind[@]}" create cluster --name "$name" --image "$KIND_NODE_IMAGE" --config "$dir/kind-config.yaml" \
    --kubeconfig "$dir/kubeconfig" --wait 120s
  trap '"${kind[@]}" delete cluster --name "$name"' EXIT
  node="$name-control-plane"
  docker exec "$node" rm -f /etc/kubernetes/manifests/kube-controller-manager.yaml /etc/kubernetes/manifests/kube-scheduler.yaml
  KUBECONFIG="$dir/kubeconfig" USE_EXISTING_CLUSTER=true SRENAUTIX_APISERVER_AUDIT_LOG="$dir/audit/audit.log" \
    go test -count=1 -timeout 6h -run "^TestInvariant${n}" "$root/test/invariants/"
  "${kind[@]}" delete cluster --name "$name"
  trap - EXIT
done
