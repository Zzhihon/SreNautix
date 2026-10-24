# 0147 外部上游的事件按周期汇总，不逐条推送、不开 issue

## 背景

CCHP 影子部署里，根因落在上游模型服务方（`provider:<id>`）或按主题聚合的 `component:provider`（`AlertThemeEscalated`，`theme=provider`）上的事件占了 Telegram 消息与事件 issue 的大半（cchp-k8s-ops#250、#253、#254、#255、#258）。cchp 包在 cchp-k8s-ops#263 把 provider 与 model 声明为 `external: true`（ADR 0138）：集群内没有可处置的对象，研判结论为 likely 及以上时处置推导为 ignore。但通知仍然逐条即时推送、逐个开 issue。用户的要求是：provider 相关的告警每小时聚合回报一次，精简，突出和业务服务相关的信息。

## 决定

外部上游的判定（`notify/external.ts`）：

- 事件的根因（完成的研判给出的根因，没有时为发现根因）的组件类型声明了 `external: true`。拓扑里有的节点取节点上匹配出的类型；只来自告警的实体（provider、model 不在拓扑里）按 kind 与名字匹配领域包的组件类型；
- 或者根因在 `notify.digest.external_roots.components` 里（例如 `component:provider`：cchp 包的这个组件类型同时匹配 `business`，不能整体声明为外部）；
- 或者事件的全部成员告警都满足 `alert_labels`（例如 `theme: [provider]`）。

这类事件：

1. **不逐条推送**。期望消息带 `digest: external`，投递引擎不为它新发消息；之前已经发出的消息照常编辑，不留下停在旧状态的消息。风暴判定也不计入它们。
2. **每个周期一条汇总**（默认 1 小时，按 UTC 纪元对齐，即整点）。周期结束 1 分钟后统计一次 `[from, to)` 内触发过的外部上游事件，按根因归组，存进 `server.notify_external_windows`；每个群一条 `external_digest` 消息（`notify_messages` 新的 kind，subject 是时间段起点），静默发送，之后不再编辑。周期结束超过半个周期的时段不补发（进程停过时不一次发出一串旧汇总）。内容精简为每个上游一行：名称、根因上最多 2 张卡的数值（故障率、首字延迟等）、本时段新触发的成员告警数与上一时段的对比、恢复情况；头部是总数与上一时段的对比和业务影响。
3. **伴随业务影响时照常即时推送**。事件仍在触发，且同一集群里有触发中的业务告警（`business_impact.alert_labels`，CCHP 用 `layer: [L0]`，即边缘 5xx 的错误预算告警），或本事件、其他非外部上游的触发中事件有异常的影响卡（`impact: true`）时，事件照常推送，横幅写“上游故障已影响业务：<信号>”。汇总里这个上游也出现，写明已即时推送。
4. **不开 issue**。IssueService 开 issue 之前判定（只对处置为 escalate 的登记，修复提议需要改仓库时照常开）：未恢复时推迟 10 分钟再判定，期间出现业务影响就照常开出；恢复后记为 skipped（`github.issue_skipped` 的 `reason: external_root`）。

选择不开 issue 而不是每天一个汇总 issue：issue 是给人跟进的工作项，外部上游的故障在集群内没有可做的事（处置推导本来就是 ignore）；每天一个汇总 issue 只是另一份日志，没有人会关闭它，开着的旧 issue 反而淹没真正需要跟进的。需要回看的人有每小时的 Telegram 汇总与控制台的事件列表；一旦影响业务，事件照常开 issue。

`notify.digest.external_roots` 默认开启：只有领域包明确声明为外部的组件类型才会进入汇总，没有声明的部署行为不变。`components` 与 `alert_labels` 默认为空。

契约不变（`external_digest` 是 server 内部的消息种类）；迁移是 expand：放宽 `notify_messages` 的 kind 与风暴约束（按约束定义查找名字后删除重建，其余约束不动），新建 `notify_external_windows`，N-1 版本照常运行。

## 测试

- 单元：汇总正文（每个上游一行、上一时段对比、业务影响、不可信名称的转义）按 Bot API 的 HTML 规则严格解析；飞书卡片同样的行；窗口对齐；组件类型查询对拓扑里没有的 provider 按 kind 匹配。
- 集成（真实 PostgreSQL，经 PgMessageSource、ReportSource 与投递引擎）：一小时内 4 个外部上游事件（其中一个是 `component:provider` 的主题升级）在整点之前一条都不发，整点后 1 分钟只发 1 条汇总，之后不重发；L0 告警触发后，仍在触发的上游事件即时推送并带横幅，已恢复的不推送，下一条汇总写明业务影响；关闭时照常逐条推送；issue 的判定随业务影响变化。

不采用的做法：

- **把外部上游的事件降为 info 不推送**：严重度是告警规则给的，改它会让控制台与 issue 上的严重度失真，也失去恢复与对比的汇总。
- **按风暴的汇总消息合并**：风暴汇总随成员编辑、只列标题，不带数值与上一时段对比；外部上游的问题持续数小时，风暴每 5 分钟就结束一次。
