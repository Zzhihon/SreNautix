# 0183 告警类别：领域包声明、标签覆盖、部署方规则，事件的类别与列表筛选

## 背景

排查时经常要取"最近 N 天和业务可用性、性能相关的告警，去掉外部上游的"这样一份清单（Zzhihon/SreNautix#44）。`GET /v1/incidents` 只能按 `state`、时间、`severity`、`component`、`q` 筛选，事件上没有"这是哪一类问题"的属性：严重度描述规则自己的阈值，角色（cause、symptom 等，DESIGN §3.2）描述告警在因果链上的位置，两者都回答不了"它是可用性问题还是观测链路自身的问题"。

不同部署的告警规则标签不同（`layer`、`team`、`component` 的取法各不一样），类别的来源要同时覆盖三种情况：仓库自带领域包里的通用告警（kube-prometheus-stack、各中间件的社区规则）、部署方自己的规则、以及部署方想对某条通用告警改判的情况。

## 决定

### 1. 类别的取值

`AlertCategory`（契约 2.46.0，`common.schema.json`）：

| 类别 | 判断标准 | 典型 |
|---|---|---|
| `availability` | 工作负载或数据服务不能正常提供服务：停止、崩溃、未就绪、副本不足、请求失败、证书过期导致握手失败、数据卷写满、复制中断、主库切换 | `KubePodCrashLooping`、`KubeDeploymentReplicasMismatch`、`KubePersistentVolumeFillingUp`、`CNPGClusterHACritical`、`NGINXTooMany500s` |
| `performance` | 仍在提供服务，但变慢或接近容量：延迟、限流、饱和、积压、复制延迟、连接数接近上限、扩容到顶 | `KubeHpaMaxedOut`、`CPUThrottlingHigh`、`PostgreSQLSlowQueries`、`KafkaConsumerLag` |
| `provider` | 集群外部的上游服务方：模型服务方、云厂商接口、第三方支付 | 仓库自带的包没有这一类，由部署方的标签或规则给出 |
| `platform` | 工作负载之下的集群基础设施：节点与 kubelet、控制面与 etcd、存储系统、入口控制器的配置、GitOps 交付、集群容量与配额 | `KubeNodeNotReady`、`KubeAPIDown`、`etcdNoLeader`、`LonghornVolumeStatusCritical`、`ArgoCdAppSyncFailed`、`KubeQuotaExceeded` |
| `observability` | 监控与告警链路自身：Prometheus、Alertmanager、prometheus-operator、kube-state-metrics、抓取目标、导出器错误、指标缺失 | `TargetDown`、`PrometheusRuleFailures`、`AlertmanagerFailedToSendAlerts`、`CNPGInstanceMetricsAbsent` |

同一条告警同时符合多条标准时，按告警直接描述的现象判断：节点内存压力导致驱逐是 `platform`（`KubeNodeEviction`），被驱逐的工作负载副本不足是 `availability`（`KubeDeploymentReplicasMismatch`），两条告警进入同一个事件时事件同时带两个类别。容量趋势归入它会耗尽的东西：工作负载的数据卷是 `availability`，节点文件系统是 `platform`。

`IncidentCategory` 是 `AlertCategory` 加 `unclassified`：标签、告警目录与部署方规则都没有给出类别。

类别、严重度、角色与紧急度（ADR 0182，`Incident.urgency`）是四个相互独立的属性：紧急度由标签规则、拓扑距离与实测业务影响计算，不读类别；类别只由标签与声明决定，不读紧急度。两者都用 ADR 0166 的匹配器写部署方规则，都给 `GET /v1/incidents` 增加筛选，筛选条件之间是"且"。

### 2. 一条告警的类别

按顺序取第一个给出类别的来源（packages/core 的 `AlertCatalog.category`）：

1. **标签** `srenautix_category`：取值在 `AlertCategory` 里时直接采用。取值不合法（包括 `unclassified` 与空串）时忽略这个标签，按后面的来源继续，每次分类计一次 `srenautix_alert_category_label_invalid_total{alertname}`，每个（告警名，取值）在进程内写一次警告日志。
2. **告警目录条目**的 `category`（`alert-catalog-entry.schema.json`，可选）：取标签最具体的命中条目（与角色分类相同的 `lookup`）。
3. **部署方规则** `ingest.category_rules`：有序的表，每项是 ADR 0166 的匹配器（`labels`、`exclude_labels`）加 `category`，取第一条命中的。规则只给告警目录没有声明类别的告警（部署方自己的规则、第三方包里没有声明的条目）；要改判一条通用告警，在规则上加 `srenautix_category` 标签。
4. 都没有时为 `unclassified`。

