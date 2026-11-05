# 0184 告警复发时事件身份保持稳定，同一系列复用事件 issue

## 背景

一个部署方的影子期里，一条 HPA 到顶的告警（`KubeHpaMaxedOut`）在 3 天里反复 firing 与 resolved，每次持续几分钟到四十几分钟。SreNautix 每次都新建一个事件，并为每个事件新开一个影子 issue，共 15 个。issue 标题的根因在 `Deployment:<ns>/<name>` 与 `HorizontalPodAutoscaler:<ns>/<name>` 之间来回变化，看起来是两类问题。

逐项核对后的原因：

- **每次复发都是新事件**。告警的 id 是 `<标签指纹>@<开始时间>`，每次复发的开始时间不同，id 也不同。事件引擎每轮只把仍在触发、或在回看窗口（`adjacency`，默认 30 分钟）内结束的事件读作 `previous`；上一次结束超过 30 分钟后，新告警组成的分组与任何已有事件都不共享成员。ADR 0132 的 `dormant` 只按共享成员或完全相同的稳定标签认领 resolved 事件，稳定标签带着首次触发时间（取整到 10 分钟），复发的标签总是不同，于是每次都新建事件。
- **根因在 HPA 与 Deployment 之间来回变化**。拓扑里 HPA 与它伸缩的工作负载之间没有任何边：informer 读到 HPA 对象，但不读 `spec.scaleTargetRef`。告警目录把 `KubeHpaMaxedOut` 的实体映射到 HPA，HPA 没有 owned_by，组件就是 HPA 自己，发现根因因此一直是 `HorizontalPodAutoscaler:<ns>/<name>`。研判与确定性结论规则（ADR 0178）看的是被伸缩的 Deployment（资源配额、CPU 限流），结论根因多为 `Deployment:<ns>/<name>`。消息与 issue 的标题取研判根因，没有研判结论时取规则结论，再没有时取发现根因，标题就随每个事件有没有结论而在两者之间切换；按属主粒度比较两者也不一致（`rootsAgree` 只认 owned_by），每个 issue 都多一条“研判根因与发现根因不一致”的评论。
- **issue 只按事件去重**。`server.github_issues` 以 incident_id 为主键，每个新事件都是一个新 issue。

用户已定的方向：在引擎层保持事件身份稳定，同一告警、同一归一后的实体在有界窗口内复发时重开原事件；同一系列已有打开的 issue 时复用并评论发生次数；“疑似同一根因”的跨事件分组只在导出时做，不进入引擎。

## 决定

### 1. HPA 的组件归到它伸缩的工作负载

- 拓扑构建（`packages/core/src/topology/kube.ts`）为每个 HPA 加一条边 `HorizontalPodAutoscaler → spec.scaleTargetRef`，关系 `scales`，来源 `structural`（置信度 1），依据 `spec.scaleTargetRef <kind>/<name>`。伸缩对象不在拓扑中时补一个虚节点，与 ownerReference 的做法相同。
- `scales` 是成员关系：没有 owned_by 的 HPA 归到伸缩对象所在的组件，`componentOf(HPA)` 就是 Deployment（或 StatefulSet、Argo Rollout 等伸缩对象的顶层属主），`membersOf(Deployment)` 包含这个 HPA。HPA 有控制者时（例如 KEDA 的 ScaledObject 创建的 HPA）跟随控制者。`scales` 不是依赖边，不参与可达与归并的展开。
- 同一条规则在所有求组件的地方生效（`packages/core` 的 `memberParents`）：拓扑图（`TopologyGraph.componentOf`、`membersOf`）、状态库的属主查找（`TopologyStore.ownerOf`，优先 owned_by）、评测重建包的属主查找、研判账本的组件粒度与假设范围（`research/ledger.ts`），以及消息里“根因与它拥有的对象上的正常卡”。
- 告警的实体保持告警指向的对象：`KubeHpaMaxedOut` 的实体仍是 HPA，证据卡照常按 HPA 执行；变化的是告警归属的组件，事件的发现根因随之是 Deployment。研判根因是 Deployment 或 HPA 时，按属主粒度都与发现根因一致。
- kube-state-metrics 历史（ADR 0033）不产生 HPA 节点，不受影响。分支 reader（ADR 0030）不读取 HPA 对象，多集群部署中 reader 上报的拓扑没有 HPA 节点与 `scales` 边，那里的 HPA 告警按实体标签落到 HPA 自己。

这条归一只依赖 HPA 对象自己的声明，与告警标签、研判结果无关，同一份拓扑重放的结果相同。

### 2. 系列键

