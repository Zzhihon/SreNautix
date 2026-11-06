# 0185 导出时的 Kubernetes Warning 摘要与疑似同一根因分组

## 背景

一个真实部署连续三天的非供应商告警里，大多数来自同一个根因：两个内存较小的节点内存不足，kubelet 每天驱逐几十次 API 网关与控制面的 Pod。这个根因同时引出了 HPA 到顶、Pod 调度失败（`Insufficient memory` 加上 PV 的节点亲和）、readyz 失败与 5xx、错误预算燃烧等告警。SreNautix 把它们研判成十几个互不相关的事件，`Evicted` 事件也没有进入任何一个事件的证据。

批量导出（issue #44）需要在每个事件上带出时间窗内的 Kubernetes Warning 计数，并给出「疑似同一根因」的分组。用户已经决定（2026-11-05）：分组只在导出时按启发式算出，标注为疑似并列出依据；不注入研判，不在引擎里合并事件。

## 决定

### 1. 一个库，两个契约类型

`apps/srenautix/src/export/kube-warnings.ts` 的 `collectKubeWarnings(deps, { cluster_id, incidents })` 对一个集群与一组事件返回 `KubeWarningReport`（契约 2.47.0，`contract/schemas/kube-warnings.schema.json`）。事件的输入是 `incident_id`、时间窗（终点为 null 时取计算时刻）、组件（`Incident.components`）与成员告警名。报告包含：

| 字段 | 内容 |
|---|---|
| `summaries` | 每个事件一条 `KubeWarningSummary`，顺序与输入相同 |
| `groups` | `SuspectedCommonCauseGroup` 的列表 |
| `queries` | 实际执行的每次查询：查询文本、状态（`ok`、`truncated`、`failed`）、保留的序列数、说明、耗时 |
| `complete` | 全部查询都是 `ok` 时为 true；每条摘要也带同样的 `complete` |
| `window`、`step_seconds` | 查询覆盖的范围与分桶宽度 |

计数 `KubeWarningCount` 是 (reason, 来源, 单位, 次数, 其中提到内存的次数)。来源为 `events`（Loki 里的 Kubernetes 事件）或 `kube_state_metrics`；单位为 `occurrences`（发生次数）、`pods`（不同 Pod 数）或 `seconds`（节点处于某个状态的累计秒数）。不同来源与单位的计数分开列出，不相加。

摘要里有三类计数：`counts` 是组件本身以及拓扑中属于它的对象（ReplicaSet、Pod）上的计数；`nodes` 是时间窗内组件所在的每个节点上的计数（节点对象与该节点上的全部 Pod），并注明确定组件在这个节点上的依据（`component` 组件本身就是节点、`topology` 拓扑历史、`events` 组件对象的事件由这个节点的 kubelet 记录）；`objects` 是组件对象的明细，最多 20 个。组件里有 HPA 时，`scale_targets`（契约 2.50.0）列出它展开到的伸缩对象与这个关系的依据（第 4 条）。

`apps/srenautix/src/export/kube-warnings-config.ts` 的 `kubeWarningsDeps(config, ports)` 由 server 配置构造依赖，导出接口直接调用它与 `collectKubeWarnings`。

### 2. 事件日志的格式做成配置

不同部署的事件采集器写进 Loki 的格式不同。`datasources.loki.kube_events` 给出格式、日志流选择器与字段来源：

| 格式 | 解析器 | 默认日志流 | reason / kind / 命名空间 / 对象名 / 节点 |
|---|---|---|---|
| `alloy_json` | json | `job="loki.source.kubernetes_events"` | `reason` / `kind` / 日志流标签 `namespace` / `name` / `sourcehost` |
| `alloy_logfmt` | logfmt | 同上 | 同上 |
| `kubernetes_event_exporter` | json | 必须填写 | `reason` / `involvedObject.kind` / `involvedObject.namespace` / `involvedObject.name` / `source.host` |
| `eventrouter` | json | 必须填写 | 同上，在 `event.` 之下 |

