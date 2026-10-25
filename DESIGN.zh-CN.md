# SreNautix 设计

本文从 [POSITIONING.zh-CN.md](POSITIONING.zh-CN.md) 出发。设计经过两轮共 11 位质疑者的推敲：

- **第一轮**：架构、自身可靠性、集成、LLM 与评测、控制台、安全、拓扑与领域包。
- **第二轮**：自洽性与复杂度、故障场景推演、竞品复攻、复用核对。

第 0 节说明定位中的每一条承诺分别落在哪一节。

## 0. 定位到设计的对应

| 定位中的承诺 | 落在哪里 |
|---|---|
| 10 分钟内给出可信的判断（处理 / 忽略 / 升级） | §7.1 阶段 A：确定性的独立通道，p95 ≤60 秒，不依赖模型，也不依赖 PG；§7.2 阶段 B：必须给出 `disposition` |
| 附上你会去查的证据，查不实就说"无法判定" | §6 证据卡与 CEL 判定；§7.3 假设账本、区分性检查、结论阶梯 |
| 一键批准，告诉你是否生效，没生效就撤销 | §9.1 扩大可逆动作集；§9.2 审批分 L/H 两档，L 档可以在聊天里一键批准；§9.4 执行后校验、自动撤销、`needs_human` |
| 按你的模型，在你自己的事件上量出它有多准 | §14：快照和重建两种回放、观察模式 1 小时出成绩单、自助法置信区间、按模型给成绩单 |
| 链路完整 | §1 架构；§2 状态所有权与事件流 |
| 集成广泛 | §10：集成清单、按方向分级、契约、一致性测试 |
| 界面完整 | §12 控制台；§13 身份与权限 |
| 12 条不变量 | §16.1 不变量、实现方式与测试 |
| 国内私有化部署 | §1.3 合规配置；§8 方言档案与出境控制；§10 国内集成；§16 审计与供应链；§17 离线安装 |
| 2–50 人的团队用得起来 | §1.3 三种安装配置；标准配置不要求三权分立、通行密钥、WORM 存储、专用节点池 |

## 1. 架构

### 1.1 角色

```
                ┌───────────────────────────────── 中心（hub）─────────────────────────────────┐
告警源 ─webhook─▶ │ server  接入·告警目录·拓扑·事件·阶段A通道·规则提议·反馈·通知·控制台(SPA+BFF)·事件流 │
                │ worker  阶段B模型研判·区分性检查·回放（唯一持有模型密钥）                          │
                │ mcp     对外 MCP（默认关闭；只能提议）                                         │
                │ PostgreSQL（≥2 实例，每个角色一个库角色）                                      │
                └──────────▲───────────────────────────────▲──────────────────────────────────┘
                 出站长连接 │ 工单/读取请求 ↓  事件/结果 ↑     │ 出站长连接
                ┌──────────┴──────────────┐      ┌─────────┴───────────────┐
                │ 分支 A：reader + gateway │ ...  │ 分支 N：reader + gateway │
                │ reader：只读（拓扑、对账、 │      └─────────────────────────┘
                │  声明过的证据查询、校验读）│
                │ gateway：唯一写身份；准入 │
                │  策略约束；本地审计暂存    │
                └─────────────────────────┘
```

| 角色 | 镜像 | 持有 | 不持有 |
|---|---|---|---|
| `server` | `srenautix`（TypeScript） | OIDC 客户端；渠道 token；服务签名密钥（只签 L 档审批）；集群只读凭证和数据源只读凭证（单集群安装时直接使用） | 模型密钥、写权限 |
| `worker` | 同一镜像，`--role=worker` | 模型密钥；数据源只读凭证；只读 MCP 客户端 | 审批能力、渠道 token、ConfigMap 读取权限；出站受 NetworkPolicy 限制 |
| `mcp` | 同一镜像，`--role=mcp` | OAuth 资源服务器 | 审批能力 |
| `reader` | `srenautix-spoke`（Go），`--role=reader` | 本集群只读（不含 Secret）；本集群数据源只读凭证 | 写权限 |
| `gateway` | 同一镜像，`--role=gateway` | 本集群唯一的写身份；审计签名密钥（挂载）；本地只读指标客户端（只用于执行后校验） | 模型、渠道、数据源的通用查询 |

**部署方式**

- 单集群安装：reader 与 gateway 部署在同一集群，中心直接访问本集群。
- 多集群安装：每个被管集群部署一组 reader + gateway，二者都只向中心发起出站长连接；中心不持有任何成员集群的凭证。

**镜像与入口**

- 共两个镜像：`srenautix`（TypeScript）、`srenautix-spoke`（Go）。
- 控制台由 server 提供：同一个进程，独立的入口和路由。需要扩容时，可以单独起一个 `--role=server --serve=console` 的 Deployment。

### 1.2 一次事件的端到端流程

1. Alertmanager 的 webhook 推送到 server。server 写入接入日志，再由事件引擎重算并对账，得到事件 `incident.updated`。
2. server 的阶段 A 通道立即做三件事：执行证据卡、做根因排序、评估规则提议。然后用模板渲染出确定性报告，发出或编辑这个事件的那一条消息。这一步不调用模型，也不经过 worker 的队列。
3. 调度器把阶段 B 任务放进队列，worker 认领后进行模型研判，完成后发布 `research.concluded`，消息就地更新。
4. 提议经 server 写入，提交时带幂等键，并绑定事件版本、根因和证据指纹。需要审批的提议，进入控制台或聊天渠道的审批流程。
5. 分支 gateway 拉取已批准的工单，逐项校验签名、策略、绑定关系和预检，然后执行。执行完成后，用本地只读指标客户端做校验，必要时撤销。执行状态写在本集群的 CRD 里，事件推回中心。
6. 反馈、回放和评测都关联到同一个 `incident_id`。

### 1.3 安装配置

| 配置 | 组成 | 适用场景 |
|---|---|---|
| **观察模式**（observe） | server、worker、PG，以及一个只读 reader（单集群时内嵌在 server 中）。不部署 gateway | 首次试用：1 小时内用过去 14 天的数据给出成绩单（见 §14.5），之后每个新事件都出阶段 A 和阶段 B |
| **标准**（standard） | 观察模式加上 gateway | 2–50 人的团队：<br>• 身份：OIDC，或可选的 Dex/LDAP<br>• 角色：5 种（§13）<br>• 审批：L 档可以在聊天里批，H 档必须在控制台、并在 5 分钟内重新认证过<br>• 审计：JSONL 哈希链写入对象存储，没有对象存储时写入 PG 并提示风险 |
| **合规**（compliance） | 标准配置，外加更严的要求 | 等保、国内私有化部署：<br>• 三权分立、双人放宽策略<br>• H 档必须用通行密钥（WebAuthn）<br>• 提议人不能审批自己的提议<br>• 审计必须写入 WORM，可选 syslog/CEF 和 SM2/SM3<br>• 专用节点池<br>• 离线包、麒麟（Kylin）镜像、镜像校验策略 |

定位中的不变量在三种配置下全部成立；配置只改变"强度"类的选项。

## 2. 状态、所有权与事件流

### 2.1 一项状态只有一个写入方

| 所有者 | 表或对象 |
|---|---|
| server | `ingest_log`、`alert_state`、`topology_events`、`incidents`、`incident_aliases`、`incident_members`（带版本）、`stage_a_reports`、`feedback`、`suppressions`、`proposals`、`approval_assertions`、`chat_links`、`notify_messages`、`eval_cases`、`eval_results`、`users`、`sessions`、`role_bindings_cache`、`governance_audit`、`outbox` |
| worker | `research_runs`、`hypotheses`、`llm_calls`、`tool_calls`、`evidence_snapshots`、`research_manifests`、`outbox` |
| gateway（在所在集群） | `ActionExecution` CRD；Lease（只用于选主隔离）；本地审计暂存卷 |
| Git（通过 GitOps 挂载） | 策略、动作启用、工作流模板白名单、`pack.lock`、模型路由、拓扑覆盖、角色绑定、集成实例定义、审批人公钥（合规配置）、`srenautix-freeze`（熔断开关） |

- 每个角色使用独立的数据库角色，对其他 schema 没有 USAGE 权限（CI 用 `has_schema_privilege` 检查）。
- 跨角色读取只能走 API 或事件流。
- `suppressions` 只影响 SreNautix 自己的消息和研判，从不影响 Alertmanager 的路由。

### 2.2 事件的身份

- **事件是重算结果的持久化对账**：每次对账都按确定性规则重算一次，再和已持久化的事件对账。这样同时支持合并（`incident_aliases`：`from → into`）和拆分（`split_from`）。
- 主键是 `incident_id`（UUID）。原来的事件键 `<根组件>:<首次触发时间取整到 10 分钟>` 保留为稳定标签；旧 URL 和邮件链接通过别名表解析，继续可用。
- 成员关系按 `incident_version` 递增。
- 所有键都带 `cluster_id`。

### 2.3 事件流

- **outbox**：每个所有者都有一张只追加的 outbox（`seq`、`event_id`、`type`、`schema_version`、`payload`），与状态变更写在同一个事务里。
- **投递**：用 `LISTEN/NOTIFY` 唤醒消费者；消费者按游标调用 `GET /v1/events?after=`，可用长轮询或 SSE。投递语义是至少一次，消费者按 `event_id` 幂等处理。
- **对账**：通知和控制台都按期望状态对账，每 60 秒全量对账一次。
- **分支到中心**：分支 gateway 的执行事件先写入本地暂存，中心可达时补推。

### 2.4 幂等、绑定与事务

**提议**

- 幂等键：`hash(incident_id, run_id|rule_id, action, canonical_params)`。
- 每个提议都绑定 `{incident_version, root_component, evidence_fingerprint}`。三者任一变化，提议即标为 stale；gateway 在执行前会通过中心再检查一次。

