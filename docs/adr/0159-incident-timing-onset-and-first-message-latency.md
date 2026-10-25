# 0159 事件的计时起点、阶段 A 报告第一次生成的时刻与首条消息时延

## 背景

一次 24 小时的并行运行用 `srenautix_stage_a_latency_seconds` 与状态库的 `stage_a_reports` 判定"阶段 A p95 ≤ 60 秒"，三处度量与实际不符。

1. **拆分出的事件按原事件的首个告警计时**。一个数据库故障事件运行约 1 小时后，事件引擎把其中的发布告警、Kubernetes 事件告警与 gateway 慢查询告警拆成 3 个新事件。新事件沿用成员告警的首个触发时刻，阶段 A 在拆分时刻生成，时延记成 19–57 分钟，直方图的 p95 落在最大的桶。拆分前这些告警已经随原事件在 43 秒内出过阶段 A 和消息。检测延迟 `srenautix_incident_detection_seconds` 与评测的影子统计有同样的问题。
2. **报告第一次生成的时刻被覆盖**。`stage_a_reports` 每个事件版本一行，领域包变化后的重算、研判前的刷新与手动重算都用 `ON CONFLICT DO UPDATE` 改写 `rendered_at`。一次领域包更新后，5 个仍在保留期内的事件被重算，`rendered_at` 都变成重算时刻；按 `rendered_at` 事后统计，这 5 个事件看起来从创建起一直没有阶段 A，直到重算才有。outbox 里的 `stage_a.reported` 显示它们在事件创建后 0.1–1 秒内就出了报告；直方图里没有它们的样本，是因为它们在统计窗口开始之前创建。
3. **阶段 A 时延不等于值班人员什么时候看到消息**。阶段 A 报告之后还有投递；外部上游的事件进入周期汇总，没有事件消息。判定是否切换时看的是业务影响类事件的第一条消息。

## 决定

### 1. 事件的计时起点

`incidentOnsetMs`（`apps/srenautix/src/incident/onset.ts`）：

| 事件 | 计时起点 | `origin` |
|---|---|---|
| `split_from` 为空 | `first_firing_at`（首个成员告警的触发时刻） | `new` |
| `split_from` 不为空 | 事件自己的 `created_at`（拆分时刻） | `split` |

- `srenautix_stage_a_latency_seconds` 增加标签 `origin`，第一个版本的阶段 A 从计时起点算，降级通道相同。
- 拆分出的事件不计入 `srenautix_incident_detection_seconds` 与评测影子统计的检测延迟：它们的告警已经在原事件里被发现。
- 重开（ADR 0132）与合并不改变计时起点；它们不是第一个版本，不记阶段 A 时延。

### 2. 报告第一次生成的时刻

`server.stage_a_reports` 增加 `first_rendered_at`（incident 迁移 6，expand）：

- 写入报告时设为 `rendered_at`，`ON CONFLICT` 时不更新；`rendered_at` 仍是最近一次计算的时刻。
- 已有的行取 outbox 中同一事件版本最早的 `stage_a.reported`（`outbox_type_seq_idx` 按类型扫描一次），outbox 里没有的取 `rendered_at`；之后设默认值 `now()` 与 `NOT NULL`，滚动升级期间旧版本写入的报告也有值。

### 3. 首条消息时延

`srenautix_first_message_latency_seconds{business_impact, origin}`：

- 一条事件消息第一次送达后，投递引擎调用 `MessageSource.firstMessage`。这个事件在所有渠道目标上更早送达过事件消息时不记；同一毫秒送达的取消息 id 小的那条。
- 时延从计时起点算到送达时刻。
- `business_impact`：送达时事件的成员告警（含已经离开的）中有一条满足 `notify.business_impact_alerts` 的任一项即为 `true`。每项是标签到允许取值的映射，项内每个标签都要满足、取值之一即可。默认 `[{severity: [critical]}]`；部署按自己的标签配置，例如 `[{severity: [critical], tier: [user-facing, data]}, {component: [release]}]`。这个设置只决定指标的标签，不影响推送。
- 进入外部上游周期汇总（ADR 0147）的事件没有事件消息，不计入；汇总的时效按汇总消息自己的发送时刻判定。

### 4. 告警源的回溯计入计时

计时起点是告警源给出的开始时刻，与 Alertmanager 的通知、其他值班系统使用同一个时间基准。vmalert 把开始时刻记为 `truncate(求值时刻 - rule.evalDelay, 组间隔)`（`-rule.evalDelay` 默认 30 秒），告警出现在 Alertmanager 时已经比开始时刻晚 30 秒到"30 秒加一个组间隔"，取决于组的求值相位。并行运行中 35 个对账接入的事件拆开看：

| 段 | 时长 |
|---|---|
| 规则引擎的回溯（开始时刻到出现在 Alertmanager） | 31.6–59.4 秒 |
| 等待对账（15 秒一轮） | 0.2–13.0 秒，均值 7.3 秒 |
| 阶段 A 自身（事件创建到报告写入） | 0.1–1.1 秒 |
| 报告写入到消息送达 | 0.4–1.7 秒（风暴等原因延后的除外） |

阶段 A 自身不是瓶颈；超过 60 秒的样本都来自求值相位靠后的规则组。接入段的缩短见 ADR 0160，规则引擎的回溯由 `srenautix_ingest_delay_seconds`（ADR 0160）单独度量。

## 影响

- 直方图增加标签后，`histogram_quantile(0.95, sum by (le) (...))` 的查询不变；只看新事件时加 `origin="new"`。
- 测试：`test/integration/stage-a-first-rendered.test.ts`（迁移从 outbox 补时刻、重算不覆盖第一次生成的时刻）、`test/integration/notify-first-message.test.ts`（两个渠道目标只记一次、拆分出的事件从拆分时刻计时、业务影响类判定）、`test/unit/incident-onset.test.ts`。
