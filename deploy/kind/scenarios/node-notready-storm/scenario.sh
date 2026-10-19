# shellcheck shell=bash
# 节点 NotReady 引发 Pod 风暴：停止 srenautix-worker2 的 kubelet。节点约 50 秒后变为 NotReady，
# 被打上 unreachable 污点；5 分钟后其上的 Pod 被驱逐，在其余节点上重建，期间 api、web 的副本数不足。
# shellcheck disable=SC2034
NODE="${CLUSTER_NAME}-worker2"
EXPECTED_ALERTS=(KubeNodeNotReady KubeNodeUnreachable)
VERIFY_TIMEOUT=600

inject() {
  docker exec "$NODE" systemctl stop kubelet
}

recover() {
  docker exec "$NODE" systemctl start kubelet
  k wait --for=condition=Ready "node/$NODE" --timeout=300s
  wait_namespace_ready shop 600
}
