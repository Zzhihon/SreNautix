# shellcheck shell=bash
# 拓扑与领域包覆盖：人工向 shop 的告警规则加一条 ShopCatalogStale，它只带 service="catalog" 标签，
# 没有 namespace、pod、deployment 等可以映射到拓扑的标签，领域包与拓扑覆盖也没有它。告警触发后映射不到组件。
# 期望：结论指向 api（商品目录由 api 提供），修复 PR 为这条告警新增拓扑覆盖或领域包的告警目录条目。
# shellcheck disable=SC2034
EXPECTED_ALERTS=(ShopCatalogStale)
VERIFY_TIMEOUT=600
# 发现：只带 service 标签的告警归入逻辑组件 component:<service>（ADR 0104 §6），事件的根因是 component:catalog；
# eval/scenarios/unmapped-alert.yaml 的 root_components（api）是研判应当指出的真实来源，不是接入时的组件。
# 分析：component:catalog 经同名的 Service shop/catalog 与它选中的 Pod 映射到 Deployment shop/api（ADR 0130），
# 阶段 A 在 api 上执行证据链，阶段 B 的组件枚举包含 api。
# 自愈：gitops 包的 alert-catalog-entry 为没有命中目录条目的告警在 kind-shop 包的告警目录中按 service 标签加条目
SRENAUTIX_ROOT='^component:catalog$'
SRENAUTIX_MAX_INCIDENTS=1
SRENAUTIX_REMEDIATION=topology_coverage
SRENAUTIX_PR_FILES='^srenautix/(topology-overrides|packs/kind-shop)/'

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
