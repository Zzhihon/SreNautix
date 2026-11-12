# 0200 网络策略放行的边与领域包声明的依赖

状态：已采纳

## 背景

全集群地图（ADR 0199）上线后，参考部署（CCHP）的网关到 PostgreSQL、Dragonfly、NATS 没有依赖边。数据库出事件时，网关不会被标为受影响。

在集群上核对了原因：

- 网关、控制面、后台任务与归档导出都从 Secret `cchp-runtime` 读取 `DATABASE_URL`、`DRAGONFLY_URL`、`NATS_URL`。reader 不读 Secret 的值，配置引用推不出这几条依赖。
- `cchp-prod` 没有 CiliumNetworkPolicy，也没有出站规则。放行写在数据库一侧的 NetworkPolicy 入站规则里，例如 `cchp-data/postgresql-ingress` 允许命名空间 `cchp-prod` 访问 `cnpg.io/cluster=cchp-postgres` 的 Pod。reader 只解析出站规则。
- 集群里另有 29 条 CiliumNetworkPolicy（cloudflared、Argo Workflows、SreNautix 自己），reader 不读。

网络策略推出的边置信度是 0.6，等于归并阈值 τ（0.6），会参与事件归并、根因排序与影响范围。给新的推断边同样的置信度会改变参考部署的事件分组，这个变化需要单独用回放评估。

## 决定

### 1. NetworkPolicy 的入站规则

reader（Go，`NetworkPolicyEdges`）与单集群 informer（TypeScript，`buildKubeTopology`）同时解析出站与入站规则，边都是 `egress_to`（from 的 Pod 被允许访问 to 的 Pod），两端取顶层 owner：

| 规则 | 边 | 置信度 |
|---|---|---|
| 出站：被选中的 Pod → 对端 | 不变 | 0.6 |
| 入站：对端 → 被选中的 Pod | 新增 | 0.5（`ConfPolicyAllowed`、`POLICY_ALLOWED_CONFIDENCE`） |

同一对组件既有出站又有入站的放行时保留置信度高的一条。入站规则里“命名空间内全部 Pod 互相放行”（策略与对端的 podSelector 都为空、对端不跨命名空间）不产生边：参考部署 `observability-communication` 一条这样的规则就会产生 650 对。

### 2. CiliumNetworkPolicy

reader 新增内置识别器 `ciliumPolicy`（`cilium.io/v2` 的 `ciliumnetworkpolicies`，chart 的只读权限加上这个资源）。`endpointSelector` 选中的 Pod 与 `egress.toEndpoints`、`ingress.fromEndpoints` 选中的 Pod 之间产生 `egress_to` 边，置信度 0.5：

- 选择器的键去掉来源前缀（`k8s:`、`any:`），按 Pod 标签加上 `io.kubernetes.pod.namespace`、`io.cilium.k8s.namespace.labels.<键>`、`io.cilium.k8s.policy.serviceaccount` 求值；没有提到命名空间时只看策略所在的命名空间。
- `toEntities`、`toFQDNs`、`toCIDR` 不对应集群里的对象，不产生边；用到其他来源前缀（例如 `reserved:`）的选择器跳过。
- `spec` 与 `specs` 都读；“全部端点互相放行”同样不产生边。
- 这种识别器要查询 Pod，实现 `LookupRecognizer`；Pod、命名空间变化后与 NetworkPolicy 一起重算。

CiliumClusterwideNetworkPolicy 不在范围内。

### 3. 置信度 0.5

0.5 低于 τ：这些边进入拓扑存储，画在拓扑、邻域图与全集群地图上，不参与事件归并、根因排序与地图的影响范围（ADR 0199 §4 的 0.7）。地图侧栏的“它依赖 / 依赖它的”只列出 τ 以上与声明的边，只被网络策略放行的组件只给数量，例如“另有 26 个只被网络策略放行”。要让它们参与归并，先用回放比较事件分组再调整。

### 4. 领域包声明的依赖

`business.yaml` 新增 `dependencies`（契约 2.62.0）：

```yaml
dependencies:
  - from:
      - { kind: StatefulSet, namespaces: [cchp-prod], name_pattern: '^gateway$' }
      - { kind: Deployment, namespaces: [cchp-prod], name_pattern: '^(control|worker|archive-exporter)$' }
    to:
      - { kind: Cluster, api_group: postgresql.cnpg.io, namespaces: [cchp-data], name_pattern: '^cchp-postgres$' }
    reason: 四个工作负载都从 Secret cchp-runtime 读取 DATABASE_URL
```

- 条件是 `ComponentMatch`，按 kind、命名空间与名称核对（`matchesByName`）；带 `labels` 的条件无法核对，加载时报错。
- `clusterMap` 在命中 from 与 to 的组件之间加一条 `depends_on` 边，来源是新的 `declared`、置信度 1；已有推出的边时并入它。影响范围沿这些边传播，网关因此在数据库出事件时被标为受影响。
- 声明的依赖不进入拓扑存储，也不参与事件归并；服务目录的 `inputs()`（归属的指纹）不含它们，改依赖不触发重新归类。

### 5. 根因放到地图上

`mapPlacer` 在内存里的拓扑上求根因的顶层对象，替代每个事件一次的数据库查询。根因是领域包的伪组件（`component:gateway`）时，取主服务里同名的组件，没有时取全图唯一同名的组件。参考部署 2026-11-12 正在触发的 21 个事件里有 20 个的根因是伪组件，原来都只能计入服务框。

## 考虑过的方案

- **新的推断边用 0.6**：与出站一致，但入站规则多是按命名空间放行，比出站规则粗；直接参与归并会改变参考部署的事件分组，没有评估过。
- **只解析 CiliumNetworkPolicy**：参考部署的 `cchp-prod` 没有 Cilium 策略，网关的缺口还在。
- **把声明的依赖写进拓扑存储**：研判引擎会立刻用上它们，效果同上，需要回放评估。
- **按服务声明依赖（gateway 依赖 postgres）**：服务里有入口路由、cloudflared 这类不连数据库的组件，按服务展开会画出不存在的依赖。

## 结果

用参考部署 2026-11-12 的 Pod、命名空间与 NetworkPolicy 核对（TypeScript 实现，规则与 reader 相同）：

- 入站规则推出网关、控制面、后台任务、归档导出到 PostgreSQL、Dragonfly、NATS 的边。
- 去掉命名空间内互相放行后，入站规则推出约 1170 对工作负载（去掉前约 1800 对），大多是观测命名空间的抓取与发布流水线的门禁。
- 出站规则推出的边不变，研判引擎的输入不变。

参考部署 `cchp-data/data-replication-and-backup` 的出站规则（`podSelector: {}` 到 `podSelector: {}`）在命名空间内互相放行，推出 PostgreSQL、Dragonfly、NATS 两两之间 0.6 的边，参与归并。出站规则是否同样跳过命名空间内互相放行，需要回放评估后另行决定。
