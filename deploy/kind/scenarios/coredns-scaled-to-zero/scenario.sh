# shellcheck shell=bash
# CoreDNS 缩到 0：集群内的名称解析全部失败。api 的数据库连接检查按 Service 名连接，随之失败并进入
# CrashLoopBackOff；CoreDNS 自身没有任何告警（沉默的根因，DESIGN §5），需要对集群枢纽执行探测卡才能发现。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(KubePodCrashLooping)
VERIFY_TIMEOUT=900

inject() {
  k -n kube-system scale deployment coredns --replicas=0
}

recover() {
  k -n kube-system scale deployment coredns --replicas=2
  k -n kube-system rollout status deployment/coredns --timeout=300s
  wait_namespace_ready shop 600
}
