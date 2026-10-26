# 0169 变更与事件关联的确定性分级

## 背景

变更进入事件只有一条路径：收敛时 `changeExplains` 给出告警与变更之间 0–1 的关联置信度，达到归并阈值就把两者并到一个分组（ADR 0104、0140、0142、0161）。并查集合并之后这个数值就丢掉了，`Incident.changes` 只列出变更本身，看不出它为什么在事件里、关联有多强：

- 根因排序的"近期变更"一项只看时间，取 0 或 1。直接作用在异常组件上、之后那里出现新症状的发布，与只是同一时段、经拓扑可达的发布得分相同；
- 阶段 A 的时间线、阶段 B 的变更片段、通知与控制台都只列出变更，研判看不到关联依据；
- 研判可以把根因归到一次只经命名空间或拓扑关联的变更上，结论阶梯（ADR 0083、0134）只看证据卡与告警，不看变更与事件的关系，这样的结论也能到 likely；
- 回退只在通知渲染时计算（`notify/compose.ts`），研判与控制台看不到。

## 决定

### 1. 分级在 core 中计算

`packages/core/src/change-grade.ts` 的 `changeLinks(group, graph, params)` 为分组里的每个变更（`group.changes` 与只因"已合并、尚未同步"列进来的 `group.pendingChanges`）计算一条 `ChangeLink`。`computeIncidents` 在排序之前调用它，结果放进 `ComputedIncident.links`，并传给 `rankRoot`；服务端的事件引擎与重建评测都经 `computeIncidents` 得到同一结果。

**时间条件**（`changeTimed`，与 `changeExplains` 共用）：告警在变更之后的变更窗口内开始，并且告警所在组件的问题开始不早于变更 10 分钟以上（ADR 0142 的容差）。

**关联依据**（`basis`，按下列顺序，不重复）：

| 依据 | 条件 |
|---|---|
| `component_match` | 满足时间条件的成员告警，组件就是变更目标所属的组件（含作为其他目标管理应用的组件）；或没有对象锚点的告警按"落在变更自己的目标上"归到变更 |
| `acts_on` | 满足时间条件的成员告警落在变更作用对象上：变更中按强依据（`managed_by`、`revision_label`、`image`）挂上的 Job、或一次性 Job 自成的变更，经 `egress_to` 访问的组件（`actsOn`，ADR 0140）。按 `namespace_window` 挂上的 Job 不产生作用对象 |
| `topology_reach` | 满足时间条件、没有直接作用的成员告警，沿置信度不低于归并阈值的边可达变更目标（路径置信度不低于归并阈值；作为其他目标管理应用的组件不算） |
| `namespace` | 没有对象锚点的告警按同一命名空间归到变更（ADR 0104） |
| `logical_owner` | 没有对象锚点的告警按逻辑归属归到变更：与已经归到变更的告警逻辑归属相同，或者是变更类告警、按变更有影响归到它（流水线告警没有对象，它的逻辑归属就是这次变更） |
| `retire_scrape_job` | 告警报的抓取 job 随这次退役失去全部目标（ADR 0161）；满足时间条件时同时算作直接作用 |
| `pending_sync` | 已合并、尚未同步的提交落在告警所在的应用上（ADR 0161） |
| `late` | 变更晚于它自己目标上已经开始的问题（`lateChange`，ADR 0142） |

没有对象锚点的告警归到哪次变更、按哪条规则，由收敛时的 `changeTargets` 一并给出，记在 `PreparedAlert.attachedTo`。forecast 告警不参与。

**新信号**：角色为 `symptom` 或 `cause` 的成员告警，落在变更的目标上（组件就是变更目标所属的组件、是变更的作用对象，或报退役带走的抓取 job），开始时刻不早于变更时刻。`change`、`meta`、`forecast` 角色不算：变更类告警报的是变更本身，meta 报观测缺口，都不说明变更之后出现了异常。

**分级**：

- `high`：有满足时间条件并且直接作用（`component_match`、`acts_on` 或 `retire_scrape_job`）的成员告警，并且至少有一条新信号；
- `medium`：没有达到 high，但有满足时间条件的直接作用（没有新信号），或满足时间条件、只经拓扑可达；
- `low`：其余情况，即只经 `namespace`、`logical_owner`、`pending_sync` 关联，或依据含 `late`（晚到的变更即使之后目标上又有新告警，也是 low）。

`new_signals` 只在 high 时列出支撑它的成员告警 id（排序），其余为空。

退役变更的收敛与候选（ADR 0161、0167）不变：抓取 job 消失的告警通常是 meta，所以计划内退役的分级是 medium，报这个 job 的症状告警会让它成为 high。

**回退**（`isRollback`）：变更的 `revision` 等于事件中更早一次变更的 `previous_revision`，`previous_revision` 等于那次变更的 `revision`。判定从通知移到 core，结果写进 `ChangeLink.rollback`。

### 2. 存储（契约 2.37.0）

- `Incident.change_links`（可选）：`ChangeLink[]`，顺序与 `changes` 相同；`ChangeLink` 与 `ChangeGrade` 定义在 `incident.schema.json` 的 `$defs`。新算出的事件总有这个字段（没有变更时为空数组）；之前版本算出、之后没有再重算的事件没有。分级变化不让 `incident_version` 加一，与 `changes` 相同。
- `ChangeEvent.paths`（可选）：GitHub 变更源在提交改动的文件命中路径前缀时写入命中的 `paths[].prefix`，按配置顺序。它只用于展示，目标已经由这些前缀映射得出，分级不读它。
- `TimelineEntry.change_link`（可选）：控制台时间线中 kind 为 `change` 的记录带上这个变更的关联记录。

