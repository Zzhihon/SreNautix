# 0182 按紧急度分级处理事件：标签首轮、拓扑距离与实测业务影响的校正

状态：提议（设计评审中）。详细设计见 [docs/server/urgency.zh-CN.md](../server/urgency.zh-CN.md)。

## 背景

告警（Alertmanager 的 webhook、对账与快速轮询，ADR 0117、0160）与 SreNautix 自己发现的异常（集群状态检测器，ADR 0105）都汇成事件。事件之后的处理目前只按 `severity` 区分：

| 处理 | 现在的依据 |
|---|---|
| 推送 | `notify.severities`（critical、warning 都推送），外部上游进入每小时汇总（ADR 0147、0150） |
| 阶段 B 的排队 | 严重度 → 吸收的症状数 → 新事件优先 → 等待时长；1 个槽位保留给 critical；预算 80% 时 warning 只出阶段 A（DESIGN §7.5） |
| 事件 issue | 处置为 escalate 或有改仓库的提议时开出，单一仓库 `issues.repo`，每小时上限之外的记为 skipped（ADR 0095） |
| 自愈 PR | 研判结论与准入条件（ADR 0108、0170），与业务是否受影响无关 |
| 技能 | 按技能自己的触发运行，结果开技能自己的 issue（ADR 0181） |

`severity` 描述的是告警规则自己的阈值，不描述这件事离业务可用性有多近。部署方 7 天的告警（2026-10-27 至 11-03，VictoriaMetrics `ALERTS` 只读查询）里，critical 的告警片段有 124 个，分布在边缘 SLO、gateway 自身 SLO、PG 内存、发布后异常、HPA 到顶与观测自身；同为 critical，边缘错误预算的快速燃烧与一次发布后异常需要的响应速度完全不同。反过来，gateway 的 OOM 终止在规则上是 warning（`KubeContainerOOMKilled`，`layer: L2`），2026-10-24 的 OOM 循环（10-23 15:50Z 至 10-24 10:20Z）里，边缘错误率的 5 分钟与 30 分钟燃烧率同时超过 6 倍的时间累计 193 分钟。

已有的“业务影响告警”（`notify.business_impact_alerts`，ADR 0166）只是一个是或否的标签匹配，用在外部上游汇总、处置推导与首条消息时延上，不给事件排序，也不看业务是否真的受了影响：2026-10-31 公共首页的探测失败（`PublicEndpointProbeFailed`，L0 critical）持续了约 10 小时，其间 API 的边缘错误率大部分时间在错误预算之内。

用户决定（2026-11-03）：事件按类型与紧急度分级，越接近业务可用性越紧急；紧急度由标签首轮判定、到 L0 业务入口的拓扑距离与实测的业务影响共同决定；issue 按根因所在的位置分到 ops 仓库或业务仓库并互相引用；PR 只在 ops 仓库；事件按紧急度与类型自动调用技能，技能的输出并入事件的 issue。

## 决定

### 1. 四个紧急度

| 紧急度 | 含义 | 典型 |
|---|---|---|
| U0 业务中断 | 用户请求大面积失败，或计费与数据的正确性正在受损 | L0 错误预算快速燃烧；转发与计费核心路径的 critical；PG 没有可写主库或正在切换 |
| U1 业务降级 | 用户可感知的局部失败或变慢，或核心路径上的部件失效但还有余量 | L0 warning；核心路径依赖（PG、Dragonfly、NATS）的 critical；核心工作负载 OOM 或被驱逐 |
| U2 有风险 | 现在没有业务影响，趋势或冗余的缺失会导致影响 | 容量、内存与磁盘趋势，备份，证书；离 L0 两跳以上的部件；外部上游 |
| U3 无业务影响 | 只影响观测、交付流水线或 SreNautix 自身 | 观测自身、CI、e2e、文档 |

紧急度是事件的属性（契约 `Incident.urgency`），与 `severity` 并存：`severity` 照常来自成员告警，用于展示与兼容；处理矩阵（第 6 条）只读紧急度。

### 2. 首轮：告警标签规则

`urgency.label_rules` 是有序的规则表，每条规则是 ADR 0166 的匹配器（`labels`、`exclude_labels`）加 `tier`、`floor`、`id`。每条触发中的成员告警取第一条命中的规则；事件的首轮紧急度是这些告警中最紧急的一个。`role` 为 forecast 的告警最多给出 U2。没有任何规则命中的事件由拓扑距离给出首轮（第 3 条）。规则只看标签，标签契约的 `layer`、`severity`、`role`、`component`、`chain` 与对象标签（`namespace`、`container`）都可以写进匹配器。

