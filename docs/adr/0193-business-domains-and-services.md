# 0193 业务领域与服务：领域包声明，告警与事件的服务归属

## 背景

收件箱、通知与导出里的事件只有两种归类：类别（ADR 0183，`availability`、`performance` 等五种故障类型）与根因组件键（ADR 0034）。两者都回答不了值班人最先问的问题：哪块业务出事了。

在一个参考部署 2026-11-02 至 11-05 的 132 个真实事件上：

- 网关这一个服务的 44 个事件分散在 6 种根因组件键下：`component:gateway`、`StatefulSet:<ns>/gateway`、`Job:<抓取任务>`、`route:<路由>`、`Namespace:<ns>`、`PodDisruptionBudget:<ns>/gateway`。
- 归档导出器这一个服务的 23 个事件分在 `observability`、`platform`、`availability` 三个类别里。
- 控制面 HPA 到顶的 19 个事件全部是 `critical`，类别是 `performance`，和网关的扩容到顶混在一起。

类别描述故障的性质，组件键描述 Kubernetes 对象，两者都不描述业务。这一层要由部署方声明：平台不知道哪个 StatefulSet 属于哪块业务。

## 决定

### 1. 模型

| 概念 | 含义 | 键 |
|---|---|---|
| 业务领域（BusinessDomain） | 一块业务，例如请求转发、请求归档 | `id`，部署内唯一 |
| 服务（Service） | 领域里一个可以单独出问题的部分，例如网关、归档导出器 | `id`，部署内唯一，属于一个领域 |
| 层级（tier） | 领域对业务的重要程度：`core` 核心业务，`supporting` 支撑业务，`foundation` 集群底座与交付，`self` 运维与观测系统自身 | 每个领域一个 |

服务的成员有两种写法：

- `component_type`：领域包已有的组件类型 id。组件类型与服务一样细时用这种写法。
- `match`：与组件类型的 `match` 同一模式（kind、`api_group`、命名空间、名称正则），用同一个匹配函数求值。组件类型比服务粗时用这种写法，例如一个组件类型同时覆盖三个服务的逻辑组件，或者内置的 `kubernetes.deployment` 覆盖全部 Deployment。

一个对象命中多个成员时，取最具体的成员：`match` 按它写出的条件数计，`component_type` 按那个组件类型的 `match` 计。同样具体时 `match` 优先于 `component_type`，因为它是为区分这个服务写的；写法也相同时取先加载的包、先声明的成员。

“业务领域”与主动优化的领域（ADR 0146 的 `Domain`、`domains.yaml`，例如 `compute`、`database`）是两个概念。为了不让一个词有两个含义，本 ADR 的类型、文件与字段都带 `business` 前缀。

### 2. 领域包的声明

领域包增加可选文件 `business.yaml`：

```yaml
business_domains:
  - id: forwarding
    title: 请求转发
    tier: core
    services:
      - id: gateway
        title: 网关
        members:
          - component_type: cchp.gateway-workload
          - component_type: cchp.edge-route
          - match: { kind: component, name_pattern: '^gateway$' } # cchp.component-app 同时覆盖 gateway、control、worker
          - match: { kind: PodDisruptionBudget, namespaces: [cchp-prod], name_pattern: '^gateway$' }
        namespaces: [cchp-prod] # 可选：这些命名空间里归属不到任何服务的告警推定归这个服务
```

加载规则：

- 领域 `id` 与服务 `id` 在全部启用的包中唯一；重复时包加载失败。
- 成员引用的组件类型必须存在于启用的包中。
- 一个命名空间最多是一个服务的默认命名空间；重复时包加载失败。
- 告警目录条目可以声明 `service: <服务 id>`，引用的服务必须存在。只给描述的业务与所在对象不同的告警声明，例如归档导出的告警挂在网关的 Pod 上。
- 汇总其他告警的告警（例如按主题升级的告警，它继承源主题的 `component` 标签）不声明 `service`，按它带的组件归属。为它声明固定的服务会把它汇总的业务全部拉到这个服务下。

内置包 `business-foundation` 声明三个领域：`platform`（集群底座，`foundation`）、`delivery`（发布与交付，`foundation`）、`observability`（观测系统，`self`），成员是其他内置包的组件类型。部署方要用自己的领域划分时，按包的启用配置禁用 `business-foundation`，在自己的包里声明全部领域。包之间没有覆盖规则。

### 3. 一条告警的服务

按顺序取第一个得出结果的来源，记在 `AlertClassification.service` 与 `service_source`：

1. `label`：标签 `srenautix_service` 的值是已声明的服务。取值未声明时忽略这个标签，计指标 `srenautix_alert_service_label_invalid_total`。
2. `catalog`：命中的告警目录条目声明了 `service`。
3. `component`：告警归属的组件（`Alert.component`）命中某个服务的成员。
4. `entity`：告警实体命中某个服务的成员。
5. `owner`：告警实体沿 `owned_by`、`scales` 取到的顶层属主（`TopologyStore.ownerOf`）命中某个服务的成员。
6. `namespace`：告警的命名空间是某个服务的默认命名空间。这是推定，控制台标注“按命名空间推定”。
7. `default`：以上都没有，服务为 `null`。

