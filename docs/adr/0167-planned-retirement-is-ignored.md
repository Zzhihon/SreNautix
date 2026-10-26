# 0167 计划内退役判为 ignore，不推送消息

## 背景

ADR 0161 让计划内的退役（先合并删除工作负载的 Git 提交，再删除或缩到 0）进入变更时间线：退役变更（kind `retire`）带走的抓取 job 写在 `scrape_jobs`，计划依据的提交写在 `planned_by`，抓取 job 消失的告警由这次退役解释并归到它的分组。处置仍按 ADR 0138 推导：阶段 A 没有退役这一项，研判以管理应用为根因（likely）时，模型给出 escalate 或 undetermined，代码保持模型的取值；事件照常推送到聊天渠道。

一次存储组件按计划退役之后，"抓取 job 的目标全部消失"告警触发，消息推到运维群，值班人员确认是计划内的操作，没有需要处理的事。部署方决定：一个事件的全部成员告警都能由带 `planned_by` 的退役解释时判为 ignore，不推送；前提是事件里没有业务影响告警。

## 决定

### 1. 阶段 A：`planned_retirement`

阶段 A 的处置（`stage-a/report.ts` 的 `plannedRetirement`）增加一条 ignore 依据，原因 `planned_retirement`（契约 2.36.0，`stage-a-report.schema.json` 的 `disposition_reason`）：

- 事件的变更中有带 `planned_by` 的退役变更；
- 事件现有的每一条成员告警都由其中一次这样的退役解释：
  - 告警不早于退役时刻减去 10 分钟开始（与变更关联的容差 `CHANGE_ONSET_TOLERANCE_MS` 相同；退役时刻取副本数第一个 0 的采样点，缩容中的告警可能略早）；
  - 告警的 `job` 标签在退役的 `scrape_jobs` 里，或告警的组件是被退役的工作负载（`targets` 中去掉管理应用 `refs` 的那些）。落在管理应用上的告警不算：应用还管理着别的对象，应用上的告警可能来自它们；
- 成员告警全部读到（读不到的成员不判）；
- 成员中没有业务影响告警（`notify.business_impact_alerts`，ADR 0166），不论状态：退役期间业务受到影响时，这件事需要人看。

顺序在"被抑制""领域包排除"之后、"只有预测与长期告警"之前；有触发中的业务影响告警并且有异常卡时（ADR 0163）不判，这个条件已经包含在"没有业务影响告警"里。

### 2. 阶段 B：依据记为 `planned_retirement`

研判照常准入（与领域包排除、只有长期告警的 ignore 相同）。处置推导（`research/disposition.ts`）中阶段 A 的 ignore 依据成立时，原因是 `planned_retirement` 的依据记为 `planned_retirement`，其余仍记为 `stage_a`；`validation_notes` 写"阶段 A 判为 ignore：全部成员告警由计划内的退役解释，没有业务影响告警"。"ignore 不带修复"（规则提议与适用的修复模板）照常适用，模型自己的提议按 ADR 0168 处理。

### 3. 通知、控制台与 issue

- 消息源对最新阶段 A 报告的原因是 `planned_retirement` 的事件标记 `withheld`，通知引擎不为它发新消息（与外部上游事件进入汇总相同的处理）；之前已经发出消息的事件（例如先有一条不由退役解释的告警，后来它离开了事件）照常编辑，消息的处置一行写"忽略 · 阶段 A：全部告警由计划内的退役解释"。
- 控制台照常显示事件与阶段 A 报告（文案 `verdict.stage_a.planned_retirement`）。
- 事件 issue 的登记规则不变。

## 结果

- 实现：`stage-a/report.ts`（`plannedRetirement`、`disposition`）、`research/disposition.ts`（`IgnoreBasis` 的 `planned_retirement`）、`notify/{source,ports,engine,compose}.ts`（`withheld` 与处置原因文案）、`packages/ui` 的中英文案；契约 2.36.0。
- 测试：
  - `test/unit/planned-retirement.test.ts`：抓取 job 消失与被退役工作负载上的告警判为 ignore（`planned_retirement`），critical 与异常卡不影响；没有 `planned_by`、job 不在 `scrape_jobs`、告警落在管理应用上、早于退役超过容差、成员中有业务影响告警（触发或已恢复）、成员告警没有全部读到时不判；provider 组件按排除写法不算业务影响告警；静默仍然优先；阶段 B 的依据记为 `planned_retirement`，其他阶段 A 原因仍记为 `stage_a`；
  - `test/integration/notify-planned-retirement.test.ts`（真实 PostgreSQL 与 Telegram 回放服务）：计划内退役的事件不发消息，另一个事件照常发；已经发出消息的事件改判后照常编辑，写明处置原因。
