# 0101 组件的可读名称只用于显示，由阶段 A 求出并随事件读取

## 背景

以 id 为键的组件（例如 CCHP 的 provider）在标题、通知、控制台和 issue 里直接显示 UUID，例如 `provider:01a134f4-437f-75d9-8731-697393b9f30f`。CCHP 已经有名字来源：provider 告警的注解 `provider_name`，以及指标 `cchp_gateway_provider_info{provider_id, provider_name}`。

## 决定

1. **领域包声明来源**（契约 2.10.0）：`ComponentType.display_name` 按顺序列出 `alert_annotation`、`alert_label` 或 `{signal, label}`，取第一个非空且不等于实体名的值（packs-sdk 的 `resolveDisplayName`）。组件键不变。
2. **阶段 A 求值**：证据链执行完后，对根因、候选与成员告警的实体（组件类型声明了 `display_name` 的）在事件锚点求名称，告警来源取实体所在的第一条告警。数据源错误只让该来源落空；其他异常记日志后跳过这个组件。名称求值不影响证据卡与阶段 A 的结果。
3. **存储**：`server.component_names (cluster_id, component, display_name)`，只更新求出了名称的组件，求不出时保留上一次的名称。
4. **读取**（契约 2.11.0）：`GET /v1/incidents/{ref}` 的事件附上 `component_names`（根因、候选与成员组件）；收件箱的 `IncidentSummary.component_names` 只含根因。事件流与历史版本的事件不带这个字段。
5. **显示**：标题（通知、issue）用名称；正文的根因、候选与结论写"名称（组件键）"；issue 标题里以根因组件键开头的事件标签换成名称；控制台的列表与详情显示名称，副标题带对象名。没有名称时一律退回解码后的组件键。按钮、回复解析与审批仍以组件键为准。

## 结果

- CCHP 的 provider 事件显示为"智元 API"等名称；没有起名的 provider（名称本身是 UUID）退回组件键。
- 回放时快照里没有名称来源的数据，名称为空，不影响评测。
