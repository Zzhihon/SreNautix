# 0174 反馈原因码与关闭的跟踪

## 背景

反馈（DESIGN §11）的两个维度说明结论与处置对不对，`reason` 是自由文本，各入口收集原因的方式也不一样：控制台与 Grafana 可以填写，Telegram 只在拒绝根因时回复文字，飞书的表单没有原因，提议被拒绝时填写的理由只进治理审计。自由文本无法统计，也无法据此判断这次事件是不是本来就不该打扰人。

人在 GitHub 上的操作同样是反馈：关闭自愈 PR 而不合并，说明修复方向不对或告警本身不需要处理；以 not planned 关闭事件 issue，说明这次事件不需要跟进。之前的代码只在下一次同类补丁出现时才读取 PR 的状态，不产生反馈，事件 issue 的关闭完全没有跟踪。

## 决定

### 1. 原因码

`Feedback.reason_code` 与 `FeedbackCreate.reason_code`（契约 2.40.0，`feedback.schema.json` 的 `ReasonCode`），取值：

| 原因码 | 含义 | 级别 |
|---|---|---|
| `false_positive` | 真误报 | warning |
| `not_actionable` | 不需要处理 | warning |
| `known_issue` | 已知问题 | info |
| `planned_change` | 计划内变更 | info |
| `transient_self_resolved` | 短暂、自行恢复 | info |
| `external_upstream` | 外部上游 | info |
| `duplicate` | 重复 | warning |
| `poor_wording` | 措辞不佳 | warning |
| `wrong_fix` | 修复方向错误（事件是真的） | warning |
| `worse_than_baseline` | 并行期评为比旧系统差 | warning |
| `other` | 其他 | info |

原因码登记在原因码登记表（`contract/reason-codes.json`，ADR 0172）的阶段 `feedback`、分组 `feedback`，说明文字取自登记表；契约测试校验分组与 `ReasonCode` 的取值相同。级别按含义区分：说明 SreNautix 的输出有问题（误报、不需要处理、重复、措辞、修复方向、比旧系统差）的为 warning，说明事件本身性质（已知问题、计划内变更、短暂恢复、外部上游、其他）的为 info；反馈的原因码都不是 error，`SreNautixAbnormalTerminalStates` 不因反馈告警。

- 自由文本 `reason` 保留，作为补充说明。请求体可以省略原因码（等同 null），老版本的客户端照常可用；表单在拒绝根因或处置时要求选择，由各入口负责。
- `server.feedback` 增加 `reason_code` 列（`proposals` 轨道版本 4，只增不删），列约束只接受上表的取值；表约束放宽为 `verdict`、`disposition_verdict`、`implicit`、`reason_code` 至少一项不为空。只有原因码、不评价根因与处置的反馈合法：并行期的人工评分（"比旧系统差"）就是这种反馈。
- 研判提示词的"人工反馈"一段带上原因码本身。这一段属于事件数据，不参与裁剪；只增加每条反馈的一个短字段，没有反馈时提示词不变。
- 事件时间线的反馈条目以 `TimelineEntry.code` 带原因码，`level` 取登记表的级别，文字在评价之后写出登记表的说明（"原因：真误报"）。
- 写入带原因码的反馈时计入 `srenautix_terminal_states_total{stage="feedback",code,level}`，与其他阶段的原因码同一个指标。

### 2. 各入口

- **控制台与 Grafana**：`FeedbackControl`（`packages/ui`，两者共用）在两个维度下方有原因选择。处置或根因任一维度选了"错"时必选，否则可选；只选原因也可以提交。已反馈的摘要显示原因。
- **飞书**：拒绝根因与拒绝处置的表单各有一个必选的原因下拉（`reason_code`）。原因选择加入之前发出的卡片没有这一项，提交时原因码为 null；有这一项而取值不在表里时提示重新选择。表单变化使渲染器版本升为 3，尚未呈现的期望内容按新版重新渲染。
- **Telegram**：拒绝根因之后的回复提示改为带一组原因按钮（每行 3 个）的消息，提及点击者，仍以"回复本消息填写真实根因组件"的方式收集组件。原因按钮只有发起这次反馈的成员可以点，可以重复选择、以最后一次为准，选择记在等待中的回复上（`server.notify_pending_replies.reason_code`，`notify` 轨道版本 5）；回复提交或 5 分钟后过期提交"结论错、根因未知"时，原因码一起写入。原因按钮的 short id 另按原因码与提示所属的按钮区分，其他按钮的 id 与之前相同，已发出的消息不因此重新编辑。拒绝提议的理由提示保持原样（ForceReply）。
- **提议被拒绝**：审批时填写的理由（`approval.reason`）写进隐式反馈 `rejected` 的 `reason`。

