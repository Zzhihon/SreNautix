# 0011 拓扑的对象图、组件与事件溯源

## 背景

DESIGN §4 要求拓扑以事件形式保存、可以按任意时刻查询，边带来源、置信度与作用范围，集群枢纽单独处理。收敛与根因排序需要两种粒度：作用范围要在对象级判断（节点故障只影响运行在该节点上的 Pod），根因与反馈要落在值班人员认得的组件上（Deployment、CNPG 集群），而不是某一个 Pod。

## 决定

1. **对象图**：节点是 Kubernetes 对象或领域包声明的组件实例，键为 `<kind>:<namespace>/<name>`（集群级对象省略命名空间），名称段按 ADR 0034 转义。边的方向是"from 依赖 to"，to 的故障沿边反向传播到 from。
2. **组件**：`owned_by` 是成员关系，只为 ownerReference 中的控制者生成。沿 `owned_by` 向上的顶层对象就是组件：Pod → ReplicaSet → Deployment，CNPG 的 Pod、PVC、Service → Cluster。其余的边都是依赖边。
3. **边的来源与默认置信度**：结构性 1.0（ownerReference、Pod→节点、Pod→PVC→PV→CSI 驱动、Service 选择器或 Endpoints、Ingress→Service、领域包的 Operator 约定、同节点的枢纽 DaemonSet Pod），运行时观测 0.9，配置引用 0.7（环境变量与被引用 ConfigMap 中的 Service DNS 名、secretKeyRef 的名称），NetworkPolicy 出站规则 0.6，命名推断 0.3。Secret 的内容永远不读；ConfigMap 的值只用于匹配 Service 名，边的依据只写键名。
4. **作用范围**：在对象级可达性中自然体现。从告警实体及其全部成员出发沿依赖边走，`instance` 边只连到具体实例，`service` 边沿服务依赖传播。路径置信度取各边之积的最大值。
5. **枢纽**：组件类型声明 `hub: true` 的对象（CoreDNS、CNI、apiserver）与 CSI 驱动是枢纽。枢纽可以被到达，但不作为中间节点继续展开，避免所有工作负载经它连成一片。
6. **深度**：在组件图上先折叠强连通分量，再取从没有依赖方的组件出发的最长路径长度，只用于根因平分。
7. **事件溯源**：`TopologyStore` 按来源对账完整快照，产生 `node_upsert`、`node_delete`、`edge_upsert`、`edge_delete` 事件，seq 即拓扑版本；`asOf(t)` 取 `valid_from <= t < valid_to` 的节点与边。kube-state-metrics 历史重建写入带起止时间的区间（来源 `ksm_history`），用于回放与观察模式。
8. **实体解析顺序**：告警时刻的拓扑（informer）→ 删除不超过 24 小时的墓碑 → kube-state-metrics 历史（`kube_pod_info`、`kube_pod_owner`、`kube_replicaset_owner`）。都找不到时归入命名空间伪组件 `Namespace:<namespace>`。

## 结果

- 同一份拓扑同时支持对象级的作用范围判断和组件级的根因输出。
- 回放与研判引用的是当时的拓扑版本；被删除的 Pod 在 24 小时内仍能解析到它的组件。
- 枢纽的处理不依赖名单：领域包声明组件类型即可。
