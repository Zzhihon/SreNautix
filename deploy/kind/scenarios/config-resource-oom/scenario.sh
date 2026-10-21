# shellcheck shell=bash
# 配置与资源：人工提交把 checkout 的 CACHE_MB 从 4 调到 64，内存缓存超过容器的内存上限（32Mi），
# 新 Pod 启动时被 OOMKilled，反复重启；旧 Pod 继续服务，发布卡住。
# 期望：根因是 checkout 的配置变更；修复 PR 调整 workloads.yaml 中 checkout 的内存上限或 CACHE_MB。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(KubePodCrashLooping ShopRolloutIncomplete)
VERIFY_TIMEOUT=900
SRENAUTIX_ROOT='^(Deployment:shop/checkout|Application\.argoproj\.io:argocd/shop)$'
SRENAUTIX_MAX_INCIDENTS=2
SRENAUTIX_REMEDIATION=config_resource
SRENAUTIX_PR_FILES='^apps/shop/workloads\.yaml$'

# 已知缺口（断言不变）：memory-limit-raise 要求内存卡异常，kind-e2e 39666613594 中 checkout 的内存卡没有看到 OOM
# （cAdvisor 计数没有采到，内存卷让重启在初始化时失败）。ADR 0126 第 6、7 条之后待 kind-e2e 确认。
KNOWN_GAP='Zzhihon/SreNautix#5 (3)：checkout 的内存卡没有看到 OOM，memory-limit-raise 不适用'

set_cache_mb() {
  gitops_file main apps/shop/workloads.yaml |
    yq "(select(.kind == \"Deployment\" and .metadata.name == \"checkout\") | .spec.template.spec.containers[]
          | select(.name == \"checkout\") | .env[] | select(.name == \"CACHE_MB\") | .value) = \"$1\"" \
    >"$SCENARIO_STATE_DIR/workloads.yaml"
  gitops_commit "$2" "apps/shop/workloads.yaml=$SCENARIO_STATE_DIR/workloads.yaml" >/dev/null
}

inject() {
  set_cache_mb 64 "Warm a larger checkout cache"
}

recover() {
  set_cache_mb 4 "Revert the checkout cache size"
  wait_argo_synced shop 600
  wait_deployment_rolled_out shop checkout 600
}
