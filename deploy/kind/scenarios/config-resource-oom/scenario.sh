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
  k -n shop rollout status deployment/checkout --timeout=600s
}