### 3. 拓扑距离

`d` 是事件的研判根因（没有时为发现根因，ADR 0121、0126）到业务入口组件集合 `urgency.entry_components` 的最短依赖距离：入口依赖根因（入口 → … → 根因），沿置信度不低于 τ 的边计数，展开规则与 ADR 0150 的 `dependencyPath` 相同（枢纽可以到达但不再展开，经访问边到达的组件不再沿它的依赖展开，命名推断的边不算），在入口 `urgency.topology.max_hops`（默认 6）跳以内的子图（`TopologyStore.subgraph`，ADR 0144）上查找，结果缓存 60 秒。根因就是入口组件时 `d = 0`；找不到路径时 `d = ∞`。

拓扑距离有两个用途：没有标签规则命中时给出首轮（`d ≤ near_hops`，默认 1，为 U1；其余为 U2）；校正时判断事件是否“接近业务”（第 4 条）。路径写进紧急度的依据，消息的“拓扑联系”段沿用它。

### 4. 实测业务影响的校正

业务影响由部署方声明的指标（`urgency.impact.indicators`，引用领域包的 metrics 信号）与本事件的影响卡（`impact: true`，ADR 0125、0150）实测。每个指标按多窗口燃烧率判定：

| 状态 | 条件（默认） |
|---|---|
| `outage` | 短窗与长窗的燃烧率都不低于 `outage_burn`（14.4 倍，5m 与 1h），持续 `sustain`（3 分钟） |
| `degraded` | 短窗与中窗的燃烧率都不低于 `degraded_burn`（6 倍，5m 与 30m），持续 `sustain`；或本事件有异常的影响卡 |
| `none` | 事件开始之后的 `settle`（10 分钟）里一直不满足 degraded，且流量不低于 `traffic_guard` |
| `pending` | 事件开始不到 `settle` |
| `unknown` | 指标没有数据、数据源出错、流量低于下限，或事件观测失明 |

影响要与本事件相关才计入：开始于事件开始之前 10 分钟到之后 `within`（30 分钟）之间，或根因到入口有路径（`d` 有限）。事件开始之前就已经存在的影响（由更早的事件解释）不用来升级本事件，也不允许本事件因此降级。

校正规则（每次只移动一级）：

- **升一级**：实测状态对应的紧急度（outage 为 U0、degraded 为 U1）比当前更紧急时，升一级，不超过实测状态对应的紧急度。
- **降一级**：实测为 `none`、首轮来自标签规则或 `d ≤ near_hops`、当前为 U0 或 U1 时，降一级，不低于命中规则的 `floor`。
- `pending` 与 `unknown` 不校正，保持首轮：看不见业务时偏向紧急。

### 5. 随时间的变化

- 升级立即生效；降级要求较低的紧急度连续保持 `deescalate_after`（15 分钟）。
- **持续影响**：实测为 degraded 连续 `sustained_after`（30 分钟）时升一级，最高 U0。
- **复发**：同一（根因组件，证据链）在 `recurrence.window`（24 小时）内第 `recurrence.count`（3）次成为事件根因时升一级，最高 U1。
- 事件记录当前紧急度与峰值；issue 与 PR 的资格按峰值，通知与研判的排队按当前值。
- 每一次变化写入 `server.urgency_transitions` 与事件时间线（`TimelineEntry.kind = urgency_changed`），带原因码（原因码表的 `urgency` 分组，ADR 0172）。

### 6. 处理矩阵

| | U0 | U1 | U2 | U3 |
|---|---|---|---|---|
| 推送 | 即时，新消息；从较低级别升到 U0 时回复原消息再提醒一次；仍在触发时每 30 分钟提醒一次，最多 4 次 | 即时 | 不即时推送，进入每日汇总 | 不推送，只在控制台 |
| 首条消息期限 | 60 秒（阶段 A 未出时先发，ADR 0173） | 120 秒 | 汇总时刻 | — |
| 阶段 B | 最高优先，保留槽位；预算 100% 时仍研判；常规路由全部被故障域熔断时用兜底路由（ADR 0152） | 高优先；预算 80% 时仍研判 | 只在空闲槽位；预算 80% 时只出阶段 A；输入预算减半 | 只出阶段 A |
| 技能 | 自动调用，绕过 settle，每小时上限内优先 | 自动调用 | 按技能触发调用，空闲时 | 不自动调用 |
| ops 事件 issue | 立即开出；达到每小时上限时等待重试，不跳过 | 处置为 escalate 或有改仓库的提议时开出；超过上限时并入每日汇总 | 只在有改仓库的提议时开出（PR 需要 Refs） | 不开 |
| 自愈 PR 类别 | `release_rollback`、`config_resource` | `release_rollback`、`config_resource` | `config_resource`、`alert_rule` | `alert_rule` |

