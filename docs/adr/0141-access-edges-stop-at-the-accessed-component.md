# 0141 访问边只到被访问的组件为止：失败的迁移 Job 不经数据库的 Pod 并入节点告警

## 背景

ADR 0140 的 what-if 回放（在重建包副本里给失败的迁移 Job 加上现在 reader 会生成的 `egress_to` 边）里，bypassrls-2 的 KubeJobFailed（04:05）与 storage-01、storage-03 上从 02:34 开始的 NodeMemoryRequestsNearAllocatable 合并成一个事件，事件标签取 `Node:storage-03`。开始时间相差 91 分钟，在 ADR 0104 §10 的 2 小时之内。迁移前检查失败（迁移账号没有 BYPASSRLS）与节点的内存请求接近可分配量没有因果关系，这是过度合并。

合并路径（what-if 副本，04:20 重算收敛，逐对打印依赖路径）：

```
Job:cchp-prod/cchp-migrate-67a9ece70780
  -egress_to(0.6, network_policy)-> Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres
  -primary(1)-> Pod:cchp-data/cchp-postgres-2 -runs_on(1)-> Node:storage-03
  -replica(1)-> Pod:cchp-data/cchp-postgres-3 -runs_on(1)-> Node:storage-01
```

路径置信度 0.6，等于合并阈值 τ。不是 Job 自己的 `runs_on`：Job 的 Pod 运行在 appservice-01 上，这个节点没有告警。数据库在整个窗口里没有任何告警。

原因在可达的展开方式。可达从告警的对象出发，沿置信度不低于 τ 的边取最大乘积路径。两条网络策略边相乘是 0.36，低于 τ，所以合并只会经过一条 `egress_to`。但到达被访问的对象之后，置信度为 1 的结构边会继续展开：CNPG Cluster 的 `primary`、`replica` 到它的 Pod，再经 `runs_on` 到 Pod 运行的节点（存储同理）；Deployment 经 `managed_by` 到管理它的 Argo 应用。调用方因此能到达被访问组件运行的节点与管理它的应用。这些是被访问组件自己的放置与管理，不是调用方使用的服务。

这不只发生在一次性 Job 上：任何带 `egress_to` 边、指向数据库的工作负载，都会这样与数据库所在节点上的告警合并。

## 决定

**访问边只到被访问的组件为止**（core `TopologyGraph.reach`）：经 `egress_to`（`ACCESS_RELATIONS`）到达一个对象之后，只沿目标仍在这个组件内部的边展开。调用方能到达被访问的组件本身和它的成员（数据库的主库与备库 Pod），不能再经这些成员到达它们运行的节点、挂载的存储，也不能到达管理被访问组件的应用。

- 被访问组件受到下游的影响时，自己通常也有告警，比如节点 NotReady 时，主库 Pod 就绪失败。这时调用方的告警经数据库 Pod 与它合并，数据库 Pod 的告警再经 `runs_on` 与节点告警合并，三者仍在一个事件里。被访问组件没有任何告警时，没有证据表明节点的情况影响到了调用方。
- 与 ADR 0104 §13、ADR 0140 的作用对象一致：作用对象也只取 `egress_to` 指向的组件，不再往下扩展。
- 同一个对象可能有两条路径，一条经访问边、一条不经过，所以展开时记录对象与限制（不受限制，或受限于某个组件）组成的状态。经其他路径不受限制地到达的对象照常展开。
- 合并（τ）与候选排序（置信度 0）的可达都按这条规则，两边的依赖含义一致。`graph.reach` 只有收敛与排序在用。
- 枢纽的规则不变：可以被到达，但不作为中间节点展开。

不采用的做法：

- **一次性 Job 的 `runs_on` 与节点依赖不作为合并的依据**：
  - 这次的路径不是 Job 自己的 `runs_on`。
  - 只对 Job 生效治标不治本：长期运行的工作负载只要有指向数据库的 `egress_to` 边，就会经同一条路径与数据库节点上的告警合并。
  - Job 自己的 Pod 运行的节点是真实的故障路径（驱逐、OOM、节点 NotReady 都会杀掉 Job 的 Pod），与其他 Pod 适用同一条对象级作用范围（DESIGN §4）。
- **合并要求时间相邻，并且依赖方向与故障传播方向一致**：这次两条都满足。节点在上游、先开始，方向与传播一致；节点告警一直在触发，与 Job 告警时间相邻；开始时间相差 91 分钟，在 §10 的 2 小时之内。
  - 能拆开这次合并的窗口（小于 91 分钟）只是碰巧拆开：同一条节点告警照样会并入 03:00 失败的 Job。
  - 缓慢传播的真实故障（数据库磁盘逐渐写满）需要 §10 的窗口。
  - 另一种做法是"由变更解释的告警不按依赖合并变更之前开始的告警"。这样数据库在迁移之前已经在告警、迁移因此失败时，两者会被拆开，而这正是 ADR 0140 要让数据库成为候选的情形。
