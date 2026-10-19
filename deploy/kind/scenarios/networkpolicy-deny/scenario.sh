# shellcheck shell=bash
# NetworkPolicy 拒绝流量：新增的出站策略 api-egress-lockdown 只放行 DNS，api 到 postgres 的连接被拒绝，
# api 的数据库连接检查失败并进入 CrashLoopBackOff；postgres 本身正常。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(KubePodCrashLooping)
VERIFY_TIMEOUT=900

inject() {
  k apply -f "$KIND_DIR/scenarios/networkpolicy-deny/api-egress-lockdown.yaml"
}

recover() {
  k delete -f "$KIND_DIR/scenarios/networkpolicy-deny/api-egress-lockdown.yaml"
  wait_namespace_ready shop 600
}