**研判**

- 触发的唯一键是 `(incident_id, incident_version, reason)`。新事件与重开的事件（版本原因 reopened，ADR 0135）都触发研判。
- 绝对上限：每个事件每 6 小时最多 3 次模型研判，在入队时执行。
- 指纹带迟滞：判定向量连续两次对账都一致，才视为发生了变化。

**gateway 执行**

- 先写 `ActionExecution(phase=executing, attempt_id)`，再产生副作用。
- 写操作带 `resourceVersion` 前置条件，并加注解 `srenautix.io/execution-id`。
- 崩溃恢复时先观察目标对象，绝不重跑。

## 3. 接入与告警目录

### 3.1 接入

- **主路径（从第一天起就是 webhook）**：Alertmanager、Grafana 告警、夜莺的 webhook。文档建议 SreNautix 这个接收器的 `group_wait` ≤30 秒。
- **对账**：每 60 秒对比 Alertmanager v2 的 `GET /api/v2/alerts` 和 `ALERTS` / `ALERTS_FOR_STATE`。PG 恢复后，活动告警从这里重建。
- **通用 webhook**：用 JSONPath 映射字段。
- **时间**：一律使用告警源的时间戳。所有过期判断都基于 PG 的 `now()`；PG 不可用时，改用 reader 测得的 apiserver 时间。

### 3.2 告警目录与角色

- **告警目录**：内置 `alerts-kps`，覆盖 kubernetes-mixin、node-mixin、etcd、Prometheus、Alertmanager 的全部告警名。CI 会按固定版本渲染 kube-prometheus-stack，要求 100% 覆盖。
- **角色**：

  | 角色 | 含义 |
  |---|---|
  | `cause` | 原因 |
  | `change` | 变更 |
  | `symptom` | 症状 |
  | `forecast` | 预测类，不能成为活动事件的根因，也不能把两个分组连起来 |
  | `meta` | 观测缺口；依赖这个目标的证据卡会被标为"无法判定" |

- **按表达式分类**：未知告警通过 rules API 取规则表达式来分类，规则如下：

  | 表达式特征 | 归入角色 |
  |---|---|
  | 含 `predict_linear` | forecast |
  | 含 `changes()` / `resets()` / generation | change |
  | 重启、`up==0` | cause |
  | 错误率、延迟 | symptom |

  目录内的告警也按表达式判断是否属于 forecast，而不是看告警名。例如 KubePersistentVolumeFillingUp 的 critical 变体（剩余 <3%）描述的是当前状态，属于 cause。分类结果附带置信度，由 `srenautix doctor` 列出待确认的条目。
- **标签契约（可选）**：告警自带 `component`、`role`、`entity`、`chain` 标签时，优先使用这些标签。

### 3.3 实体解析

按顺序查找：informer 缓存 → 24 小时墓碑 → kube-state-metrics 历史（`kube_pod_info{pod_ip,node}`、`kube_pod_owner`、`kube_replicaset_owner`、`kube_pod_spec_volumes_persistentvolumeclaims_info`、`kube_node_info`）。

## 4. 拓扑

### 4.1 存储与回溯

- 由 server 维护（多集群时由各分支的 reader 推送）。
- 以事件形式保存（`valid_from` / `valid_to`），可以按任意时刻查询；每次研判引用当时的拓扑版本。
- 回放时可以从 kube-state-metrics 历史重建拓扑。

### 4.2 边

| 来源 | 置信度 | 用途 |
|---|---|---|
| 结构性关系：ownerReference、Pod→节点、Pod→PVC→PV→CSI、Service→Endpoints、路由→Service、领域包声明的 Operator 约定（例如 CNPG 的 `-rw` Service 指向它的 Cluster）、用户声明 | 1.0 | 归并与根因 |
| 运行时观测：Tempo 服务图、Hubble、Istio/Linkerd、Beyla | 0.9，过期衰减 | 归并与根因 |
| 配置引用：环境变量与 ConfigMap 中的 Service DNS 名、secretKeyRef 名称；由 server/reader 读取名称，worker 不读 | 0.7 | 归并与根因 |
| NetworkPolicy 出站规则 | 0.6 | 归并与根因 |
| 命名推断 | 0.3 | 只用于展示 |

**归并阈值 τ = 0.6**：置信度低于 τ 的边只参与候选排序，不会把告警拉进同一个分组。

### 4.3 作用范围与枢纽

- **实例级**：Pod→所在节点、同节点的 DaemonSet Pod、Pod→PVC→PV→CSI。
- **服务级**：沿服务依赖传播。
- **集群枢纽**（CoreDNS、CNI、apiserver、存储）：只有在出现针对该枢纽的证据，或者至少 3 个独立依赖方同时失败时，才吸收症状。计算深度之前先折叠强连通分量。

### 4.4 冷启动

`srenautix doctor` 输出以下内容，控制台拓扑页的默认视图就是这张覆盖表：

- 已解析的信号
- 14 天内未映射的告警名
- 没有证据链的组件
- 覆盖建议

## 5. 收敛与根因排序

**归并规则**：告警映射到实体后，满足以下条件就合并为一个事件：

- 沿置信度 ≥ τ 的边可达；
- 符合作用范围规则；
- 时间相邻（默认 30 分钟）。

相互独立的根因保持为多个事件。

**候选根因得分**（默认权重写在 `rca-params` 里，修改需要通过回放门禁）：

| 项 | 权重或规则 |
|---|---|
| 症状覆盖率（能解释的症状数 ÷ 症状总数，按路径置信度加权） | 0.40 |
| 先于症状触发 | 0.15 |
| 角色先验：change 1.0 / cause 0.8 / symptom 0.3 / forecast 与 meta 0 | 0.20 |
| 30 分钟内的变更：新 ReplicaSet/ControllerRevision、挂载的 ConfigMap 版本变化、cordon、HPA 扩缩、Argo/Flux 同步 | 0.15 |
| 长期告警惩罚（告警名 × 实体，7 天触发率） | −0.10 |
| 深度 | 只用于平分时排序 |

**覆盖率规则**：一个原因能解释全部 N 个症状时，它的排名高于只能解释 1 个症状的变更。

**输出**

- 前 k 个候选及分差。分差小于 δ（默认 0.1）时，把根因标为"有歧义"，两个候选的证据链都执行。
- **沉默的根因**：症状存在但没有指向原因的告警时，对上游组件执行探测卡，结果异常的加入候选。如果某个命名空间出现错误，会对该命名空间内 StatefulSet 的 PVC 执行容量探测，并执行 ENOSPC 日志卡。
- **未映射的告警**归入"命名空间伪组件"，不丢弃。

## 6. 证据与领域包

### 6.1 证据卡与 CEL

一张证据卡由以下部分组成：信号引用、时间窗口、`params`、判定、展示、链接。

判定用 CEL 编写：`abnormal_if: [{cel, say}]`、`undeterminable_if`。运行时提供的函数分三组：

- **聚合**：`max/min/last/sum/count/none(ref)`
- **序列**：`any_point(ref, pred)`、`transitions(ref)`、`top_share(ref, k)`、`join(a, b, op)`、`ratio(a, b)`、`let`
- **展示**：声明式表格模板

时序逻辑尽量放在 PromQL 里完成（`changes()`、`and`、比较运算）。CEL 的求值成本有上限，领域包里不允许出现可执行代码。

**唯一运行时**：CEL 只在 TypeScript 运行时里求值（server 的阶段 A 和 worker 用的是同一套实现）。gateway 的执行后校验条件使用自己的简单阈值表达式，不使用 CEL。

**三种结论**：正常、异常、无法判定。另外有一种独立的显示状态"能力缺失"，表示所需的数据源能力不可用，和"没有数据"区分开。卡片结果按研判运行保存。

### 6.2 信号层与可移植性

- **备选信号**：每个信号按优先级列出备选，加载时逐个探测，并按数据源记录最终选中的一个。
- **标签档案**：自动探测命名习惯，例如 `namespace/pod` 与 `kubernetes_namespace` 两种写法、OTel 的 `k8s_namespace_name`、外部标签 `cluster`、Mimir 租户。
- **查询方言**：PromQL 用严格解析器做 lint；使用 MetricsQL 必须显式声明 `dialect: metricsql`。`$rate_window` 由抓取间隔推导。
- **录制规则可选**，同时保留原始表达式作为兜底。
- **日志**：每个日志集成都必须实现 `logs.match{k8s selector, contains|regex, window, limit}`。

### 6.3 领域包

**文件构成**（只包含数据）：

| 文件 | 内容 |
|---|---|
| `pack.yaml` | 元数据、依赖的能力（`requires` / `optional`） |
| `signals.yaml` | 信号与备选 |
| `components.yaml` | 组件类型、匹配规则、Operator 约定边 |
| `alerts.yaml` | 告警目录条目 |
| `chains.yaml` | 证据链 |
| `checks.yaml` | 检查项 |
| `rules.yaml` | 确定性规则提议，例如"卡住的 Pod"，只能引用目录中已有的动作 |
| `rca-params.yaml` | 根因排序参数 |
| `runbooks/*.md` | runbook |
| `knowledge/*.yaml` | 知识条目，带 `learned_from` |
| `prompts/*.md` | 提示词片段，低信任 |
| `action-requests.yaml` | 动作启用申请 |
| `chaos/*.yaml` | 混沌实验 |
| `tests/` | 测试 |

**分层**：内置层 + 用户层。用户层可以有多个文件，按声明的顺序合并（组织在前、集群在后）。支持 `params`、`disable`、`patch`、`extend` 四种操作。内容哈希写进 `pack.lock`，每次研判和评测都会记录它。