- **把同样的规则用到所有跨组件边**（`references`、`selects`、`routes_to`）：这会改掉 DESIGN §4 的作用范围（frontend 经 api 的 Pod 到达 node-1，`topology.test.ts` 覆盖）。配置引用写的是调用方实际使用的服务地址，比"网络策略允许访问"更强。留下的已知差异：引用数据库 Service 的工作负载，仍经 Service → `selects` → Pod → `runs_on` 到达数据库运行的节点。CCHP 线上的迁移 Job 只经 `egress_to` 到达数据库：它引用的 Secret、ConfigMap 在 cchp-prod，没有到数据库的边（release-rollback-failed 包里 reader 记录的 `cchp-migrate-147f17829ea1`）。

## 回放

17 个标注故障的发现回放（本地重建包，不连集群）。领域包取 cchp-k8s-ops `a7396a2` 的导出副本（`sha256:402ed4d6…`），代码分别是 a1bdd06 与本 ADR。"加边"与 ADR 0140 相同：在副本里给两个失败的迁移 Job 加上指向 pg Cluster 与 CoreDNS 的 `egress_to`，置信度 0.6。原始包与标注不动。

| 输入 | 代码 | 通过 | 根因命中 | 每次故障的事件数（平均 / 最多） | unlabelled |
|---|---|---|---|---|---|
| 原包 | a1bdd06 | 14/17 | 14/15 | 1.71 / 5 | 7/59 |
| 原包 | 本 ADR | 14/17 | 14/15 | 1.71 / 5 | 7/59 |
| 加边 | a1bdd06 | 14/17 | 14/15 | 1.71 / 5 | 7/60 |
| 加边 | 本 ADR | 14/17 | 14/15 | 1.71 / 5 | 7/59 |
| 加边，bypassrls-1 的 Job 新建时刻取 01:22 | a1bdd06 | 15/17 | 15/15 | 1.65 / 5 | 6/59 |
| 加边，bypassrls-1 的 Job 新建时刻取 01:22 | 本 ADR | 15/17 | 15/15 | 1.65 / 5 | 6/58 |

- **原包**：17 行逐行相同（事件数、主事件根因、窗口事件数）。原包里失败的迁移 Job 没有 `egress_to` 边。
- **加边**：只有 bypassrls-2 改变。
  - a1bdd06：节点告警事件 `Node:storage-03:02:30` 吸收了 Job 的失败与流水线告警，窗口里共 4 个事件。
  - 本 ADR：两条节点告警各自成事件；`component:release` 的事件只包含 KubeJobFailed、ArgoWorkflowsReleaseFailed、CCHPReleaseBreakerOpen 与两条 CCHPPostDeployAnomaly；窗口里共 3 个事件。
  - 故障事件数仍是 1。04:20 的候选是迁移 Job（0.35）、`component:release`（0.35）与 pg Cluster（change，0.21），没有节点。
- **加边并修正时刻**：bypassrls-1 是 1 个事件，01:35 的候选是迁移 Job 与 pg Cluster。bypassrls-2 同上。
- 只加边时 bypassrls-1 仍不通过，原因是 kube-state-metrics 5 分钟步长下 Job 的新建时刻偏晚（ADR 0140"数据与标注"），与本 ADR 无关。
- 每个故障的事件数在三种输入上都没有上升。16:30Z 发布事故（release-rollback-failed）仍是 1 个事件，窗口里 7 个事件。pg 类（pg-sync 4、pg-lock 5、barman×3 各 1）不变。

## 结果

- 实现：`packages/core/src/topology/graph.ts`，`ACCESS_RELATIONS` 与 `reach` 的受限展开。
- 测试：`packages/core/test/access-edge-reach.test.ts`，夹具按 bypassrls-2 的 what-if 搭建，覆盖三点：
  - Job 经 `egress_to` 到达数据库与它的 Pod，但到不了节点；数据库自己出发仍能到达节点；
  - 失败的迁移 Job 与 02:34 起的节点请求告警分属不同事件，数据库仍是候选，节点不是；
  - 数据库主库 Pod 自己有告警时，Job、数据库与节点告警仍合并为一个事件。

  不带本 ADR 的修改时，前两条失败。
- ADR 0140 回放一节留下的"04:20 的主事件里仍有这两条节点资源请求告警"由本 ADR 处理。
