# 0163 告警源的抑制规则不使事件被抑制；业务影响告警在触发、证据卡异常时处置不能是 ignore

## 背景

部署方与前一个研判系统并行运行的一天里，一次数据库事故（主库反复 OOM、故障切换，一度没有可写主库，同时段一次发布的回退失败）中，SreNautix 有两个 critical 子事件出了问题：

| 事件 | 成员告警 | 阶段 A 处置 | 消息 |
|---|---|---|---|
| 网关错误预算燃烧 | 快速燃烧与慢速燃烧两条 critical 告警 | 版本 1、2 为 ignore（原因 `suppressed`），恢复后为 undetermined | 事件期间没有；事件恢复后发出一条"已恢复" |
| 网关系统错误率 | 系统错误率 critical 与 warning、主题升级 | 5 个版本都是 ignore（`suppressed`） | 只有一条"已恢复"（一个成员恢复时） |

当时网关自身 5xx 峰值 96%，两个事件的阶段 A 都有异常卡（网关 5xx、应用连接池 100%、未就绪副本）。

原因在事件的抑制状态：

1. **抑制规则被当成静默**。部署方的 Alertmanager 有一条抑制规则"PG 主库故障解释它上面组件的症状"：数据库根告警触发时，网关、控制面等组件 `role="symptom"` 的告警被抑制。对账读到这些告警的状态是 `suppressed`、`inhibitedBy` 非空，接入记为 `inhibited`。事件的抑制状态按"全部触发中的成员都被告警源抑制（`suppressed != none`）"计算，`inhibited` 与人工静默（`silenced`）同样计入，两个事件因此被当作被抑制：
   - 阶段 A 的确定性处置第一条"事件被抑制则 ignore"命中；
   - 消息源只取没有被抑制的事件，事件期间不发消息；研判准入同样跳过被抑制的事件，没有阶段 B。
2. **恢复后补发**。事件恢复、没有触发中的成员时，"全部触发中的成员都被抑制"不成立，抑制状态变回 false，消息源随即取到这个事件，发出一条"已恢复"。网关错误预算燃烧事件的消息因此在事件结束后才出现。

抑制规则的语义是"另一条触发中的告警能解释这条告警"，用来减少邮件里重复的通知；告警本身仍然成立。它解释的那条告警所在的事件（这里是数据库事件）照常推送，但被抑制的告警可能和它分在不同的事件里（网关事件的根因是网关，没有与数据库事件归并），这时把被抑制的告警所在的事件当作被抑制，就丢掉了业务受影响的信号。人工静默才表示"这条告警不需要处理"。

另外，阶段 A 的 ignore 依据（被抑制、领域包排除、只有预测与长期告警）都不看证据：业务影响告警在触发、证据卡显示业务受影响时，任何一条依据命中都会给出 ignore。阶段 B 的 ignore 依据（ADR 0138）有同样的问题：研判根因是外部组件时给 ignore，不看同一事件里业务影响告警是否在触发。

## 决定

### 1. 事件的抑制状态只认静默

- 事件被抑制：命中 SreNautix 的抑制规则，或全部触发中的成员都被告警源静默（`silenced`）。告警源的抑制规则（`inhibited`）不计入。`packages/core` 的分组与 server 的事件引擎（`suppressedAlertIds`）用同一个口径；
- 没有触发中的成员时，抑制状态保持上一个版本的取值：被抑制期间没有发出消息的事件，恢复时也不补发"已恢复"。

告警的 `suppressed` 字段照常记录 `inhibited`，用于展示。

### 2. 业务影响告警在触发、证据卡异常时不给 ignore

业务影响告警由部署方定义：server 的 `notify.digest.external_roots.business_impact.alert_labels`（ADR 0150，外部上游的汇总已经用它判定"有业务影响时即时推送"），评测的 `reconstruct.business_impact_labels`。事件的成员中，状态为 firing、严重度为 critical、标签满足条件的告警是触发中的 critical 业务影响告警。

