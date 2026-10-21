# 0130 逻辑组件映射到候选工作负载

## 背景

没有对象标签、只带 `component` 或 `service` 标签的告警归入逻辑组件 `component:<值>`（带命名空间时 `component:<命名空间>/<值>`，ADR 0104 §6）。逻辑组件不是拓扑里的对象，于是以它为根因的事件：

- 阶段 A 没有任何证据卡：证据链按组件类型执行，逻辑组件没有组件类型，告警也没有实体；
- 阶段 B 的研判子图是逻辑组件在拓扑里的两跳邻域，也是空的，组件枚举里没有它背后的工作负载，模型提出的根因被删除，假设为空，输出不合 schema，研判失败。

Kind 的 unmapped-alert（kind-e2e 39620204509）就是这样：ShopCatalogStale 只带 `service="catalog"`，事件根因是 `component:catalog`，600 秒内没有证据卡，研判以"/hypotheses must NOT have fewer than 1 items"失败。CCHP 的 `component:cchp-prod/worker`（CCHPWorkerNoAvailableReplicas）同样没有证据卡。

## 决定

1. **映射**（`ComponentExpander.logicalCandidates`，按研判或阶段 A 的时刻读拓扑）：一个逻辑组件的候选来自三种来源：
   - 同名的 Service、Deployment、StatefulSet、DaemonSet；逻辑组件带命名空间时只在这个命名空间里找；
   - 落在这个逻辑组件上的告警的 `service` 标签指向的 Service；告警带 `namespace` 标签时只在这个命名空间里找；
   - 拓扑里前两步找到的 Service 沿 selects 选中的 Pod，再取这些 Pod 的顶层属主。

   候选的顺序是同名的工作负载、Service 选中的工作负载、Service，各自按键排序，最多 6 个。拓扑覆盖（ADR 0104）仍是把告警直接解析到对象的方式；映射只在告警已经归入逻辑组件之后使用。
2. **证据卡**：阶段 A 对根因与告警归属的组件中的逻辑组件做映射，每个候选按自己的组件类型执行证据链（实体是候选对象），与成员告警实体上的证据链合并去重。降级通道不查状态库，不做映射。
3. **阶段 B 的组件**：研判输入的拓扑邻域以事件组件、候选根因与它们映射出的候选为起点；映射本身作为 `maps_to` 边（来源 naming，置信度 0.3，低于归并阈值 τ，不进入假设的范围）放进邻域。worker 的研判子图里候选离逻辑组件一跳，进入根因组件的枚举（ADR 0127）与卡片检查（ADR 0116）。
4. **自愈模板的根因**：逻辑组件只映射出一个工作负载时，模板按这个工作负载匹配与解析目标（ADR 0126）。
5. **Kind**：shop 增加 Service `catalog`（选中 api 的 Pod，api 的 `/catalog` 提供商品目录）。`component:catalog` 经它映射到 Deployment `shop/api`，unmapped-alert 的接入与发现不变。

## 结果

- 实现在 `apps/srenautix/src/topology/expand.ts`（`logicalCandidates`、`hintOf`、`isLogicalComponent`）、`topology/store.ts`（`named`）、`stage-a/pack-evidence.ts`（`LogicalLookup`）、`api/routes-research.ts`（`logicalEdge`）、`remediation/service.ts` 与 `roles/server.ts`；契约不变。
- 集成测试（真实 PostgreSQL、Prometheus 与内置领域包）：同名 Service 与它选中的工作负载、告警的 service 标签、带命名空间的逻辑组件各自的候选；`component:catalog` 的事件在映射之前没有证据卡，之后在 Deployment `shop/api` 上有工作负载证据链的卡；研判输入的邻域里有 api、Service 与 `maps_to` 边，卡片检查包含 api。单元测试覆盖告警线索与研判子图的跳数、组件枚举。