`stream` 是标签名到取值的相等匹配，配置了 `datasources.loki.labels.cluster` 时再加上集群标签；`fields` 按字段覆盖来源（`line` 为解析器提取的字段路径，`label` 为日志流标签）；`reasons` 是计数的事件 reason。选择器写成映射，查询由结构拼出，SreNautix 不解析部署方写的 LogQL。

解析器提取的字段写到带 `srx_` 前缀的标签上：采集器常把 reason、kind 等字段同时放进 structured metadata 或日志流标签，同名的提取结果会被 Loki 改名为 `<名字>_extracted`，加前缀后结果的标签名固定。

### 3. 查询预算：每个集群常数次

每次导出每个集群执行：

1. Loki 一次区间查询：`sum by (reason, kind, 命名空间, 对象名, 节点, 是否提到内存) (count_over_time(<选择器> |~ <reasons> | <解析器> | reason=~<reasons> | regexp <内存片段> [step]))`。行过滤先排除不含这些 reason 的行；`regexp` 在整行上查找 `low on resource: memory`、`Insufficient memory`、`reclaim memory`，与格式无关。
2. kube-state-metrics 一次区间查询：容器 OOM 重启（第 7 条）。
3. 拓扑存储一次查询：全部事件组件的对象与所在节点（第 4 条）。

查询次数与事件数无关。分桶宽度不小于 60 秒、取整分钟，使求值点数不超过 1440（3 天的导出为 3 分钟）。求值时刻从范围终点按 step 向前排列，第一个分桶的开始不晚于范围起点，分桶恰好覆盖整个范围。一个分桶与事件时间窗有重叠就计入该事件。

每次查询有超时（Loki 为 `kube_events.timeout`，默认 60 秒；kube-state-metrics 为 60 秒）与序列数上限（`kube_events.max_series`，默认 5000；kube-state-metrics 为 5000）。序列数超过上限时按标签排序后截断，状态为 `truncated`；数据源报错、超时或拒绝查询（例如 Loki 自己的单次查询序列数上限）时状态为 `failed`，这一来源的计数缺失。两种情况报告与每条摘要的 `complete` 都为 false，其余来源照常计数。查询构造或解析的缺陷照常抛出。

### 4. Pod 所在的节点

一个计数归到哪个节点，按以下顺序确定：

1. 事件本身给出的节点：节点对象的事件取对象名；kubelet 记录的事件（`Evicted`、`BackOff`、`EvictionThresholdMet` 等）取 `source.host`；kube-state-metrics 的计数取 `kube_pod_info` 的节点。
2. 数据没有给出节点时，取拓扑历史中这个对象在该分桶所在的节点（`runs_on` 边的区间）。
3. 都没有时（例如还没有调度成功的 Pod 的 `FailedScheduling`），计数只归到组件，不归到节点。

事件本身给出的节点优先：它是实际执行驱逐或重启的 kubelet，对象被驱逐、删除之后拓扑里的边已经关闭，按事件时刻回溯拓扑也只能得到同一个节点。

组件在哪些节点上取拓扑历史：`TopologyStore.placements` 沿 `owned_by` 反向展开到组件拥有的对象（最多 4 层，组件本身也算），再取与查询范围重叠的 `runs_on` 区间；组件对象上带节点的计数也算作组件在这个节点上。

组件是 HPA 时，沿 ADR 0184 的 `scales` 边从它伸缩的工作负载展开：

