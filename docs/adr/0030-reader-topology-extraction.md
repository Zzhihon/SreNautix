# 0030 reader 从集群对象提取拓扑

## 背景

DESIGN §4.1–§4.2 要求拓扑以事件形式保存（`valid_from` / `valid_to`），边带来源与置信度；§3.3 要求实体解析依次查 informer 缓存、24 小时墓碑、kube-state-metrics 历史。多集群安装时由各分支的 reader 产生拓扑事件并推送给中心。reader 只有只读权限，不能读取 Secret；配置引用边只能使用名称。

同一节点或边可能由多个对象贡献：一个 Deployment 的每个 Pod 都贡献同一条"Deployment 引用某 Service"的配置引用边；一个 Node 既是自己的对象，也被每个 Pod 的 `spec.nodeName` 引用。某个贡献者消失时，边不能随之消失。

## 决定

1. **按贡献者累计**：拓扑存储（`internal/spoke/reader/topology.Store`）以"来源对象"为单位保存贡献（节点与边）。每次对象变化用新的贡献整体替换旧的贡献，再为每个被触及的节点或边重新选出生效值：
   - 节点：对象自己的贡献（`Own`）优先，其余是从引用推出的占位节点（只有键，没有 UID 和标签）。
   - 边：取置信度最高的贡献。
   - 生效值变化才产生事件；最后一个贡献者撤回时产生删除事件。
   - 同一批事件里，节点新增在前、边在中间、节点删除在后，消费者按序应用时看不到指向不存在节点的边。
2. **序号与时间**：集群内事件序号连续递增，也是拓扑版本。首次列举的对象以创建时间作为 `valid_from`，之后的变化用 apiserver 参考时间（ADR 0031）。同一节点或边的 `valid_from` 不早于它上一条事件的 `valid_from`，区间不会倒置。
3. **边的来源**：

   | 关系 | 来源对象 | 来源类别与置信度 | 作用范围 |
   |---|---|---|---|
   | `owned_by` | 任意对象的 `ownerReferences` | structural 1.0 | service |
   | `runs_on` | Pod `spec.nodeName` | structural 1.0 | instance |
   | `mounts` | Pod 的 PVC 卷与通用临时卷 | structural 1.0 | instance |
   | `bound_to` | PVC `spec.volumeName` | structural 1.0 | instance |
   | `provisioned_by` | PV `spec.csi.driver` → `CSIDriver`（集群枢纽） | structural 1.0 | instance |
   | `csi_node_plugin` | PV → 使用它的 Pod 所在节点上该驱动的 node plugin Pod（带 `csi-node-driver-registrar`，注册路径含驱动名） | structural 1.0 | instance |
   | `selects` | EndpointSlice 的 `targetRef` → Service 选中的 Pod | structural 1.0 | service |
   | `routes_to` | Ingress 后端、HTTPRoute `backendRefs` | structural 1.0 | service |
   | `attached_to` | HTTPRoute `parentRefs` → Gateway | structural 1.0 | service |
   | `managed_by` | Argo CD Application `status.resources`（目标为本集群时）、Flux Kustomization `status.inventory` | structural 1.0 | service |
   | `operator_convention`、`primary`、`replica` | CNPG Cluster：`<名称>-rw/-ro/-r` Service → Cluster；Cluster → `status.currentPrimary` 与其余 `status.instanceNames` | structural 1.0 | service |
   | `references` | Pod 的环境变量与 ConfigMap 值中的 Service DNS 名、ConfigMap 名、`secretKeyRef`/`envFrom`/卷中的 Secret 名 | config_ref 0.7 | service |
   | `egress_to` | NetworkPolicy 出站规则允许的对端 Pod | network_policy 0.6 | service |

4. **配置引用与 NetworkPolicy 边的端点**：起点和终点都取 Pod 的顶层 controller owner（例如 Pod → ReplicaSet → Deployment；静态 Pod 的顶层 owner 是 Node，集群级 kind 的键不带命名空间，写作 `Node:<节点>`），每个工作负载只有一条边，Pod 滚动更新不会改变它。
5. **只读名称**：环境变量字面值与 ConfigMap 的值只在 reader 进程内用于匹配 Service DNS 名，不进入任何输出；证据字段只写"env DB_HOST"、"ConfigMap app-config key upstream"。Secret 从不读取，名称只从 Pod spec 的引用中得到。整个值就是 `<svc>` 或 `<svc>:<port>` 时才识别同命名空间的短名，`info`、`true` 之类的普通取值即使与某个 Service 同名也不产生边。
6. **派生贡献的重算**：配置引用、CSI node plugin、NetworkPolicy 边依赖其他对象（ConfigMap、Service、PV、命名空间标签、ReplicaSet）。这些对象变化时，把受影响的派生贡献标为待重算，每 2 秒批量重算一次，避免一个 ConfigMap 变化触发上千次即时重算。
7. **自定义资源**：识别器（`topology.Recognizer`）声明要监听的资源。reader 每分钟做一次资源发现，只为 apiserver 实际提供的资源启动 informer；资源消失时停止 informer 并撤回它的全部贡献。领域包声明的 Operator 约定通过同一接口接入。
8. **Pod 的镜像**：Pod 节点带 `images`，内容是普通容器 spec 中的 `image` 与 status 中的 `imageID`（digest）。中心用它把发布之前的迁移 Job 关联到发布（ADR 0104 §13 第 2 档）。
   - 每个引用按中心的 `normalizeImage` 规范化：去掉运行时前缀，带 digest 的只保留 `sha256:…`，其余转小写。结果去重、按字典序排列，没有镜像时省略。
   - init 容器不计入，与 kube-state-metrics 的 `kube_pod_container_info` 一致。等待迁移的 init 容器可能与迁移 Job 用同一个镜像，计入后第 2 档会因 init 镜像误判为匹配，实时拓扑与按 kube-state-metrics 回放的结果也会不同。临时容器同样不计入。
   - 只读镜像引用，环境变量与 Secret 都不进入节点。
9. **墓碑**：删除的对象保留 24 小时，按组件键和 Pod IP 索引，记录创建与删除时间、所在节点和顶层 owner。查询带时刻时，只返回在该时刻存活的对象；同一个键先后对应多个对象（例如 StatefulSet 的 Pod 重建）时全部保留。

## 结果

- 中心按事件流重放得到的拓扑，与 reader 本地的快照逐项一致（envtest 测试 `TestWatcherBuildsTopologyFromLiveCluster` 校验）。
- 配置引用边不携带任何配置取值，reader 的 RBAC 不含 Secret，满足不变量 1。
- 派生边最多延迟 2 秒；依赖对象很多时重算成本按批次计算，与变化次数无关。
- kube-state-metrics 历史重建得到的事件使用同一套节点键与关系名（ADR 0033），回放与实时拓扑可以直接比较。