**信任**

- 来自 Git 的包，以 Git 作为信任来源；来自 OCI 的包，必须有 cosign 签名。
- 提示词片段放进低信任的分隔槽位，启用前需要管理员批准差异。
- 领域包不能定义新动作。`action-requests.yaml` 必须经 Git PR 合入策略之后才生效。

**能力缺失的处理**：`requires` 中的能力缺失，整个包禁用并给出原因；`optional` 中的能力缺失，相应的卡显示"能力缺失"。

**内置包**：

| 类别 | 包 |
|---|---|
| 告警与平台 | `alerts-kps`、`kubernetes-core`、`node`、`workload`、`pvc`、`observability-self`、`cert-manager` |
| 数据库与中间件 | `postgres`、`redis`、`mysql`、`kafka`、`rocketmq`、`nacos` |
| 入口 | `ingress-nginx`、`envoy-gateway` |
| 变更 | `argocd`、`flux` |
| 存储 | `longhorn` |
| 示例 | `_example` |

每个包标注成熟度：`stable` 表示有 CI 夹具，并且在 Prometheus 和 VictoriaMetrics 上结论一致；`beta` 和 `draft` 依次降低。只有 `stable` 的包计入"支持"。

**测试套件**

- 夹具使用 promtool 的 `input_series` 格式，在 Prometheus 和 VictoriaMetrics 上各跑一遍，结论必须一致。
- 每张卡自动生成三类测试：无数据、部分无数据、数据源报错。
- 拓扑、告警映射、归并与根因排序都有黄金测试。
- `srenautix pack test --replay` 可以在录制的快照上运行。

**迁移旧判定**：从命令式判定（例如参考集群原有的 TypeScript 判定）迁移时，在夹具和回放种子上新旧两套并行运行，结论一致后才切换。

**参考集群也必须按这种方式运行**：内置包加参考集群的用户包，并公开这个用户包的行数。

## 7. 研判

### 7.1 阶段 A：确定性独立通道（server）

- **不依赖什么**：不调用模型，也不占用 worker 的槽位。
- **触发**：事件创建或版本变化后立即执行。
- **内容**：
  - 收敛后的事件
  - 前 k 个候选根因及分差
  - 证据卡的判定向量
  - 被排除嫌疑的正常卡
  - 时间线摘要
  - runbook 链接
  - 规则提议
  - 确定性的 `disposition`
- **disposition 的判定规则**：

  | 结果 | 条件 |
  |---|---|
  | `ignore` | 命中抑制规则、领域包的排除规则，或者只有 forecast 和长期告警 |
  | `act` | 有动作明确的规则提议 |
  | `escalate` | critical 且有歧义，或者观测失明 |
  | `undetermined` | 其余情况 |

- **观测失明**：至少 50% 的卡没有数据时判定为观测失明，不交给模型去猜。
- **渲染**：使用模板，中英文文案固定，不经过模型。
- **SLO**：从首次触发到发出，p95 ≤60 秒。
- **PG 不可用时**：server 在内存中继续归并，直接调用渠道发送，消息带有"状态库降级"横幅；PG 恢复后补写。

### 7.2 阶段 B：模型研判（worker）

阶段 B 在阶段 A 的基础上做三步：

| 步骤 | 内容 |
|---|---|
| `hypothesize` | 一次结构化调用。模型输出假设树，每个假设引用证据卡 ID；解码时用动态枚举，只允许本次运行中存在的卡 ID。对排名前 N 的假设，各给出一项区分性检查 `next_checks`：用哪个包查询模板或只读工具，以及什么结果能推翻这个假设 |
| `discriminate` | 由控制器执行这些检查，把结果判定为新的卡，写入假设账本 |
| `conclude` | 输出 `disposition`、现状与背景、根因、修复建议和提议 |

- 最终的 `disposition` 由代码在结论阶梯之后推导，模型的取值是输入之一（ADR 0138）：观测失明为 escalate；ignore 只按确定性依据给出（阶段 A 已判为 ignore、likely 以上的根因是领域包声明的集群外部组件、没有异常卡、影响卡全部正常），并且不带修复；act 需要有效提议、规则提议或根因上适用的修复模板；其余按严重度改写为 escalate 或 undetermined。
- 证据先过基线（ADR 0153）：阶段 A 与区分性检查的异常卡在事件之前同样长度的时段（前 1 小时、24 小时、7 天的同一时段与 7 天内的均匀样本）重新判定；与基线相比没有明显升高的卡是常态，只作背景，不作为根因或支持证据，处置与修复模板也按正常对待。告警目录条目的 `required_cards` 是告警的最低取证集合（告警自身的指标族与 runbook 的只读检查），没有覆盖完时结论只能是 undetermined。

- 模型调用是流式的，每条路由有首 token 超时与空闲超时（默认值按模型类别，托管大模型为 120 秒与 30 秒，ADR 0098），不设单次总时长。整个阶段 B 的硬期限是 8 分钟。超时或模型不可用时，阶段 A 依然有效，消息里会标注原因。
- 原生的只读工具（MCP 的 K8s 和指标工具）也通过 `next_checks` 的 `type: tool` 由控制器执行。模型不直接调用工具。

### 7.3 假设账本、停止规则与结论阶梯

- **假设账本**由代码维护，每个假设的状态是以下之一：待检验、支持、推翻、检验后仍无法判定。
- **停止条件**（满足任一即停止）：
  - 排名第一的假设有支持卡，并且其余候选都已被推翻，或检验后仍无法判定；
  - 连续两步判定都没有变化；
  - 达到步数、时长或预算上限。
- **结论阶梯**（全文统一使用这组术语）：

  | 档位 | 判定方式 |
  |---|---|
  | `evidence_consistent` | 由代码判定，必须同时满足：<br>• 支持卡的实体在假设的范围内<br>• 支持卡异常的起始时间不晚于症状起始时间加容差<br>• 该机制所需的信号上没有相反的正常卡<br>• 至少检验过一个竞争假设 |
  | `likely` | 有支持卡，但不满足上面的全部条件 |
  | `inconclusive` | 有假设，但没有支持卡 |
  | `undetermined` | 无法形成判断 |

- **代码校验**：删除无效的证据引用；删除目录以外的提议；把修改记录写进 `validation_notes`。

### 7.4 重复研判

- **指纹不变**：只刷新证据卡并追加"仍然一致"，不调用模型。
- **指纹变化**：从上一份账本开始增量研判，并受 §2.4 绝对上限的约束。
- **反馈也作为输入**：确认的假设固定下来，否定的假设标为推翻。

### 7.5 调度、预算与风暴

- **队列**：阶段 B 的队列使用 PG 的 `FOR UPDATE SKIP LOCKED`，任务租约为阶段超时的 2 倍。默认 4 个槽位，其中 1 个保留给 critical。
- **优先级**：严重度 → 吸收的症状数 → 新事件优先于重研 → 等待时长。同一事件的多次触发会合并，以最新一次为准。
- **风暴模式**：活动告警超过 200 条，或 5 分钟内出现超过 20 个新事件时进入。风暴模式下只有排名前 3 的根因进入阶段 B，其余只出阶段 A。中心恢复后补推的积压不计入风暴判定。
- **预算**：

  | 范围 | 默认值 |
  |---|---|
  | 每个事件 | 输入 token 中位数 ≤150k；DeepSeek 级模型 ≤$0.5；前沿模型 ≤$2 |
  | 每天 | 有上限 |

  - 达到 80%：warning 事件只出阶段 A。
  - 达到 100%：只有 critical 事件进入阶段 B。
  - MCP 和 API 调用方各有独立配额。
  - 预算消耗速率有元告警。
- **上下文预算**：按方言档案中的上下文长度确定。例如 Qwen-32B 的上下文是 32k，阶段 B 会相应缩小证据包，只放入异常卡和候选根因相关的卡。
- **数据源保护**：
  - 每个数据源固定并发上限（默认 8），每张卡超时 10 秒，配有熔断器。
  - K8s 只读 informer 缓存。
  - 发布内容附带可选的 APF 清单：worker 低优先级，gateway 有小份保底。
  - apiserver 返回 429 时，gateway 只提议、不执行。

## 8. 模型层

### 8.1 路由、故障域与熔断

**路由**：每条路由包含 base URL、模型、方言档案、单价、`failureDomain`、`in_domain`（是否境内）。

**两种熔断器**（所有研判共用）：

| 类型 | 条件 |
|---|---|
| 失败型 | 60 秒内失败 5 次，打开；之后每 30 秒放行一次探测 |
| 延迟型 | 成功调用的首 token 延迟 p50 超过路由首 token 超时的一半，打开（失败不计入） |

**故障域**

- 事件涉及的组件落在某条路由的 `failureDomain` 内时，提前打开这条路由的熔断器，避免把研判请求打到出故障的模型网关上。如果所有路由都被这样打开，阶段 B 跳过，只出阶段 A。
- 所有路由都落在被管拓扑内时，配置校验会告警，控制台显示横幅；文档建议至少保留一条拓扑之外的路由，例如本地 vLLM。
- SreNautix 自身的模型调用错误（`llm_calls`）也作为一张证据卡，用于模型服务类事件的研判。

**出境**：国内配置默认禁用出境路由。每条路由都记录服务方的数据保留条款。

### 8.2 方言档案与结构化输出

**能力探测**：启动时和评测时，逐条路由测量以下能力，结果写入方言档案：严格 json_schema、原生工具调用、推理通道、上下文长度、中文能力。

**可移植的 schema 子集**：扁平结构；所有字段必填；`additionalProperties:false`；使用枚举；不使用 `oneOf`。Go 和 TS 的校验器对同一批黄金夹具必须给出一致结果。

