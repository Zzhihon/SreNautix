# shellcheck shell=bash
# 错误的配置被发布：人工向 kind/gitops 提交一次改动，新增 ConfigMap checkout-config-v2（mode 是无效值），checkout 改为引用它。
# Argo CD 同步后新 Pod 启动即退出（CrashLoopBackOff）；maxUnavailable=0，旧 Pod 继续服务，发布在 120 秒后判为卡住。
# shop 由 Argo CD 管理，故障与恢复都经 Git 提交（直接 kubectl patch 会在下一次同步时被覆盖）。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(KubePodCrashLooping)
VERIFY_TIMEOUT=900

workloads=apps/shop/workloads.yaml

# 把 checkout 的配置卷指向参数中的 ConfigMap，输出改后的 workloads.yaml
checkout_config() {
  gitops_file main "$workloads" | yq "
    (select(.kind == \"Deployment\" and .metadata.name == \"checkout\") | .spec.template.spec.volumes[]
      | select(.name == \"config\") | .configMap.name) = \"$1\"
    | select((.kind == \"ConfigMap\" and .metadata.name == \"checkout-config-v2\") | not)"
}

inject() {
  {
    checkout_config checkout-config-v2
    echo ---
    cat "$KIND_DIR/scenarios/bad-config-rollout/checkout-config-v2.yaml"
  } >"$SCENARIO_STATE_DIR/workloads.yaml"
  gitops_commit "Switch checkout to the v2 configuration" "$workloads=$SCENARIO_STATE_DIR/workloads.yaml" >/dev/null
  wait_argo_synced_to_main shop 300
}

recover() {
  checkout_config checkout-config >"$SCENARIO_STATE_DIR/workloads.yaml"
  gitops_commit "Revert checkout to the v1 configuration" "$workloads=$SCENARIO_STATE_DIR/workloads.yaml" >/dev/null
  wait_argo_synced_to_main shop 300
  wait_deployment_rolled_out shop checkout 300
}
