# shellcheck shell=bash
# 告警规则调优：shop 的 ShopPodRestarted 对任何一次重启立即以 critical 告警（for 0m）。
# 注入一次正常的容器重启（api 的 db-check 容器收到 TERM 后退出并由 kubelet 重启，业务不受影响），critical 告警随即触发。
# 期望：结论为不需要处理业务（disposition ignore），修复 PR 调整 platform/observability/rules/shop.yaml 中这条规则的
# 阈值、持续时间或严重度。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(ShopPodRestarted)
VERIFY_TIMEOUT=600
SRENAUTIX_ROOT='^(Pod:shop/api-.+|Deployment:shop/api)$'
SRENAUTIX_MAX_INCIDENTS=1
SRENAUTIX_CONCLUSIONS='likely evidence_consistent'
# gitops 包的 noisy-alert-relax：研判结论为不需要处理且告警为 critical 时，把这条规则改为 warning、持续时间至少 1h
# （不需要 7 天的长期告警历史）。处置由代码推导（ADR 0138）：录制给出 ignore，依据是 kind-shop 包的影响卡
# traffic/client-errors（外部客户端经 web 访问 api 的请求）在 api 与 web 上全部正常（ADR 0139）
SRENAUTIX_REMEDIATION=alert_rule
SRENAUTIX_PR_FILES='^platform/observability/rules/shop\.yaml$'

inject() {
  local pod
  pod=$(k -n shop get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
  k -n shop exec "$pod" -c db-check -- kill 1
  log "已让 ${pod} 的 db-check 容器退出一次"
}

recover() {
  k -n shop rollout status deployment/api --timeout=300s
}
