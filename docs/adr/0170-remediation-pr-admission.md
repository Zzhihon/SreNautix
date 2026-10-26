# 0170 自愈 PR 的准入条件

## 背景

自愈 PR（ADR 0108）在研判结论达到 `remediation.conclusions`、领域包的修复模板适用、类别启用时生成补丁并提交 `gitops_pr` 提议。去重与拒绝冷却（ADR 0155）解决了同一个修改反复提出的问题，但没有回答另一个问题：这次研判是否足以支撑一次仓库修改。部署方的影子期里，被人关闭的 PR 都有同样的特点：根因不在仓库负责的对象上，或者结论只由告警与拓扑关系支撑，没有一条运行时的度量、日志或集群状态说明根因上确实出了问题。模板的适用条件只看卡片结论与告警，看不出这些。

研判输出里有回答这个问题需要的材料：选中假设的支撑卡（`consistency_detail`）、证据索引（`evidence_index`）、检查产生的卡（`check_cards`）、处置推导用到的仓库事实（ADR 0162 的 `declared`）。缺少的是根因在哪里（仓库负责的组件、调用方、被依赖的服务方、基础设施）与 ignore 的依据是哪一条。

## 决定

### 1. 根因范围

conclude 的模型输出增加必填字段 `cause_scope`（契约 2.38.0，可移植子集的静态枚举）：`local`、`configuration`、`downstream`、`upstream`、`infrastructure`、`unknown`。模型给出取值，代码在结论阶梯之后按确定性依据校正（`research/validate.ts` 的 `correctCauseScope`），写进 `conclusion.cause_scope`，每次改写写一条 `validation_notes`：

1. 档位为 `undetermined` 或没有选中根因：`unknown`；
2. 研判根因在处置依据的 `external` 中（领域包声明的集群外部组件）：`upstream`；
3. 研判根因不由 GitOps 仓库负责，而模型给出 `local` 或 `configuration`：`unknown`。

"由仓库负责"是处置依据新增的 `repository_owned`（`remediation/facts.ts` 的 `repositoryRoots`）：`declared` 的全部组件，加上管理着候选根因的 GitOps 应用，以及展开到由 GitOps 应用管理的工作负载的逻辑组件。`declared` 为 act 的依据（ADR 0162）排除了应用与逻辑组件，因为发现根因是它们时事件由一次变更引起，回退还是向前修复要由模板或人决定；准入要回答的是修改是否落在仓库负责的对象上，发布与清单的变更正是经这些应用从仓库生效的，发布回退模板的根因本来就是应用或逻辑组件（ADR 0139）。只用 `declared` 会让发布回退永远不能准入，所以准入用 `repository_owned`，`declared` 的含义不变。

模型的取值不能把范围扩大到仓库负责的组件之外；校正只会把范围改为 `upstream` 或 `unknown`，不会改为 `local` 或 `configuration`。

#### 上下文小的路由上的 conclude 请求

conclude 的请求在上下文 16k 的路由上（本地部署的模型）留给输入的只有上下文减去输出上限 8000 的部分，约 8.4k token。裁剪（ADR 0099）估算的是整个请求体：固定指令、可移植 schema（不支持严格 json_schema 的路由写在系统提示里，按 JSON 转义之后的字节计）、目录、事件概要、成员告警、账本与任务说明都计入，但只有证据卡、知识、参考案例、变更与拓扑可以裁剪。告警少、证据卡少的事件里可裁剪的内容很少，请求能否放下取决于不裁剪的部分。

`cause_scope` 的字段定义在 json_object 路由上约占 330 token。conclude 的固定部分按"同一条要求只写一处"组织：

