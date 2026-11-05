# 0186 按时间窗批量导出事件

## 背景

排查时经常需要「最近 N 天和业务可用性、性能相关的事件，去掉外部上游的」这样一份清单，每个事件带研判结论、关键证据和影子 issue（Zzhihon/SreNautix#44）。`GET /v1/incidents` 一页最多 500 条摘要，摘要里没有告警名、累计时长、无法判定的原因与证据；逐个调用 `GET /v1/incidents/{incident_ref}` 要 N+1 次请求。同一告警反复复发时（ADR 0184 之前），一个问题在清单里出现十几次。

告警类别（ADR 0183）、稳定的事件身份与系列键（ADR 0184）、Kubernetes Warning 摘要与疑似同一根因分组（ADR 0185）给出了导出所需的属性与计算，本文决定导出接口本身。

## 决定

### 1. 接口

`GET /v1/incidents/export`（契约 2.49.0，`contract/schemas/incident-export.schema.json` 的 `IncidentExport`）：

| 参数 | 含义 |
|---|---|
| `from`、`to` | 必填，`to` 不早于 `from`，相隔不超过 31 天。导出与 [from, to] 有重叠的事件 |
| `cluster_id`、`severity`、`component`、`category`、`exclude_category`、`exclude_component`、`suppressed` | 与 `GET /v1/incidents` 相同 |
| `format` | `json`（默认）、`ndjson`、`md` |
| `group` | `incident`（默认）只给事件明细；`series` 另按系列汇总 |
| `group_gap`、`group_before`、`group_after`、`group_min_incidents` | 覆盖疑似同一根因分组的参数（ADR 0185 §5），实际使用的值写在结果的 `grouping` |
| `limit`、`cursor` | 一次最多 `limit` 条（默认与上限 5000）；还有更多时 `truncated` 为 true，`next_cursor` 继续 |

筛选条件与列表接口共用 `console-bff/incident-filters.ts` 的 `incidentConditions`：同一段 SQL 构造，两个接口的语义不会分开演化。合并掉的事件（`state = merged`）不导出，它们计入吸收它们的事件的 `merged_count`。授权与可见性与列表接口相同：`Auth.reader` 给出读取作用域，按事件根因组件所在的命名空间判断可见；外部调用方（MCP、API token）按它的命名空间。

排序与列表接口相同（`first_firing_at` 从新到旧，同一时刻按 `incident_id`），游标也是同一种：上一页最后一个事件的 `(first_firing_at, incident_id)`。

### 2. 每个事件的内容

| 字段 | 来源 |
|---|---|
| `alertnames` | 成员告警的告警名，去重排序。离开时仍在触发的成员（拆分或合并转到了别的事件）不算，与 `incidentOccurrences` 的取法相同 |
| `root`、`components` | 事件的发现根因（组件、实体、是否有歧义）与组件 |
| `first_firing_at`、`last_firing_at`、`ended_at` | 首次触发、最后一次开始触发（成员 `starts_at` 的最大值）、恢复时刻 |
| `firing_seconds`、`occurrences` | 成员告警触发区间的并集（ADR 0184 的发生）：总长与段数，仍在触发的区间算到 `generated_at` |
| `merged_count`、`reopened_count` | `incident_aliases` 中并入它的事件数；`incident_versions` 中版本原因为 `reopened` 的版本数 |
| `categories`、`primary_category`、`severity`、`series_key` | 事件的列（ADR 0183、0184） |
| `conclusion` | 第 3 条 |
| `evidence` | 最新阶段 A 报告中 `abnormal` 与 `undeterminable` 的卡：卡名、verdict、原因类型、一句摘要（主值加判定说明的第一句，最多 300 字） |
| `issues` | `server.github_issues` 中有编号的 issue：repo、编号、链接、人是否已关闭、是否同一系列复用 |
| `kube_warnings` | 事件的 `KubeWarningSummary`（ADR 0185） |

