# 0173 阶段 A 补跑、没有阶段 A 时的消息与群消息的最后一次编辑

## 背景

部署方的并行期出现了两类群消息问题。

**阶段 A 缺失。** 事件流水线的一轮里，对版本有变化的事件逐个执行阶段 A。循环中任何一次抛错，这一轮剩下的事件都没有报告，只留一条日志；之后没有任何补跑，领域包变化后的重算只扫已经有报告的事件。通知的期望消息内连接阶段 A 报告，没有报告的事件没有群消息，要等到下一次版本变化（往往是恢复）。几个事件因此长时间没有阶段 A，一个 critical 子事件在结束之后才发出消息。

**群消息停在旧内容。** 已结束事件的消息最多再编辑 5 次，计数包括被渠道拒绝的编辑。用完后放弃这一版内容；期望内容再变化时放弃被清除，但计数保留，于是每次都立即再次放弃，群里永远停在旧内容。放弃的消息不算投递失败，`srenautix_notify_abandoned_total` 没有告警，没有人知道。

## 决定

### 1. 每个事件的阶段 A 单独执行

流水线对本轮每个版本有变化的事件单独执行阶段 A。某个事件的阶段 A 抛错时：

- 写一条终态记录 `stage_a_failed`（ADR 0172），说明为错误的类型与信息，计入 `srenautix_terminal_states_total`，记一条 error 日志；
- 这个事件这一轮不进入阶段 B 准入（研判需要阶段 A 报告），本轮其余事件照常执行。

状态库连接错误照常抛出：这时写记录同样会失败，交给流水线的降级通道处理。失败没有被吞掉，它进入记录、指标与告警（`SreNautixAbnormalTerminalStates`），补跑负责恢复。

### 2. 补跑

每轮流水线在处理完本轮的新版本之后，查找当前版本超过 60 秒没有阶段 A 报告的事件并重新执行阶段 A：

- **期限**：从当前版本写入的时刻（事件的 `updated_at`）算起 60 秒，与阶段 A 首次触发到发出的期限相同；
- **范围**：不含 merged；已结束的事件只看 6 小时内更新过的（与研判次数上限的窗口相同），不为很久以前的事件补算；
- **顺序与数量**：critical 在前，再按版本写入的先后，每轮最多 5 个。补跑排在新版本之后，持续失败的旧事件不会挡住新事件的阶段 A；
- **成功后**：照常按触发原因准入阶段 B，重开的版本（版本原因为 reopened）按 reopened 准入；
- **次数上限**：补跑的失败记为 `stage_a_failed`、关联对象为 `retry`。同一版本补跑失败 3 次后写 `stage_a_missing`（同一版本一次），不再补跑。事件有了新版本时按新版本重新计算。

一个版本从首次失败到 `stage_a_missing` 累计 4 次 `stage_a_failed`，`SreNautixAbnormalTerminalStates` 必然触发。

### 3. 没有阶段 A 时的消息

期望消息外连接阶段 A 报告。没有报告的事件只在两种情况下有消息：

- critical、仍在触发，并且首个成员告警进入 Alertmanager 已经超过 60 秒（成员告警都不来自 Alertmanager 时从事件创建时刻算）。计时从 Alertmanager 起算，与首条消息时延的 `clock="alertmanager"` 口径相同：用户感受到的是“告警已经在 Alertmanager 里，群里还没有消息”；
- 已经有消息的事件，继续编辑。

warning 不先发：没有证据卡的 warning 消息信息量很少，会增加群里的噪声，warning 等阶段 A 或下一次版本变化。

这条消息照常有标题、现状、时间线、根因候选与拓扑联系，不带证据卡、处置行与处置反馈按钮，横幅为“阶段 A 尚未生成：原因”。原因取当前版本最近一条阶段 A 记录：没有记录时为“阶段 A 仍在执行”，`stage_a_failed` 时为它的说明加错误摘要（最多 200 字），`stage_a_missing` 时为补跑次数用完。阶段 A 生成后期望内容变化，消息照常编辑为完整报告。外部上游的汇总与业务影响判定对没有报告的事件按没有影响卡处理。

### 4. 已结束事件的编辑上限与最后一次编辑