**修复阶梯**：解析 → jsonrepair → 校验 → 按字段挽救 → 带上错误重新请求一次 → 换下一条路由 → 只出确定性报告并标注"模型输出无效"。每一级的失败率按阶段、按路由记录。

**推理模型**：只约束最终输出，不约束推理过程。

**两档模型**：

- 小模型：压缩、"仍然一致"检查、修复。
- 大模型：`hypothesize` 和 `conclude`。

消息渲染使用模板，不经过模型。

### 8.3 token 与成本

- 计量依据服务方返回的 `usage`。发送前的估算值按路由用实际 usage 持续校准；对于没有公开分词器的模型，用字节估算兜底。
- 按阶段分别设预算。工具结果先判定成卡，原始结果不再进入上下文。
- 提示词按稳定前缀排列，以便命中缓存。

### 8.4 脱敏与出境控制

- **唯一出口**：所有出站请求都经过同一个模块（lint 强制）。FQDN 策略只允许 worker 访问模型端点。
- **卡片级控制**：每张卡有 `egress: allow|redact|never`。
- **剔除凭证**：Pod 环境变量的字面值在进入提示词前剔除；worker 不读 ConfigMap。
- **CI 语料**：植入各云 AK/SK、JWT、PEM、DSN、身份证号、手机号、银行卡号，断言它们都不会出现在提示词中。
- **运行时蜜标**：出站请求一旦命中蜜标，立即停止出站并告警。
- **存储与展示**：`llm_calls` 只保存脱敏后的内容。每次研判生成一份出境清单，在控制台展示。

### 8.5 复现与服务方风险

**研判清单**：每次研判都记录

- 代码 SHA、`pack.lock`
- schema 版本、提示词哈希
- 路由与模型 ID、服务方指纹
- 采样参数与种子
- 拓扑版本、快照 ID
- 脱敏规则版本
- 检索到的案例与知识条目 ID

**复现的含义**：后处理部分可以基于已保存的响应精确重放；如果重新采样模型，得到的是一个分布，而不是同一个结果。

**服务方漂移**：服务方的模型指纹发生变化时告警，该路由的回放分数作废，直到重新回放。

**人工确认**：模型的输出必须经过人工确认，才能成为案例或知识；每条都标注 `source: model|human`。

## 9. 处置

### 9.1 动作分级与目录

| 等级 | 动作 | 撤销方式 |
|---|---|---|
| reversible | `node_cordon`/`uncordon`（只撤销 SreNautix 自己做的 cordon）；`workload_scale`（恢复原副本数）；`hpa_bounds_set`（恢复原上下限）；`rollout_pause`/`resume`；`cronjob_suspend`/`resume`；`argocd_autosync_suspend`/`resume`；`flux_suspend`/`resume`；`release_breaker_toggle`（以标志位实现时） | 自动恢复原状态 |
| compensable | `cnpg_switchover`、`release_rollback`、`gitops_pr`（补偿方式是 revert PR）、以 PR 实现的发布熔断 | 补偿需要再次审批 |
| reversible（可重建） | `pod_restart`，目标同时满足：由控制器管理、控制器至少还有 2 个就绪副本、PDB 有余量 | 由控制器自动重建；执行时重新核对这三个条件 |
| irreversible | 不满足上述条件的 `pod_restart`、`workload_rolling_restart`、`argocd_app_sync`、`workflow_terminate` | 无法撤销；执行后校验失败时转为 `needs_human` |

**每个动作需要声明**：

- 目标解析、参数 schema
- 冲突域（每个集群本地维护）
- 预检：PromQL 条件、K8s 条件、PDB 余量
- 执行后校验的条件与窗口
- 撤销或补偿方式、TTL
- 爆炸半径的计算方法
- 风险档位（见 §9.2）

**自我保护**：目标落在 SreNautix 自己的依赖集合内时（所在节点、PG 集群、自身工作负载），一律按 irreversible 加 H 档处理。

**不允许自动执行**：irreversible 和 compensable 的动作一律不自动执行。SreNautix 自身的依赖（见上面的自我保护）也不自动执行；自身的自愈交给存活探针。

**可以自动执行**：只有 reversible 动作（包括满足条件的可重建 Pod 重启），并且要满足以下条件：

- 在策略的允许范围内（指定的命名空间和动作）；
- 预检通过；
- 未超过每小时上限。

### 9.2 审批

| 档位 | 包含的动作 | 在哪里审批 | 签名方式 |
|---|---|---|---|
| L | reversible；以及爆炸半径有界的 irreversible，例如单个 `pod_restart`，或 PDB 有余量的 `workload_rolling_restart` | 聊天渠道（只限已绑定的账号）或控制台 | server 的服务签名 |
| H | compensable、爆炸半径超限、放宽策略、涉及自身依赖 | 只能在控制台，并且 5 分钟内重新认证过（OIDC `max_age`）；合规配置下还必须用通行密钥 | 合规配置下由审批人的通行密钥签名；标准配置下由服务签名，并附带重新认证的凭据 |

**审批断言**（`contract/approval-assertion.v1`，Go 与 TS 共用黄金测试向量）：

```
{proposal_id, action, level, tier, params_hash, canon_version, target_uid, cluster,
 incident_version, root_component, evidence_fingerprint,
 approver_principal, channel, issued_at, expires_at}
```

提议的 TTL 和审批的 `expires_at` 是两个独立字段。提议的 TTL 从第一次成功送达时开始计算，并且有硬上限。

**gateway 在执行时检查**：

- 签名
- 断言里的各个绑定字段
- 审批人的作用域：按目标 UID 所在的命名空间计算
- 档位与动作等级是否匹配
- 签发时间是否晚于恢复标记（见 §15.3）

**聊天账号绑定**：在控制台登录后获取一次性绑定码，在聊天里发送 `/link <code>`。如果聊天账号和控制台使用同一个身份源（例如飞书的 union_id），则自动绑定。只有绑定过的账号可以审批和反馈；仅仅是群成员不行。

**提议人审批自己的提议**：标准配置下，L 档允许，但会被审计；合规配置下不允许。

**批量审批**：只允许同类型、同集群、L 档的提议。

**已知缺口（标准配置）**：server 被攻破时，攻击者可以批准 L 档动作；H 档需要重新认证，攻击者拿不到。合规配置用通行密钥消除这个缺口。这一点在文档中明确写出。

### 9.3 外部提议（MCP 与 API）

- 外部调用方只能提议，不能审批，也不能修改策略。
- 按调用方授权：可用的动作 × 命名空间。
- 每个调用方有独立的速率限制和成本配额。
- 同一调用方的重复提议会被去重；行为异常的调用方会被熔断。
- 这条安全写入路径也服务于其他 Agent。例如 HolmesGPT、kagent，或者 Grafana、Datadog 用户自己的 Agent，都可以通过它安全地提交修复动作。

### 9.4 分支 gateway

**生命周期**：

```
pulled → prechecked → executing → verifying → verified
                         ↘ failed    ↘ verify_failed ─┬→ reverted（reversible）
                                                      ├→ awaiting_compensation_approval（compensable）
                                                      └→ needs_human（irreversible）
其他：stale | expired | rejected | indeterminate（中断后由人判断）
```

**执行**

- 执行前重新预检。目标 UID 或 `resourceVersion` 发生变化，判为 stale。
- 执行后校验用本地只读指标客户端完成，所以中心不可用时也能完成。
- 进入 `needs_human` 时，导出本地指标，由所在集群的 Alertmanager 告警，不依赖中心。

**选主与冲突域**

- 单副本，使用 Recreate 部署策略；Lease 只用于选主隔离，Lease 身份就是 Pod 名。
- 冲突域的排队和槽位计数放在主实例的内存里；切换主实例时，从 `ActionExecution` 对象重建。
- 排队位置推送回中心，在审批页上展示。

**写入约束**

| 动作 | 约束 |
|---|---|
| `argocd_app_sync` | 固定到指定 revision |
| `gitops_pr` | 绑定 head SHA；只新建 `srenautix/*` 分支，推送前后核对 base 没有变化；从不合并；base 有分支保护或经批准的补偿控制；每个仓库每小时开 PR 的数量有上限；main watchdog 发现机器人写入或合并 base 时停止推送（ADR 0025）。改动只在人合并 PR 后生效，因此是可撤销动作（关闭 PR），可以自动执行 |
| `workflow_submit` | 只接受 Git 白名单中的模板，按名称、内容 sha256、ServiceAccount 匹配；参数必须符合 schema |

**准入策略**

- Helm 根据启用的动作生成准入策略，只约束 gateway 自己的 ServiceAccount，并显式包含 `pods/eviction`。
- `srenautix-freeze` 作为 `paramRef` 引用，配置 `paramNotFoundAction: Deny`：ConfigMap 缺失时，所有写入都被拒绝。冻结只约束集群写入：冻结期间 gateway 仍然执行只写 Git 的 `gitops_pr`，其余动作一律不执行（ADR 0025）。
- 自检：启动时和每次执行前，各提交一次违规的 `dryRun=All` 写入，必须被拒绝；被放行就转为只提议。

**升级与停机**：收到 SIGTERM 后不再认领新工单，等进行中的动作完成。正在执行或校验时不升级。

**审计**：gateway 自己维护一条执行审计链。先写本地暂存卷，再直接写入审计汇。审计汇不可用时：

- 不认领新的执行；
- 已在进行中的执行后校验和撤销继续完成，记录留在本地暂存，之后补写。

**时钟**：用 apiserver 时间和 NTP 测量时钟偏差，超过 5 秒拒绝执行。

## 10. 集成体系

### 10.1 集成清单

每个集成都有一份 `integration.yaml`，包含：

