# 0203 PodDisruptionBudget 的保护边与事件在地图上的落点

状态：已采纳

## 背景

全集群地图（ADR 0199）把事件放到根因的组件上（ADR 0200 §5）。参考部署（CCHP）2026-11-12 正在触发的 20 个事件里只有 2 个放上了地图，其余只计入服务框。放不上的根因：

| 根因 | 事件数 | 原因 |
|---|---|---|
| PodDisruptionBudget | 7 | PDB 不在拓扑里。集群状态检测器（`pdb_blocking`）算出了被保护的工作负载，只写进告警描述 |
| Argo CD Application | 6 | Application 不是有 Pod 的顶层对象 |
| Node | 3 | 节点在地图的节点条上，不是组件 |
| 其他 | 1 | 领域包的伪组件在地图上没有同名组件 |

`pdb_blocking`（`disruptionsAllowed=0`）在被保护的 Pod 全部健康时同样成立，例如 CNPG 主库的 PDB 一直不允许驱逐主库。它说明节点维护会被挡住，不说明工作负载出了问题。

## 决定

### 1. 拓扑里的 `protects` 边

reader（Go，`topology.PDB`）与单集群 informer（TypeScript，`buildKubeTopology`）为每个带 `spec.selector` 的 PodDisruptionBudget 加边：

- reader：PDB → 被选中 Pod 的顶层对象；单集群 informer：PDB → 被选中的 Pod。求组件后两边一致。
- 关系 `protects`，来源 `structural`，作用域 `service`，证据 `spec.selector`。
- 置信度 0.5（`ConfProtects`、`PROTECTS_CONFIDENCE`），低于归并阈值 τ（0.6）：PDB 的事件不并入被保护工作负载的事件，也不进入根因排序与影响范围。HPA 的 `scales` 边（ADR 0184）是 1，因为伸缩确实改变工作负载；PDB 不改变工作负载。
- reader 的 Pod、Namespace、ReplicaSet、Job 变化时重新贡献全部 PDB，与 NetworkPolicy 相同。

### 2. 落点的种类

`GET /v1/topology/map` 的事件带 `placement`（契约 2.64.0）。`mapPlacer` 依次尝试：

| `placement` | 条件 | `component` | 地图上的表现 |
|---|---|---|---|
| `root` | 根因的顶层对象是地图上的组件 | 该组件 | 着色，并沿 ≥0.7 的依赖边标出受影响的组件 |
| `node` | 根因是节点条上的节点 | 节点键 | 节点条上着色并计数，按主服务计入服务框 |
| `protects` | 根因是 PDB，它保护的组件里取唯一一个（先看主服务） | 被保护的组件 | 只给该组件着色，侧栏注明经 PodDisruptionBudget 定位 |
| `named` | 根因是伪组件，取主服务里同名的组件，没有时取全图唯一同名的 | 同名组件 | 同 `root` |
| `null` | 都不命中 | `null` | 只计入服务框 |

只有 `root` 与 `named` 向依赖它的组件传播。`protects` 不传播，原因同 §1；`node` 不传播，节点故障影响的是运行在它上面的组件，节点条已在指向时突出这些组件。

### 3. 不放 Application 的事件

一个 Argo CD Application 管理几十个组件。放到其中任何一个都会误导值班的人，Application 的事件继续只计入服务框。

## 考虑过的方案

- **把 PDB 并入被保护工作负载（与 HPA 相同的成员关系）**：PDB 的事件会并入工作负载的事件。主库 PDB 长期 `pdb_blocking`，会让 PostgreSQL 的每个事件都多一个常驻成员，改变参考部署的事件分组，需要回放评估。
- **在研判引擎里把 PDB 的根因改成被保护的工作负载**：同上，并且改的是已存档事件的根因。
- **地图直接解析告警描述里的保护对象**：描述是给人读的文字，没有契约。

## 结果

- 事件归并、根因排序与地图的影响范围只用 ≥τ 与 ≥0.7 的边，`protects` 边不改变它们。
- 参考部署上线后的落点数在部署记录里核对。