- **只计成功的编辑**：事件结束后对消息成功编辑的次数计入 `ended_edits`；被拒绝、不可达与限流的尝试按原来的规则重试，不消耗次数。
- **最后一次编辑**：成功编辑满 5 次后期望内容再变化时，同步把这一版渲染成最后一次编辑的内容：保留标题、头条、现状与关键问题两节，现状末尾加一行“消息停止更新（原因：编辑次数达到上限），完整内容见控制台”与事件的控制台链接，按钮只留打开控制台（之后的点击与进展不会再反映到这条消息里）。消息变短，渠道的长度与实体预算照样适用。
- **之后**：最后一次编辑成功时记 `final_edited_at` 与终态记录 `final_edit`，这条消息之后不再投递，期望内容变化也只更新库里的期望状态。
- **放弃**：最后一次编辑被渠道拒绝时才放弃，原因为 `ended_edit_cap`：永久错误先按纯文本重试一次，仍被拒绝时放弃；其他 4xx 直接放弃。这种放弃在事件仍是已结束时保留，内容再变化也不重试，避免对同一条消息反复请求被拒绝的编辑。
- **事件重新触发**：编辑计数、`final_edited_at` 与 `ended_edit_cap` 的放弃都清除，消息照常编辑。
- **已有数据**：ADR 0173 之前的版本写下的 `ended_edit_cap` 放弃没有尝试过最后一次编辑，由数据修正 `notify/ended-edit-cap-final-edit` 在新版本取得主实例之后清除（ADR 0176），只清除没有终态记录的放弃；渲染器版本加一，这些行按当前代码重新渲染为最后一次编辑的内容。

### 5. 放弃的可见性

- 状态条件 `NotifyAbandoned`（server，subject 为渠道）：最近 1 小时内这个渠道有放弃的消息内容时成立，消息写明条数与原因。窗口取 1 小时：放弃本身不会自行消失（直到内容再变化），按“仍处于放弃状态”判定会让条件一直成立；1 小时足够让 `SreNautixConditionActive`（持续 10 分钟）告警，之后没有新的放弃时条件恢复。
- `SreNautixNotifyAbandoned`：`srenautix_notify_abandoned_total` 增加即告警，标签带渠道与原因（ADR 0172）。
- 事件消息的每次放弃、每个渠道目标第一次送达、最后一次编辑都写终态记录，进入事件时间线。

## 结果

- 迁移：`notify` 轨道版本 4，`server.notify_messages` 增加 `final_edited_at`；只加列，N-1 版本照常运行。已有的 `ended_edit_cap` 放弃由取得主实例之后的数据修正清除（ADR 0176）。渲染器版本 2。
- 实现：`incident/pipeline.ts`（`report`、`retryMissing` 与常量 `STAGE_A_RETRY_AFTER_MS`、`STAGE_A_MAX_RETRIES`、`STAGE_A_RETRIES_PER_ROUND`、`STAGE_A_RETRY_LOOKBACK_MS`）；`notify/source.ts`（外连接、`STAGE_A_MISSING_NOTIFY_MS`、`withheld`）；`notify/compose.ts`（`stageA` 可为 null、说明行、`finalMessage`）；`notify/engine.ts`、`notify/store.ts`（最后一次编辑、只计成功的编辑、放弃的记录）；`console-bff/conditions.ts`、`roles/server.ts`（`NotifyAbandoned`）。
- 测试：
  - `test/integration/stage-a-missing.test.ts`（真实 PostgreSQL，阶段 A 的写入失败以触发器注入）：一轮中某些事件的阶段 A 抛错，其余事件照常出报告并进入阶段 B，失败写进记录并计数；期限之前不补跑；critical 事件在 Alertmanager 中 60 秒后先发不带证据卡、带说明行的消息，warning 与不到 60 秒的不发；补跑成功后进入阶段 B；补跑失败 3 次后记 `stage_a_missing`、计数并不再补跑；时间线的条目与级别；阶段 A 生成后消息编辑为完整报告；
  - `test/integration/notify-stale-desired.test.ts`：成功编辑满 5 次后的最后一次编辑（精简内容、说明行、控制台链接、只留打开控制台的按钮），之后不再请求渠道，重新触发后清零；最后一次编辑被拒绝时放弃且不重试；被拒绝的编辑不计数；
  - `test/unit/notify-reason-lines.test.ts`：没有阶段 A 时的说明行与消息内容，最后一次编辑的内容；大事件的这两种消息仍在 Telegram 的文字长度、实体数与实体总大小之内；
  - `test/unit/reason-codes.test.ts`：期限、补跑次数与登记表说明一致；
  - helm 单元测试与 promtool 规则测试：`SreNautixNotifyAbandoned`、`SreNautixIncidentPersistErrors`。
