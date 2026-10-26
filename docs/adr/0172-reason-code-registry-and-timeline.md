# 0172 终态原因码登记表与事件时间线

## 背景

一个事件从告警到结束会经过很多终态：阶段 A 出报告或失败，研判给出结论、失败、只出阶段 A 或在入队时被跳过，通知送达、被拒绝或决定不推送，事件 issue 开出或跳过，事件恢复、重开或被抑制。这些终态散落在不同的表、日志与指标里：

- 事件时间线只有告警、变更、卡、合并与拆分、阶段 A、研判结论、自愈 PR、提议、执行与反馈。研判失败与只出阶段 A、入队跳过、阶段 A 失败、通知的送达与放弃、不推送的决定、issue 的结果、事件的恢复、重开、抑制与写入失败都看不到；
- 自愈 PR 的原因码写在时间线的文本里，控制台与外部调用方只能解析文字；
- 原因码的取值在各模块里各自定义（研判的失败类型与停止原因、入队的跳过原因、通知放弃的原因、自愈 PR 的跳过代码），没有一张表说明每个值是什么意思、是否正常；
- 带原因的指标（`srenautix_notify_abandoned_total`、`srenautix_incident_persist_errors_total` 等）没有告警规则，一个反复出现的失败只留在日志里。

目标是没有静默的失败：每个终态都有一个登记过的原因码，进入时间线与指标，不正常的终态会告警。

## 决定

### 1. 原因码登记表

`contract/reason-codes.json`（schema 为 `contract/schemas/reason-codes.schema.json`）登记全部原因码。每个原因码有：

- `stage`：notify、stage_a、research、remediation、issue、incident；
- `code`：同一阶段内唯一，不同阶段可以同名（研判的 `no_change` 是停止原因，自愈 PR 的 `no_change` 是补丁没有改动）；
- `level`：info 为正常的终态；warning 为需要留意、已有其他条件或告警覆盖的终态（预算、熔断、跳过、策略拒绝）；error 为不应发生、需要人处理的终态（阶段 A 失败、研判内部错误、模型输出无效、租约过期、放弃投递、事件写入失败、模板求值出错）；
- `text`：中英文说明，写成能接在“原因：”之后的短语，时间线、群消息的说明行与控制台都用它；
- `groups`：所属的分组。分组对应代码或契约中的一个取值集合：研判失败类型（`ResearchFailed.kind`）、停止原因（`stop_reason`）、入队跳过原因、通知放弃的原因、渠道永久错误、不推送的原因、修复模板的跳过代码、自愈 PR 的准入条件与去重结论等。同一个取值在两个集合里含义相同时只登记一次，属于两个分组（例如研判的 `deadline` 既是失败类型也是停止原因）。

`packages/contract` 的生成脚本按登记表生成按阶段（`ReasonCodesByStage`）与按分组（`ReasonCodesByGroup`）的字面量联合类型与数据；(stage, code) 重复、分组不存在或分组的阶段与原因码不同时生成失败。各模块的取值类型改为引用生成的类型（`FailureKind`、`StopReason`、`PermanentReason`、`AbandonReason`、入队的 `SkipReason`、packs-sdk 的 `SkipCode`、自愈 PR 的 `AdmissionCode` 与原因码），写一个没有登记的值是类型错误。从库里或外部读出的原因码经 `reasonEntry` 查表，没有登记时抛出。

契约测试校验：登记表符合自己的 schema、生成的数据与文件相同、每个分组至少一个原因码；`research_failure` 与 `ResearchFailed.kind` 的枚举相同，`research_stop` 与研判输出、研判运行、主动优化输出的 `stop_reason` 枚举相同；通知放弃的原因是渠道永久错误加上 `ended_edit_cap`。

### 2. 终态存在哪里

已有表承载的终态不搬家：研判的失败类型在研判镜像的 `error.kind`，停止原因在研判输出，入队跳过与被取代在 `server.research_queue`，自愈 PR 的原因码在 `server.remediation_attempts.code`。其余终态写进新表 `server.incident_reasons`：

- 事件、事件版本（有时）、阶段、原因码、说明（错误摘要、抑制原因、渠道应答等，最多 1000 字）、关联对象（渠道与渠道目标、issue 地址等）、时刻；
- `once_key` 不为空时同一事件、同一阶段、同一原因码、同一 `once_key` 只写一次（部分唯一索引）：不推送的决定每个事件每种原因一次，不进入阶段 B 与事件状态的变化每个版本一次，送达每个渠道目标一次，放弃每个消息的每一版内容一次；阶段 A 的每次失败都写；
- 级别不存库，读出时按登记表，调整级别不需要迁移数据。

### 3. 写入点

| 阶段 | 原因码 | 写入处 |
|---|---|---|
| stage_a | `stage_a_failed`、`stage_a_missing` | 事件流水线（ADR 0173） |
| research | 失败类型 | worker 的 `research.failed` 进入研判镜像时 |
| research | `lease_expired` | 认领时回收租约过期次数超过上限的任务，同时写研判镜像 |
| research | `budget`、`storm`、`capped`、`no_model_route`、`superseded`、`not_researched` | 准入 |
| remediation | 全部 | 自愈 PR 的处理结果 |
| notify | `delivered`、`final_edit`、放弃的原因、`withheld_*` | 通知引擎 |
| issue | `opened`、`external_root`、`rate_limit`、`failed` | 事件 issue |
| incident | `resolved`、`reopened`、`suppressed`、`persist_failed` | 事件引擎 |

