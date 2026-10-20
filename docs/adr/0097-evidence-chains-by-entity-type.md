# 0097 证据链按实体的组件类型执行，告警目录只作补充

## 背景

CCHP 影子部署的 26 份阶段 A 报告证据卡全部为 0，11 次研判结论全是 inconclusive。原因有三处：

1. 阶段 A 只为带告警目录条目的成员告警执行证据链。CCHP 的告警自带 `role` 标签，分类来源是 label，`catalog_entry` 为 null，目录声明的证据链从不执行；根因的组件类型又只从拓扑节点上取。
2. 按标签解析出的实体用告警里的小写 kind（`node:storage-01`、`pod:…`），节点告警还带着抓取目标的命名空间（`node:observability/storage-01`），与拓扑键 `Node:storage-01` 对不上，组件类型查不到。
3. 静态 Pod 的属主是 Node 时，informer 用 Pod 的命名空间拼出属主的键，拓扑里出现虚构的 `Node:kube-system/control-plane-0x`。

## 决定

1. **证据链按实体执行**：每个能解析出实体的成员告警，不论分类来源（label、catalog、expression、default），都按实体的组件类型执行领域包的证据链；告警归属的组件（例如 Pod 的属主 StatefulSet）与实体不同时，组件类型的证据链也执行。告警目录条目声明的证据链作为补充。按标签分类时目录照样查找，`catalog_entry` 照样记录。
2. **组件类型**：先取拓扑节点上由领域包匹配出的类型；没有拓扑节点或没有匹配时，按 kind、命名空间与名称静态匹配（领域包的自定义 kind，例如 provider、cluster，以及告警里的 CRD 对象走这一条）。静态匹配跳过带 `labels` 约束的类型；`api_group` 无法核对，视为满足。
3. **最具体的类型优先**：一个对象匹配多个组件类型时取约束最多的（labels 的个数，加上 name_pattern、namespaces、api_group 各算一个），只按 kind 匹配的类型是兜底，不会抢走领域包里更具体的类型；约束个数相同时按声明顺序。
4. **实体的规范写法**：告警标签里已知的 Kubernetes kind 统一成规范大小写（node → Node，pvc → PersistentVolumeClaim，以及 Application、Certificate 等领域包使用的 CRD）；集群级对象（Node、PersistentVolume、ClusterRole 等）忽略 namespace 标签；`kubernetes_node` 标签与节点级抓取任务（node-exporter、kubelet、cAdvisor）的 `instance` 映射到 Node；`entity_kind: none` 表示没有实体。领域包的自定义 kind 原样保留，并保留 namespace。
5. **保留标签与目录给出的实体**：标签契约（entity、entity_kind）与目录映射给出的实体即使拓扑里没有（自定义 kind、CRD 对象、删除超过 24 小时的对象）也保留，按它执行证据卡；只按标签推断（pod、node 等）出的实体必须在拓扑中找到。
6. **集群级属主**：informer 与 kube-state-metrics 历史中，属主是集群级 kind 时属主的键不带命名空间。

## 结果

- 用 CCHP 种子里 208 个事件的 3027 条真实告警跑阶段 A（没有拓扑，证据卡对空的 Prometheus 执行）：修改前 0 个事件有证据卡；修改后只用内置领域包（含通用包按 kind 兜底的组件类型）时 153 个事件共 6375 张卡，加上 cchp 领域包后 207 个事件共 9826 张卡，每个事件中位数 45 张。
- 告警多的事件证据卡变多，阶段 A 的取数量随之增加，仍受 40 秒期限与并发上限约束。
- 依赖告警目录的旧行为不变：目录链照样执行。