累计时长不按导出时间窗截取：它回答「这个事件一共触发了多久」，与 vmalert 的 `ALERTS` 历史对照时用事件的全部区间。

### 3. 研判结论与无法判定的原因

结论取最近一次完成的阶段 B 研判（`server.research_runs` 的 `disposition`、`conclusion_level`、`summary`）；没有时取最新版本的阶段 A 处置（`disposition`、`disposition_reason`）；都没有时 `source` 为 `none`。

处置或档位为 `undetermined`、或者没有任何结论时，`undetermined` 给出原因：

- `codes`：登记表（ADR 0172）中的原因码，依次为完成的研判的停止原因（`research_stop`）、比它更新的那次研判失败的类型（`research_failure`）、比它更新的入队跳过原因（`research_skip`），以及事件最近一个有终态记录的版本上 `research`、`stage_a` 阶段的终态记录（例如 `rule_only`、`stage_a_missing`）。同一原因码只列一次，带登记表的说明与记录的 `detail`。
- `undetermined_reason`：研判给出的无法判定的原因（模型生成的文字）。

证据卡层面的「查询没有返回样本」由 `evidence` 里 `undeterminable` 卡的 `reason_kind`（`no_data`、`source_error` 等）给出。验收要求每个事件都有结论或无法判定的原因，这两处合起来满足它：有结论的事件 `undetermined` 为 null，其余都有 `undetermined`。

### 4. 按系列汇总

`group=series` 时 `series` 按系列汇总同一集群的事件：有系列键（ADR 0184）时按系列键，没有时（之前版本写入的事件、没有根因的事件）按 `<根因组件>|<告警名,…>`，`key_source` 写明是哪一种。每项给出发生次数与累计时长（全部事件的成员区间合并后计算，和影子 issue 恢复评论里的「第 N 次发生」同一个算法）、首次与末次触发、最后恢复的时刻、事件 id 列表与按 repo、编号去重的 issue。开出 issue 的事件在导出范围内时，这个 issue 在系列上不算复用。

### 5. Kubernetes Warning 与疑似同一根因

每个集群调用一次 `collectKubeWarnings`（ADR 0185）。事件的计数时间窗是事件时间窗限定在导出时间窗与计算时刻之内的部分，导出的跨度上限（31 天）因此也是查询范围的上限。分组只在这一页的事件里计算：分页导出时跨页的事件不会进同一组，需要完整分组时缩小筛选条件或用默认的 5000 条一次导出。

结果的 `kube_warnings` 是每个集群的 `KubeWarningReport` 去掉 `summaries`（摘要在每个事件上）：查询覆盖的范围、分桶宽度、每次查询的状态与分组。数据源失败或截断时照实标出，`complete` 为 false，其余内容照常给出。

指标查询用证据数据源的 Prometheus 适配器与探测出的标签档案（`EvidenceSource.metrics`，与阶段 A 共用缓存），节点归属用拓扑历史（`TopologyStore.placements`）。

### 6. 查询预算

状态库：事件按 1000 行一批读出，凑满 `limit + 1` 条可见事件或读完为止；附加信息（阶段 A、完成的研判、最近的研判、入队跳过、终态记录、合并、重开、issue）每类一次 `= ANY($ids)` 的批量查询。Warning 查询每个集群固定次数（ADR 0185 §3）。查询数与事件数无关，5000 条事件的导出是 8 次附加查询加几批事件查询。

### 7. 三种输出

- `json`：一个 `IncidentExport` 对象。
- `ndjson`（`application/x-ndjson`）：每行一个 `IncidentExportRecord`，依次是 `header`、每个事件一行 `incident`、`group=series` 时每个系列一行 `series`、每个集群一行 `kube_warnings`、最后一行 `end`（导出数、`truncated`、`next_cursor`、`complete`）。响应按行流式写出，调用方读到 `end` 才算完整。
- `md`（`text/markdown`）：给人阅读。先列疑似同一根因的分组（种类、判据、节点信号与计数、关联事件与告警），再按系列汇总，最后是事件明细；`md` 总是带系列汇总。

