# shellcheck shell=bash
# 拓扑与领域包覆盖：人工向 shop 的告警规则加一条 ShopCatalogStale，它只带 service="catalog" 标签，
# 没有 namespace、pod、deployment 等可以映射到拓扑的标签，领域包与拓扑覆盖也没有它。告警触发后映射不到组件。
# 期望：结论指向 api（商品目录由 api 提供），修复 PR 为这条告警新增拓扑覆盖或领域包的告警目录条目。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(ShopCatalogStale)
VERIFY_TIMEOUT=600
# 只带 service 标签的告警目前没有根因（事件记录 no_root），也没有模型录制；SreNautix 能从 service 标签推断组件、
# 领域包的 alert-catalog-entry 模板识别 service 标签之后，在这里检查三个环节：
#   SRENAUTIX_ROOT='^(Deployment:shop/api|Service:shop/api)$' SRENAUTIX_MAX_INCIDENTS=1
#   SRENAUTIX_REMEDIATION=topology_coverage SRENAUTIX_PR_FILES='^srenautix/(topology-overrides|packs/kind-shop)/'
SRENAUTIX_ROOT=

rules=platform/observability/rules/shop.yaml

inject() {
  gitops_file main "$rules" | yq '(.spec.groups[] | select(.name == "shop") | .rules) += [{
      "alert": "ShopCatalogStale",
      "expr": "label_replace(vector(1), \"service\", \"catalog\", \"\", \"\")",
      "for": "1m",
      "labels": {"severity": "warning"},
      "annotations": {"summary": "商品目录超过 1 小时没有刷新"}
    }]' >"$SCENARIO_STATE_DIR/shop-rules.yaml"
  gitops_commit "Alert when the catalog is stale" "$rules=$SCENARIO_STATE_DIR/shop-rules.yaml" >/dev/null
}

recover() {
  gitops_file main "$rules" | yq 'del(.spec.groups[].rules[] | select(.alert == "ShopCatalogStale"))' \
    >"$SCENARIO_STATE_DIR/shop-rules.yaml"
  gitops_commit "Remove ShopCatalogStale" "$rules=$SCENARIO_STATE_DIR/shop-rules.yaml" >/dev/null
  wait_argo_synced platform-rules 300
}
