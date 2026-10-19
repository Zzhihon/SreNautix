# shellcheck shell=bash
# 节点 NotReady 引发 Pod 风暴：停止 zone b 节点（srenautix-worker2，标准答案中的根因）的 kubelet。
# 节点约 50 秒后变为 NotReady，被打上 unreachable 污点；5 分钟后其上的 Pod 被驱逐，在其余节点上重建，
# 期间 api、web 的副本数不足。监控与 SreNautix 固定在 zone a，不受影响。
# shellcheck disable=SC2034
NODE="${CLUSTER_NAME}-worker2"
EXPECTED_ALERTS=(KubeNodeNotReady KubeNodeUnreachable)
VERIFY_TIMEOUT=600

inject() {
  local zone platform shop
  zone=$(k get node "$NODE" -o jsonpath='{.metadata.labels.srenautix\.io/zone}')
  [[ "$zone" == b ]] || die "$NODE 的 srenautix.io/zone 应为 b，实际为 ${zone:-空}"
  platform=$(k get pods -A --field-selector "spec.nodeName=$NODE" -o json |
    jq '[.items[] | select(.metadata.namespace | IN("monitoring", "srenautix", "cnpg-system")) |
      select(.metadata.ownerReferences[0].kind != "DaemonSet")] | length')
  ((platform == 0)) || die "$NODE 上有 ${platform} 个监控或 SreNautix 的 Pod，停止它会让监控失明"
  shop=$(k -n shop get pods --field-selector "spec.nodeName=$NODE" -o name | wc -l)
  ((shop > 0)) || die "$NODE 上没有 shop 的 Pod，场景不会产生 Pod 风暴"
  docker exec "$NODE" systemctl stop kubelet
}

recover() {
  docker exec "$NODE" systemctl start kubelet
  k wait --for=condition=Ready "node/$NODE" --timeout=300s
  wait_namespace_ready shop 600
}
