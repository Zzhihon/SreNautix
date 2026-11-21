# 0208 事件根因子图：逻辑组件展开、声明依赖、宿主机底座与边分档

状态：已采纳

## 背景

全集群地图（ADR 0199、ADR 0200、ADR 0205）上线后，事件详情页里的根因子图（`GET /v1/incidents/:ref/subgraph`）与地图之间出现三处割裂：

1. **逻辑伪组件根因画成孤立单点**：许多事件的根因是领域包产生的逻辑组件（例如 `component:gateway`、`component:pg`、`component:archive-exporter`）。`server.topology_events` 里没有逻辑组件的边，`subgraphOf` 只查对象图，结果事件详情页里画出一个孤立节点，看不到上下游与受影响面。
2. **缺少领域包声明的依赖，同时被网络策略放行边淹没**：`business.yaml` 声明的依赖（ADR 0200，`provenance: declared`）只在 `clusterMap` 里注入，没有进入 `subgraphOf` 与邻域图；与此同时，`< 0.6` 的 `network_policy` 放行边在两跳展开时把大量无关工作负载拉进子图，画面退化成蛛网。
3. **宿主机底座可见性与历史回放割裂**：Deployment 经 `ReplicaSet → Pod → Node` 需要 3 跳，两跳子图看不到宿主机；Pod 根因经过宿主机又会反向拉入同节点上的全部无关 Pod。事件详情页也没有直达全集群地图发生时刻的入口，地图回放时间轴固定在最近 24 小时，超出 24 小时的历史事件无法直接回放。

## 决定

不修改 OpenAPI 契约（`contract/schemas/topology-event.schema.json` 已包含 `declared` 来源，`Subgraph` 结构不变），在核心、服务端与控制台做四项改进：

### 1. 根因子图富化（`packages/core/src/topology/subgraph.ts`）

`buildIncidentSubgraph` 基于时间点拓扑快照与当前领域包的服务目录构建子图，由 `apps/srenautix/src/console-bff/routes-incidents.ts` 的 `subgraphOf`（事件子图）与 `apps/srenautix/src/console-bff/routes-system.ts`（邻域图）调用；未传入服务目录的调用方（例如通知）继续沿用原有的逐跳查询。

- **逻辑组件展开**：优先按 `mapPlacer`（ADR 0203）命中同名真实工作负载，再按带命名空间的精确匹配、服务目录内的名称包含匹配及小规模服务成员（不超过 4 个）展开为真实工作负载，并将逻辑组件上的成员告警转移到真实节点上。无法映射的外部逻辑组件（例如上游供应商）保留原样。
- **注入声明依赖**：将 `business.yaml` 声明的 `dependencies` 匹配到快照中的节点，生成 `relation: depends_on`、`provenance: declared`、`confidence: 1` 的边，双向参与子图展开。
- **宿主机底座与有界展开**：为顶层工作负载补充直连宿主机的 `runs_on` 边，使 Deployment 在 1 跳内可见宿主机并与同机依赖共享节点；同时在 BFS 中限制非根因 `Node` 不沿 `runs_on` 反向拉入无关 Pod（仅保留同机事件成员或候选），限制 `< 0.6` 的 `network_policy` 边只在第 1 跳出现、不在第 2 跳扩散，也不穿过集群枢纽继续展开。

### 2. 子图三档边过滤与语义编码（`packages/ui/src/domain/subgraph-model.ts`、`packages/ui/src/domain/Subgraph.tsx`）

- 与全集群地图（ADR 0205）保持一致的三档边切换：**核心链路**（`core`）、**全部依赖**（`deps`，默认）、**网络放行**（`allowed`）。
- 默认 `deps` 档展示声明依赖、结构、运行时、配置引用、宿主机 `runs_on` 与 `≥ 0.6` 的网络策略边，隐藏 `< 0.6` 的网络策略放行噪声及仅由它们连出的纯邻居节点，并在工具条显式给出可点击的隐藏边数提示，不静默丢弃数据。
- 按边的语义着色（声明蓝色实线、路由紫色实线、宿主机绿色虚线、运行时信息色、网络策略细点线），为宿主机 `Node` 卡片增加左侧色条与底部紧凑图例。

### 3. 事件详情一键跳转地图发生时刻（`packages/ui/src/views/IncidentView.tsx`）

- 扩展 `Links.clusterMap` 支持可选的 `at` 参数（`packages/ui/src/data.tsx`、`web/console/src/route-params.ts`）。
- 事件详情页的根因子图面板头部增加「在集群拓扑图查看发生时刻」链接，携带事件的 `cluster_id`、`business_domain` 与合法的 `first_firing_at`；时间戳缺失或非法时回退为实时地图链接。

### 4. 地图回放支持 24 小时 / 3 天 / 7 天跨度（`web/console/src/pages/topology.tsx`、`packages/ui/src/domain/MapReplay.tsx`）

- `GET /v1/topology/map/timeline` 服务端已支持最长 7 天、`topology.history_retention` 保留 14 天（ADR 0144、ADR 0205）。地图面板增加 `24 小时 / 3 天 / 7 天` 跨度切换（默认保持 24 小时），并分别采用 15 分钟、1 小时、2 小时切格。
- 从历史事件深链打开带 `?at=` 的地图时，若时刻早于 24 小时自动扩展到 `3d` 或 `7d`；若时刻早于 7 天（仍在 14 天拓扑保留期内），地图照常按 `?at=` 渲染历史快照，回放条显式说明所看时刻早于当前时间轴。
- 请求时间轴时将 `from` 向上对齐到格子边界，确保 `to - from` 始终不超过后端 7 天上限。

## 结果

- 不改动数据库结构、不改动 OpenAPI 契约、不改动 Go spoke。
- 当前与过去 14 天内的所有事件（包括逻辑组件根因与历史已恢复事件）在读取时即自动获得展开后的真实工作负载、声明依赖、共享宿主机底座与低噪声分层子图，并可一键回到发生时刻的全集群地图复盘。