- id、类别、等级、契约版本
- 能力列表，每项注明 alpha、beta 或 stable
- 测过的版本矩阵
- 配置 schema（密钥字段只写挂载文件的引用）
- `requiredScopes`
- owner
- 每项能力的 `verify()`

控制台的集成页由清单生成。一项能力只有在清单里声明过、并且 `verify()` 通过，才算可用。启动时会探测凭证是否超出所需权限；超出时，该集成降级为 warn 或只提议。

### 10.2 按方向分级

| 方向 | 允许的等级 |
|---|---|
| read | 核心、官方、社区、MCP 桥接 |
| notify | 核心、官方、社区（经渠道桥） |
| approve、authenticate | 只能是核心或官方 |
| execute | 只能是核心；领域包只能通过白名单中的 `workflow_submit` 扩展 |

**等级的确定**

- **核心级**：属于默认路径，并且在 Kind 上有端到端测试。
- **官方级**：需要指定 owner，一致性测试持续通过，并且至少有一份真实部署报告。
- **首发时**：没有部署报告的集成标为"官方候选"，不称为"支持"。
- **降级**：夜间测试连续 14 天失败，或者一个版本周期内没有 owner，就降级。

### 10.3 各类集成的契约

契约是与语言无关的 JSON Schema，放在 `contract/integrations/<kind>/v1`。

| 类别 | 契约 |
|---|---|
| metrics | `query`、`query_range`、`series`、`rules`、标签档案 |
| logs | 必须实现 `logs.match`，原生查询为可选 |
| traces | `search`、`trace`、服务图 |
| changes | `changes.list(scope, window) → ChangeEvent{source, refs, revision, actor, time, link}`。每个适配器都要把变更映射到拓扑：<br>• Argo CD 用 `status.resources`<br>• Flux 用 inventory<br>• Jenkins、GitHub Actions、GitLab CI 用镜像 digest 关联到运行中的 Pod<br>• 通用 git 适配器覆盖 GitHub、GitLab、Gitee、Gitea |
| notify / approve | 发送、编辑、回调签名校验、账号绑定。approve 另有一致性测试：签名测试向量、重放和过期回调必须被拒绝、未绑定账号必须被拒绝、编辑是幂等的 |
| identity | 输出 `Principal{id, groups/departments}` |
| model | 方言档案 |

### 10.4 外部代码

外部代码只有两种接入方式：

1. **带类型的 MCP 配置档**，用于读数据：
   - 通过一致性测试的算社区级；没有类型约束的算 MCP 桥接级。
   - MCP 桥接级的服务器运行在自己的 Pod 里，不挂载 token（或只有只读 Role），出站受 NetworkPolicy 限制。
   - 它的工具默认关闭，需要管理员逐个加入白名单。
   - 返回结果按不可信文本处理，并有大小上限。
2. **HTTP 渠道桥**，只用于通知。

第三方代码永远不在 SreNautix 自己的进程里运行。

### 10.5 首发集合

**核心级**（约 15 个）

| 类别 | 集成 |
|---|---|
| 告警 | Alertmanager、通用 webhook |
| 指标 | Prometheus API（在 Prometheus 和 VictoriaMetrics 上测试） |
| 日志与链路 | Loki、Tempo |
| K8s 与变更 | 内置 informer、Argo CD、K8s rollout 与事件、通用 git |
| 通知与审批 | Telegram、飞书（审批卡片）、控制台 |
| 模型 | OpenAI 兼容的两种方言；DeepSeek 档案；vLLM 上的 Qwen 档案 |
| 身份 | OIDC、本地管理员（仅用于首次引导） |
| 执行 | 目录中的执行器 |

**官方候选**

| 类别 | 集成 |
|---|---|
| 告警 | Grafana 告警、夜莺 |
| 指标 | Mimir、Thanos |
| 日志与链路 | VictoriaLogs、Elasticsearch/OpenSearch、SkyWalking、Jaeger |
| 变更 | Flux、GitLab、Jenkins |
| 通知 | 钉钉、企业微信、Slack；邮件只通知 |
| 身份 | LDAP，以及经 Dex 接入的飞书、钉钉、企业微信 SSO |

**社区级或 MCP 桥接**：Zabbix、Teams、各云厂商的监控、阿里云 SLS。

**CI 分级**

- 核心级：在 Kind 上做端到端测试。
- 官方级和官方候选：每晚用 testcontainers 跑一致性测试。
- SaaS 后端：每个 PR 跑录制的夹具和签名测试向量，每周在真实账号上做一次冒烟测试。徽章上注明是哪一种验证。

所有适配器都必须遵守回放时钟窗口，这一点由一致性测试检查。

## 11. 通知与反馈

**消息**

- 一个事件只对应一条消息，内容有变化时就地编辑。
- 消息分四段：现状与背景、问题根源、解决方案、相关证据。
- 阶段 A 发出时标注"模型研判中"，阶段 B 完成后原地更新。

**限流**：每个渠道一个令牌桶：

| 渠道 | 速率 |
|---|---|
| Telegram 群 | 约 20 条/分钟 |
| 飞书机器人 | 100 条/分钟，且 5 条/秒 |
| 钉钉、企业微信 | 20 条/分钟 |
| Slack | 约每频道 1 条/秒 |

发送分优先级：审批和新的 critical 事件 → 风暴摘要 → 编辑 → 恢复。同一条消息的多次编辑只保留最新一次。发送队列持久化在 PG 的 outbox 中；PG 不可用时直接发送，见 §7.1。

**不可信文本**

- 消息里引用的日志、告警、事件原文，一律放在引用块中并注明来源。
- 模型写的"解决方案"段落标注"模型生成"。
- 结论如果只依赖日志类卡片，会标注出来。

**按钮**

- 批准：仅限 L 档提议、已绑定的账号。
- 拒绝：必须填写理由。
- 在控制台中打开。
- 撤销。
- 反馈：分两个维度
  - 处置判断是否正确；
  - 根因组件，从本次研判的拓扑组件中选择。

**反馈**

- **隐式反馈**：批准、拒绝、撤销会自动记为对应的反馈；事件恢复时，消息上会出现一键确认按钮。
- **反馈的效力**：只有已绑定账号的反馈才进入评测的标准答案。
- **反馈的字段**：每条反馈都记录来源渠道（`channel`：console / telegram / feishu / …）。"结论错"可以不填根因（`root_component = null`），这类反馈有两点处理：
  - 不生成回放用例，也不作为参考案例；
  - 计入准确率和校准统计，记为一次未命中。


**元告警**：SreNautix 自身的告警必须发往其他接收方（Helm 会校验）。接入层会丢弃 `srenautix_self` 告警。

## 12. 控制台

### 12.1 信息架构

**全局头部**：集群切换、搜索、状态条（不可关闭，见 §12.4）、语言、主题、用户。

| 分组 | 页面 |
|---|---|
| 值班 | 事件收件箱、事件详情、研判运行明细 |
| 处置 | 动作队列、审批页 |
| 度量 | 回放与评测、Agent 健康与成本 |
| 系统 | 拓扑、集群、集成、领域包、策略与目录、模型与出境 |
| 治理 | 审计、用户与角色、设置 |

### 12.2 关键页面

**事件收件箱**

- 每行一个事件，显示：处置判断、结论阶梯、根因组件与集群、严重度、持续时长、研判新鲜度、待审批数、反馈状态。
- 显示"合并自 N"或"拆分自"。
- 被抑制的事件折叠成计数，不隐藏。
- 用盲区色带标出观测失明的时段。
- 过滤条件保存在 URL 中。

**事件详情**

- 首屏回答"10 分钟内怎么办"：
  - 一句结论、处置判断；
  - 证据计数和降级的数据源；
  - 根因子图（只画根因加不超过 2 跳的邻居，用 ELK 布局）；
  - 待审批的提议，直接内联；
  - 反馈框，固定在页面上。
- 标签页：
  - **证据**：按"异常、无法判定、正常"排序。默认显示研判当时的快照；"实时重跑"的结果并排显示，并标注"非模型所见"。
  - **时间线**：一条泳道。
  - **假设**：假设树和代码校验的记录。
  - **运行**：各次研判之间的差异。

**告警链接**

- `/alerts?l.<标签名>=<标签值>&…`：外部通知（Alertmanager 邮件等）只知道告警的标签，用全部标签生成这个链接。
- 中心按接入的身份规则计算指纹，取最新的一条告警，经成员关系与别名链打开所属事件；找不到时写明原因，并给出收件箱入口（ADR 0154）。

**研判运行明细**

- 状态机瀑布图。
- 每次模型调用：路由、模型、提示词版本、token、成本、延迟、回退原因。
- 脱敏后的提示词，以及脱敏命中次数。
- 工具调用：查询内容、生效的上限、返回量、是否被截断。
- 预算账本：估算与实际、停止原因。
- 出境清单。
- "加入评测用例"按钮。
- 原始提示词只对 auditor 和 admin 可见。

**审批页**（移动端优先）

- 按顺序显示：
  1. 动作、等级、档位
  2. 目标（集群、命名空间、类型、名称、UID、当前状态）
  3. 参数与哈希
  4. 服务端重新执行的预检（带时间戳）
  5. 爆炸半径
  6. 冲突域与排队位置
  7. 校验条件与窗口
  8. 撤销或补偿方式
  9. TTL
  10. 触发审批的策略规则
  11. 提议来源
  12. 绑定的事件版本和根因
- 模型给出的理由折叠显示，灰色，标注"模型生成，未经验证"。
- H 档审批前，需要输入目标名称并重新认证。
- 显示审批回执和校验进度，可以撤销。

**审计**

- 两条链分开展示：执行链（每个集群一条）和治理链。
- 显示校验状态、导出位置与延迟、保留期。导出延迟超过阈值时，状态显示为红色。