PR 的类别是在 ADR 0170 准入条件之上的再一层约束；PR 只开不合并，经人审阅（不变量 12）。

### 7. issue 按根因位置路由

- 事件的 ops issue（ADR 0095，`issues.repo`，CCHP 为 `CCH-HQ/cchp-k8s-ops`）承载事件本身：现状、证据、拓扑、处置、PR 与技能结果。
- 根因落在应用代码上时另开业务 issue（`optimization.repositories.business.repo` 的 `business` 角色，CCHP 为 `CCH-HQ/claude-code-hub-plus`）。判定依据只取确定性的代码位置：技能的 `code.locate@v1` 输出或主动优化的代码定位（ADR 0146 §3.5），置信度不低于 `routing.business.min_confidence`；研判的 `cause_scope` 为 `local` 而没有代码位置时不开业务 issue，ops issue 写明“根因可能在应用代码，未定位到代码”。
- 业务 issue 以代码指纹（技能发现的指纹，ADR 0181 §7.5）去重：同一代码位置再次成为根因时在已有 issue 下评论，不按事件开新 issue；以 completed 关闭后再次出现开下一代，以 not planned 关闭后 30 天内只计数。
- 两边互相引用：ops issue 的“定位”段写 `CCH-HQ/claude-code-hub-plus#<n>`，业务 issue 的正文写 `CCH-HQ/cchp-k8s-ops#<n>`；引用写在正文里，用两个角色白名单都允许的 `PATCH issues/<n>`（只改 body）补写。业务仓库仍然只有 issue 与评论（不变量 15）。
- 每小时上限按仓库分别计算（`github/issues.ts` 的 `openedLastHour`）：ops 仓库沿用 `issues.max_per_hour`（CCHP 为 3），事件 issue、覆盖 issue 与技能 issue 合计；业务仓库用 `routing.business.max_per_hour`。

### 8. 技能的自动调用与合并

- 技能清单增加触发种类 `incident`：匹配事件的紧急度、成员告警的标签匹配器、证据链与异常的证据卡；运行对象是研判根因（没有时为发现根因）展开到的工作负载。部署方在 `skills.auto_invoke.<技能名>.tiers` 收窄或放宽紧急度。
- 任何触发（`incident`、`alert`、`kube`、`metric`）产生的运行，运行对象属于一个仍在触发、或结束不到 30 分钟的事件的组件时，运行挂到这个事件上（`skill_runs.incident_id`）。
- 挂到事件上的运行不开技能自己的 issue：结果写成 ops 事件 issue 正文中的一段（`<!-- srenautix:issue=skill:<技能名> -->`，就地更新），第一次出现新的发现时追加一条评论；发现带代码位置时，这个发现就是第 7 条的业务 issue，指纹沿用技能发现的指纹。没有挂到事件上的运行照 ADR 0181 投递。
- 预算与上限共用：运行仍受技能自己的每次运行预算与每小时运行数约束；issue 与评论计入同一仓库的每小时上限；后端并发按紧急度排队（U0、U1 先于阶段 B 的 U2 与主动优化）。风暴期间只为 U0 事件开始新的运行，每次最多一个。

### 9. 展示

- 消息头条在严重度之前写紧急度，例如 `U0 业务中断`；“现状”段第一行写紧急度与依据：首轮命中的规则、拓扑距离、实测影响与校正。影子期间同样带 `[影子]` 前缀，段落顺序仍为 现状 → 关键问题 → 拓扑联系 → 解决方案 → 证据链。
- 控制台的事件列表按紧急度排序与筛选，事件详情有紧急度的依据与变化历史；responder 及以上的角色可以手动指定紧急度（记为反馈，进入评测候选）。
- 指标：`srenautix_incident_urgency{tier}`、`srenautix_urgency_transitions_total{from,to,code}`、`srenautix_urgency_impact_state_total{state}`；`srenautix_first_message_latency_seconds` 增加标签 `urgency`。

### 10. 契约 2.46.0 与迁移

全部为新增的可选字段、枚举值与接口：`Incident.urgency`（`UrgencyAssessment`）、notify 的 `Message.urgency`、`TimelineEntry.kind` 的 `urgency_changed`、原因码阶段 `urgency` 与分组、技能清单的 `SkillIncidentTrigger`、技能运行的 `incident_id`、评测快照与标注的 `urgency`、`GET /v1/incidents` 的 `urgency` 筛选与 `PUT /v1/incidents/{id}/urgency-override`、状态条件 `UrgencyImpactBlind`。迁移只增不删：`incident` 轨道新建 `server.incident_urgency` 与 `server.urgency_transitions`；`github` 轨道新建 `server.github_issue_links`；`skills` 轨道给 `server.skill_runs` 增加 `incident_id`。

