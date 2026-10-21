# 0125 事件消息：确定性的报告结构、富文本渲染与证据链接

## 背景

影子部署的 Telegram 消息与事件 issue 只写了结论档位、card_id 与数值。证据卡没有标题、阈值、基线与时间，正常卡只写"没有命中任何异常条件"；读者看不到做了哪些区分性检查、竞争假设怎样被排除、为什么是 likely 而不是 evidence_consistent，也没有时间线；"现状"一段是模型写的自由文本。消息里的数值无法核对，也没有链接回到控制台或数据源。

## 决定

1. **消息主线**：现状 → 关键问题 → 拓扑联系 → 解决方案 → 证据链。Telegram、飞书与 issue 共用同一份 `NotifyMessage`（notify 契约 v1）：
   - 最上面是加粗的一句话现状 `headline`：严重度、根因组件、症状、状态。
   - **现状**：问题陈述（组件、症状、开始时间、影响范围、告警与组件数）与时间线（首个告警、相关变更、告警升级、首张异常卡、症状起点、阶段 A、研判、恢复）。
   - **关键问题**：结论档位与根因；四个一致性条件逐项给出依据；处置判断与理由；每个假设的状态与理由。
   - **拓扑联系**：从根因组件到每个受影响组件的路径，标出边的类型（owns、manages、egress_to 等），链路前面是触及它们的变更，末尾是该组件上的告警。
   - **解决方案**：提议、建议与每条的验证方法。验证方法由代码给出：哪些异常卡重跑后应转为正常、哪些告警应恢复，以及动作目录的执行后校验。
   - **证据链**：按假设分组，每张卡写标题、对象、实测值、阈值或基线、时间、判定、对假设的作用（支持或相反），并带两个链接：控制台的卡片详情（`/incidents/<id>#card-<n>`）与数据源查询（Grafana Explore 或 vmui，带查询与时间窗）。其后是已执行的检查、排除的信号、无法判定的卡、告警（generatorURL 或 Alertmanager 链接）与变更（变更来源的链接、Argo 应用或 Git 提交）。
2. **富文本**：块带 `runs`（片段的样式为 plain、bold、code、italic，可带 http/https 链接），段带 `folded`、`priority`、`omitted`，块带 `scope`（all、summary、full）。渠道各自渲染：
   - Telegram 用 `parse_mode=HTML`：数字与对象名为 `<code>`，模型文字为 `<i>` 并带【模型】，证据链放进 `<blockquote expandable>`。所有文本按 Bot API 的规则转义（`&`、`<`、`>`、`"`）。超长时从优先级最低的段的末尾逐块删减，最后加一行"其余见控制台"；删减以块为单位，标签总是闭合。实体数不超过 100，超出的样式按纯文本输出。
   - 飞书卡片用 markdown 元素（按飞书的转义表转义），证据链放进折叠面板。
   - issue 用 GitHub Markdown，渲染 `scope` 为 all 与 full 的块，内容是全文；正文在研判结束与事件恢复时就地更新（server 的 GitHub 白名单允许只改 issue 的 body）。
3. **数值只来自确定性数据**：Incident、StageAReport（证据卡结果与时间线）、ResearchOutput 的账本与检查、changes 与动作目录。模型文字只出现在四处：假设机制、结论摘要、建议的标题与步骤、无法判定的原因，都标【模型】。worker 在研判结束时审计这些文字（`research/numbers.ts`）：时刻、百分比、带单位的数与小数必须能在本次证据里找到；找不到的数值在括号内的补充说明里时删掉这段括号，否则连同所在分句（以逗号、句号与因果箭头分隔）删掉，并写入 `validation_notes`。`ResearchOutput.situation` 不再出现在消息里，问题陈述由模板生成。
4. **契约 2.23.0**（全部为可选字段或新增枚举值）：
   - `EvidenceResult`：`observations`（let 绑定的标量取值）、`params`、`conditions`（每条判定条件的求值结果与说明）、`baseline`、`unit`、`impact`。
   - 卡片定义：`display.baseline`、`impact`、规则的 `normal_say`。
   - `ResearchOutput`：`Hypothesis.status_reasons` 与 `checks_run`、`Conclusion.consistency_detail`（四个条件的依据）、`check_cards`（检查产生的卡，序列为空）、`evidence_index`（`card:n`、`alert:n`、`change:n` 的映射）、`stop_reason`、`NextCheck.error`。
   - `ChangeEvent.previous_revision`：版本标签的旧取值，用来识别回退。
   - 告警目录条目的 `title`：告警的可读症状。
   - notify：`Message.headline`、`Section.title/folded/priority/omitted`、`Block.runs/scope/indent/table` 与类型 heading、table，段类型增加 `key_issue`、`topology`。
5. **链接配置**：server 配置的 `links`：`metrics_explore_url`、`logs_explore_url` 是模板，占位符为 `{query}`（URL 编码的查询）、`{query_json}`（查询写成带引号的 JSON 字符串后再 URL 编码，用于 Grafana Explore 的 JSON 参数）、`{from}`、`{to}`（RFC3339）、`{from_ms}`、`{to_ms}`、`{range}`（窗口长度，例如 `40m`）；`alertmanager_url`、`argocd_url` 是根地址；`git_commit_url` 是模板，占位符 `{revision}`。没有配置时证据只带控制台链接。

## 结果

- 消息里的每个数值与时刻都能对到一个字段；正常卡写出实测值与阈值；结论档位的依据逐项可查。
- 研判卡片编号按研判所用事件版本的阶段 A 报告与检查卡编号，控制台的证据页（`#card-<n>`）与消息一致。
- Telegram 的 HTML 由快照测试（2026-10-20 发布事故的脱敏样例）与解析测试覆盖：输出只含 Bot API 支持的标签、标签闭合、实体与转义合法，截断后同样成立。