### 3. 根因排序

`rankRoot` 的近期变更一项按分级取值：high 1、medium 0.5、low 0.2。作用对象（ADR 0140）取分级的值乘访问边的置信度；有 `change` 角色告警的候选仍取 1（告警本身报的就是变更）。多项取最大值。`rankRoot` 的调用方可以传入 `links`，省略时按分组计算。

### 4. 展示

- 阶段 A 时间线：变更行在计划说明之后写"关联分级 <grade>（依据：…；回退）"，GitHub 变更再写命中的路径。
- 阶段 B 的变更片段：每个变更带 `grade`、`basis`、`new_signals`（成员告警的引用 `alert:N`）、`rollback`；不在事件里的相关变更为 low、依据为空；事件没有分级时不带这几项。中英两套 system 提示词说明分级的含义、分级由代码计算、把根因归到变更上时受分级约束。
- 通知：时间线与全文的变更清单在变更标题后写分级与依据；"发布"与"回退到"读 `ChangeLink.rollback`。事件没有关联记录时按同一个 `isRollback` 对事件的变更计算，旧事件的消息照常写出回退。
- 控制台：事件详情时间线的变更记录显示分级、依据与回退（`packages/ui` 的 `ChangeLinkPill`，中英文案）。

### 5. 结论档位上限

`research/change-cap.ts` 的 `changeCap` 在 `controller.ts` 中紧接最低取证集合的限制（`requiredCap`，ADR 0153），在处置推导（`deriveDisposition`）之前执行。选中的假设把根因归到变更上时适用，三种情形任一成立：

1. 根因是发布的逻辑组件（`component:release`，或带命名空间的 `component:<命名空间>/release`）：证据簿里的全部变更都对应它；
2. 根因是管理变更目标的 GitOps 应用：子图里有变更目标（或它的顶层属主）到根因的 `managed_by` 边，或根因是变更 `refs` 中的应用；对应它管理的目标上的变更；
3. `supporting` 引用了 `change:N`：对应被引用的变更。

对应的变更中最高分级是 high 时不限制；是 medium 或 low，或者没有对应的变更时，likely 与 evidence_consistent 改为 inconclusive，`validation_notes` 写明每个对应变更的引用、change_id、分级与缺少的条件（没有新信号、只经拓扑可达、晚于问题开始、不满足时间条件、只经弱依据关联、不在事件里）。证据簿中不在事件里的相关变更（`book.related`）一律按 low。档位已经是 inconclusive 或 undetermined 时不变。

事件没有 `change_links`（之前版本算出）时无法知道分级，不限制，`validation_notes` 记一条说明。事件里的变更在 `change_links` 中找不到记录时直接报错：两者由同一次计算写入，缺少说明数据不一致。

## 取舍

- **退役带走抓取 job 算直接作用**：抓取 job 不是拓扑对象，但退役正是让它失去目标的动作，告警的对象就是变更作用的对象。把它当作弱依据会让每次退役都是 low，计划内退役（ADR 0167）与"退役后另一组件报缺数据"无法区分。
- **新信号只认 symptom 与 cause**：变更类告警（迁移 Job 失败、流水线失败）证明变更执行出了问题，并不证明它造成了业务异常；这类事件的根因在变更自身，高分级要求目标或作用对象上出现异常告警。
- **只经拓扑可达是 medium**：可达说明有依赖关系，但症状落在依赖方，变更目标本身没有异常时，变更与症状之间缺少直接的一环；结论阶梯不能只凭这种关联确认变更是原因。
- **变更类告警的候选在排序中仍取 1**：近期变更一项衡量的是"候选上有变更"，变更类告警本身就是变更发生的直接证据，与 ChangeEvent 的关联分级是两件事。
- **没有对应变更的发布根因也受限**：发布逻辑组件作为根因时，结论说的是"这次发布造成了事件"；事件与证据簿里都没有可对应的变更，就没有任何依据支撑它到 likely。

## 结果

- 实现：`packages/core/src/{change-grade,converge,rank,incidents}.ts`；`apps/srenautix/src/research/{change-cap,controller,prompt}.ts`、`prompts/{zh,en}.ts`、`stage-a/report.ts`、`notify/compose.ts`、`console-bff/routes-incidents.ts`、`changes/github.ts`；`packages/ui` 的 `TimelineLane` 与中英文案；契约 2.37.0。
- 测试：
  - `packages/core/test/change-grade.test.ts`：high（组件相同、cause 角色、落在管理应用上、强附着的 `acts_on`）；medium（只经拓扑可达、目标上只有 change 或 meta 告警）；low（可达置信度低于归并阈值、`namespace_window` 附着、窗口外开始、late、namespace、pending_sync）；`logical_owner` 与 high 并存；退役的 medium 与 high；回退；`change_links` 与 `changes` 顺序相同；近期变更按分级取值与作用对象乘访问边置信度；
  - `apps/srenautix/test/unit/change-cap.test.ts`：引用 high 不限制，medium、low 各种缺少条件的说明，相关变更按 low，GitOps 应用与发布逻辑组件两种根因，不归到变更上与档位已经较低时不变，旧事件不限制；变更片段的分级字段；
  - `test/integration/research-replay.test.ts`：同一段录制的研判，h1 引用变更，变更为 medium 时结论为 inconclusive 并写明原因，为 high 时保持 likely；
  - 阶段 A 时间线、通知渲染、控制台时间线与 GitHub 变更源的 `paths`。
