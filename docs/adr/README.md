# 架构决策记录（ADR）

<!-- 由 hack/adr-index.mjs 生成，不要手工修改。新增或修改 ADR 后执行 node hack/adr-index.mjs -->

每篇 ADR 记一项决定。读一篇 ADR 时，看"之后引用它的 ADR"一列：后来的 ADR 可能修订了它。

新 ADR 在标题下第一行写状态：`状态：提议`、`状态：已采纳`、`状态：部分取代（见 NNNN）` 或 `状态：已取代（见 NNNN）`。
没有状态行的 ADR 按已采纳处理。编号取 docs/adr 中最大的编号加一。

| 编号 | 标题 | 状态 | 之后引用它的 ADR |
|---|---|---|---|
| [0010](0010-contract-versioning.md) | 契约的版本与生成 | 已采纳 | — |
| [0011](0011-topology-component-model.md) | 拓扑的对象图、组件与事件溯源 | 已采纳 | [0034](0034-component-key-name-escaping.md) |
| [0012](0012-convergence-and-root-ranking.md) | 收敛与根因排序 | 已采纳 | [0104](0104-release-convergence.md) |
| [0020](0020-approval-assertion-format.md) | 审批断言的格式、规范化与签名 | 已采纳 | [0021](0021-ticket-protocol.md) [0022](0022-action-execution-state.md) [0044](0044-approval-issuance.md) [0094](0094-compliance-passkey-approval-issuance.md) [0118](0118-local-admin-totp-switch.md) |
| [0021](0021-ticket-protocol.md) | 中心与 gateway 之间的工单协议 | 已采纳 | [0022](0022-action-execution-state.md) [0031](0031-reader-hub-protocol.md) |
| [0022](0022-action-execution-state.md) | gateway 的执行状态：ActionExecution | 已采纳 | — |
| [0023](0023-gateway-admission-generation.md) | 由动作目录生成 gateway 的准入策略与 RBAC | 已采纳 | [0024](0024-admission-self-check-cadence.md) [0060](0060-helm-chart-and-profiles.md) |
| [0024](0024-admission-self-check-cadence.md) | 准入自检的频率与探针标记 | 已采纳 | — |
| [0025](0025-gitops-pr-compensating-controls.md) | gitops_pr：唯一的 Git 写入路径、补偿控制与冻结 | 已采纳 | [0095](0095-incident-issues-linked-to-prs.md) [0108](0108-remediation-prs.md) [0146](0146-goal-driven-optimization.md) [0155](0155-remediation-change-dedupe-and-alert-facts.md) |
| [0030](0030-reader-topology-extraction.md) | reader 从集群对象提取拓扑 | 已采纳 | [0033](0033-ksm-history-topology.md) [0184](0184-stable-incident-identity-on-recurrence.md) |
| [0031](0031-reader-hub-protocol.md) | reader 与中心之间的协议 | 已采纳 | — |
| [0032](0032-declared-evidence-queries.md) | 声明式证据查询的执行与限制 | 已采纳 | — |
| [0033](0033-ksm-history-topology.md) | 从 kube-state-metrics 历史重建拓扑 | 已采纳 | [0110](0110-reconstruction-and-loop-metrics.md) [0184](0184-stable-incident-identity-on-recurrence.md) |
| [0034](0034-component-key-name-escaping.md) | 组件键名称段的转义与非法对象的跳过 | 已采纳 | [0035](0035-reader-object-health.md) [0193](0193-business-domains-and-services.md) |
| [0035](0035-reader-object-health.md) | reader 上报不健康的对象（集群状态检测器） | 已采纳 | [0105](0105-cluster-state-detectors.md) |
| [0040](0040-server-state-store.md) | server 的状态库：库角色、分轨迁移、outbox 与事件流 | 已采纳 | [0176](0176-schema-only-migrations-and-leader-data-corrections.md) |
| [0041](0041-research-queue-and-admission.md) | 阶段 B 的队列与准入由 server 持有 | 已采纳 | [0086](0086-worker-role.md) |
| [0042](0042-notify-desired-state-queue.md) | 通知用期望状态表作为发送队列 | 已采纳 | — |
| [0043](0043-stage-a-degraded-lane.md) | 状态库不可用时的阶段 A 降级通道 | 已采纳 | — |
| [0044](0044-approval-issuance.md) | server 签发审批断言的规则 | 已采纳 | [0094](0094-compliance-passkey-approval-issuance.md) |
| [0060](0060-helm-chart-and-profiles.md) | 一个 Helm chart 与三种安装配置 | 已采纳 | — |
| [0061](0061-supply-chain.md) | 镜像、chart 与离线包的供应链 | 已采纳 | — |
| [0062](0062-chart-validation-vs-runtime-degradation.md) | chart 的渲染期校验与运行时降级的分工 | 已采纳 | — |
| [0070](0070-ui-package-and-data-port.md) | `@srenautix/ui`：共享组件与注入的数据端口 | 已采纳 | — |
| [0071](0071-console-routing-and-live-data.md) | 控制台的路由、页面状态与实时数据 | 已采纳 | — |
| [0072](0072-grafana-plugin-packaging.md) | Grafana 插件的打包与后端代理 | 已采纳 | — |
| [0073](0073-console-end-to-end-tests.md) | 控制台与插件的端到端测试 | 已采纳 | [0154](0154-alert-link-to-incident.md) |
| [0080](0080-model-layer.md) | 模型层：方言档案、结构化输出与修复阶梯、熔断与故障域 | 部分取代（见 [0098](0098-streaming-model-calls-with-per-route-timeouts.md)） | [0083](0083-stage-b-ledger-and-ladder.md) [0136](0136-renumber-recommendation-ids.md) [0152](0152-last-resort-model-route.md) [0178](0178-deterministic-conclusion-rules.md) |
| [0081](0081-egress-and-redaction.md) | 唯一出口、脱敏与蜜标 | 已采纳 | [0158](0158-route-thinking-setting.md) [0177](0177-error-samples-evidence.md) |
| [0082](0082-token-accounting-and-budgets.md) | token 计量与预算 | 已采纳 | [0129](0129-research-input-budget-for-large-incidents.md) |
| [0083](0083-stage-b-ledger-and-ladder.md) | 阶段 B：代码维护的假设账本、区分性检查与结论阶梯 | 已采纳 | [0169](0169-change-link-grades.md) |
| [0084](0084-eval-replay-and-gate.md) | 回放评测：用例与快照、防泄漏、统计与发布门禁 | 已采纳 | [0110](0110-reconstruction-and-loop-metrics.md) |
| [0085](0085-legacy-seed-import.md) | 导入旧版 Ops-Agent 的回放种子 | 已采纳 | — |
| [0086](0086-worker-role.md) | worker 角色：认领、状态与事件流 | 已采纳 | — |
| [0087](0087-mcp-role.md) | mcp 角色：只能提议的对外 MCP 服务 | 已采纳 | [0186](0186-incident-export.md) |
| [0088](0088-evidence-card-judgement.md) | 证据卡判定：CEL 引擎、函数库、成本上界与无数据语义 | 已采纳 | [0090](0090-pack-tests-on-real-backends.md) |
| [0089](0089-signal-alternatives-and-label-profile.md) | 信号备选、标签档案与官方解析器 | 已采纳 | — |
| [0090](0090-pack-tests-on-real-backends.md) | 领域包测试在真实 Prometheus 与 VictoriaMetrics 上执行 | 已采纳 | — |
| [0091](0091-pack-sources-lock-and-layers.md) | 领域包来源、pack.lock 与用户层 | 已采纳 | — |
| [0092](0092-integration-manifests-and-conformance.md) | 集成清单与一致性测试 | 已采纳 | [0096](0096-github-change-sources-over-rest.md) |
| [0093](0093-disable-noncompliant-model-routes.md) | 不合规的模型路由在启动时禁用，worker 照常就绪 | 已采纳 | — |
| [0094](0094-compliance-passkey-approval-issuance.md) | 合规配置 H 档审批的通行密钥签发流程 | 已采纳 | — |
| [0095](0095-incident-issues-linked-to-prs.md) | 需要人跟进的事件在 GitHub 开 issue，并与修复 PR 互相关联 | 已采纳 | [0096](0096-github-change-sources-over-rest.md) [0108](0108-remediation-prs.md) [0146](0146-goal-driven-optimization.md) [0155](0155-remediation-change-dedupe-and-alert-facts.md) [0162](0162-disposition-act-on-declared-components.md) [0171](0171-coverage-gaps-become-issues.md) [0181](0181-hot-pluggable-skills.md) [0182](0182-urgency-tiered-incidents.md) [0184](0184-stable-incident-identity-on-recurrence.md) |
| [0096](0096-github-change-sources-over-rest.md) | 变更源经 GitHub REST API 读取，不在 hub 镜像里带 git | 已采纳 | [0103](0103-remediation-patch-templates.md) [0108](0108-remediation-prs.md) [0151](0151-sql-audit-change-source.md) [0161](0161-retirement-and-pending-sync-changes.md) |
| [0097](0097-evidence-chains-by-entity-type.md) | 证据链按实体的组件类型执行，告警目录只作补充 | 已采纳 | [0126](0126-remediation-follows-the-research-root.md) |
| [0098](0098-streaming-model-calls-with-per-route-timeouts.md) | 模型调用改为流式，超时按路由配置，延迟熔断只看成功调用的首 token | 已采纳 | — |
| [0099](0099-trim-prompts-to-route-window-and-budget.md) | 提示词按路由窗口与输入预算裁剪，不因超限让研判失败 | 已采纳 | [0127](0127-research-context-for-large-incidents.md) [0129](0129-research-input-budget-for-large-incidents.md) [0170](0170-remediation-pr-admission.md) |
| [0100](0100-condition-directions-in-the-contract.md) | 状态条件的方向由契约定义，分支条件只保留当前实例并随心跳过期 | 已采纳 | [0161](0161-retirement-and-pending-sync-changes.md) |
| [0101](0101-component-display-names.md) | 组件的可读名称只用于显示，由阶段 A 求出并随事件读取 | 已采纳 | — |
| [0102](0102-wait-for-the-database-instead-of-exiting.md) | 启动时数据库没准备好：重试并保持 not ready，不退出 | 已采纳 | [0176](0176-schema-only-migrations-and-leader-data-corrections.md) |
| [0103](0103-remediation-patch-templates.md) | 修复补丁模板：领域包声明改什么，server 配置改哪里 | 已采纳 | [0108](0108-remediation-prs.md) [0146](0146-goal-driven-optimization.md) |
| [0104](0104-release-convergence.md) | 发布事故收敛：从拓扑推导发布变更，Pod 告警归到工作负载，没有锚点的告警归到变更 | 已采纳 | [0110](0110-reconstruction-and-loop-metrics.md) [0130](0130-logical-components-map-to-workloads.md) [0139](0139-remediation-templates-judge-their-own-root.md) [0140](0140-failed-pre-step-releases.md) [0141](0141-access-edges-stop-at-the-accessed-component.md) [0142](0142-late-and-no-op-changes-issue-titles-research-reason.md) [0151](0151-sql-audit-change-source.md) [0155](0155-remediation-change-dedupe-and-alert-facts.md) [0161](0161-retirement-and-pending-sync-changes.md) [0169](0169-change-link-grades.md) |
| [0105](0105-cluster-state-detectors.md) | 集群状态检测器：对象状态由 reader 或 informer 上报，server 按阈值合成告警 | 已采纳 | [0128](0128-detector-findings-across-leader-handover.md) [0146](0146-goal-driven-optimization.md) [0161](0161-retirement-and-pending-sync-changes.md) [0181](0181-hot-pluggable-skills.md) [0182](0182-urgency-tiered-incidents.md) [0183](0183-alert-categories.md) |
| [0106](0106-kubernetes-read-checks-and-related-changes.md) | 阶段 B 的 Kubernetes 只读检查与相关变更 | 已采纳 | [0116](0116-evidence-cards-as-checks.md) [0146](0146-goal-driven-optimization.md) [0151](0151-sql-audit-change-source.md) [0181](0181-hot-pluggable-skills.md) |
| [0107](0107-stage-a-recompute.md) | 阶段 A 按当前领域包重算 | 已采纳 | [0131](0131-check-windows-share-the-stage-a-anchor.md) [0149](0149-long-running-incident-card-windows.md) |
| [0108](0108-remediation-prs.md) | 自愈 PR：server 计划与校验补丁，gateway 开 PR | 已采纳 | [0117](0117-external-labels-are-not-alert-identity.md) [0126](0126-remediation-follows-the-research-root.md) [0138](0138-disposition-derived-from-deterministic-evidence.md) [0146](0146-goal-driven-optimization.md) [0170](0170-remediation-pr-admission.md) [0182](0182-urgency-tiered-incidents.md) |
| [0109](0109-alert-condition-cards.md) | 告警条件卡：主卡由告警规则生成，与规则在同一份夹具上核对 | 已采纳 | [0153](0153-evidence-baseline-and-minimum-evidence.md) [0187](0187-metricsql-cards-and-split-configmap-packs.md) |
| [0110](0110-reconstruction-and-loop-metrics.md) | 重建评测与发现、分析、自愈 PR 三个环节的度量 | 已采纳 | [0144](0144-point-in-time-topology-queries.md) [0152](0152-last-resort-model-route.md) [0175](0175-eval-candidates-and-benign-silence.md) |
| [0116](0116-evidence-cards-as-checks.md) | 卡片即检查：证据链的卡作为阶段 B 的区分性检查 | 已采纳 | [0124](0124-evidence-consistent-needs-a-ruled-out-competitor.md) [0130](0130-logical-components-map-to-workloads.md) [0131](0131-check-windows-share-the-stage-a-anchor.md) [0137](0137-controller-picks-checks-when-none-are-given.md) [0146](0146-goal-driven-optimization.md) [0153](0153-evidence-baseline-and-minimum-evidence.md) |
| [0117](0117-external-labels-are-not-alert-identity.md) | Prometheus 的 external labels 不属于告警身份 | 已采纳 | [0154](0154-alert-link-to-incident.md) [0160](0160-alertmanager-additions-fast-poll.md) [0182](0182-urgency-tiered-incidents.md) |
| [0118](0118-local-admin-totp-switch.md) | 本地管理员登录的 TOTP 开关 | 已采纳 | — |
| [0120](0120-ledger-pick-when-the-model-abstains.md) | 模型在 conclude 弃权时由代码按账本选中结论 | 已采纳 | [0121](0121-research-roots-at-component-granularity.md) [0122](0122-member-alerts-as-research-support.md) [0123](0123-conclude-selects-and-the-ladder-grades.md) [0134](0134-contrary-evidence-caps-the-ladder-at-inconclusive.md) [0146](0146-goal-driven-optimization.md) |
| [0121](0121-research-roots-at-component-granularity.md) | 阶段 B 的假设根因使用组件粒度 | 已采纳 | [0122](0122-member-alerts-as-research-support.md) [0127](0127-research-context-for-large-incidents.md) [0133](0133-targeted-refutation-and-full-ranking.md) [0134](0134-contrary-evidence-caps-the-ladder-at-inconclusive.md) [0146](0146-goal-driven-optimization.md) [0182](0182-urgency-tiered-incidents.md) |
| [0122](0122-member-alerts-as-research-support.md) | 成员告警作为阶段 B 假设的支持证据 | 已采纳 | [0161](0161-retirement-and-pending-sync-changes.md) [0178](0178-deterministic-conclusion-rules.md) |
| [0123](0123-conclude-selects-and-the-ladder-grades.md) | conclude 只负责选择，档位由结论阶梯决定；处置判断的 ignore 条件 | 已采纳 | [0138](0138-disposition-derived-from-deterministic-evidence.md) |
| [0124](0124-evidence-consistent-needs-a-ruled-out-competitor.md) | evidence_consistent 要求检验并排除竞争假设 | 已采纳 | [0133](0133-targeted-refutation-and-full-ranking.md) [0146](0146-goal-driven-optimization.md) |
| [0125](0125-incident-report-messages.md) | 事件消息：确定性的报告结构、富文本渲染与证据链接 | 已采纳 | [0142](0142-late-and-no-op-changes-issue-titles-research-reason.md) [0145](0145-telegram-entity-size-budget.md) [0146](0146-goal-driven-optimization.md) [0148](0148-business-signals-in-incident-messages.md) [0177](0177-error-samples-evidence.md) [0182](0182-urgency-tiered-incidents.md) |
| [0126](0126-remediation-follows-the-research-root.md) | 修复模板按研判根因匹配，并展开到具体对象 | 已采纳 | [0130](0130-logical-components-map-to-workloads.md) [0138](0138-disposition-derived-from-deterministic-evidence.md) [0139](0139-remediation-templates-judge-their-own-root.md) [0162](0162-disposition-act-on-declared-components.md) |
| [0127](0127-research-context-for-large-incidents.md) | 大事件的研判上下文，与缺少 template 的检查 | 已采纳 | [0129](0129-research-input-budget-for-large-incidents.md) [0130](0130-logical-components-map-to-workloads.md) [0136](0136-renumber-recommendation-ids.md) |
| [0128](0128-detector-findings-across-leader-handover.md) | 检测器的发现在主实例切换时保持触发 | 已采纳 | [0132](0132-reopen-dormant-incidents-and-isolate-persist-failures.md) |
| [0129](0129-research-input-budget-for-large-incidents.md) | 大事件的单次研判输入：估算校准与拓扑写法 | 已采纳 | [0146](0146-goal-driven-optimization.md) |
| [0130](0130-logical-components-map-to-workloads.md) | 逻辑组件映射到候选工作负载 | 已采纳 | [0155](0155-remediation-change-dedupe-and-alert-facts.md) |
| [0131](0131-check-windows-share-the-stage-a-anchor.md) | 阶段 B 的检查与阶段 A 用同一个锚点 | 已采纳 | [0149](0149-long-running-incident-card-windows.md) |
| [0132](0132-reopen-dormant-incidents-and-isolate-persist-failures.md) | 超出回看窗口的事件重开，事件写入按组隔离 | 已采纳 | [0135](0135-reopened-incidents-trigger-research.md) [0142](0142-late-and-no-op-changes-issue-titles-research-reason.md) [0159](0159-incident-timing-onset-and-first-message-latency.md) [0184](0184-stable-incident-identity-on-recurrence.md) |
| [0133](0133-targeted-refutation-and-full-ranking.md) | 推翻要有针对性，账本输出保留全部假设 | 已采纳 | [0134](0134-contrary-evidence-caps-the-ladder-at-inconclusive.md) [0137](0137-controller-picks-checks-when-none-are-given.md) [0146](0146-goal-driven-optimization.md) |
| [0134](0134-contrary-evidence-caps-the-ladder-at-inconclusive.md) | 有相反证据时结论档位最高为 inconclusive | 已采纳 | [0146](0146-goal-driven-optimization.md) [0178](0178-deterministic-conclusion-rules.md) |
| [0135](0135-reopened-incidents-trigger-research.md) | 重开的事件触发研判 | 已采纳 | [0184](0184-stable-incident-identity-on-recurrence.md) |
| [0136](0136-renumber-recommendation-ids.md) | 修复建议的 id 不合规时重新编号 | 已采纳 | — |
| [0137](0137-controller-picks-checks-when-none-are-given.md) | 模型没有给出检查时由控制器补选 | 已采纳 | [0146](0146-goal-driven-optimization.md) [0153](0153-evidence-baseline-and-minimum-evidence.md) |
| [0138](0138-disposition-derived-from-deterministic-evidence.md) | 处置由代码按确定性依据推导 | 已采纳 | [0139](0139-remediation-templates-judge-their-own-root.md) [0146](0146-goal-driven-optimization.md) [0147](0147-external-upstream-digest.md) [0162](0162-disposition-act-on-declared-components.md) [0163](0163-inhibited-alerts-and-business-impact-disposition.md) [0167](0167-planned-retirement-is-ignored.md) [0168](0168-model-proposals-dropped-on-benign-ignore.md) [0170](0170-remediation-pr-admission.md) |
| [0139](0139-remediation-templates-judge-their-own-root.md) | 修复模板按根因自己的卡适用 | 已采纳 | [0155](0155-remediation-change-dedupe-and-alert-facts.md) [0170](0170-remediation-pr-admission.md) |
| [0140](0140-failed-pre-step-releases.md) | 停在前置步骤的发布：一次性 Job 自成变更，变更的作用对象进入候选 | 已采纳 | [0141](0141-access-edges-stop-at-the-accessed-component.md) [0142](0142-late-and-no-op-changes-issue-titles-research-reason.md) [0161](0161-retirement-and-pending-sync-changes.md) [0169](0169-change-link-grades.md) |
| [0141](0141-access-edges-stop-at-the-accessed-component.md) | 访问边只到被访问的组件为止：失败的迁移 Job 不经数据库的 Pod 并入节点告警 | 已采纳 | [0142](0142-late-and-no-op-changes-issue-titles-research-reason.md) |
| [0142](0142-late-and-no-op-changes-issue-titles-research-reason.md) | 没有改动、晚于症状的变更不参与根因排序；issue 标题跟随事件；研判镜像的原因取自队列 | 已采纳 | [0151](0151-sql-audit-change-source.md) [0169](0169-change-link-grades.md) |
| [0143](0143-pack-revision-rolls-server-and-worker.md) | 用户包变化时滚动更新：由 GitOps 侧填写的 packs.revision | 已采纳 | [0181](0181-hot-pluggable-skills.md) |
| [0144](0144-point-in-time-topology-queries.md) | 时间点拓扑查询按索引取、子图逐跳取、并发合并与缓存；拓扑历史按保留期压缩 | 已采纳 | [0146](0146-goal-driven-optimization.md) [0150](0150-external-upstream-impact-relevance.md) [0182](0182-urgency-tiered-incidents.md) |
| [0145](0145-telegram-entity-size-budget.md) | Telegram 消息按实体总大小分配链接 | 已采纳 | [0148](0148-business-signals-in-incident-messages.md) |
| [0146](0146-goal-driven-optimization.md) | 目标驱动的主动优化：目标、领域体检与趋势触发，业务 issue 与 ops PR | 已采纳 | [0153](0153-evidence-baseline-and-minimum-evidence.md) [0162](0162-disposition-act-on-declared-components.md) [0171](0171-coverage-gaps-become-issues.md) [0181](0181-hot-pluggable-skills.md) [0182](0182-urgency-tiered-incidents.md) [0193](0193-business-domains-and-services.md) |
| [0147](0147-external-upstream-digest.md) | 外部上游的事件按周期汇总，不逐条推送、不开 issue | 已采纳 | [0150](0150-external-upstream-impact-relevance.md) [0155](0155-remediation-change-dedupe-and-alert-facts.md) [0159](0159-incident-timing-onset-and-first-message-latency.md) [0182](0182-urgency-tiered-incidents.md) |
| [0148](0148-business-signals-in-incident-messages.md) | 事件消息在现状之后列出业务关键信号 | 已采纳 | — |
| [0149](0149-long-running-incident-card-windows.md) | 长期事件的卡片窗口以评估时刻为终点 | 已采纳 | — |
| [0150](0150-external-upstream-impact-relevance.md) | 外部上游事件的业务影响按相关性判定 | 已采纳 | [0163](0163-inhibited-alerts-and-business-impact-disposition.md) [0166](0166-business-impact-alert-matchers.md) [0182](0182-urgency-tiered-incidents.md) |
| [0151](0151-sql-audit-change-source.md) | SQL 审计表作为变更来源：运行时配置变更进入时间线、根因排序与研判的首要假设 | 已采纳 | [0161](0161-retirement-and-pending-sync-changes.md) |
| [0152](0152-last-resort-model-route.md) | 兜底模型路由：只在全部常规路由因故障域提前熔断时使用 | 已采纳 | [0158](0158-route-thinking-setting.md) [0182](0182-urgency-tiered-incidents.md) |
| [0153](0153-evidence-baseline-and-minimum-evidence.md) | 证据先过基线；告警的最低取证集合由阶段 A 执行，没覆盖完时结论为 undetermined | 已采纳 | [0162](0162-disposition-act-on-declared-components.md) [0163](0163-inhibited-alerts-and-business-impact-disposition.md) [0164](0164-cards-that-describe-the-failure-skip-the-baseline.md) [0169](0169-change-link-grades.md) [0178](0178-deterministic-conclusion-rules.md) [0180](0180-eval-mechanism-grounding-safety-and-environment.md) |
| [0154](0154-alert-link-to-incident.md) | 告警链接：按标签集打开告警所属的事件 | 已采纳 | — |
| [0155](0155-remediation-change-dedupe-and-alert-facts.md) | 自愈 PR 按修改去重并记住被拒绝的修改，目录条目与告警调优模板只用告警能确认的事实 | 已采纳 | [0170](0170-remediation-pr-admission.md) [0171](0171-coverage-gaps-become-issues.md) |
| [0158](0158-route-thinking-setting.md) | 路由的思考模式设置 | 已采纳 | — |
| [0159](0159-incident-timing-onset-and-first-message-latency.md) | 事件的计时起点、阶段 A 报告第一次生成的时刻与首条消息时延 | 已采纳 | [0160](0160-alertmanager-additions-fast-poll.md) [0165](0165-first-message-latency-from-alertmanager.md) [0166](0166-business-impact-alert-matchers.md) |
| [0160](0160-alertmanager-additions-fast-poll.md) | 两轮完整对账之间快速轮询 Alertmanager 的新增告警 | 已采纳 | [0165](0165-first-message-latency-from-alertmanager.md) |
| [0161](0161-retirement-and-pending-sync-changes.md) | 退役与已合并、尚未同步的提交进入变更时间线；meta 告警的研判方向 | 已采纳 | [0167](0167-planned-retirement-is-ignored.md) [0169](0169-change-link-grades.md) |
| [0162](0162-disposition-act-on-declared-components.md) | 处置 act 的确定性依据：研判根因上的修复模板与仓库声明的运行中组件 | 已采纳 | [0163](0163-inhibited-alerts-and-business-impact-disposition.md) [0168](0168-model-proposals-dropped-on-benign-ignore.md) [0170](0170-remediation-pr-admission.md) |
| [0163](0163-inhibited-alerts-and-business-impact-disposition.md) | 告警源的抑制规则不使事件被抑制；业务影响告警在触发、证据卡异常时处置不能是 ignore | 已采纳 | [0166](0166-business-impact-alert-matchers.md) [0167](0167-planned-retirement-is-ignored.md) [0168](0168-model-proposals-dropped-on-benign-ignore.md) |
| [0164](0164-cards-that-describe-the-failure-skip-the-baseline.md) | 描述故障类型的卡不取证据基线 | 已采纳 | — |
| [0165](0165-first-message-latency-from-alertmanager.md) | 首条消息时延从告警第一次出现在 Alertmanager 算起 | 已采纳 | — |
| [0166](0166-business-impact-alert-matchers.md) | 业务影响告警的统一匹配器 | 已采纳 | [0167](0167-planned-retirement-is-ignored.md) [0182](0182-urgency-tiered-incidents.md) [0183](0183-alert-categories.md) |
| [0167](0167-planned-retirement-is-ignored.md) | 计划内退役判为 ignore，不推送消息 | 已采纳 | [0169](0169-change-link-grades.md) |
| [0168](0168-model-proposals-dropped-on-benign-ignore.md) | ignore 的确定性依据成立时模型的提议不生效 | 已采纳 | — |
| [0169](0169-change-link-grades.md) | 变更与事件关联的确定性分级 | 已采纳 | [0178](0178-deterministic-conclusion-rules.md) |
| [0170](0170-remediation-pr-admission.md) | 自愈 PR 的准入条件 | 已采纳 | [0175](0175-eval-candidates-and-benign-silence.md) [0182](0182-urgency-tiered-incidents.md) |
| [0171](0171-coverage-gaps-become-issues.md) | 覆盖缺口改为 issue | 已采纳 | [0181](0181-hot-pluggable-skills.md) [0193](0193-business-domains-and-services.md) |
| [0172](0172-reason-code-registry-and-timeline.md) | 终态原因码登记表与事件时间线 | 已采纳 | [0173](0173-stage-a-retry-and-final-edit.md) [0174](0174-feedback-reason-codes-and-closure-tracking.md) [0176](0176-schema-only-migrations-and-leader-data-corrections.md) [0181](0181-hot-pluggable-skills.md) [0182](0182-urgency-tiered-incidents.md) [0186](0186-incident-export.md) |
| [0173](0173-stage-a-retry-and-final-edit.md) | 阶段 A 补跑、没有阶段 A 时的消息与群消息的最后一次编辑 | 已采纳 | [0176](0176-schema-only-migrations-and-leader-data-corrections.md) [0182](0182-urgency-tiered-incidents.md) [0184](0184-stable-incident-identity-on-recurrence.md) |
| [0174](0174-feedback-reason-codes-and-closure-tracking.md) | 反馈原因码与关闭的跟踪 | 已采纳 | [0175](0175-eval-candidates-and-benign-silence.md) [0184](0184-stable-incident-identity-on-recurrence.md) [0192](0192-controlled-incident-qa.md) |
| [0175](0175-eval-candidates-and-benign-silence.md) | 评测候选与健康场景的度量 | 已采纳 | [0180](0180-eval-mechanism-grounding-safety-and-environment.md) [0192](0192-controlled-incident-qa.md) |
| [0176](0176-schema-only-migrations-and-leader-data-corrections.md) | 迁移只改 schema，语义修正在取得主实例之后执行 | 已采纳 | [0183](0183-alert-categories.md) [0184](0184-stable-incident-identity-on-recurrence.md) [0193](0193-business-domains-and-services.md) |
| [0177](0177-error-samples-evidence.md) | 错误样例证据卡：按依赖与错误类别聚合错误日志 | 已采纳 | — |
| [0178](0178-deterministic-conclusion-rules.md) | 领域包的确定性结论规则：模型不可用时的根因候选与机制，研判可用时作为假设进入账本 | 已采纳 | [0179](0179-relation-causality-controls.md) [0184](0184-stable-incident-identity-on-recurrence.md) |
| [0179](0179-relation-causality-controls.md) | 关系证据只构成假设：因果性标注与对照对象 | 已采纳 | — |
| [0180](0180-eval-mechanism-grounding-safety-and-environment.md) | 评测的机制命中、证据扎根与安全三轴，以及运行的环境指纹 | 已采纳 | — |
| [0181](0181-hot-pluggable-skills.md) | 可热插拔的技能：清单、能力白名单、预算与热加载 | 已采纳 | [0182](0182-urgency-tiered-incidents.md) |
| [0182](0182-urgency-tiered-incidents.md) | 按紧急度分级处理事件：标签首轮、拓扑距离与实测业务影响的校正 | 提议 | [0183](0183-alert-categories.md) [0184](0184-stable-incident-identity-on-recurrence.md) [0185](0185-kube-warnings-and-suspected-common-cause.md) [0186](0186-incident-export.md) |
| [0183](0183-alert-categories.md) | 告警类别：领域包声明、标签覆盖、部署方规则，事件的类别与列表筛选 | 已采纳 | [0185](0185-kube-warnings-and-suspected-common-cause.md) [0186](0186-incident-export.md) [0193](0193-business-domains-and-services.md) |
| [0184](0184-stable-incident-identity-on-recurrence.md) | 告警复发时事件身份保持稳定，同一系列复用事件 issue | 已采纳 | [0185](0185-kube-warnings-and-suspected-common-cause.md) [0186](0186-incident-export.md) [0196](0196-series-key-stays-on-root-component.md) |
| [0185](0185-kube-warnings-and-suspected-common-cause.md) | 导出时的 Kubernetes Warning 摘要与疑似同一根因分组 | 已采纳 | [0186](0186-incident-export.md) |
| [0186](0186-incident-export.md) | 按时间窗批量导出事件 | 已采纳 | [0193](0193-business-domains-and-services.md) |
| [0187](0187-metricsql-cards-and-split-configmap-packs.md) | 只能用 MetricsQL 查询的卡与分在多个 ConfigMap 中的包 | 已采纳 | [0188](0188-deterministic-oci-pack-artifacts.md) |
| [0188](0188-deterministic-oci-pack-artifacts.md) | 确定性的 OCI 领域包制品与测试后端的回收 | 已采纳 | — |
| [0190](0190-incident-summary-headline.md) | 收件箱的一行显示问题陈述 | 已采纳 | [0193](0193-business-domains-and-services.md) |
| [0191](0191-subgraph-zoom-and-node-navigation.md) | 根因子图的缩放、全屏与节点导航 | 部分取代（见 [0197](0197-subgraph-large-graph-browsing.md)） | [0197](0197-subgraph-large-graph-browsing.md) [0199](0199-cluster-map.md) |
| [0192](0192-controlled-incident-qa.md) | 受控事件问答与标注反哺 | 已采纳 | — |
| [0193](0193-business-domains-and-services.md) | 业务领域与服务：领域包声明，告警与事件的服务归属 | 已采纳 | [0196](0196-series-key-stays-on-root-component.md) [0199](0199-cluster-map.md) |
| [0194](0194-notify-brief-block.md) | 事件消息的结论块：处置、影响、下一步紧跟标题 | 已采纳 | — |
| [0195](0195-incident-claims.md) | 事件的认领：谁在处理 | 已采纳 | — |
| [0196](0196-series-key-stays-on-root-component.md) | 系列键保持根因组件加告警名，不改用服务 | 已采纳 | — |
| [0197](0197-subgraph-large-graph-browsing.md) | 组件多的子图：滚轮缩放、同类合并、突出与查找 | 已采纳 | [0199](0199-cluster-map.md) |
| [0198](0198-evidence-chain-view.md) | 证据标签页：按论证分组的证据链 | 已采纳 | — |
| [0199](0199-cluster-map.md) | 全集群地图 | 已采纳 | — |