**回放与评测**

- 按"模型 × 用例集"给出成绩单：
  - top-1 及自助法置信区间、pass^3；
  - 良性用例误报率、无法判定比例；
  - 结构化输出失败率；
  - 每个用例的成本。
- 快照成绩和重建成绩分开列出。
- 版本趋势与发布门禁状态。
- 用例浏览器：列出被排除的材料。
- 运行前显示成本估算。

**Agent 健康与成本**

- P0 记分卡，与阈值对照。
- 运行指标：
  - 零工具调用比例；
  - 未检验竞争假设的比例；
  - 重研次数、预算截停、回退率。
- 成本：按天、按事件、按模型统计。
- 出境账本。

**拓扑**

- 覆盖表。
- 未映射告警列表，可直接生成覆盖规则的 PR。
- 邻域图，每条边标注来源。
- 版本差异。

**集群**：reader 与 gateway 的连接状态、版本、准入自检结果、熔断开关、informer 新鲜度。自检未通过的集群，在所有页面上都显示红色的"仅提议"。

**集成**：每张卡片显示等级徽标、最近一次成功、错误率、被哪些证据链或动作使用、Git 来源、密钥引用；提供服务端连接测试。

**领域包**：来源、`pack.lock`、成熟度、加载状态、CI 测试结果。编写只用 CLI 和 Git，控制台从不执行草稿查询。

**策略与目录**

- 显示从 Git 渲染出的生效策略、仓库 SHA 和漂移。
- 模拟器：选定动作和目标，查看结果和需要谁审批。
- 软暂停：由 server 扣住工单，不下发。
- 硬停止：只能用 kubectl 或 GitOps 修改 `srenautix-freeze`，控制台只显示状态和操作说明。

**模型与出境**：路由、健康状况、故障域、结构化输出失败率、单价与上限、出境的数据类别。

**用户与角色**：用户、角色绑定（来自 Git）、组与部门的映射、聊天账号绑定、通行密钥注册（合规配置）、权限解释。

**设置**：渠道、API token（只有提议权限）、保留期、语言与时区、订阅。

### 12.3 配置归属

| 归属 | 内容 |
|---|---|
| Git（控制台显示 SHA 与漂移，可以发起 PR） | 策略、动作启用、领域包锁、模型路由、拓扑覆盖、角色绑定、集成实例、审批人公钥、熔断开关 |
| 控制台（存在 PG 中，全部审计，适用的项会过期） | 事件状态、反馈、审批、评测标注、抑制规则（必须设过期时间）、订阅、偏好、软暂停 |
| Secret | 永远不经过控制台 |

### 12.4 显性失败

server、worker、reader、gateway 都会发布带类型的状态条件，例如：

- 接入静默超过 N 分钟
- Watchdog 告警缺失
- 数据源不可用
- 模型路由熔断
- 准入自检失败
- 领域包加载失败
- 预算截停比例高
- 渠道投递失败
- 审计导出延迟
- 时钟偏差
- 状态库降级

这些条件驱动每个页面顶部的状态条。每个判定都会附带影响它的条件。空状态必须写明原因："没有事件"和"接入在 14:02 中断"不能显示成同一个样子。

### 12.5 前端技术

| 方面 | 选型 |
|---|---|
| 框架与路由 | React 19 + Vite + TypeScript；TanStack Router 与 Query；SSE 推送缓存失效 |
| 接口 | openapi-typescript / openapi-fetch，由 `contract/` 生成 |
| 组件 | Radix 原语 + 自有设计令牌；vanilla-extract 或 CSS Modules |
| 图表、拓扑、表格 | uPlot；xyflow + elkjs；TanStack Table + 虚拟滚动 |

**`@srenautix/ui`**：分为原语和领域组件两层。领域组件包括 VerdictHeader、EvidenceCard、ApprovalSheet、RunTrace，数据通过注入的 `DataPort` 获取。

**界面约定**

- 语言：默认 zh-CN，第二语言 en；文案使用 ICU MessageFormat，服务端渲染和前端共用一份。
- 主题：深色和浅色。状态一律用"图标 + 文字"表示，不只靠颜色区分。
- 密度：
  - 每个页面只回答一个问题，首屏不超过约 7 个主要元素。
  - 拓扑图只画 ≤2 跳的邻居。
  - 注解放在单独的泳道里，不叠加在图表上。
  - 截断的文字在悬停提示中显示全文。

**Grafana 插件**：嵌入收件箱、详情和运行明细三个页面，可以读取和提交反馈。插件里的"批准"按钮会打开控制台的审批页，插件本身不提供审批路径。

## 13. 身份与权限

**身份接入**：server 本身是一个 OIDC 客户端。LDAP/AD 和飞书、钉钉、企业微信 SSO 通过可选的 Dex 子 chart 接入（也可以换成 Keycloak）。组或部门的声明映射到 Git 中的角色绑定。

**角色**

| 配置 | 角色 |
|---|---|
| 标准 | viewer、responder（反馈、人工提议）、approver（带作用域与风险上限）、auditor、admin |
| 合规 | 把 admin 拆成 sys-admin 和 security-admin，与 auditor 三权分立；放宽策略需要两个人 |

**绑定**：每条绑定是 `(主体, 角色, 作用域)`，作用域为 `{集群, 命名空间集合, 组件标签}`。审批在执行时按目标所在的命名空间再检查一次。

**会话与认证**

- 会话保存在服务端；cookie 带 `__Host-` 前缀、HttpOnly、SameSite=Strict。
- 空闲 30 分钟或累计 12 小时后失效。
- 改变状态的请求要校验 Origin 并携带 CSRF token。
- 登录失败到一定次数会锁定。
- 管理员必须使用双因素认证。

**本地管理员**：只用于首次引导。SSO 验证通过后自动停用，此后只作为紧急入口，要求 TOTP，使用时页面显示横幅，所有操作都被审计。

**H 档审批**

- 必须在 5 分钟内重新认证过。
- 合规配置下还必须使用 WebAuthn：控制台需要从外部可访问（文档说明入口和证书的配置）。在飞书 webview 中无法使用通行密钥时，提示"在浏览器中打开"。

## 14. 评测

### 14.1 用例

| 类型 | 来源 | 标准答案 |
|---|---|---|
| `incident` | 真实事件 | 根因集合；粒度（Pod < 工作负载 < 组件 < 节点）；可选的机制；处置判断 |
| `feedback` | 已绑定账号的反馈，且给出了根因 | 最新的一条反馈。只说"结论错"、没有给根因的反馈不生成用例，只计入准确率和校准统计 |
| `benign` | 被人工忽略的告警事件；或在平静时段注入的告警 | 处置判断为 `ignore`，并且不出现 `evidence_consistent` |
| `abstain` | 去掉根因异常卡后的反事实快照 | `undetermined` |
| `scenario` | 在 Kind 上注入的级联故障，带背景噪声和干扰项 | 注入的根因 |

`scenario` 覆盖的场景：

- 节点 NotReady 引发 Pod 风暴
- PVC 写满，或数据库 OOM 后应用 CrashLoop，同时有无关的发布在进行
- 错误的镜像或配置被发布
- CoreDNS 缩到 0
- NetworkPolicy 拒绝流量
- HPA 达到上限

### 14.2 两种回放

| 模式 | 数据来源 | 用途 |
|---|---|---|
| `snapshot`（标准答案级） | 用例在被提升时，固化一份"查询邻域"：两跳以内组件的所有证据链查询结果，以及降采样后的原始序列。回放时只从这份缓存读取（VCR），缓存没有的就返回"不可用"，并统计未命中率 | 发布门禁、对外公布的成绩 |
| `reconstructed` | 在保留期内重新查询；被降采样过的卡标注"重建" | 新用户的观察模式成绩单；趋势参考 |

两种模式的成绩始终分开报告。日常研判只保存卡片结果，不录制查询邻域。

### 14.3 防泄漏

- 排除该事件自己的事故报告、反馈、同根因的历史结论。
- 只检索用例开始之前就已解决的案例。
- 领域包的知识、证据链、runbook 都带 `learned_from`，回放时排除来自该用例的部分。
- 分数分两组报告："领域包早于事件"和"领域包晚于事件"。
- 工具只能查询快照窗口内的数据，K8s 实时工具不可用。
- 先盲标，再显示候选。
- Kind 场景由维护者编写，存在作者偏差，所以单独报告；同时接受外部贡献的场景。

### 14.4 评分、统计与门禁

**评分**

- top-1 是否落在根因集合内
- 集合召回@3
- 按粒度分别统计
- 处置判断的准确率
- 覆盖率与选择性准确率（"无法判定"算弃权）
- 运行之间的一致性、pass@1、pass^3

**置信区间**：用聚类自助法计算，把同一用例的多次运行嵌套在该用例内；对外公布时始终同时给出分子和分母。

**校准**：每个模型一张可靠性表，列出各档位的精确率和置信区间。`evidence_consistent` 的精确率下界低于约 85% 时，该档位自动降级。

**发布门禁**

- 之前 pass^3 通过、现在失败的用例必须为零，或者在发布说明中逐条豁免。
- 在相同用例上做配对比较，新减旧的单侧 90% 下界：用例数 n < 100 时不得低于 −10 个百分点，n ≥ 100 时不得低于 −5 个百分点。

**LLM 评委**：只用于从事故复盘中抽取标签，以及参考性地检查"证据是否支持这句话"。必须用不同家族的模型，并人工抽检；不进入门禁。

### 14.5 三级门禁与新用户