`component_type` 成员按阶段 A 已有的方式求组件类型：拓扑节点上的 `component_type`，没有时用 `matchTypeByName`。第 3 到第 5 步让网关的 Pod、StatefulSet、PodDisruptionBudget 与抓取任务落到同一个服务。

### 4. 事件的服务

与类别相同（ADR 0183 §3），由 `packages/core` 的纯函数从成员求出：

- `services`：当前成员（没有时取全部成员）的服务的并集，按字典序排列，不含 `null`。
- `primary_service`：先在服务来源不是 `namespace` 的成员中取，没有时再在 `namespace` 来源的成员中取。每一轮里，取根因组件上的成员中最严重的一个的服务；根因组件上没有这样的成员时，取全部这样的成员中最严重的一个。都没有服务时为 `null`。
- `primary_service_source`：`primary_service` 取自的成员的服务来源，控制台据此标注推定。
- `business_domain`：`primary_service` 所属的业务领域。成员也带上告警的 `business_domain`，求事件的服务时不需要服务目录。

事件引擎写 `server.incidents` 时一并写这三项，不增加新的写入方。

### 5. 归属输入变化后重新计算

服务归属的输入（全部包的领域声明、组件类型到服务的映射、告警目录条目的 `service`）与 ADR 0183 的类别输入合并成一个"归类输入"，指纹规则不变。指纹变化后，`recategorize` 对服务为 `null` 的成员按当前输入重算，已有服务的成员不改。

### 6. 显示与接口

- 事件标题：`<服务名> · <问题陈述>`（问题陈述见 ADR 0190）；没有服务时只显示问题陈述。组件键与事件键移到详情。
- `GET /v1/incidents` 增加筛选 `business_domain`、`service`、`exclude_business_domain`（可以重复），与已有筛选是"且"。
- `GET /v1/business-domains` 返回业务领域、服务、层级与每个服务的进行中事件数。
- 收件箱默认按领域分组，组内按首次触发时间倒序。
- 导出（ADR 0186）与 MCP 增加同样的筛选与字段。
- Telegram 与飞书的消息标题以 `[<领域名>/<服务名>]` 开头。

### 7. 未归属

- 指标 `srenautix_incident_unassigned_total{cluster_id}`：`primary_service` 为 `null` 的新事件数。
- 告警名在 24 小时内产生过未归属的事件时，按覆盖缺口（ADR 0171）开 issue，每个（集群，告警名）一个。

## 考虑过的方案

| 方案 | 不采用的原因 |
|---|---|
| 把类别扩成业务领域 | 类别是跨部署通用的故障性质；领域是部署专有的。两者合并后，内置包的类别声明无法复用 |
| 事件引擎写入时按拓扑求服务 | 引擎的归并是纯函数（`packages/core`），拓扑查询是异步数据库访问；在引擎外另起写入方会让 `server.incidents` 多一个写入者 |
| 服务成员另写一套匹配器 | 组件类型已经是对象到"这是什么"的映射；第二套匹配器会和它不一致 |
| 由模型判断领域 | 不确定，不可重放，违反"确定性先行"（DESIGN §3） |

## 结果

- 契约 2.53.0 增加 `BusinessDomain`、`BusinessService`、`ComponentMatch`（从 `ComponentType.match` 抽出，两者共用），`AlertClassification` 与 `IncidentMember` 的 `service`、`service_source`、`business_domain`，`Incident` 的 `services`、`primary_service`、`primary_service_source`、`business_domain`。§6 的接口在后续版本加入。
- 服务目录与匹配函数在 `@srenautix/packs-sdk/business`（Apache-2.0）：部署方用 `pack lint` 校验自己的 `business.yaml`。`packages/core` 只做事件的折叠，并从这里取匹配函数。
- `server.incidents` 增加 `services text[]`、`primary_service text`、`primary_service_source text`、`business_domain text` 四列，只改 schema（ADR 0176）；历史事件由数据修正回填。
- 验收：在参考部署 11-02 至 11-05 的导出上重算，未归属为 0，网关的 6 种根因组件键归到同一个服务；不改声明，在 11-06 至 11-10 上重算，未归属不超过 5%。

### 设计时的重放

本 ADR 定稿前，用参考部署 11-02 至 11-05 的 132 个事件模拟了 §3 的顺序（只用导出里的根因组件键、根因实体与告警名，HPA 的属主按同名 Deployment 近似）。两处设计由重放改定：

| 初稿 | 重放结果 | 定稿 |
|---|---|---|
| 服务成员只能是组件类型 | 一个组件类型覆盖网关、控制面与后台任务三个服务，网关的逻辑组件被归到控制面 | 成员可以写 `match`，最具体的成员优先 |
| 汇总告警可以声明服务 | 7 个归档事件被汇总告警拉到运维系统自身 | 汇总告警不声明服务 |

定稿后的结果：未归属 0；请求转发 48、请求归档 22、账务与控制面 19、运维系统自身 15、数据存储 10、发布与交付 10、集群底座 8；网关的 6 种根因组件键都归到网关服务。来源分布：`component` 54、`catalog` 45、`owner` 19、`namespace` 14。
