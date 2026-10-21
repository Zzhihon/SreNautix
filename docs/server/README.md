# server 角色

server 是中心的状态与入口（DESIGN §1.1）：告警接入与对账、拓扑、事件引擎、阶段 A、规则提议、阶段 B 的准入与队列、提议中转与审批断言、反馈、通知与聊天渠道、身份、控制台 BFF、事件流、治理审计。代码在 `apps/srenautix/src/`，入口为 `node apps/srenautix/dist/main.js --role=server --config=/etc/srenautix/config.yaml`。

```mermaid
flowchart LR
  AM[Alertmanager / Grafana / 夜莺 / 通用 webhook] -->|POST /v1/ingest/:source| ING[接入]
  REC[60 秒对账] --> ING
  ING -->|alert_state + NOTIFY| ENG[事件引擎]
  TOPO[拓扑：informer 或 reader] --> ENG
  ENG -->|新版本| SA[阶段 A]
  SA -->|规则提议| PR[提议中转]
  SA --> ADM[准入与队列]
  ADM -->|claim| W[worker]
  W -->|研判事件、提议| PR
  PR -->|审批断言| T[工单]
  T -->|长轮询| GW[分支 gateway]
  ENG & SA & PR --> OB[(outbox)]
  OB --> NT[通知：Telegram / 飞书]
  OB --> EV[/v1/events]
```

## 文档

| 文档 | 内容 |
|---|---|
| [identity.md](identity.md) | 本地管理员与 TOTP、会话与 CSRF、OIDC、角色绑定与权限、聊天账号绑定 |
| [audit.md](audit.md) | 治理审计链的格式、导出与校验 |
| [notify.md](notify.md) | 消息模型、发送队列与限流、风暴、按钮、Telegram 与飞书的配置 |
| ADR 0040–0044 | 状态库与事件流、阶段 B 队列、通知队列、降级通道、审批断言签发 |

## 数据库

1. 以数据库管理员身份初始化（可以重复执行）：

   ```bash
   PGHOST=… PGPORT=5432 PGDATABASE=srenautix PGUSER=postgres PGSSLMODE=require \
     node apps/srenautix/dist/main.js db bootstrap --admin-password-file=/path/to/admin-password
   ```

   这会建立 `srenautix_server`、`srenautix_worker`、`srenautix_mcp` 三个角色与 `server`、`worker` 两个 schema，口令另行设置。
2. server 启动时自动执行扩展迁移；也可以在升级前单独执行 `db migrate --config=…`。全部副本升级后执行 `db contract` 完成收缩迁移（ADR 0040）。
3. 连接参数取 libpq 的环境变量 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGSSLMODE`（默认 `verify-full`，此时需要 `PGSSLROOTCERT`），口令从 `database.password_file` 读取。

## 配置

配置文件是 YAML，完整的键与默认值见 `apps/srenautix/src/config/server.ts`（未知的键会让启动失败）。最小的单集群配置：

```yaml
cluster_id: prod
profile: standard            # observe | standard | compliance
public_url: https://srenautix.example.com
ingest:
  sources:
    - { id: am, kind: alertmanager, token_file: /etc/srenautix/secrets/ingest/am }
  reconcile:
    alertmanager_url: http://alertmanager.monitoring:9093
    prometheus_url: http://prometheus.monitoring:9090