配置 `urgency.mode`：`off`（默认）不评估；`shadow` 评估、展示并记指标，处理矩阵不生效；`enforce` 处理矩阵生效。

### 11. 约束

- 紧急度只决定 SreNautix 怎样处理事件，不进入 SreNautix 自身升级与同步的门禁（第二阶段章程 §4 第 13 条）。
- 实测影响按集群每分钟一批查询（每个指标 3 个窗口），与事件数无关；查询走领域包信号（预聚合的录制规则），经后端并发限制（ADR 0146 §6）。
- 紧急度只由确定性数据计算，模型不参与。

## 考虑过的方案

- **直接用 severity 与 layer 排序**：同一 severity 的告警离业务的距离相差很大，layer 是部署方的分层编号，各部署含义不同（CCHP 的 L1 是上游供应商、L2 是应用运行时、L3 是数据与基础设施），写死在代码里只适合一个部署。规则表把映射留在配置里。
- **只看实测影响**：影响指标有分钟级的滞后，PG 切换与计费写入失败在边缘错误率上可能看不到；首轮与 `floor` 保证这类事件不因指标还没反映而被降级。
- **每升降一次都即时推送**：Telegram 的编辑不产生提醒，升级到 U0 时必须有一条会提醒的消息；降级不提醒，只编辑。
- **业务 issue 按事件开**：同一个代码问题（例如 gateway 的归档导出占用内存）会在每次 OOM 时开一个新 issue；按代码指纹去重让复发累计在同一处。
- **U2 每天开一个汇总 issue**：与 ADR 0147 的理由相同，汇总 issue 没有人会关闭，开着的旧 issue 淹没需要跟进的；U2 的跟进入口是每日汇总消息与控制台，需要改仓库时才开 issue。
- **技能结果单独开 issue 再与事件 issue 互相引用**：同一件事分在两个 issue 里，人要看两处；并入事件 issue 后只剩一个入口，代码问题仍有自己的业务 issue。

## 结果

- 事件按离业务可用性的远近排队、推送与跟进；不影响业务的事件不再打扰群，影响业务而规则上只是 warning 的事件得到及时处理。
- 部署方的映射（入口组件、规则表、影响指标）都在配置里，CCHP 的取值见 cchp-k8s-ops 的映射文档。
- 实现范围与差距见设计文档 §14。

## 已决定的事项（用户，2026-11-03）

1. 紧急度 = 标签首轮（`layer`、`severity`、`role`、`component`）+ 到 L0 业务入口的拓扑距离 + 实测业务影响的校正：接近但没有实测影响的降一级，规则之外但有实测影响的升一级。
2. issue 按根因位置路由：部署、配置与集群在 `CCH-HQ/cchp-k8s-ops`，应用代码在 `CCH-HQ/claude-code-hub-plus`，两边互相引用；两个仓库都装有 GitHub App「SreNautix」（5379322）。
3. PR 只在 cchp-k8s-ops（发布回退、资源与 HPA、告警规则调优），只开不合并，经人审阅；业务仓库只有 issue。
4. 事件按紧急度与类型自动调用匹配的技能，技能输出并入事件的 issue，不单独开 issue，共用去重指纹与每小时上限。
5. 根因在应用代码时：事件 issue 总是开在 ops 仓库；有确定性代码位置时另开业务仓库 issue，按代码指纹去重、沿用技能发现的代际规则，两边互相引用（第 7 条）。
6. 没有实测影响时的降级下限：CCHP 的 `pg-failover` 与 `billing-critical` 保持 U0；`core-termination`（gateway、control、worker 的 OOM、CrashLoop 与异常退出）与 `billing-warning` 至少为 U1。理由：OOM 杀掉 gateway Pod 时中断的流式请求已经返回过 200，边缘 5xx 统计不到；计费的正确性不在可用性 SLI 里。
7. U2 不即时推送，每天 09:30（Asia/Shanghai）一条 Telegram 汇总；U2 只在带有改仓库的提议时开 issue（与 ADR 0147 不开汇总 issue 的理由相同）。
8. 实测业务影响的指标：边缘错误率的燃烧率（全部根因）加 gateway 自身错误率的燃烧率（只用于集群内的根因），要求连续 3 分钟并有流量下限（`cchp:edge_requests:rate5m ≥ 0.02`）。