结果写进 `Alert.classification` 的 `category` 与 `category_source`（`label`、`catalog`、`rule`、`default`）。拓扑覆盖（`docs/server/README.md` 的"拓扑覆盖"）只改角色与归属，类别照常按上面的顺序求出。`reresolve` 在组件或类别变化时都通知事件流水线重算。

优先级的理由：标签写在告警规则旁边，是规则作者对这一条告警的明确判断；领域包的声明来自对上游规则的逐条审阅；部署方规则是按标签批量归类的兜底，不应该覆盖逐条的判断。

### 3. 事件的类别

- 成员 `IncidentMember.category`：成员告警的类别；之前版本接入、还没有重新解析的告警按 `unclassified`。
- `Incident.categories`：当前成员（`left_version` 为空）类别的并集，按字典序排列、不重复；没有当前成员（合并掉的事件）时取全部成员。
- `Incident.primary_category`：根因组件上的当前成员中最严重的一个的类别；根因组件上没有成员（没有根因、沉默根因）时取全部当前成员中最严重的一个；同样严重时取开始更早的，再按 `alert_id`。

类别变化不改变事件版本：版本只随成员、根因与重开变化（DESIGN §2.2），类别是成员属性的汇总，变化时事件与 `updated_at` 照常更新。

### 4. 存储与历史事件

`incident` 迁移 8 给 `server.incidents` 增加 `categories text[]`、`primary_category text` 与 `categories` 的 GIN 索引，只改 schema（ADR 0176）。事件引擎写入时两列与 body 一起写；packages/core 给出的事件（含合并掉的事件）没有类别时写入立即失败。

之前版本写下的事件由数据修正 `incident/categories` 在取得主实例之后补写一次：只改两列为空的行，每批 500 个。成员的类别按当前的告警目录与规则重算：告警还在 `alert_state` 时用它的完整标签，已经不在时只按告警名查目录（命中没有 `match_labels` 的条目），按标签匹配的部署方规则对这些成员不生效，求不出时为 `unclassified`。补写成员的 `category`、body 的 `categories` 与 `primary_category` 和两列；`incident_versions` 中的历史版本不改。

成员优先按完整标签重算：告警还在状态库时，完整标签能让 `srenautix_category` 标签与部署方规则对历史事件同样生效，与新事件的口径一致；只有告警已经清理掉的成员退回按告警名。修正执行之前，列表摘要的类别按 body 的成员计算（没有类别的成员为 `unclassified`），按类别包含的筛选不命中这些行，按类别排除的筛选不去掉它们。

### 4.1 类别解析的输入变化后重新分类

部署方给领域包补上 `category`、或者修改 `ingest.category_rules` 之后，已经写成 `unclassified` 的事件也要按新的输入分类，历史时间窗的列表与导出（ADR 0186）才和新事件一致。server 取得主实例、数据修正完成之后，在后台检查一次（`incident/recategorize.ts` 的 `startRecategorize`，不阻塞其他单活工作）：