### 3. 关闭的跟踪

server 的主实例每 10 分钟运行一轮（`github/closures.ts` 的 `ClosureTracker`，配置了 GitHub App 时启用）：

- **自愈 PR**：刷新状态为 `open` 的修改（`server.remediation_changes`），每个仓库每轮最多 30 个，最久没有检查的在前，检查过的（包括 GitHub 请求失败的）更新 `checked_at`。读取沿用 `RemediationChanges.refresh`：PR 从打开变为关闭且没有合并时，再读取一次 issue 接口得到关闭者（`closed_by`），并读取 PR 的评论，取关闭之前的最后一条人工评论（带 SreNautix 标记的评论不算，关闭之后的评论不算），与状态更新同一事务写入隐式反馈 `pr_closed`。去重判断（`verdict`）时读取到的关闭同样写入反馈，两条路径只会有一条读取到状态的变化。审批时被拒绝的提议没有 PR，已经有隐式反馈 `rejected`，不再写入。
- **事件 issue**：刷新 `server.github_issues` 中仍打开、还没有记下关闭的 issue，同样每个仓库每轮最多 30 个。关闭时记下关闭时刻与 `state_reason`（`github` 轨道版本 5 增加 `closed_at`、`state_reason`、`checked_at`），写入治理审计 `github.issue_closed`；以 `not_planned` 关闭时同一事务写入隐式反馈 `issue_not_planned`，关联事件最近一次完成的研判。`state` 不变：事件 issue 的进展评论照常追加。
- 两种隐式反馈的渠道是 `github`（`Feedback.channel` 的取值为提交渠道之一或 `github`，契约的 `FeedbackChannel`），提交者为 `github:<关闭者>`，读取不到关闭者时为 `github`，`linked` 为 false：它们不进入研判提示词的人工反馈，也不作为评测的标准答案，只经评测候选（ADR 0175）由人确认。
- 反馈的"最新一条"（收件箱的已反馈、消息上的反馈摘要）不算批准与这两种关闭：它们不是对结论的评价，已结束事件的消息不因此重新编辑。
- GitHub 请求只用白名单内的读取：`GET pulls/{n}`、`GET issues/{n}`（PR 的编号同样可以按 issue 读取）、`GET issues/{n}/comments`。

## 结果

- 契约 2.40.0：`feedback.schema.json` 的 `reason_code`、`ReasonCode`、`FeedbackChannel`，`implicit` 增加 `pr_closed` 与 `issue_not_planned`；原因码登记表增加阶段 `feedback` 与 11 个原因码，`TimelineEntry` 的 `feedback` 条目带原因码。
- 迁移：`proposals` 版本 4（反馈原因码与约束，评测候选表见 ADR 0175）、`notify` 版本 5、`github` 版本 5，都只增不删。
- 实现：`contract/reason-codes.json`、`proposals/feedback.ts`、`proposals/service.ts`、`notify/{interactions,store,ports,actions,text,shortid,channel}.ts`、`channels/telegram/updates.ts`、`channels/feishu/render.ts`、`github/closures.ts`、`remediation/{dedupe,service}.ts`、`research/prompt.ts`、`console-bff/routes-incidents.ts`、`roles/server.ts`、`packages/ui` 的 `FeedbackControl`。
- 测试：
  - `test/unit/feedback-reasons.test.ts`：原因码与契约一致、两种语言的文案、飞书表单的原因、候选的生成规则；
  - `packages/contract` 的契约测试：登记表的 `feedback` 分组与 `ReasonCode` 相同；
  - `test/integration/feedback-reasons.test.ts`（真实 PostgreSQL）：聊天渠道与控制台的原因码写入、只有原因码的反馈、表约束、原因码的计数；
  - `test/integration/closure-tracking.test.ts`（真实 PostgreSQL 与内存中的 GitHub）：关闭且没有合并的 PR、合并的 PR、每个仓库的上限、not planned 与 completed 的 issue、GitHub 请求失败后的下一轮；
  - `test/integration/remediation.test.ts`：去重判断读取到的关闭写入反馈与候选；
  - `test/integration/channels-telegram.test.ts`、`channels-feishu.test.ts`：原因按钮与表单的原因随反馈提交；
  - `test/integration/server-e2e.test.ts`：控制台 API 的原因码、时间线反馈条目的原因码与级别、拒绝提议的理由进入隐式反馈；
  - `packages/ui` 的组件测试：拒绝时原因必选、只选原因可以提交、选项与契约一致。