系列键是 `<根因组件>|<告警名,…>`：根因组件是第 1 条归一后的发现根因，告警名取仍在的成员告警，去重后按字典序排列（`packages/core` 的 `seriesKey`、`incidentSeriesKey`、`computedSeriesKey`）。它与告警的开始时间、标签指纹（Pod 名之类会变的标签）无关，只描述“这组告警在这个组件上”。

没有根因、或根因只是命名空间伪组件（实体没有解析出来）时没有系列键：这类分组无法区分同一命名空间里的不同对象，不按系列重开，也不复用 issue。

事件引擎每次写入事件时求出系列键，写入 `server.incidents.series_key`（`incident` 迁移 9，带 `(cluster_id, series_key, ended_at)` 的部分索引）。这一版之前写入的事件为 null，不参与按系列重开；升级之后同一系列第一次复发新建一个事件，之后的复发回到它。

### 3. 按系列重开

对账（`reconcileIncidents`）的认领顺序：

1. 与 `previous` 共享成员：沿用原事件（不变）；
2. 与 `dormant` 共享成员，或标签相同：重开（ADR 0132，不变）；
3. 新输入 `reopenWindowMs` 给出时，分组的系列键与一个 resolved 事件相同，且分组最早的告警开始时距那个事件结束不超过窗口：重开那个事件。候选是 `dormant` 中的 resolved 事件，以及 `previous` 中没有分到分组、成员也不在任何分组里的 resolved 事件（回看窗口内复发、而新旧告警没有被收敛到一起的情况）；有多个时取结束最晚的一个；
4. 都没有时新建。

重开沿用 ADR 0132 的语义：incident_id 与稳定标签不变，状态回到 firing，`ended_at` 清空，版本加一，`incident_versions.reason = 'reopened'`，终态记录 `reopened`。上一次的告警离开成员（`left_version` 记为新版本），这一次的告警加入。merged 的事件不重开。

窗口以“这次复发的开始”与“上一次的结束”之间的间隔计，默认 7 天：覆盖按天、按周出现的容量问题（工作日的流量高峰、每周的批处理），更久以前的同名问题多半已经因为扩容、修复或发布而换了原因，作为新事件重新研判。

引擎在同一事务里把重开窗口内结束、系列键是本轮某个分组系列键的 resolved 事件也读进 `dormant`。降级通道与评测重建不传 `dormant` 与窗口，行为与 ADR 0132 相同。

### 4. 与已有机制的交互

- **合并与拆分**：按系列认领排在共享成员与标签之后；从窗口内事件拆分出来的分组只按共享成员认领，不按标签或系列认领（与 ADR 0132 相同），拆分出的事件不会重开一个无关的旧事件。成员落在别的分组里的 `previous` 事件不作为系列候选，它按原规则合并进那个分组的事件。
- **提议绑定失效**：重开是版本变化，绑定在旧版本上的提议照常由 `StaleMarker` 标为 stale。
- **阶段 A 与阶段 B**：重开的版本照常出阶段 A，以研判原因 `reopened` 申请阶段 B（ADR 0135），受每事件 6 小时 3 次的上限约束；同一系列反复复发时，研判次数由这个上限控制。
- **通知**：一个事件一条消息、就地编辑（DESIGN §11）。重开把消息编辑回触发中，已结束事件的编辑次数随状态回到 firing 清零（ADR 0173）；不发新消息。
- **紧急度（ADR 0182）**：紧急度是事件的属性，与身份正交。ADR 0182 §5 的“复发”以同一（根因组件，证据链）成为事件根因的次数计；身份稳定之后，同一系列的复发是同一个事件的重开，复发次数按事件的 `reopened` 版本与发生次数（第 5 条）统计。

### 5. 事件 issue 复用同一系列已开的 issue

事件需要 issue 时（ADR 0095 的 escalate 与 repo_change），先查同一集群、同一系列的其他事件在同一仓库里是否有打开、还没有被人关闭（`closed_at` 为空，ADR 0174）的 issue：

- **有**：复用它，不新开。这一行的 number、url 取那个 issue，`reused_from` 记开出它的事件（`github` 迁移 6）；写治理审计 `github.issue_reused`、终态记录 `reused`（契约 2.48.0 的原因码，`issue` 阶段）与指标 `srenautix_github_issues_total{outcome="reused"}`。复用不计入 `issues.max_per_hour`（`openedLastHour` 只数 `reused_from` 为空的行）。
- **没有**（包括人已关闭的）：照常开新 issue，受每小时上限约束。人关闭 issue 表示这一轮跟进结束，之后的复发开下一个 issue，与 ADR 0182 §7 业务 issue 按指纹去重、关闭后开下一代的做法一致。

同一个 issue 接了几个事件时，正文与标题跟随最近接上它的事件（`refreshContent` 只处理同一 issue 最近接上的一行），正文开头的事件标记随之换成这个事件；其余事件的进展评论（研判结束、关联的 PR）照常追加在同一个 issue 下。