1. **输入指纹**：`AlertCatalog.categoryInputs()` 列出全部已加载领域包的目录条目的 `alertname`、`match_labels` 与 `category`（没有声明时为 null），条目按告警名排序、同名的按 `lookup` 的查找顺序排列，后面是有序的 `ingest.category_rules`；指纹是它的规范化 JSON（RFC 8785）的 sha256。条目的标题、角色、证据链与包名不决定类别，不在输入里：只改这些的升级不触发重新分类；包的先后决定同样具体的条目谁先命中，因此会改变指纹。
2. **是否执行**：指纹与 `server.incident_recategorizations`（`incident` 迁移 10）最近一行的指纹相同时不做事；不同（包括还没有记录）时执行。全部批次完成后插入一行：指纹、执行的实例、改写的事件数、回写的告警数与起止时间。
3. **改写的范围**：逐个集群、按 `incident_id` 分批（每批 500 个，一批一个事务）扫描 body 里有 `unclassified` 成员的事件（含已恢复与合并掉的事件）。只重算 `unclassified` 成员，规则与 `incident/categories` 相同：告警还在 `alert_state` 时用完整标签，已经不在时按告警名查目录；已有其他类别的成员不改，当时的标签覆盖与判断保留。至少一个成员重算出类别的事件改写成员的 `category`、body 的 `categories` 与 `primary_category` 和两列；事件版本、`updated_at` 与 `incident_versions` 不改（第 3 节：类别变化不改变事件版本），通知、事件 issue 与按 `updated_at` 同步的消费方不会因为重新分类再次处理这些事件。
4. **告警状态**：成员告警还在 `alert_state`、存储的类别是 `unclassified` 而按当前输入求出了类别时，同一事务里把分类的 `category` 与 `category_source` 两个键改成新值，其余键保留。事件引擎重算回看窗口内的事件时从 `alert_state` 取成员的类别，回写之后引擎求出的类别与重新分类的结果相同；仍在触发的告警下一次接入时整份分类本来就按当前输入重写。
5. **与事件引擎串行**：每批的事务先取事件引擎的同一把集群咨询锁（`srenautix.incident-engine.<cluster_id>`），引擎在一批执行期间等待，最多等一批；引擎写入的事件不会被一批里读到的旧 body 覆盖。
6. **中途停下**：每批之前检查仍是主实例、进程没有退出；否则停下，不插入记录，`srenautix_recategorize_runs_total{outcome="interrupted"}`。之后每 30 秒检查一次，再次是主实例时从头扫描：已经改写的成员不再是 `unclassified`，重复执行得到相同的结果。执行出错时记 error 日志与 `outcome="failed"`，30 秒后重试；失败不暂停其他单活工作，类别是列表与导出的筛选属性，事件的分组、根因与通知都不读它。
7. **观测**：`srenautix_recategorize_runs_total{outcome}`（`unchanged`、`completed`、`interrupted`、`failed`）与 `srenautix_incidents_recategorized_total`；执行时写一条 info 日志，带新旧指纹、结果与两个行数。

重新分类只把 `unclassified` 变成类别，不把已有的类别改成别的类别：部署方把某条告警从 `performance` 改判为 `availability` 之后，历史事件保留当时的类别。已有的类别可能来自当时的 `srenautix_category` 标签，告警清理掉之后无法区分标签给出的类别与目录给出的类别，统一保留才不会覆盖规则作者的明确判断。

### 5. 列表接口

`GET /v1/incidents` 增加三个可以重复的参数，条件写进状态库的查询：

| 参数 | 语义 | SQL |
|---|---|---|
| `category` | 保留类别与任一取值相同的事件；可以是 `unclassified` | `categories && $n::text[]` |
| `exclude_category` | 去掉类别全部落在给出取值中的事件；`unclassified` 不能被排除，给出时返回 400 | `NOT coalesce(categories <@ $n::text[], false)` |
| `exclude_component` | 去掉组件（`Incident.components`，含根因组件）全部落在给出组件中的事件；没有组件的事件不去掉 | `NOT (jsonb_array_length(body->'components') > 0 AND body->'components' <@ to_jsonb($n::text[]))` |

排除取"全部落在里面"：`exclude_category=provider` 去掉只有外部上游告警的事件，外部上游故障同时带出了 `availability` 成员（业务请求失败）的事件仍然返回，排查业务影响时不会漏掉它。带 `unclassified` 的事件总有一个类别不在排除的取值里，因此永远不被排除：没有分类的告警需要人去看，筛掉它们会让缺口不可见。取值不在枚举里、为空或组件键不合法时返回 400。

摘要（`IncidentSummary`）增加必填的 `categories` 与 `primary_category`。

### 6. 仓库自带的领域包

`alerts-kps`（kube-prometheus-stack 全部告警）、`argocd`、`cert-manager`、`envoy-gateway`、`flux`、`ingress-nginx`、`kafka`、`longhorn`、`mysql`、`nacos`、`postgres`、`redis`、`rocketmq`、`_example` 与 Kind 演示环境的 `kind-shop` 的每个条目都按第 1 条的标准声明了类别；`kubernetes-core`、`workload`、`node`、`pvc`、`observability-self`、`kps-conditions`、`upstream-conditions` 没有告警目录，它们覆盖的告警登记在 `alerts-kps` 与各中间件包里。packs-sdk 的测试要求这些文件的每个条目都声明类别，同名告警的变体类别相同。

## 考虑过的方案