- `cause_scope` 各取值的含义写在 schema 中这个字段的 `description` 里；任务说明写明代码按处置依据校正取值、只有 `local` 与 `configuration` 开 PR，校正规则只在本节第 1 条与代码里；
- 字段的取值规则写在任务说明里：`hypothesis_id`、`situation`、`summary`、`recommendations`、`runbook_ref`、`action_id` 在 schema 里没有 `description`；`params_json` 的 `description` 只写任务说明之外的"目标由代码推导"；
- 动作与目标的限制写在系统提示的"边界"里，任务说明的 `proposals` 条目只写 `params_json` 与 `expected_effect`；
- 契约 schema 根上的 `description` 是写给契约读者的说明（引用 DESIGN 与 ADR 的章节），`bindSchema` 生成发给模型的可移植 schema 时去掉它，四个模型 schema 都适用；
- 可用动作目录里的参数 schema 在提示词里去掉字符串的长度上下限（Kubernetes 名字的 1–63、1–253），枚举、数值范围、格式与说明照写；提议按动作目录中完整的参数 schema 校验（`research/validate.ts`），网关执行前再校验一次。

worker 端到端的兜底路由场景（6 个可用动作、3 个假设、没有证据卡，json_object 路由）里，conclude 的估算是 7911 token，余量 473；严格 json_schema 的本地路由场景（worker-e2e）是 7631 token，余量 753。六个假设的账本在 16k 路由上裁剪之后放得下，由 `test/unit/research-context-budget.test.ts` 检查。

### 2. ignore 的依据写进研判输出

研判输出增加可选字段 `ignore_basis`：处置为 ignore 时成立的依据（`stage_a`、`planned_retirement`、`external`、`evidence_normal`、`impact_normal`，ADR 0138、0167、0168），由处置推导直接给出。告警调优的准入按它判断，不从备注文字里解析。

### 3. 准入条件

发布回退与配置资源（`alert_rule` 以外的类别）修改系统本身，四项同时满足才开 PR：

| 条件 | 判断时机 | 跳过代码 |
|---|---|---|
| `cause_scope` 为 `local` 或 `configuration` | 模板匹配之前，按研判 | `cause_scope` |
| 选中假设有支撑卡，不只是成员告警与变更 | 同上 | `topology_only` |
| 支撑卡中至少一张的查询是运行时证据：能力族为 metrics、logs、dbstats，或只读工具 `kube_*` | 同上 | `no_runtime_evidence` |
| 补丁修改的文件在基线上都存在（`before` 非空），研判根因由仓库负责 | 计划校验之后，按模板 | `no_repo_fact` |

告警调优（`alert_rule`）修改的是告警规则本身，根因在哪里与它无关。它只要求处置为 ignore，并且依据说明系统状态正常：`stage_a`（抑制、领域包排除、只有预测类与长期告警）、`evidence_normal` 或 `impact_normal`；不满足时跳过代码为 `not_benign`。`planned_retirement` 的告警如实反映了一次计划中的变更，`external` 的告警如实反映了上游故障，都不是告警过于敏感，不降级。领域包模板 `noisy-alert-relax` 的长期告警分支因此只在研判判为 ignore 时生效。

支撑卡取 `consistency_detail` 的 `support_refs` 与 `model_judged_refs` 的并集：Kubernetes 只读检查的结果由小模型判定，记在后者，它正是运行时证据的一种。链路（traces）、变更（changes）与其他只读工具的卡不算运行时证据：前两者说明调用与变更的关系，不说明根因上的状态；其他工具的输出没有统一的语义。

卡的引用按研判运行时的证据解析（`remediation/admission.ts` 的 `resolveCards`）：检查产生的卡取输出的 `check_cards`；其余是运行开始时的阶段 A 卡，按 `evidence_index` 的 `<卡片>@<实体>` 在研判针对的事件版本的阶段 A 报告里找。阶段 A 重算会改变编号，按编号会指到另一张卡。找不到的引用不算运行时证据。

仓库事实要看补丁计划，放在计划校验之后。研判根因是否由仓库负责在提交时按当前拓扑重新求值，求值的键是研判根因、事件根因、候选根因与事件组件（研判时还包括两跳邻域，那里的应用只用于排除，不影响这几个键的结果）。研判时的根因范围已经按同一个规则校正过，这里再判断一次，覆盖研判之后拓扑变化的情况。