- **阶段 A**：有触发中的 critical 业务影响告警，并且有判为异常、证据基线没有判为常态（ADR 0153）的卡时，被抑制、领域包排除、只有预测与长期告警这三条 ignore 依据都不生效，处置按其余规则判定（规则提议、观测失明、critical 且有歧义、其余为 undetermined）。
- **阶段 B**：处置依据（`disposition_facts`，契约 2.34.0）增加 `business_impact`：触发中的 critical 业务影响告警的 id。有这些告警、并且本次研判有领域包规则判定的异常卡（常态的不算）时，ADR 0138 的四种 ignore 依据都不成立；模型给出的 ignore 按严重度改写（critical 为 escalate），`validation_notes` 写明告警数与异常卡。
- 标签条件为空时没有业务影响告警，处置与原来相同。

### 3. 重放用例

部署方的标注集加入这次事故（标注根因 pg；发布是次要因素，写在机制里；处置 escalate，修复是在库上删除保留的策略与修改应用代码）。重建包从部署方的指标与状态库只读导出。重建包里告警的抑制状态没有历史（`ALERTS` 不带抑制状态），第 1 条由单元与集成测试覆盖。

## 结果

- 实现：`packages/core/src/incidents.ts`（分组的抑制状态）、`apps/srenautix/src/roles/server.ts`（`suppressedAlertIds`）、`incident/engine.ts`（没有触发中的成员时保持）、`stage-a/report.ts`（`businessImpactAlerts`、阶段 A 的 ignore 条件）、`stage-a/service.ts`、`remediation/facts.ts`（`business_impact`）、`research/disposition.ts`、`api/routes-research.ts`、`eval/{config,reconstruct,phase2}.ts`；契约 2.34.0：`eval-snapshot.schema.json` 的 `DispositionFacts.business_impact`，`incident.schema.json`、`alert.schema.json` 的 `suppressed` 说明。
- 测试：
  - `packages/core/test/inhibited-alerts.test.ts`：两条被抑制规则抑制的 critical 告警成一个 critical、没有被抑制的事件；全部静默时被抑制，静默与抑制规则混合时不被抑制；
  - `apps/srenautix/test/integration/incident-suppression.test.ts`（真实 PostgreSQL，经接入层写入）：抑制规则抑制的告警照常成事件、在消息源的选取范围内；静默的告警使事件被抑制；两者恢复后抑制状态保持；
  - `apps/srenautix/test/unit/business-impact-disposition.test.ts`：按这次事故构造的事件（成员告警 inhibited、事件被抑制、异常卡）阶段 A 不是 ignore；领域包排除、长期告警同样不给 ignore；没有异常卡、异常卡都是常态、告警已恢复、不是 critical、没有标签条件时照常 ignore；阶段 B 外部组件为根因、模型给出 ignore 时改写为 escalate，阶段 A 的抑制不再是依据。
- 快照模式：重构基线的 20 份录制离线重算，逐字段一致 20/20。
- 重建模式：17 个分析用例的两份录制在本项改动（基于 da46bd6，含 ADR 0162）上离线重算（评测配置的业务影响条件与部署方相同，`{layer: [L0], severity: [critical]}`），处置与只有 ADR 0162 时相同：这些用例中模型或代码给出 ignore 的运行都是外部上游与良性用例，事件里没有触发中的 critical L0 告警；重建包里告警的抑制状态都是 none。
- 重放用例在本项改动上两条路由各调用一次（235,637 token）：primary 研判根因 gateway StatefulSet（likely），发布回退模板适用，处置 act（标注 escalate）；fallback 只出阶段 A。主事件阶段 A 的处置为 escalate（critical 且有歧义；235 张卡中 105 张异常），不是 ignore。

## 遗留

- **重放用例的研判根因不对**：主事件的发现根因是业务的 GitOps 应用（发布），研判在 primary 路由上选中 gateway StatefulSet（发布不兼容），pg 的假设被一项与机制不符的检查（OOM 机制，检查的是连接占比，结果正常）推翻；fallback 路由在 hypothesize 阶段用完了单次研判的输入预算（15 万 token），只出阶段 A。这是发现与研判的问题，不在处置推导里解决。
- **网关错误预算燃烧不是 L0**：部署方的业务影响条件是 `{layer: [L0], severity: [critical]}`，这次的两个子事件的告警是 L2（网关自身），第 2 条对它们不生效；它们的 ignore 由第 1 条消除。是否把网关层的错误预算燃烧也算作业务影响告警，由部署方决定。