每处写入同时计数 `srenautix_terminal_states_total{stage,code,level}`；在事务里写入的在提交后计数，重复投递（同一个研判结果、once 冲突）不计数。登记表中的每个原因码启动时导出 0，第一次出现也能被 `increase()` 看到。

几处取舍：

- **研判镜像的状态取 worker 写入的值**：`research.failed` 增加可选的 `state`（契约 2.39.0）。出站策略禁用全部路由时 worker 的失败类型是 `model_unavailable`、状态是只出阶段 A，同一个失败类型在模型调用中途失败时状态是失败，只看失败类型推不出状态。契约 2.39.0 之前的 worker 不写 `state`，这时按失败类型推出（`breaker_open`、`budget_exhausted` 为只出阶段 A）。
- **租约过期由 server 判定**：worker 没有机会报告，server 在回收时把研判镜像写成 `failed`、`error.kind` 为 `lease_expired`，通知立即同步，群消息出现研判失败的说明；worker 之后仍发出结束事件时镜像按 worker 的结果覆盖。
- **不进入阶段 B**：严重度不在研判范围、被抑制或已合并的版本每个写一条，说明写明是哪一种，时间线能回答“这个事件为什么没有研判”。
- **事件被抑制**：说明写抑制的原因，命中状态库的抑制规则时取最早创建的那条规则的 `reason`，只被告警源静默时写“告警源静默”；恢复与重开在写入版本时判定。
- **事件写入失败**：保存点回滚之后，在同一个事务里为组内每个事件写一条 `persist_failed`（同一个要写入的版本一次），事件之后写入成功时时间线上仍能看到这次失败。事件第一次写入就失败时，记录先于事件存在。

### 4. 群消息的说明行

研判失败、只出阶段 A 与入队跳过的说明行写原因码的说明，例如“模型研判失败：模型输出无效，以下为确定性报告”“只出确定性报告：当日模型预算达到研判上限”；worker 的原始错误信息留在研判明细与时间线里。消息里停止原因的说明同样取登记表。失败的研判镜像没有失败类型时抛出（研判镜像的写入方总是写失败类型）。

### 5. 事件时间线

`TimelineEntry` 增加必填的 `code` 与 `level`（没有原因码的条目为 null），条目种类增加：

- `stage_a_missing`：阶段 A 的每次失败（带错误摘要）与补跑次数用完；
- `research_ended`：失败与只出阶段 A（失败类型）、入队跳过、被取代、不进入阶段 B，`ref` 为 run_id；
- `notify`：送达、最后一次编辑、放弃与不推送，说明带渠道目标；
- `issue`：开出、跳过与重试用尽；
- `incident_state`：恢复、重开、被抑制与写入失败。

`research_concluded` 带停止原因，`remediation_attempt` 的原因码改为结构化的 `code`，文本只留模板、结果与说明（提出了提议时为 null）。条目种类决定原因码所属的阶段，`timelineOf` 按它查级别，带原因码的种类没有阶段时抛出。说明里有错误信息或渠道应答原文的条目按不可信文本显示。

控制台的时间线在说明之前显示原因码与级别（正常、留意、异常），级别为留意与异常的记录按级别着色。原因码的说明由 server 写在 `text` 里，控制台的文案只有条目种类与级别。

### 6. 告警

- `SreNautixAbnormalTerminalStates`：level 为 error 的原因码 15 分钟内增加 3 次以上，标签带 stage 与 code。阈值取 3：单次失败多数由补跑或重试自行恢复（阶段 A 的一次失败之后有 3 次补跑），3 次以上说明是持续的问题；补跑次数用完时同一版本已经累计 4 次失败，必然触发。
- `SreNautixNotifyAbandoned`、`SreNautixIncidentPersistErrors`：增加即告警。放弃投递的内容不再重试，事件写入失败的事件停在写入之前的版本，都需要人看；`srenautix_notify_abandoned_total` 启动时按渠道与原因导出 0。

## 结果

- 契约 2.39.0：`contract/reason-codes.json` 与 schema、`packages/contract` 生成的原因码类型与数据（`reasonEntry`、`reasonText`）、`TimelineEntry.code`、`level` 与新的条目种类、`ResearchFailed.state`、状态条件 `NotifyAbandoned`（ADR 0173）。
- 迁移：`incident` 轨道版本 7，新建 `server.incident_reasons`，只增不删。
- 实现：`incident/reasons.ts`、`incident/{engine,pipeline}.ts`、`scheduler/{admission,worker-events}.ts`、`research/{controller,service}.ts`、`notify/{engine,compose,source,channel,store}.ts`、`github/issues.ts`、`remediation/{service,admission}.ts`、`console-bff/routes-incidents.ts`、`metrics.ts`、`roles/server.ts`；packs-sdk 的 `SkipCode`；控制台 `TimelineLane` 与中英文案；chart 的自身告警规则。
- 测试：契约测试（登记表与枚举）；`test/unit/reason-codes.test.ts`（指标启动时导出、级别）；`test/unit/notify-reason-lines.test.ts`（每种失败类型与跳过原因的说明行）；`test/integration/incident-timeline.test.ts`（每种新条目的原因码与级别、租约过期写镜像并计数、不进入阶段 B 每个版本一次，响应符合契约）；`research-reason-mirror.test.ts`（镜像状态与 worker 一致、重复投递不重复计数）；`incident-suppression.test.ts`（抑制、恢复带原因的记录）；`notify-planned-retirement.test.ts`、`notify-external-digest.test.ts`、`stage-a-missing.test.ts`（不推送的决定）；helm 单元测试与 promtool 规则测试（`ci/rules/terminal-states.test.yaml`）。
