# shellcheck shell=bash
# 发布回退：人工提交发布 r3，镜像换成 busybox（没有 HTTP 服务，启动后立即退出），迁移本身正常。
# api 的新 Pod CrashLoopBackOff，旧 Pod 继续服务，发布卡住。
# 期望：根因是这次发布；修复 PR 把 release.json 的镜像退回上一个已知良好的版本（r1 的镜像）。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(KubePodCrashLooping ShopRolloutIncomplete)
VERIFY_TIMEOUT=900
SRENAUTIX_ROOT='^(Application\.argoproj\.io:argocd/shop|Deployment:shop/api)$'
SRENAUTIX_MAX_INCIDENTS=2
SRENAUTIX_REMEDIATION=release_rollback
SRENAUTIX_PR_FILES='^apps/shop/release\.json$'

inject() {
  jq --arg image "$(image_ref busybox)" '.data.image = $image | .data.release_id = "r3"' \
    <(gitops_file main apps/shop/release.json) >"$SCENARIO_STATE_DIR/release.json"
  gitops_commit "Release r3" "apps/shop/release.json=$SCENARIO_STATE_DIR/release.json" >/dev/null
}

recover() {
  jq --arg image "$(image_ref nginx)" '.data.image = $image | .data.release_id = "r1"' \
    <(gitops_file main apps/shop/release.json) >"$SCENARIO_STATE_DIR/release.json"
  gitops_commit "Revert release r3" "apps/shop/release.json=$SCENARIO_STATE_DIR/release.json" >/dev/null
  wait_argo_synced shop 600
  k -n shop rollout status deployment/api --timeout=600s
}