- 查询范围内有这个 HPA 的 `scales` 边时，取这些边，`scale_targets` 的 `basis` 为 `in_window`。
- 查询范围内没有时，取这个 HPA 最近一次已知的 `scales` 边（`valid_from` 最晚的一条，不限时间），`basis` 为 `last_known`。拓扑来源开始上报 `scales` 之前的历史没有这条边（例如分支 reader 读取 HPA 之前写入的拓扑），HPA 与伸缩对象的关系又很少改变，用最近一次已知的关系才能把这些时间段里的 HPA 事件连到工作负载的 Pod 与节点。
- 伸缩对象之下的 `owned_by` 与 `runs_on` 仍按查询范围取，节点与计数只来自事件时间窗里实际存在的 Pod。
- 拓扑里从来没有这个 HPA 的 `scales` 边时不展开，HPA 事件只有 HPA 自身的计数，`scale_targets` 为空。

`basis` 写进每条摘要，读结果的人可以分辨哪些节点与计数是按推定的伸缩关系得到的。`scale_targets` 与 `KubeWarningScaleTarget` 是契约 2.50.0 的新增字段，`TopologyStore.placements` 的每一行带上对象经由的伸缩对象与依据（`PlacementRow.scales`），仍是一次查询。

### 5. 疑似同一根因的分组

分组以节点信号为依据，种类写在 `kind` 上，第一种是 `node_memory_eviction`。它的信号是：

- `Evicted`、`EvictionThresholdMet`，并且消息提到内存；
- `NodeHasInsufficientMemory`（kubelet 把它记为 Normal 类型的事件，计数不按事件类型过滤），或 kube-state-metrics 的节点 `MemoryPressure` 条件；
- `SystemOOM`（节点级的 OOM）。

容器超过自身内存限制的 `OOMKilled` 与节点内存无关，不算信号。

规则：

1. 每个节点上的信号分桶按时间并成时间段，相邻分桶的间隔不超过 `gap`（30 分钟）时合并。
2. 事件与一个时间段相连，当且仅当：事件时间窗与时间段向前放宽 `before`（30 分钟）、向后放宽 `after`（30 分钟）的范围重叠；并且组件在事件时间窗或时间段内（取两者的范围）在这个节点上。后一条照顾被驱逐之后重新调度失败的组件：调度失败的事件时间窗里，它的 Pod 已经不在原来的节点上。
3. 相连的事件与时间段构成一组，可以跨节点：一个事件的组件同时在两个有信号的节点上时，两个节点的时间段在同一组。
4. 至少有 `min_incidents`（2）个事件的组才输出。

每组列出 `criteria`（上面的参数与信号 reason）、每个节点的信号时间段与这些时间段内该节点上的各原因计数、每个事件的成员告警名、与信号相连的节点、事件时间窗与信号时间段重叠的秒数，以及事件组件上的计数（例如调度失败里提到内存的次数）。`suspected` 恒为 true。`group_id` 是 `sha256:` 加上 `JCS([cluster_id, kind, 各节点信号时间段])` 的 SHA-256，同样的信号得到同样的 id。

新的种类（例如节点磁盘压力、节点 NotReady）在 `NODE_SIGNAL_RULES` 中增加一条规则（信号判定与写进 criteria 的 reason），契约的 `SuspectedCommonCauseKind` 增加取值；使用方必须容忍未知的种类。

### 6. 计数的语义

- Loki 的计数是事件日志的行数。事件采集器在 Event 对象新增与更新（`count` 增加）时各写一行，行数近似于发生次数。
- `pods` 单位的计数是窗口内处于该状态的不同 Pod 数。kube-state-metrics 的 `Evicted` 只在 Pod 第一次出现被驱逐状态的分桶计一次（被驱逐的 Pod 对象一直保留到被回收），查询多求值范围之前的一个 step，用来排除范围开始之前已经被驱逐的 Pod。
- `seconds` 单位的计数是处于该状态的分桶数乘以 step。
- `memory` 是计数中消息提到内存的部分；kube-state-metrics 没有消息，为 null。

### 7. kube-state-metrics：OOMKilled 与降级