packs: { dirs: [/app/packs] }
datasources: { prometheus: { url: http://prometheus.monitoring:9090 } }
topology: { source: informer }         # 单集群；多集群为 reader
leader: { mode: lease, namespace: srenautix }
worker: { url: http://srenautix-worker:8080, token_file: /etc/srenautix/secrets/worker/token }
policies_dir: /etc/srenautix/policies  # 各集群 gateway 策略，与 gateway 挂载同一份
notify:
  prefix: "[影子]"
  telegram: { enabled: true, bot_token_file: …, chats: [{ id: -1001234567890 }], updates: none }
approvals: { signing_key_file: /etc/srenautix/secrets/approvals/ed25519.pem, key_id: prod-2026-10 }
callers: { tokens_file: /etc/srenautix/secrets/callers/callers.yaml }
identity:
  local_admin: { username: admin, password_hash_file: …, totp_secret_file: …, totp_required: true }  # false：只凭口令登录（ADR 0118）
  bindings_dir: /etc/srenautix/role-bindings
audit:
  checkpoint_key_file: /etc/srenautix/secrets/audit/ed25519.pem
  s3: { endpoint: http://minio:9000, bucket: srenautix-audit, access_key_file: …, secret_key_file: … }
```

- `callers.tokens_file` 列出服务调用方（worker、各分支的 reader 与 gateway、外部提议方、Grafana 插件），只保存 token 的 sha256，格式见 `apps/srenautix/src/identity/callers.ts`。
- `notify.telegram.updates: none` 表示只发送（bot 与其他服务共用，server 不接收它的更新）：此时事件消息不带回调按钮，只给控制台链接；改为 `webhook` 或 `polling` 后才渲染确认、静默、审批等按钮。
- 本地管理员的口令哈希：`printf '%s' '<口令>' | node apps/srenautix/dist/main.js admin hash-password`；TOTP 密钥是 20 个随机字节的 base32 编码（例如 `python3 -c 'import base64,os;print(base64.b32encode(os.urandom(20)).decode())'`），在验证器应用中按 SHA1、6 位、30 秒添加。
- 签名密钥：`openssl genpkey -algorithm ed25519 -out ed25519.pem`；审批签名的公钥写入各 gateway 的 approver-keys（ADR 0020）。
- 合规配置的 H 档审批用通行密钥签名（ADR 0094）：`approvals.approver_keys_file` 指向与 gateway 相同的审批人公钥文件（`contract/gateway/v1/approver-keys.schema.json`，来自 Git，每 60 秒重新加载），其中的 `webauthn.rp_id` 与 `origins` 对应控制台的外部地址，每个审批人的凭据写成 `{use: webauthn, credential_id, principal, alg, public_key}`：`alg` 为 `ES256`（P-256 未压缩点 65 字节的 base64url，常见的平台通行密钥）或 `EdDSA`（默认，Ed25519 公钥 32 字节的 base64url）；签名算法只取自这里登记的 `alg`，server 签出的证明类型为 `webauthn`。控制台先请求 `POST /v1/auth/webauthn/assertion-options`（挑战是待签名断言的哈希，5 分钟内有效，只能用一次），再把 `navigator.credentials.get` 的结果作为 `webauthn` 提交审批。文件缺失或没有 `webauthn` 设置时 server 照常启动，H 档审批返回 409 `webauthn_not_configured`。

## 端口

| 端口 | 内容 |
|---|---|
| `listen.api`（默认 :8080） | 全部 `/v1/*` 接口、webhook、渠道回调、`/healthz`、`/readyz`、控制台前端 |
| `listen.metrics`（默认 :9090） | `/metrics`（`srenautix_*`） |
| `listen.probes`（默认 :8081） | `/healthz`、`/readyz` |

## 控制台前端与 `--serve`

控制台前端（`web/console` 的构建产物，镜像内 `/app/web/console/dist`，配置项 `console.dir`）由 server 在 API 端口上提供：

- `/assets/*`：带内容哈希的文件，`Cache-Control: public, max-age=31536000, immutable`。
- 目录根部的其他文件（例如 favicon）：`Cache-Control: no-cache`。
- 其余不以 `/v1/`、`/healthz`、`/readyz`、`/metrics` 开头的 GET 返回 `index.html`（前端路由），`Cache-Control: no-store`，带 CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`（uPlot 与 Radix 使用内联 style 属性）。

| `--serve` | 内容 |
|---|---|
| `all`（默认） | 接口、控制台前端、单活工作 |
| `api` | 接口与单活工作，不提供控制台前端（不需要 `console.dir`） |
| `console` | 接口与控制台前端；不参与选主、不运行 informer，用于单独扩容控制台的 Deployment |

`console.dir` 中没有 `index.html` 时，`all` 与 `console` 启动失败。

### 事件流与请求风暴防护

- `GET /v1/events` 不带游标（`after` 或 SSE 的 `Last-Event-ID`）时从 outbox 当前末尾开始，只推送之后的新事件（契约：不填时从当前位置开始）。之前不带游标会从头回放整个 outbox，控制台对每条历史事件各失效一次查询；CCHP 上收件箱因此不停地请求 `/v1/incidents`，浏览器连接耗尽（`net::ERR_INSUFFICIENT_RESOURCES`），server 与 PG 的 CPU 被拉高。
- 控制台把事件要失效的查询键按批合并后统一失效，两次失效至少间隔 2 秒，在途的重取不被取消重发；首次连接不做全量对账，断线重连后对账一次。读请求经过防护：同一个 URL 同一时刻只有一个在途，10 秒内最多 6 次。失败按指数退避重试（1、2、4、8 秒，带抖动，上限 30 秒）：网络错误与 429 最多 4 次，5xx 最多 2 次，其他 4xx 不重试。
- server 对控制台会话（会话 cookie）的 GET 读接口限流：同一个会话对同一个接口（路由模板，不含查询参数）每秒补充 5 次、突发 20 次，超过时返回 429 `rate_limited` 与 `Retry-After`，计入 `srenautix_api_rate_limited_total{route}`。服务令牌的调用方（worker、gateway、reader、Grafana 插件）与事件流不受限。

## 单活工作

事件引擎、准入、通知的同步与投递、Telegram 长轮询、告警对账、提议过期与状态条件只在主实例上运行（`leader.mode=lease` 时用 Kubernetes Lease 选主，持有者为 Pod 名）。接口、webhook 与渠道回调在每个副本上都可以处理。

## 一次告警的处理

1. webhook 写入 `alert_state` 与接入日志，经 `NOTIFY` 唤醒主实例；60 秒对账补回遗漏并结束告警源中已经没有的告警。
   对账也是接入路径：每轮完整读取成功的对账计入接入（接入源 `reconcile` 的最后到达时间与 `srenautix_ingest_last_received_timestamp_seconds{source="reconcile"}`），对账读到 Watchdog 时计为 Watchdog 到达。只用对账、不接 webhook 推送的部署因此不会误报 `IngestSilent` 与 `WatchdogMissing`；webhook 没有推送、但对账在静默阈值内成功时，`IngestSilent` 的原因为 `ReconcileOnly`（不成立）。
2. 事件引擎用 packages/core 重算并对账事件，写入版本、成员、别名与 outbox。
3. 每个新版本立即出阶段 A：证据卡、规则提议、确定性的处置判断，发布 `stage_a.reported`，消息就地更新（见下面的"阶段 A 与领域包"）。
4. 按触发原因（新事件、根因变化、严重度升高、证据指纹变化）经准入进入阶段 B 队列，worker 认领后研判；研判事件经 server 的事件流发布，消息再次更新。
5. 提议经审批签发断言，分支 gateway 长轮询取走工单并推回执行事件。

## 阶段 A 与领域包

server 启动时用 packages/packs-sdk 加载 `packs.dirs` 下的领域包（每个子目录一个包；`packs.only` 不填时加载除 `_` 开头的示例包以外的全部包），编译 CEL 与 PromQL，并从中取得：

| 内容 | 用途 |
|---|---|
| `alerts.yaml` | 告警目录：角色分类、实体映射、告警声明的证据链 |
| `components.yaml` | 组件类型与 Operator 约定边，写进 informer 拓扑节点的 `component_type` |
| `rca-params.yaml` | 根因排序参数，按包的加载顺序叠加在默认值之上 |
| `chains.yaml`、`signals.yaml` | 阶段 A 执行的证据卡 |
| `rules.yaml` | 规则提议 |

### OCI 来源的包

`packs.oci` 中的包在目录中的包之后加载，总是加载（不受 `packs.only` 限制）。每个来源固定到 digest，启动时先用 cosign 校验签名，再检查制品类型与单层结构，最后用 oras 拉取（ADR 0091）；来源记为 `oci://<仓库>@<digest>`，计入 pack.lock。

```yaml
packs:
  dirs: [/app/packs]
  oci:
    cosign: cosign                         # 可执行文件
    oras: oras
    cache_dir: /var/cache/srenautix/packs  # 可写的临时卷，每个来源一个子目录，启动时清空后重新拉取
    sources:
      - repository: registry.example.org/packs/redis
        digest: sha256:<64 位十六进制>
        key_file: /etc/srenautix/packs/cosign.pub          # 密钥对签名
      - repository: ghcr.io/example/packs/kafka
        digest: sha256:<64 位十六进制>
        certificate_identity: https://github.com/example/packs/.github/workflows/release.yaml@refs/heads/main
        certificate_oidc_issuer: https://token.actions.githubusercontent.com   # keyless 签名
```

`key_file` 与 `certificate_identity` + `certificate_oidc_issuer` 二选一。`ignore_tlog: true` 跳过透明日志校验，只用于无法访问 Rekor 的离线环境，并且只能与 `key_file` 一起用。`plain_http: true` 用于只提供 HTTP 的仓库（仅限本机或隔离网络）。仓库凭证按 Docker 配置（`DOCKER_CONFIG`）读取。

签名校验、制品检查或拉取失败时只禁用这个来源，在"领域包"页列出原因；没有拉取到内容时摘要为制品的 digest。镜像中需要 `cosign` 与 `oras`。

阶段 A 执行哪些卡：

1. 根因（有歧义时前两个候选）的组件类型声明的证据链，实体为根因组件。
2. 每个能解析出实体的成员告警，不论分类来源（label、catalog、expression、default），按实体的组件类型执行证据链；告警归属的组件与实体不同时（例如 Pod 的属主 StatefulSet），组件类型的证据链也执行（ADR 0097）。
3. 成员告警的告警目录条目声明的证据链作为补充，实体为告警解析出的实体。
4. 组件类型先取拓扑节点上匹配出的类型；没有拓扑节点或没有匹配时，按 kind、命名空间与名称静态匹配领域包的组件类型（跳过带 labels 约束的类型）。一个对象匹配多个类型时取约束最多的，只按 kind 匹配的类型是兜底。
5. 只执行 `applies_to.kinds` 包含实体类型的卡；同一张卡对同一实体只执行一次，根因的卡排在前面。

告警标签解析出的实体统一成规范的 kind（node → Node 等），集群级对象（Node、PersistentVolume、ClusterRole 等）忽略 namespace 标签，`kubernetes_node` 与节点级抓取任务（node-exporter、kubelet）的 `instance` 映射到 Node。

卡片窗口以事件首次触发时间为锚点，终点不晚于当前时间。取数经 `datasources.prometheus`（`concurrency` 张卡同时执行，单个查询超时 `timeout`），标签档案每小时自动探测一次，信号备选的选择缓存 10 分钟。整个证据链的期限是 40 秒，超过期限时未完成的卡不进入报告。PG 不可用时降级通道照样执行证据卡，组件类型取最后一次成功对账时的拓扑。

规则提议的 CEL 上下文：`incident`（id、version、severity、全部成员共有的 labels、alerts）、`root`（根因实体与组件类型）、`cards`（卡片全局 id → verdict、display_state、value、reason_kind；同一张卡对多个实体执行时取根因上的结果）。

加载失败的处理：

- 单个包校验不通过（例如规则引用了动作目录中没有的动作）：只禁用这个包，其余包照常加载。
- `requires` 中的能力缺失，或者依赖的包被禁用：整个包禁用；`optional` 中的能力缺失时相应的卡显示"能力缺失"。
- OCI 来源的签名校验、制品检查或拉取失败：只禁用这个来源。
- 配置了 `packs.lock_file` 而加载的内容与之不一致：不加载任何包。

以上情况都发布 `PackLoadFailed` 条件（subject 为包名），控制台"领域包"页（`GET /v1/packs`）列出原因。证据数据源的标签档案探测失败时发布 `DatasourceUnavailable`（subject `evidence-metrics`），查询按规范标签名照常发出。

排除规则（`chains.yaml` 的 `excludes`）只在本次执行过的证据链上求值，上下文与规则提议相同；按声明顺序第一条命中时 disposition 为 `ignore`，报告中记录规则引用 `<pack>/<chain id>#excludes[<序号>]`。求值出错的规则不命中，计入 `srenautix_stage_a_rule_errors_total`。

## 组件的可读名称

领域包的组件类型可以声明 `display_name` 来源（告警注解、告警标签或本包的 metrics 信号的标签）。阶段 A 在事件锚点求出名称写入 `server.component_names`，事件详情、收件箱、通知标题与正文、GitHub issue 优先显示名称（正文写"名称（组件键）"），没有名称时显示组件键；组件键本身不变（ADR 0101）。

## 发布与收敛

没有配置变更源时，server 从拓扑事件推导 Kubernetes 的发布（`changes.kubernetes`，默认开启，ADR 0104）：工作负载的版本标签变化（`revision_labels`，默认 `app.kubernetes.io/version`、`helm.sh/chart`）与新的 ReplicaSet，`group_within`（默认 2m）内同一版本或同一个管理应用的变化合成一次 `kind: rollout` 的变更，目标包括管理它们的 Argo/Flux 应用。

```yaml
changes:
  kubernetes:
    revision_labels: [app.kubernetes.io/version, helm.sh/chart, cchp.io/release-id]
    ksm_fallback: true      # informer 空窗时从 kube-state-metrics 推导拓扑里没有的发布
    pre_step_labels: [cchp.io/release-id]  # 发布之前的 Job 按这些标签的取值关联到发布，默认不启用
```

发布之前 30 分钟内新建的 Job（迁移、预检，CronJob 创建的除外）按四档判定是否是这次发布的第一步（ADR 0104 §13）：管理应用（managed_by 边或 Argo 的 `app.kubernetes.io/instance` 标签）、`pre_step_labels` 的取值、Pod 镜像，都没有数据时同一命名空间且窗口里只有一个候选 Job。挂上的 Job 让发布的时间提前到它新建的时刻，变更的 `attachments` 写明依据。

informer 有空窗时（server 重启、与 reader 断连、刚安装），拓扑里没有这段时间新建的 ReplicaSet。`ksm_fallback`（默认开启，ADR 0104 §11）从证据数据源的 kube-state-metrics（`kube_replicaset_created`、`kube_replicaset_owner`、`kube_deployment_created`）补上：窗口内创建、属主 Deployment 早已存在、拓扑里从来没有记录过的 ReplicaSet 视为一次发布，与拓扑事件推导的发布用同样的规则合成。只对本集群；数据源不可用时跳过并记日志，结果缓存一分钟。

收敛时 Pod 级告警归到它的工作负载；没有对象的告警（发布流水线、部署后检查）与只落在命名空间上的告警归到它之前最近的一次发布。

## 集群状态检测器

`detectors.enabled` 打开后，server 按阈值把不健康的对象合成为 `source: detector` 的告警（ADR 0105），和告警规则一样收敛与研判；同一对象上同类的告警规则在触发时不合成。对象状态单集群由 server 的 informer 计算，多集群由 reader 上报。

```yaml
detectors:
  enabled: true
  namespaces: ["*"]
  exclude_namespaces: []
  pod_init_after: 10m
  pod_pending_after: 10m
  rollout_stalled_after: 15m
  crash_loop_after: 5m
  pdb_blocked_after: 10m
  job_failed: true
  severity: warning
  interval: 30s
  equivalent_alerts: {}          # 按状态追加视为同一问题的告警规则名
```

指标：`srenautix_detector_last_scan_timestamp_seconds{cluster_id}`、`srenautix_detector_findings{cluster_id,kind}`、`srenautix_detector_alerts_total{cluster_id,kind}`、`srenautix_detector_scan_errors_total{cluster_id}`；首个症状到事件创建的时长 `srenautix_incident_detection_seconds{source}`。

## 阶段 A 重算

阶段 A 报告记录计算时的 pack.lock。领域包变化后，主实例每分钟为最多 `stage_a.recompute_per_minute`（默认 10）个仍在触发的事件重算阶段 A；研判开始前报告过期时先重算；人工入口 `POST /v1/incidents/{ref}/stage-a/recompute`（`research.request`，写治理审计）。只算阶段 A，不触发模型（ADR 0107）。

## 阶段 B 的 Kubernetes 只读检查

`kube_reads.enabled` 打开后（需要 `roles.server.clusterRead`），区分性检查可以用 `kube_pod_status`、`kube_workload_pods`、`kube_events`、`kube_logs` 读取 server 所在集群的当前状态，只限事件涉及的命名空间，结果脱敏并截断（ADR 0106）。

```yaml
kube_reads:
  enabled: true
  tail_lines: 100
  max_bytes: 16384
```

## 自愈 PR

```yaml
remediation:
  enabled: false
  repositories:                 # 补丁模板里的仓库角色 → 仓库与文件布局（RepositoryLayout）
    gitops:
      repo: acme/gitops
      base_branch: main
      files:
        release_input: {path: apps/shop/prod/release.json, format: json, fields: {image: data.image, release_id: data.release_id}}
        alert_rules: {path: "platform/observability/rules/*.yaml", format: yaml}
        pack_alerts: {path: srenautix/packs/shop/alerts.yaml, format: yaml}
  categories: [release_rollback, config_resource, alert_rule, topology_coverage]
  conclusions: [likely, evidence_consistent]
  title_prefix: null            # 默认取 notify.prefix
```

需要 `github_app`（读仓库）与 gateway 策略中启用的 `gitops_pr`（ADR 0108）。主实例每 30 秒取最近结束、结论等级在 `conclusions` 中的研判：

1. 求适用的修复模板（领域包 `remediations.yaml`），按布局经 GitHub REST 只读地读取仓库，生成补丁；
2. 在内存中校验：路径在布局里、修改前内容与基准提交一致、补丁应用后与计划一致、修改后的 JSON/YAML 能解析、不超过 65536 字符；
3. 提交 `gitops_pr` 提议（来源 rule，规则 `srenautix/remediation-pr`；策略为 gitops_pr 列出自动执行规则 `remediation-pr` 时自动签发），分支 `srenautix/<事件前 8 位>-<类别>-<补丁摘要>`，标题带 `[影子]` 等前缀；
4. PR 描述分 结论、证据、改了什么、验证计划、回滚、研判运行 六段（`<!-- srenautix:pr=<段> -->` 标记），末尾 `Refs #<事件 issue>`；
5. gateway 开出 PR 后（执行事件里的 `PR <url> #<n>`，或按分支查询），事件 issue 里回链，通知消息的修复段落显示 PR 链接。

每次研判每个模板只处理一次，结果记在 `server.remediation_attempts`（proposed、skipped、rejected、failed 与原因码）与治理审计 `remediation.attempt`；指标 `srenautix_remediations_total{category,outcome}`、`srenautix_gitops_pulls_total{via}`。分支前缀、每小时上限、reviewers 与 main 的守护在 gateway 策略里，不在 server 配置中；server 从不写 Git。

## 变更源

事件引擎把首次触发前 30 分钟内、触及事件组件的变更放进事件（`incident.changes`），并作为根因排序的一项（DESIGN §5）。变更来自配置的变更源。hub 镜像不带 git，变更源只支持托管在 GitHub 上的仓库（`integrations/github`，ADR 0096），经 `github_app` 的安装令牌用 REST API 读取：

```yaml
github_app: { app_id: "123456", installation_id: "7890", private_key_file: /etc/srenautix/secrets/github-app/private-key.pem }
changes:
  interval: 60s          # 同步间隔
  lookback: 24h          # 每次同步回看的时长，按 change_id 去重
  sources:
    - id: gitops
      kind: github
      repo: acme/gitops
      branch: main
      paths:
        - { prefix: apps/shop/api/, targets: ['Deployment:shop/api'], kind: gitops_sync }
```

- 每次同步读取分支在回看窗口内的提交（`GET /repos/{repo}/commits`，按页读取，最多 1000 个），再读取每个提交的 diff（`GET /repos/{repo}/commits/{sha}`）中改动的文件，按路径前缀映射到拓扑节点；读过的提交不重复读取。合并提交不取（与 `git log --no-merges` 相同），时间取提交时间，链接为提交在 GitHub 上的页面。
- App 需要该仓库的 Contents 只读权限。
- 多集群时用 `cluster_id` 指定变更所属的集群，不填时为 server 的 `cluster_id`。
- 同步只在主实例上进行；有新变更时立即重算事件。某个变更源同步失败时发布 `DatasourceUnavailable` 条件（subject `changes:<id>`），其他变更源不受影响。
- `kind: git`（通用 git 远端）不支持，配置时 server 启动失败并说明改用 `kind: github`；`changes.cache_dir` 不再使用。

## 拓扑覆盖

领域包没有映射到组件的告警，可以在 Git 中用覆盖文件指定组件与角色。`topology.overrides_dir` 指向挂载的目录（与角色绑定、策略一样每 60 秒重新加载），目录下每个 `*.yaml`：

```yaml
api_version: srenautix.io/topology-overrides/v1
alerts:
  - cluster_id: prod
    alertname: KafkaConsumerLag
    match_labels: { topic: orders }        # 可省略；全部相等才命中，更具体的规则优先
    component: Deployment:shop/orders-consumer
    role: cause                            # cause | change | symptom | forecast | meta
```

命中的告警归属覆盖的组件，角色取覆盖的角色（告警自带 `role` 标签时仍以标签为准），分类依据记为 `topology-overrides/<文件>#<序号>`。文件不合法时 server 启动或重新加载失败，并指出文件与字段。

控制台拓扑页的"未映射告警"可以直接发起覆盖规则的 PR（`POST /v1/topology/overrides/pr`，admin）。server 只读地取 base 分支上的 `<dir>/<cluster_id>.yaml`，追加规则生成补丁，提交为 `gitops_pr` 提议；提议批准后由 gateway 在 `srenautix/*` 分支上提交并开 PR，从不合并（ADR 0025、0108）。server 不写 Git：

```yaml
github_app:                                            # 见下面的"GitHub App"
  app_id: "123456"
  installation_id: "7890"
  private_key_file: /etc/srenautix/secrets/github-app/private-key.pem
topology:
  overrides_dir: /etc/srenautix/topology-overrides     # 挂载仓库中的 <dir>
  override_pr:
    repo: acme/gitops
    base_branch: main
    dir: srenautix/topology-overrides
```

- 没有配置 `github_app` 与 `topology.override_pr` 时接口返回 503，说明需要在 Git 中直接修改覆盖文件；App 身份无效、没有安装到仓库、没有仓库权限或 GitHub 不可达时同样返回 503 并说明是哪一种。
- 提议绑定事件：请求带 `incident_id` 时用它，否则取包含这条告警的最近一个事件；没有这样的事件时返回 409（`no_incident`），事件没有根因或当前版本的阶段 A 报告时同样 409。gateway 策略中要启用 `gitops_pr`，否则提议记为未通过策略。
- 发起人能审批时（控制台会话、L 档、不是合规配置下的自批）直接批准，否则留待审批；响应带提议的状态与审批页地址（`approval_url`）。
- 基础分支上已有同一集群、同一告警名的规则时返回 409；同一条规则重复发起时返回已有的提议（200）。
- 开启了事件 issue 时，提议描述写 `Refs #<issue>`，issue 里回链提议；gateway 开出 PR 后（执行事件里的 PR 地址，或按分支查询）issue 里回链 PR，PR 描述还没有 Refs 时补上。见下面的"事件 issue"。
- 每次发起写入治理审计（`topology.override_pr`）。
- 2.5 版的写法 `topology.override_pr.github`（App 身份与仓库写在一起）仍然接受，解析时迁移到 `github_app` 与 `topology.override_pr`。

## GitHub App

拓扑覆盖 PR、事件 issue 与 GitHub 变更源都用同一个 GitHub App 的安装令牌（不用个人令牌）：App 私钥签的 RS256 JWT 换取安装令牌，1 小时有效，到期前 5 分钟刷新。

```yaml
github_app:
  api_base: https://api.github.com          # GitHub Enterprise 时改为 https://<host>/api/v3
  app_id: "123456"
  installation_id: "7890"
  private_key_file: /etc/srenautix/secrets/github-app/private-key.pem
```

server 对 Git 只读，写入都经 gateway 的 `gitops_pr`（ADR 0025、0108）。server 的请求白名单（`github/app.ts` 的 `deniedRequest`，不在其中的请求不发出，以 `GitHubDenied` 报错）：

- issue：列出、读取、新建，`PATCH` 只允许改正文（就地更新报告，ADR 0125）；评论：列出、新建；
- PR：列出、读取，`PATCH` 只允许改描述（补 `Refs`）；
- 只读访问仓库：分支引用（`git/ref/heads`）、文件与目录（`contents`）、提交列表与单个提交（修复补丁与拓扑覆盖的计划、变更源）。

建分支、写文件、提交、开 PR、请求审阅、合并都不在其中。server 用到的 App 仓库权限：Issues 读写、Pull requests 读写（只改描述）、Contents 只读；gateway 的 App 另需 Contents 与 Pull requests 写。

## 事件 issue

需要人跟进的事件在配置的仓库里开 issue，让 DevOps 看到问题（ADR 0095）。默认关闭：

```yaml
issues:
  enabled: true
  repo: acme/ops
  labels: [srenautix]          # 默认 srenautix
  title_prefix: "[影子]"        # 不填时取 notify.prefix
  max_per_hour: 6              # 每个仓库每小时最多新开的 issue 数
  lookback: 6h                 # 只为最近这段时间内更新过的事件开 issue
  interval: 30s                # 后台循环（登记、开出、评论、重试）
```

- **什么时候开**：阶段 A 或已完成的研判的处置判断为 `escalate`；或者有需要改仓库的修复提议（带 `incident_id` 的拓扑覆盖 PR、`gitops_pr` 提议）。被抑制、已合并的事件不开。
- **内容**：与通知同一份报告（ADR 0125，`docs/server/notify.md`）的全文：现状与时间线、关键问题（结论档位与四个条件的依据）、拓扑联系、解决方案与验证方法、证据链（每个假设的全部支持卡与相反卡、已执行的检查、排除的信号、无法判定的卡、成员告警与变更，带控制台与来源链接）。正文第一行是事件标记 `<!-- srenautix:incident=<id> -->`，随后是开 issue 的原因。标题是一句话现状（根因组件与症状），带标题前缀。
- **正文更新**：研判结束、事件恢复或证据变化后，后台循环重新生成正文，与上次写入的不同（`server.github_issues.body_hash`）时就地更新（PATCH 只改 body，`srenautix_github_issues_total{outcome="body_updated"}`）；只处理 `lookback` 内更新过的事件。
- **去重**：每个事件最多一个 issue（`server.github_issues` 以 incident_id 为主键）。开 issue 的请求超时或连接断开时，重试先按事件标记在仓库中找回已开的 issue，不重复开。
- **后续进展**：issue 开出之后结束的研判（新的结论档位与根因）、事件恢复、关联的 PR 与 gitops_pr 提议各追加一条评论，按 (事件, 键) 去重；评论同样带标记，重试时找回已写入的评论。
- **关联**：server 发起的拓扑覆盖 PR 与 gitops_pr 提议的参数描述里写 `Refs #<issue>`（跨仓库时 `owner/name#<issue>`），GitHub 在 issue 上显示关联；PR 先于 issue 开出时，issue 开出后给 PR 描述补上 Refs（`github.pr_refs`）。gitops_pr 的 Refs 在创建提议时写入参数，随参数一起被审批；幂等键按调用方给出的参数计算。
- **限速**：最近 1 小时已开满 `max_per_hour` 个 issue 时，新的事件记为 `skipped`，只记录（`github.issue_skipped`、`srenautix_github_issues_total{outcome="skipped_rate_limit"}`、日志），之后不再为它开 issue。评论不受限速。
- **失败与重试**：GitHub 返回错误或不可达时按退避重试（30 秒起，每次翻倍，最长 30 分钟），最多 8 次，用尽后记为 `failed`（`github.issue_failed`）。最近 1 小时内重试 3 次以上或放弃的 issue 与评论使状态条显示 `ChannelDeliveryFailed`（channel `github-issues`）。
- 主实例运行后台循环；控制台发起拓扑覆盖 PR、提交 gitops_pr 提议时在当前副本上立即尝试开一次。每次开出、跳过、放弃、评论与补 Refs 写入治理审计。
- 指标：`srenautix_github_issues_total{repo,outcome}`（opened、skipped_rate_limit、retry、failed、body_updated）、`srenautix_github_issue_comments_total{repo,outcome}`（posted、retry、failed）。

## 集成页

`GET /v1/integrations` 按 server 配置列出已启用的集成实例，每个实例对应 `integrations/` 中的一个清单（`integrations.dir`，不填时为与代码同一发布物中的 `integrations/`，镜像中 `/app/integrations`）：

| 实例 | 清单 | 连接测试（`POST /v1/integrations/{id}/test`，admin） |
|---|---|---|
| `ingest:<id>` | alertmanager、grafana-alerting、nightingale、generic-webhook | `alerts.webhook`：静默阈值内收到过告警；Alertmanager 配置了对账地址时 `alerts.reconcile` 请求 `/api/v2/status` |
| `datasource:prometheus` | prometheus-api | integration-sdk 的 verifyMetrics，逐项探测 |
| `changes:<id>` | git | fetch 后列出最近 1 小时的变更 |
| `notify:telegram`、`notify:feishu` | telegram、feishu | Bot API `getMe`、飞书 tenant_access_token；回调校验与 `/link` 按配置判断 |
| `approve:console` | console | 审批签名密钥；H 档在 standard 配置为口令加 TOTP 重新认证，compliance 配置检查审批人公钥文件的 WebAuthn 设置与登记的凭据 |
| `identity:local-admin`、`identity:oidc` | local-admin、oidc | OIDC 重新执行发现 |

清单中声明、但没有服务端探测的能力在结果中写明"这项能力没有服务端探测"。每次测试的结果保存在内存中，列表据此给出 `verified`；测试写入治理审计（`integration.test`）。`secret_refs` 只列出挂载文件的路径，不读出内容。

## 阶段 B 的输入与查询模板

worker 每分钟上报模型路由的可用情况：`POST /v1/research/routes`，请求体 `{worker_id, routes: [{id, enabled, reason, message}]}`。server 据此以 role `worker` 发布状态条件 `ModelRouteBreakerOpen`（被出站策略禁用的路由，原因 `EgressPolicy`；一条可用路由都没有时为 `EgressPolicyNoRoute`）。5 分钟内上报过的 worker 全部没有可用路由时，新的研判触发不入队，队列记为 `skipped`、原因 `no_model_route`，事件只出阶段 A（ADR 0093）。

worker 认领任务后读取 `GET /v1/research/tasks/{run_id}/context`（worker 的服务 token），字段与 `contract/schemas/eval-snapshot.schema.json` 的 `Context` 对应：

| 字段 | 内容 |
|---|---|
| `incident`、`alerts`、`stage_a`、`feedback` | 该事件版本、成员告警、阶段 A 报告、反馈 |
| `topology` | 研判时刻根因与组件两跳内的节点与边 |
| `catalog` | 动作目录 |
| `knowledge` | 领域包 `knowledge/*.yaml` 中与子图组件类型相关的条目（`components` 为空的通用条目总是包含），文本取配置项 `stage_a.language` 对应的语言，id 为 `<pack>/<entry id>` |
| `cases` | 参考案例：同集群已结束、经已绑定账号的人工反馈确认根因的事件（confirmed 取反馈评价版本的根因，rejected 取反馈给出的真实根因，真实根因未知的不取），根因在子图中或与子图节点同一命名空间，按结束时间从新到旧最多 10 个 |
| `templates` | 区分性检查可用的查询模板（`signals.yaml` 的 `templates`，只含附带卡的模板）：`id`（`<pack>/<template id>`）、`description`、`args`（参数的 JSON Schema） |
| `pack_lock` | 加载的领域包的 pack.lock 摘要，写入研判清单 |

查询模板由 server 执行，worker 不直接访问数据源：`POST /v1/research/tasks/{run_id}/query`，请求体 `{template, args, component}`。

- `args` 按模板的 schema 校验，值必须是数字、字符串或布尔值，覆盖卡片默认参数；不合法返回 400。
- `component` 必须是子图中的节点，或事件的组件与候选根因（包括命名空间伪组件）；否则 400。
- server 在该组件上执行模板附带的卡，窗口以事件首次触发时间为锚点，返回 `EvidenceResult`（卡片 id 为 `<pack>/templates/<template id>`）。数据源不可用时照常返回，结论为无法判定。

研判运行明细（`GET /v1/runs/{run_id}`）由 worker 持有，server 按研判所属事件的读取作用域转发，并在 `evidence` 前面合并该事件版本的阶段 A 卡（阶段 A 卡保留报告中的编号，worker 的检查卡编号在其后）。

## 录制回放的模型服务

`srenautix llm-replay --dir <录制目录> [--listen :8080]` 是同一镜像中的 OpenAI 兼容服务（`POST /v1/responses`、`/v1/chat/completions`，支持流式），kind-e2e 用它代替真实模型（`deploy/kind/scenarios/<场景>/llm/`）。

- 按结构化输出的名称与第几次出现取录制：`<名称>-<n>.json`，没有时取 `<名称>.json`。名称是 `hypothesize_output`、`check_judgement`、`conclude_output` 等。都没有时返回 503，worker 视为模型不可用。
- 录制可以是录下的 `{status, body}`，也可以是手写的 `{output: {...}}`。
- 结构化输出里整串为占位符的字符串按本次请求解析：`{{ref:<卡片 id>[@<实体>]}}` 解析为提示中这张卡的 `card:N`，`{{component:<正则>}}` 解析为第一个匹配的组件键，`{{enum:<值>}}` 只在该值出现在 schema 枚举里时保留。解析不出时删除所在的数组元素。
- `--record --upstream <base_url> [--api-key-file <文件>]` 以非流式转发到上游，并把响应写成 `<名称>-<n>.json`。
- `GET /healthz` 返回录制数、已回放与缺失的键。

## 本地运行与控制台 e2e

控制台的 Playwright e2e 可以这样启动一个真实的 server：

1. 用 `apps/srenautix/test/support/pg-cluster.ts` 的方式（`initdb` + `pg_ctl`）或任意 PostgreSQL 16+，执行 `db bootstrap`，为三个角色设置口令。
2. 按上面的最小配置写 YAML：`topology.source: off`、`ingest.reconcile.enabled: false`、不配置 `worker`；`public_url` 设为控制台的 Origin（CSRF 校验以它为准）。
3. `PGHOST=127.0.0.1 PGSSLMODE=disable PGUSER=srenautix_server … node apps/srenautix/dist/main.js --role=server --config=…`。用 `console.dir` 指向 `web/console/dist` 时 server 直接提供控制台前端；用 `vite preview` 代理 `/v1` 时加 `--serve=api`。
4. 登录：`POST /v1/auth/login {username, password, totp}`，响应设置 `__Host-srenautix_session` cookie 并返回 `csrf_token`。
5. 写入告警：`POST /v1/ingest/<source_id>`（`Authorization: Bearer <该接入源的 token>`），请求体为 Alertmanager webhook（`apps/srenautix/test/fixtures/alertmanager/` 中有录制样本）。几秒内出现事件与阶段 A 报告。
6. 写入研判结果：研判由 worker 产生。没有 worker 时，可以用 worker 的服务 token 调 `POST /v1/research/claim` 认领任务、`GET /v1/research/tasks/{run_id}/context` 取输入、`POST /v1/proposals` 提交提议。

`apps/srenautix/test/integration/server-e2e.test.ts` 按同样的步骤运行，并用 `contract/openapi.yaml` 校验每个控制台接口的响应。

## 测试

```bash
cd apps/srenautix
pnpm test            # unit + integration
```

集成测试使用真实的 PostgreSQL（`SRENAUTIX_PG_BIN`，默认 Homebrew postgresql@18）、Prometheus 3.15.0 与 Alertmanager 0.34.1（`SRENAUTIX_TEST_BIN`，默认仓库 `.scratch/bin`）、MinIO（`SRENAUTIX_MINIO_BIN`）、node-oidc-provider；单集群拓扑测试使用 envtest 的 kube-apiserver 与 etcd（仓库根目录 `make envtest-assets`）。