- **规则表优先于领域包声明**：部署方写一条宽的规则（例如 `layer: [L2]` 为 `availability`）会覆盖领域包对 `CPUThrottlingHigh` 这类告警的逐条判断；需要改判时用标签更精确。
- **排除按主类别**：`primary_category` 是 `provider` 的事件里常有业务请求失败的成员，按主类别排除会把已经影响业务的上游故障一起去掉。
- **排除按任一类别命中**：一个事件只要有一条观测类告警就会被 `exclude_category=observability` 去掉，而观测类告警经常和真正的故障进入同一个事件。
- **迁移里回填**：ADR 0176 要求迁移只改 schema；回填依赖领域包与部署方规则，只有 server 进程里才有。
- **重新分类做成按版本命名的数据修正**：数据修正（ADR 0176）在单活工作开始之前、在一个事务里执行一次，按名字记录。领域包的内容随部署方的配置变化，与 server 版本无关；全表重新分类放在一个事务里会长时间持有大量事件的行锁，并推迟全部单活工作。
- **输入变化时重算全部成员**：会把当时由 `srenautix_category` 标签给出、告警已经清理掉的类别改成目录的类别。

## 结果

- 契约 2.46.0：`AlertCategory`、`IncidentCategory`、`AlertCatalogEntry.category`、`AlertClassification.category` 与 `category_source`、`IncidentMember.category`、`Incident.categories` 与 `primary_category`、`GET /v1/incidents` 的三个参数、`IncidentSummary.categories` 与 `primary_category`。全部为新增的可选字段与参数（摘要的两个字段由 server 总是给出）。
- 实现：`packages/core/src/classify.ts`（`AlertCatalog.category`、`matchesLabels`、`ALERT_CATEGORIES`）、`packages/core/src/incidents.ts`（`incidentCategories`）、`apps/srenautix/src/alerts/category.ts`（规则 schema 与非法标签的处理）、`alerts/business-impact.ts`（匹配器改用 `matchesLabels`）、`alerts/resolve.ts`、`ingest/service.ts`、`config/server.ts`（`ingest.category_rules`）、`incident/{migrations,engine,corrections,recategorize,read}.ts`、`console-bff/{incident-filters,routes-incidents}.ts`、`roles/server.ts`；chart 的 `ingest.categoryRules`（默认空表）。
- 测试：
  - `packages/core/test/classify.test.ts`：枚举与契约相同；标签优先于目录与规则；规则不覆盖目录；规则按顺序取第一条、`exclude_labels` 命中时跳过；都没有时为 `unclassified`；非法标签（不在枚举里、`unclassified`、空串）被忽略并报告；`role` 标签不影响类别；
  - `packages/core/test/incidents.test.ts`：并集与主类别取根因上的成员；类别变化不改版本；成员离开后类别只看剩下的成员；没有根因、同样严重、之前版本的成员、全部成员已离开的情况；
  - `apps/srenautix/test/unit/alert-categories.test.ts`：`ingest.category_rules` 的默认值与非法写法；内置包的目录先于规则、非法标签计入指标；三个查询参数的解析、`unclassified` 不能被排除与 400；筛选条件；摘要在修正之前按 body 计算；
  - `packages/packs-sdk/test/alert-categories.test.ts`：内置告警目录的每个条目都声明了类别，同名变体类别相同；
  - `apps/srenautix/test/integration/incident-categories.test.ts`（真实 PostgreSQL）：事件引擎写入类别列与 body；三个参数在 SQL 里的包含与排除语义，`unclassified` 与之前版本的行不被排除；数据修正只补写之前版本的行，成员按完整标签或告警名重算，只执行一次；
  - `apps/srenautix/test/integration/incident-recategorize.test.ts`（真实 PostgreSQL）：指纹不变时不重新分类，包名与条目的其余字段不影响指纹；目录补上类别后 `unclassified` 成员按完整标签或告警名重算，已有类别的成员不动，事件版本与 `updated_at` 不变，`alert_state` 的分类同时回写、事件引擎之后重算得到同样的类别；分批执行，失去主实例时在批次之间停下、不记录指纹，再次执行时完成剩下的事件；
  - `packages/core/test/classify.test.ts` 与 `apps/srenautix/test/unit/alert-categories.test.ts`：类别解析输入的排列与取舍，内置包的指纹在同样的包与规则下相同、规则或条目的类别变化时不同。