Kubernetes 不为容器的 OOM 终止记录事件，`OOMKilled` 只在 Pod 状态里。因此无论 Loki 是否可用，都执行一次 kube-state-metrics 查询：一个 step 内容器重启次数（相隔一个 step 的两个瞬时值之差，`increase` 会按区间外推出非整数）大于 0、且上次终止原因为 `OOMKilled` 的重启次数，节点取 `kube_pod_info`（同名 Pod 只取一个节点，避免多对多匹配）。

没有配置 Loki 时另外执行四次查询降级：`kube_pod_status_reason{reason="Evicted"}`（计为 `Evicted`，单位 `pods`）、`kube_pod_status_unschedulable`（`FailedScheduling`，`pods`）、`kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}`（`BackOff`，`pods`）、`kube_node_status_condition{condition="MemoryPressure",status="true"}`（`NodeHasInsufficientMemory`，`seconds`）。降级的取舍：

- 驱逐原因不可知：指标没有消息，`Evicted` 的 `memory` 为 null，不算节点内存信号；节点内存信号来自 `MemoryPressure` 条件，kubelet 因内存驱逐时这个条件为真。
- 调度失败没有节点与原因，只计入组件。
- 计数单位是 Pod 数与秒数，与事件的发生次数分开列出。

标签名按证据数据源探测出的标签档案（`namespace`、`pod`、`container`、`node`）改写，档案里有集群外部标签时按集群过滤。

### 8. 与 ADR 0182、0183、0184 的关系

- 告警类别（ADR 0183）与紧急度（ADR 0182）是事件的属性，用于筛选要导出的事件；本库对筛选之后的事件计数与分组，不读这两个属性，也不改变它们。
- 稳定的事件身份（ADR 0184）让同一告警的复发留在同一个事件里，分组里同一个问题只出现一次；HPA 告警的实体归一到工作负载之后，组件可以沿 `owned_by` 展开到 Pod 与节点。
- 分组不进入研判、不改变事件，也不影响 ADR 0182 的紧急度校正与复发计数。

## 考虑过的方案

- **在引擎里按节点合并事件**：用户已经决定分组只在导出时给出。引擎里的合并会改变事件的身份、通知与 issue，启发式的误判会被放大到这些地方；导出时的疑似分组带着依据，由人判断。
- **按事件逐个查询 Loki**：导出 3 天的事件可能有几百个，逐个查询会压垮 Loki，查询数也随事件数增长。按 (reason, 对象, 节点) 分桶的一次聚合查询覆盖全部事件，事件的归属在内存里计算。
- **HPA 的伸缩关系只按事件时间窗取**：分支 reader 读取 HPA 之前写入的拓扑没有 `scales` 边，这段时间里的 HPA 事件既没有对象也没有节点，进不了任何分组；而这类部署里 HPA 告警正是节点内存驱逐最常见的后果之一。
- **以拓扑历史为节点的唯一来源**：被驱逐的 Pod 在驱逐时删除，拓扑里的边随之关闭；拓扑由 informer 写入，有采集延迟，也受保留期（`topology.history_retention`）限制。事件本身带的节点是执行驱逐的 kubelet，最准确；拓扑历史补上事件不带节点的计数与组件所在的节点。
- **把容器 OOMKilled 算作节点内存信号**：容器超过自身限制的 OOM 在节点内存充足时也会发生，算作信号会把互不相关的 OOM 事件归成一组。
- **事件采集器的格式写成 LogQL 模板**：模板需要 SreNautix 解析或拼接部署方写的 LogQL，集群标签与字段提取都难以可靠地加入；格式表加字段覆盖可以描述常见的采集器，查询由结构拼出。

## 结果

- 导出接口一次调用即可在每个事件上带出 Warning 计数，并把同一次节点内存不足引起的事件归到一个 `node_memory_eviction` 组，列出全部关联告警。
- 计数不完整时结果明确标出，`queries` 记录每次查询的状态与说明。
- 本库只读 Loki、Prometheus 与拓扑存储，不写任何状态。
