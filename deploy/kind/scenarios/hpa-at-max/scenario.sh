# shellcheck shell=bash
# HPA 达到上限：外部流量（traffic/loadgen）增加到 12 个客户端且不间断请求，api 的 CPU 持续超过目标，
# HPA 扩到 maxReplicas=4 后无法继续扩容，请求排队、web 的响应变慢。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(KubeHpaMaxedOut)
VERIFY_TIMEOUT=900

inject() {
  k -n traffic set env deployment/loadgen INTERVAL=0
  k -n traffic scale deployment/loadgen --replicas=12
}

recover() {
  k -n traffic scale deployment/loadgen --replicas=1
  k -n traffic set env deployment/loadgen INTERVAL=1
  k -n traffic rollout status deployment/loadgen --timeout=300s
}