**发生次数的评论**：每次发生恢复时，恢复评论写明第几次发生、本次持续时长与到这一次为止的累计时长，例如“事件已于 … 恢复。这是同一系列第 3 次发生，本次持续 28 分钟，3 次累计 1 小时 12 分。”第一次发生只写恢复时刻。发生次数取接上同一个 issue 的全部事件（同一事件的重开、复用 issue 的同系列事件）的成员告警触发区间，重叠的合并为一次（`packages/core` 的 `incidentOccurrences`）；离开时仍在触发的成员已经转到别的事件，不算。

身份稳定之后，同一系列在窗口内的复发不再产生新事件，issue 复用主要发生在窗口之外的复发、以及几个同系列事件同时存在的时候（例如升级前写入的事件没有系列键）。已经存在的重复 issue 不做任何处理。

### 6. 配置

```yaml
incidents:
  reopen:
    enabled: true   # 默认开启
    window: 7d      # 复发的告警开始时距上一次结束的最长间隔
```

关闭时不按系列重开（ADR 0132 的认领照常）；issue 复用只依赖系列键，与这个开关无关。

### 7. 契约 2.48.0

- 原因码登记表新增 `reused`（`issue` 阶段、`issue` 分组、info）；
- 拓扑边的关系名说明加入 `scales`。

都是新增，不改变已有字段。`series_key` 与 `reused_from` 是状态库的列，不进入契约中的 `Incident`。

## 考虑过的方案

- **HPA 告警的实体直接改成伸缩对象**：HPA 自己的证据卡（副本数、指标与目标值、伸缩事件）需要 HPA 实体，改掉实体会让这些卡按 Deployment 执行而失去数据；归一放在组件这一层，实体保留告警指向的对象。
- **系列键用告警的标签指纹**：指纹包含 Pod 名之类随发布变化的标签，Pod 级告警每次发布后指纹都变；以归一后的组件为键，同一工作负载的问题在发布前后仍是一个系列。
- **系列键不含告警名，只按根因组件**：同一组件上的内存问题与证书问题会被当成同一个事件的复发；告警名集合把“同一组告警”作为身份的一部分。
- **在引擎里把同一系列的事件按根因合并成一个**：合并会改写已经存在的事件（别名、merged），复发间隔里新出现的不同问题也会被并进去；重开只发生在原事件已经恢复之后，窗口有界，不改写其他事件。
- **复用 issue 时只评论、正文保持开出时的事件**：正文停在已经恢复的旧事件上，读者要翻评论才能看到当前的情况；正文跟随最近的事件，评论保留每次发生的记录。

## 结果

- 实现：`packages/core/src/topology/{graph,kube}.ts`（`scales`、`memberParents`）、`packages/core/src/incidents.ts`（系列键、`reopenWindowMs`、`incidentOccurrences`）、`apps/srenautix/src/incident/{engine,migrations}.ts`、`topology/store.ts`（`ownerOf`）、`eval/reconstruct.ts`、`research/ledger.ts`、`notify/compose.ts`、`github/{issues,migrations}.ts`、`config/server.ts`（`incidents.reopen`）、`roles/server.ts`、`metrics.ts`；契约 `reason-codes.json`、`topology-event.schema.json`。
- 迁移：`incident` 轨道版本 8（`server.incidents.series_key` 与索引），`github` 轨道版本 6（`server.github_issues.reused_from` 与索引），都只加列与索引（ADR 0176）。
- 单元测试（`packages/core/test/incident-series.test.ts`）：`scaleTargetRef` 生成 `scales` 边，HPA 归到 Deployment，有控制者时跟随控制者；实体在 HPA 与 Deployment 之间交替时告警的组件都是 Deployment；一条 HPA 到顶告警在 3 天内 firing/resolved 10 次、实体交替 → 1 个事件、10 个版本、10 次发生；不给窗口时每次复发都是新事件；回看窗口内复发回到原事件；窗口之外复发是新事件，之后的复发回到最近结束的那个；不同组件上的同名告警不合并；系列键与发生次数的合并规则。
- 集成测试（真实 PostgreSQL）：`test/integration/incident-engine.test.ts` 经接入、拓扑（含 `scales` 边）与引擎复现 10 次复发 → 1 个事件、版本 1 为 created、2 至 10 为 reopened、`series_key` 为 `Deployment:shop/api|KubeHpaMaxedOut`，另一个组件与 8 天后的复发各是新事件；`test/integration/github-issues.test.ts` 复用打开的 issue（不新开、不计入每小时上限、审计与终态记录 `reused`、正文换成新事件），恢复评论写第 2 次发生、本次 10 分钟、累计 40 分钟，人关闭之后不再复用。