| 级别 | 触发 | 内容 |
|---|---|---|
| T0 | 每个 PR，不调用模型 | 领域包测试、卡片判定、在录制快照上推断根因、在黄金响应上运行校验器 |
| T1 | 每个候选版本 | 在公开场景集和脱敏的参考集群用例上做模型回放，按参考模型分别给结果 |
| T2 | 每个部署：路由、领域包或版本有变化时，以及每周一次 | `srenautix eval --compare current candidate` |

**观察模式的首次成绩单**：安装后 1 小时内完成以下步骤：

1. 用 kube-state-metrics 重建过去 14 天的拓扑；
2. 回放 `ALERTS` 历史；
3. 按 `reconstructed` 模式给出成绩单，包括收敛效果、根因候选、处置判断分布，以及有标注时的准确率；
4. 把每个事件放入"稍后标注"队列。

另外还支持：导入事故复盘，由 LLM 抽取后经人工确认；领域包可以带上面向预发集群的混沌实验配方。

## 15. 自身可靠性

### 15.1 降级模式

| 情况 | 行为 |
|---|---|
| 模型不可用、变慢，或模型服务本身就是这次事故 | 熔断器打开（含故障域提前熔断）；只出阶段 A，并标注原因 |
| 数据源慢或部分不可用 | 固定并发、超时、熔断；相关卡显示"无法判定"并注明原因；≥50% 的卡没有数据时判为观测失明 |
| K8s API 过载 | 只读 informer 缓存；gateway 收到 429 后只提议 |
| 告警风暴 | 进入风暴模式；渠道按优先级分道；合并成摘要 |
| PG 不可用 | 阶段 A 在内存中归并并直接发送，消息带降级横幅；gateway 不认领新工单；恢复后从 Alertmanager 和 `ALERTS` 重建 |
| 渠道限流 | 令牌桶 + outbox；TTL 从送达时开始计算 |
| 中心不可用 | 分支不再拉取新工单；进行中的执行、校验、撤销用本地读和本地审计暂存继续完成；中心恢复后补推 |

### 15.2 高可用与部署位置

**PG**

- 至少 2 个实例，设置反亲和；同步复制设为"preferred"，单副本故障不会阻塞写入。
- PG 与 gateway 之间也设反亲和。

**各角色的副本方式**

| 角色 | 副本方式 |
|---|---|
| server 接入层与控制台 | 多副本 |
| 事件引擎与调度器 | 单活，用 Lease 选主 |
| worker | 多副本 |
| Telegram 长轮询 | 选主 |
| gateway | 单副本 + Recreate |

**节点与镜像**

- 标准配置：PriorityClass 高于业务负载；QoS 为 Guaranteed。
- 合规配置：专用节点池加污点。
- 镜像从被管集群之外拉取，或者预先拉取到节点上。
- 每次研判最多恢复 2 次。

### 15.3 数据分级与恢复

| 级别 | 数据 | 保护方式 |
|---|---|---|
| T0 | 审批断言、执行事件、审计 | 审计汇 + gateway 本地暂存 |
| T1 | 评测快照、反馈 | 每小时导出到集群外的对象存储 |
| T2 | 事件、研判 | RPO 24 小时 |
| T3 | 模型原文 | 不备份 |

**恢复模式**：从备份恢复 PG 后，系统先进入"已恢复"状态，按顺序执行：

1. 写入恢复标记（`restored_at`）；
2. 从各分支导入 `ActionExecution` 和审计汇的尾部；
3. 新开一个治理审计段，锚定到审计汇的最后一个哈希；
4. 把所有未结束的提议标为 stale；
5. gateway 拒绝签发时间早于恢复标记的审批；
6. 旧的聊天消息改为"已过期"。

完成以上步骤后才恢复写入。

### 15.4 升级

- 数据库迁移采用"先扩展、后收缩"，N-1 版本的二进制可以在 N 版本的 schema 上运行。
- API 和事件兼容上一个版本 N-1。
- 每个哈希都记录 `canon_version`。
- 执行后校验和撤销的截止时间持久化保存，重启后继续。
- 有动作正在执行或校验时不升级。

### 15.5 自身监控

- 发布内容附带 PrometheusRule 和仪表盘；告警发往 SreNautix 以外的接收方。
- 外部 deadman：只有接入延迟小于 2 分钟、并且准入自检通过时，才 ping 一次。
- 合成金丝雀：每 15 分钟一次，要求在 60 秒内出现在阶段 A 中，且不进入聊天。
- 导出 `srenautix_clock_skew_seconds{peer}`，超过 2 秒告警。

## 16. 安全

### 16.1 不变量与测试

所有测试放在 `test/invariants/`，每个 PR 都在 Kind 上运行，任何一项失败都阻止发布。

| # | 不变量 | 实现 | 测试 |
|---|---|---|---|
| 1 | Agent 和模型不持有写凭证，也不能读 Secret | worker、mcp、reader 的 RBAC 都是只读且不含 Secret；剔除环境变量字面值 | 对各个 SA 做 `kubectl auth can-i --list` 黄金快照 |
| 2 | 写操作只能是类型化动作 | 执行器注册表等于目录；禁止 `os/exec`；`workflow_submit` 用哈希白名单 | 一致性检查 + Semgrep；"失控 gateway"尝试目录之外的写入，必须被准入拒绝（403） |
| 3 | 没有经过自检的准入策略就只提议 | `dryRun=All` 违规自检 | 删除准入绑定或改成 Warn，60 秒内转为只提议，执行请求返回 409 |
| 4 | gateway 的 SA 对准入配置、RBAC、token、Secret 都没有权限 | RBAC 模板 | can-i 检查 + helm-unittest |
| 5 | 审批签名并绑定 | 断言 v1；执行时核对 | 属性测试逐个篡改绑定字段；伪造的审批行必须被拒绝；早于恢复标记的审批必须被拒绝 |
| 6 | 外部 Agent 只能提议 | 授权矩阵 | 授权矩阵由 OpenAPI 和 MCP 工具表生成；存在未分类的路由时 CI 失败 |
| 7 | 可补偿和不可逆动作一律人工审批（可重建的 Pod 重启除外） | 目录 lint；策略加载校验；执行时重新核对可重建条件 | 把这类动作配置为自动执行的策略，加载必须失败；对单副本 Pod、没有控制器的 Pod、PDB 无余量的 Pod 发起自动重启，必须转为人工审批 |
| 8 | 最多执行一次 | 先写 CRD 再执行，带 execution-id，恢复时先观察 | 在各阶段注入故障点并 `kill -9`，随机 1000 次；以 apiserver 审计日志为准 |
| 9 | 不可信文本不会变成控件，也不会改变动作 | 渲染时转义；目标由机器推导；聊天中引用原文时注明来源 | 注入语料（Markdown、卡片 JSON、HTML、`{{ }}`、零宽字符、RTL 字符），用 Playwright 和渠道快照验证；模型给出的目标必须等于机器推导的目标 |
| 10 | 每次写入都可追溯，审计导出到 PG 之外 | 执行链由 gateway 直接写入审计汇，本地有暂存 | apiserver 审计日志里每一条写入都能关联到审批人，并且出现在审计汇中；审计汇不可用时不接受新的执行 |
| 11 | 熔断开关不依赖 gateway | `paramRef` 引用 `srenautix-freeze`，`paramNotFoundAction: Deny` | 用 SIGSTOP 冻结 gateway 后切换开关，下一次写入被拒；删除该 ConfigMap，写入同样被拒 |
| 12 | `gitops_pr` 从不合并；base 分支有分支保护，或经批准的补偿控制 | 请求白名单与客户端都没有合并接口；只新建 `srenautix/*` 分支，推送前后核对 base；每次推送与开 PR 写入审计链；按小时限速；main watchdog | 在模拟 Git 服务器与 Kind 中的本地 Git 服务上：推送到 main 被拒、推送期间 base 前进时不开 PR、限速、机器人写入或合并 main 时告警并停止推送、冻结期间只执行 `gitops_pr` |

### 16.2 凭证

- PG 中只保存 `secretRef`、指纹和轮换时间。
- 凭证来自挂载的 Secret、External Secrets 或 Vault CSI，每个角色只挂载自己需要的部分。
- 凭证文件变化时自动重载，优先使用短时凭证。凭证的存活时长作为指标导出，并设置告警。

### 16.3 审计

| 链 | 写入方 | 记录内容 |
|---|---|---|
| 执行链 | 每个集群的 gateway | 执行全生命周期 |
| 治理链 | server | 登录与失败、角色、策略、领域包、凭证引用的变更、MCP 调用、出境清单、审批断言 |

- 每条记录包含 `seq`、`prev_hash` 和 `sha256(JCS(record))`，并定期签一个检查点：标准配置用 Ed25519；合规配置可选 SM2/SM3。
- 两条链都以 JSONL 格式写入对象存储（MinIO 或 S3）。
  - 合规配置：必须开启对象锁定（WORM），至少保留 180 天，可选 syslog 或 CEF。
  - 标准配置：没有对象存储时，写入 PG 的独立表，控制台持续提示风险。
- 提供 `srenautix audit verify` 校验工具。

### 16.4 MCP 服务

- 默认关闭，只在集群内可达。
- OAuth 2.1 资源服务器：token 按受众绑定（RFC 8707），不透传，并校验 Origin。
- 作用域模型与 §13 相同。
- 输出中的日志、告警、事件文本都放在 `untrusted_text` 字段里。工具描述带版本号，并且固定不变。

### 16.5 供应链