### 4. 记录

按运行的两类都不满足时整次研判记一行（key `-`），原因码取 `alert_rule` 以外那一类，原因写两类各自的说明；只有一类不满足时，适用的模板中这一类的各记一行跳过，另一类照常处理。没有根因范围的研判输出（契约 2.38.0 之前结束的研判）按 `cause_scope` 跳过。

跳过的原因原本只在 `server.remediation_attempts` 里。现在同时写进：

- 治理审计 `remediation.attempt` 的 `reason`；
- 指标 `srenautix_remediations_total` 增加标签 `code`（原因码，没有时为 `none`；取值来自固定的原因码与领域包的跳过码，数量有限）；
- 控制台的事件时间线：`timelineOf` 为每条处理结果给出 `remediation_attempt`（契约 2.38.0 的 `TimelineEntry.kind`），文本为模板、结果、原因码与原因，`ref` 为研判的 run_id。原因里有告警名、标签值等外部来源的原文，按不可信文本显示。

没有开出的修复仍然在研判的修复建议与事件 issue 里，人可以照建议修改。

### 5. 评测

重建评测按每次运行的研判输出计算同一组运行级准入结果（`RunRecord.admission`，卡按快照的阶段 A 卡与检查卡解析）。模板匹配的统计只计准入的模板，被挡下的模板与原因码记在 `template_matches[].blocked`，报告里单列一栏。仓库事实要读仓库，重建评测不判断。

## 结果

- 契约 2.38.0：`contract/model/conclude.schema.json` 的 `cause_scope`；`research-output.schema.json` 的 `Conclusion.cause_scope`、`CauseScope` 与 `ignore_basis`；`eval-snapshot.schema.json` 的 `DispositionFacts.repository_owned`；`openapi.yaml` 的 `TimelineEntry.kind` 增加 `remediation_attempt`。
- 实现：`research/validate.ts`（`correctCauseScope`）、`research/controller.ts`（写入 `cause_scope` 与 `ignore_basis`）、提示词（`prompts/zh.ts`、`prompts/en.ts` 的 conclude）、`llm/schema.ts`（可移植 schema 不带根上的说明）、`research/prompt.ts`（`paramsView`）、`remediation/facts.ts`（`repositoryRoots`）、`remediation/admission.ts`、`remediation/service.ts`、`metrics.ts`、`console-bff/routes-incidents.ts`、`eval/{runner,score,remediation,phase2}.ts`、`packages/ui` 的时间线与中英文案。
- 测试：
  - `test/unit/remediation-admission.test.ts`：根因范围的三条校正与不改写的情形；运行时证据的判断；按证据索引与检查卡解析引用；四项条件与告警调优的良性依据逐项；
  - `test/unit/research-context-budget.test.ts`：六个假设的账本在上下文 16k、json_object 的路由上，可裁剪的片段全部裁掉之后，conclude 的估算不超过上下文减去输出上限；动作参数 schema 在提示词里的写法；
  - `test/integration/worker-last-resort.test.ts`、`worker-e2e.test.ts`：上下文 16k 的路由上 conclude 完成；
  - `test/unit/research-disposition.test.ts`：`repository_owned` 包含管理着候选根因的应用（两种写法）与逻辑组件，`declared` 不变；
  - `test/integration/remediation.test.ts`（真实 PostgreSQL、Prometheus 与内存中的 GitHub）：每项条件不满足时的跳过代码、原因、审计、指标与时间线；阶段 A 重算改变编号后仍按证据索引找到支撑卡；仓库文件里声明、但没有管理它的 GitOps 应用的工作负载按 `no_repo_fact` 跳过，补丁已经计划；告警调优、去重与冷却按新的准入照常工作；
  - `test/integration/eval-reconstruct.test.ts`：被准入挡下的模板不计入模板触发，记在 `blocked` 里；
  - Kind 的发布回退、配置资源与告警调优场景的录制带上 `cause_scope`，仍然开出 PR。
