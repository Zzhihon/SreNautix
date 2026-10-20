# shellcheck shell=bash
# 发布卡在 initContainer：人工向 kind/gitops 的 main 提交发布 r2（release.json 换镜像与发布 ID），Argo CD 同步。
# r2 的迁移引用了不存在的表，迁移 Job shop-migrate-r2 失败；api 与 checkout 的新 Pod 停在 wait-for-migrations，
# 旧 Pod 继续服务（maxUnavailable 0），发布一直完成不了。与生产中"新 Pod 卡在迁移等待 initContainer"的事故同形。
# 期望：事件收敛到不超过 2 个，根因是这次发布；修复 PR 把 release.json 退回 r1。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(ShopMigrationFailed ShopRolloutIncomplete)
VERIFY_TIMEOUT=900
SRENAUTIX_ROOT='^(Application\.argoproj\.io:argocd/shop|Job:shop/shop-migrate-r2|Deployment:shop/(api|checkout))$'
SRENAUTIX_MAX_INCIDENTS=2
SRENAUTIX_REMEDIATION=release_rollback
SRENAUTIX_PR_FILES='^apps/shop/release\.json$'

inject() {
  release_stuck_good=$(gitops_file main apps/shop/release.json | jq -r .data.release_id)
  jq --arg image "$(image_ref nginx-next)" '.data.image = $image | .data.release_id = "r2"' \
    <(gitops_file main apps/shop/release.json) >"$SCENARIO_STATE_DIR/release.json"
  gitops_commit "Release r2" "apps/shop/release.json=$SCENARIO_STATE_DIR/release.json" >/dev/null
  log "已提交发布 r2（上一个发布 ${release_stuck_good}）"
}

recover() {
  # 人工回退：把 release.json 改回 r1（SreNautix 的 PR 不合并，由人决定）
  jq --arg image "$(image_ref nginx)" '.data.image = $image | .data.release_id = "r1"' \
    <(gitops_file main apps/shop/release.json) >"$SCENARIO_STATE_DIR/release.json"
  gitops_commit "Revert release r2" "apps/shop/release.json=$SCENARIO_STATE_DIR/release.json" >/dev/null
  wait_argo_synced shop 600
  k -n shop rollout status deployment/api --timeout=600s
  k -n shop rollout status deployment/checkout --timeout=600s
}