| 配置 | 要求 |
|---|---|
| 标准 | • 镜像和 chart（OCI 制品）都用 cosign 签名<br>• SBOM 同时提供 SPDX 和 CycloneDX<br>• 支持 ARM64<br>• 离线包：镜像、chart、签名、SBOM、信任根，可用 `cosign verify --offline` 校验<br>• 依赖固定：GitHub Actions 按 SHA、基础镜像按 digest、pnpm 冻结锁文件和 `onlyBuiltDependencies`<br>• govulncheck 和 osv-scanner 作为门禁 |
| 合规 | 标准配置之外，再加：<br>• SLSA L3 溯源<br>• 可复现构建<br>• policy-controller 的 `ClusterImagePolicy`<br>• 麒麟（Kylin）基础镜像 |

## 17. 部署形态

- **Helm**：一个 Helm chart，一个版本号。三种配置（观察、标准、合规）对应三份 values 预设，各个角色可以单独开关。
- **数据库**：外部 PostgreSQL 16 及以上，或者用 CNPG 部署内置实例（至少 2 个实例）。
- **Kubernetes 版本**：写操作要求 ≥1.30（ValidatingAdmissionPolicy GA，绑定 token 带有 Pod 名称）。低于这个版本只能用观察模式，或者只提议。
- **参考资源**（单副本）：

  | 角色 | requests | limits |
  |---|---|---|
  | server | 200m / 512Mi | 1 / 1Gi |
  | worker | 200m / 1Gi | 2 / 1Gi |
  | reader | 50m / 128Mi | 500m / 256Mi |
  | gateway | 50m / 128Mi | 500m / 256Mi |
  | PostgreSQL（每实例） | 250m / 1Gi | — |

- **快速开始**：`deploy/kind/` 一条命令拉起 Kind、kube-prometheus-stack、Loki、Tempo、SreNautix 和级联故障场景，30 分钟内看到第一份研判。`helm install --set profile=observe` 在已有集群上 1 小时内出成绩单。

## 18. 仓库结构与许可

```
SreNautix/                         服务端代码 AGPL-3.0-or-later；标注 [Apache] 的目录为 Apache-2.0
├── LICENSE  LICENSE.Apache-2.0  NOTICE  CLA.md
├── README.md  README.zh-CN.md  POSITIONING.zh-CN.md  DESIGN.zh-CN.md
├── CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
├── go.mod                         module github.com/Zzhihon/SreNautix（spoke）
├── package.json  pnpm-workspace.yaml  tsconfig.base.json
├── contract/                      [Apache] OpenAPI、事件、研判输出、审批断言、动作目录、包、集成契约
├── cmd/srenautix-spoke/           reader 与 gateway 两个角色
├── internal/spoke/
│   ├── reader/                    informer、拓扑事件、对账、声明查询
│   ├── gateway/                   ticket、policy、admission（生成准入策略）、execution、executor/*、verify、audit、lease
│   └── tunnel/                    到中心的出站长连接
├── apps/srenautix/                server / worker / mcp
│   └── src/
│       ├── ingest/  alerts/  topology/  incident/  stage-a/  rules/  scheduler/
│       ├── research/  llm/  tools/  eval/  notify/  channels/  console-bff/
│       ├── identity/  mcp/  events/  store/  api/
│       └── prompts/
├── packages/
│   ├── core/                      收敛、根因排序、CEL 判定与序列函数库
│   ├── packs-sdk/                 [Apache] 包 schema、加载、校验、测试
│   ├── integration-sdk/           [Apache] 集成契约与一致性测试套件
│   ├── ui/                        [Apache] React 组件
│   └── contract/                  [Apache] 生成的 TS 类型
├── web/console/                   控制台前端
├── plugins/grafana-app/           [Apache] Grafana 嵌入
├── packs/                         [Apache] 内置领域包
├── integrations/                  核心级与官方级集成的清单与夹具
├── eval/                          scenarios/  cases/  reports/
├── test/invariants/
├── deploy/                        helm/srenautix/（含三种配置预设）  kind/  offline/
├── docs/                          guides  reference  adr
├── hack/
└── .github/workflows/
```

**社区集成**放在独立仓库 `SreNautix-contrib`，每个集成有自己的 CODEOWNERS。

**许可**

- 服务端代码使用 AGPL-3.0-or-later。
- `contract/`、`packages/{packs-sdk,integration-sdk,ui,contract}`、`plugins/`、`packs/` 使用 Apache-2.0。
- 服务端代码的贡献者签署 CLA；Apache-2.0 目录只要求 DCO（`Signed-off-by`）。

## 19. 版本与兼容

- 契约使用语义化版本，API 和事件兼容上一个主版本（N-1）。
- 领域包声明自己要求的最低 SreNautix 版本。
- 每个版本附带评测报告 `eval/reports/<version>.md`，同时给出分子、分母和置信区间。

## 附录 A：P0 的度量方式

| 主张 | 度量 |
|---|---|
| 结论中仍有未检验竞争假设 <10% | `srenautix_research_untested_competitor_ratio`；诊断指标 `srenautix_research_zero_tool_ratio` 一并公开 |
| 同一事件重研 ≤3 次 | `srenautix_incident_research_runs` |
| 每周反馈 ≥10 条 | `srenautix_feedback_total{linked="true"}`，包括隐式反馈 |
| 回放 ≥30 真实 + ≥10 良性，pass^3，top-1 ≥60%（附置信区间），误报 ≤10% | 回放与评测页（snapshot 模式）、`eval/reports` |
| 私有模型的成绩与结构化输出失败率 | 按模型的成绩单；修复阶梯每一级的失败率 |
| ≥5 次真实闭环（≥1 次自动撤销，可以是标注过的演练；≥1 次在控制台审批）；目录外写入为 0 | 执行审计链、准入拒绝日志 |
| 可移植性：外部集群 1 天内、自定义领域包 ≤200 行，top-1 ≥50% | Kind 级联场景集，外加一份外部集群报告 |

**自动撤销的演练**：在参考集群的生产环境上，对演练工作负载执行一个 reversible 动作，例如 `workload_scale`，并预先配置一个注定不成立的校验条件，让它走完"执行 → 校验失败 → 自动恢复"的完整路径。这个过程经过正常的审批和执行链路，计入闭环，报告中单独标注为演练；其余闭环必须是自然发生的。

## 附录 B：构建顺序

下列各项按依赖关系排序：

1. **`contract/`**：事件、卡片、研判输出、审批断言、动作目录、事件流的 schema；PG 中每个所有者一个 outbox。
2. **接入与收敛**：webhook 加对账；`alerts-kps`；informer 和 kube-state-metrics 拓扑（带 `valid_from` / `valid_to`）；`packages/core` 的收敛与根因排序。
3. **证据与阶段 A**：
   - CEL 及序列函数库、信号备选；
   - 内置包：kubernetes-core、node、workload、pvc、postgres；
   - 参考集群的用户包、`pack test`；
   - 阶段 A 独立通道；
   - Telegram 一事件一消息、账号绑定、反馈按钮。
4. **评测框架**（T0/T1）：防泄漏、pass^3、自助法置信区间、按模型的报告、用例提升时固化快照。它对后续所有改动起门禁作用。
5. **阶段 B**：假设账本、区分性检查、代码校验、方言档案与修复阶梯、按 usage 计量的预算、唯一出口与脱敏、绝对上限、故障域熔断。
6. **spoke**：
   - reader 与 gateway；
   - 目录子集：cordon/uncordon、workload_scale、发布熔断、pod_restart、cnpg_switchover、gitops_pr；
   - 出站工单、断言校验；
   - `ActionExecution`、预检、校验、撤销；
   - 生成的准入策略、自检、freeze、执行审计链；
   - 不变量测试 1–12。
7. **控制台核心页**：OIDC 与本地管理员；收件箱、详情、审批、运行明细、评测成绩单、集群、状态条。
8. **Kind 级联场景**和参考集群以外的可移植性领域包。到这一步即可满足 P0。
9. **其余部分**：其余控制台页面、飞书与钉钉、Dex/LDAP/SSO、Grafana 插件、官方候选集成、MCP、多集群、合规配置的各项（WebAuthn、三权分立、WORM、SLSA、麒麟）。

## 附录 C：关键取舍

| 取舍 | 结论 | 理由 |
|---|---|---|
| 控制台怎么拿实时数据 | 不提供通用数据源代理；由服务端按用户作用域，在限定窗口内重跑研判时固定的证据卡；深入分析跳转 Grafana Explore | 通用代理存在数据外泄、资源滥用、绕过命名空间作用域的风险；控制台不持有任何数据源凭证 |
| 控制台与通知的进程形态 | 控制台（SPA + BFF）由 server 进程提供，可以单独起副本；通知服务用 TypeScript 实现，并入 server | 与 Argo CD、Grafana 的做法一致；消息渲染和界面共用一份文案，不必每个渠道写两遍 |
| 贡献协议 | 服务端代码（AGPL）签 CLA；Apache-2.0 部分只要求 DCO | 保留将来商业授权的可能，同时降低企业贡献 SDK、领域包和契约的法务门槛 |
| 研判质量指标 | 考核"结论中仍有未检验竞争假设"的比例；零工具调用比例只作为诊断指标 | 最常见的失败是不验证就下结论；证据卡已经足以下结论时，不调用工具是正确的 |
| 可重建的 Pod 重启 | 满足控制器管理、至少 2 个就绪副本、PDB 有余量时，按可撤销对待，可以自动执行 | 删除后由控制器重建，效果等同于控制器自己的修复；三个条件在执行时重新核对 |
| 演练与真实闭环 | 在生产集群上用演练工作负载触发的自动撤销计入闭环，但单独标注；其余闭环必须是自然发生的 | 演练经过的是正常的审批和执行链路；只等自然发生的校验失败，可能长期等不到 |
| 标准配置的已知缺口 | 写进文档：server 被攻破时，攻击者可以批准 L 档动作；合规配置用通行密钥消除这个缺口 | L 档只包含可撤销、爆炸半径有界的动作，以此换取聊天里的一键审批 |