告警、注解、模型摘要、证据卡说明与错误摘要等外部来源的文字，在 `json` 与 `ndjson` 中照原样给出，与 `GET /v1/incidents/{incident_ref}` 相同；MCP 的工具按 DESIGN §16.4 把它们移进 `untrusted_text`。`md` 把它们的换行并为空格并转义 Markdown 与 HTML 的控制字符，只作为文本显示。

### 8. MCP 与命令行

MCP（ADR 0087）的工具名在参数变化时发布新版本：

- `list_incidents_v2` 在 `list_incidents_v1` 的 `state`、`limit` 之外加上 `from`、`to`、`cluster_id`、`severity`、`component`、`category`、`exclude_category`、`exclude_component` 与 `cursor`，原样转给 `GET /v1/incidents`；`list_incidents_v1` 保留一个版本周期。
- `export_incidents_v1` 调 `GET /v1/incidents/export`，只给 JSON：一次最多 500 个事件（中心的上限是 5000，MCP 的结果要放进调用方模型的上下文），更多的用 `cursor` 继续。中心的超时放宽到 180 秒，覆盖每个集群的 Warning 查询。

两个工具都是读取工具，需要 `srenautix:read`，计入调用方的读取速率限制；结果经 `separateUntrusted` 把模型摘要、证据卡说明、原因码说明与错误摘要等文字移进 `untrusted_text`（DESIGN §16.4）。Markdown 不经 MCP 提供：整篇是一段文字，放进 `untrusted_text` 会按单段上限截断。

命令行 `incidents export`（`apps/srenautix/src/export/cli.ts`，同一镜像的 `main.js` 子命令）把参数转成查询串、以 bearer token 调中心、把响应体逐块写到标准输出。token 从 `--token-file`（或 `SRENAUTIX_TOKEN_FILE`）读取，是中心已有的两种外部凭据之一：控制台创建的 API token，或调用方文件里 `kind: external` 的调用方，与 mcp 角色的 `hub_token_file` 相同，不另设凭据。时间参数另外接受 `3d` 这样相对于现在的时长，参数的合法性由中心校验。

### 9. 与 ADR 0182、0183、0184、0185 的关系

- 类别（ADR 0183）与紧急度（ADR 0182）是正交的筛选属性；紧急度实现之后，导出接口与列表接口一样经 `incidentConditions` 增加 `urgency` 筛选，事件上增加紧急度字段。
- 系列键与重开（ADR 0184）给出 `series_key`、`reopened_count` 与系列汇总；ADR 0182 §5 的复发计数按同样的重开次数统计。
- 分组（ADR 0185）只在导出结果里出现，不进入研判、不合并事件。

## 考虑过的方案

- **在列表接口上加 `expand` 参数**：列表接口一页 500 条、默认只取触发中的事件，附加信息会让收件箱的每次刷新变慢；导出有必填的时间窗与更高的上限，按批量查询组织。
- **按事件逐个计算结论与证据**：沿用 `GET /v1/incidents/{incident_ref}` 的读取路径会让查询数随事件数增长，5000 条事件是几万次查询。
- **只导出系列汇总、不导出事件明细**：每个事件的研判结论、证据与 Warning 计数各不相同，汇总之后无法回答「这次为什么无法判定」；系列汇总作为明细之上的视图给出。
- **累计时长按导出时间窗截取**：与 `ALERTS` 历史对照时需要事件的完整区间；按时间窗截取的计数由 Warning 摘要（限定在导出时间窗内）给出。

## 结果

- 一次调用得到「最近 3 天、排除 provider 类」的事件清单：同一告警的复发在系列汇总里是一项，带发生次数、累计时长与同一个 issue；每个事件有结论或无法判定的原因；节点内存驱逐引起的事件在 `node_memory_eviction` 分组下列出关联告警。
- 导出只读状态库、Loki 与 Prometheus，不写任何状态。
