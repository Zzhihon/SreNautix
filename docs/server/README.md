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
| [optimization.md](optimization.md) | 主动优化（ADR 0146）：目标运行、dbstats、建议的投递、验证循环、查询上限与负载保护、与 ADR 的差异 |
| ADR 0040–0044 | 状态库与事件流、阶段 B 队列、通知队列、降级通道、审批断言签发 |

## 数据库

1. 以数据库管理员身份初始化（可以重复执行）：

   ```bash
   PGHOST=… PGPORT=5432 PGDATABASE=srenautix PGUSER=postgres PGSSLMODE=require \
     node apps/srenautix/dist/main.js db bootstrap --admin-password-file=/path/to/admin-password
   ```

   这会建立 `srenautix_server`、`srenautix_worker`、`srenautix_mcp` 三个角色与 `server`、`worker` 两个 schema，口令另行设置。
2. server 启动时自动执行扩展迁移；也可以在升级前单独执行 `db migrate --config=…`。全部副本升级后执行 `db contract` 完成收缩迁移（ADR 0040）。迁移只改 schema；按新语义修正已有数据的数据修正在新版本取得主实例之后、开始单活工作之前执行一次，记录在 `server.data_corrections`，修正失败时单活工作暂停并每 30 秒重试（ADR 0176）。
3. 连接参数取 libpq 的环境变量 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGSSLMODE`（默认 `verify-full`，此时需要 `PGSSLROOTCERT`），口令从 `database.password_file` 读取。
4. 语句超时 30 秒，被取消的语句计入 `srenautix_pg_statement_timeouts_total{pool}`（server 与 worker 各自的连接池）。
5. 时间点拓扑查询（事件引擎的当前拓扑、根因子图、研判的两跳邻域）按索引分段取，同键的并发查询合并、短期缓存，每个进程同时最多 2 条在库上执行，耗时见 `srenautix_topology_query_seconds{query, source}`。拓扑历史每小时压缩一次，删除 `topology.history_retention`（默认 `14d`）之前已经关闭的行，保留期内任一时刻的拓扑不变（ADR 0144）。

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
   配置了 `ingest.reconcile.alertmanager_url` 时，两轮完整对账之间每 `additions_interval`（默认 `5s`，`0s` 关闭）读一次 Alertmanager 的活动告警，只补写本地还没有的触发中告警（ADR 0160）。这一步不读状态库与规则引擎，不结束告警；本地有哪些告警取最近一轮完整对账的结果，完整对账成功之前、以及不是主实例时不轮询。告警源给出的开始时刻到写入的时长见 `srenautix_ingest_delay_seconds{path}`（`full` 完整对账，`fast` 快速轮询），其中包含规则引擎自身的回溯：vmalert 把开始时刻记为求值时刻减去 `-rule.evalDelay`（默认 30 秒）再按组间隔对齐，告警在 Alertmanager 中出现时已经比开始时刻晚 30 秒到一个组间隔加 30 秒。
   每个告警记下第一次在 Alertmanager 中被看到的时刻 `alert_state.alertmanager_seen_at`（ADR 0165）：Alertmanager 或 Grafana 的 webhook 到达、完整对账或快速轮询读到 Alertmanager 应答、reader 快照的读取时刻，取最早的一次。先由规则引擎的 `ALERTS_FOR_STATE` 补写的告警没有这个时刻，之后的完整对账或快速轮询在 Alertmanager 中读到它时补上；集群状态检测器、夜莺与通用 webhook 的告警没有这个时刻。首条消息时延 `clock="alertmanager"` 从这里算起。
   对账也是接入路径：每轮完整读取成功的对账计入接入（接入源 `reconcile` 的最后到达时间与 `srenautix_ingest_last_received_timestamp_seconds{source="reconcile"}`），对账读到 Watchdog 时计为 Watchdog 到达。只用对账、不接 webhook 推送的部署因此不会误报 `IngestSilent` 与 `WatchdogMissing`；webhook 没有推送、但对账在静默阈值内成功时，`IngestSilent` 的原因为 `ReconcileOnly`（不成立）。
2. 事件引擎用 packages/core 重算并对账事件，写入版本、成员、别名与 outbox。事件的每个变更带关联分级（`change_links`：high、medium、low，依据与回退，ADR 0169）。
3. 每个新版本立即出阶段 A：证据卡、规则提议、确定性的处置判断，发布 `stage_a.reported`，消息就地更新（见下面的"阶段 A 与领域包"）。时间线的变更行写"关联分级 <grade>（依据：…）"，GitHub 变更再写命中的路径前缀。
   时延从事件的计时起点算（ADR 0159）：新事件为首个成员告警的触发时刻，从已有事件拆分出的事件为拆分时刻。`srenautix_stage_a_latency_seconds{origin}` 记第一个版本的阶段 A，`origin` 为 `new` 或 `split`；拆分出的事件不计入检测延迟 `srenautix_incident_detection_seconds`。`server.stage_a_reports.first_rendered_at` 是报告第一次生成的时刻，重算只更新 `rendered_at`。
   每个事件的阶段 A 单独执行（ADR 0173）：某个事件的阶段 A 抛错时写一条终态记录 `stage_a_failed`（带错误摘要），同一轮的其余事件照常出报告；状态库连接错误照常交给降级通道。每轮流水线最后补跑当前版本超过 60 秒没有报告的事件（不含 merged，已结束的只看 6 小时内更新的，critical 在前，每轮最多 5 个），补跑成功后照常按触发原因准入阶段 B（重开的版本按 reopened）；同一版本补跑失败 3 次后记 `stage_a_missing`，不再补跑。critical 事件在 Alertmanager 中 60 秒后仍没有报告时先发不带证据卡的消息（`docs/server/notify.md`）。
4. 按触发原因（新事件、根因变化、严重度升高、证据指纹变化）经准入进入阶段 B 队列，worker 认领后研判；研判事件经 server 的事件流发布，消息再次更新。租约过期次数超过恢复上限（2 次）的任务在下一次认领时记为结束，同时把研判镜像写为 `failed`（`error.kind` 为 `lease_expired`），消息与时间线写明原因；worker 之后仍发出结束事件时镜像按 worker 的结果覆盖。研判镜像的状态取 worker 事件里的 `state`（契约 2.39.0），出站策略禁用全部路由时与 worker 一样是 `stage_a_only`。
5. 提议经审批签发断言，分支 gateway 长轮询取走工单并推回执行事件。

## 终态原因码与事件时间线

每个终态都带一个原因码（ADR 0172）。取值登记在 `contract/reason-codes.json`：每个原因码有阶段（notify、stage_a、research、remediation、issue、incident，以及反馈的原因码 feedback，ADR 0174）、级别（info、warning、error）与中英文说明，分组对应代码与契约中的取值集合（例如研判失败类型、通知放弃的原因）。`packages/contract` 生成按阶段与按分组的字面量类型，写原因码的代码只能用这些类型；从库里读出的原因码不在登记表中时抛出。

| 终态 | 存在哪里 | 时间线条目 |
|---|---|---|
| 阶段 A 失败与缺失（`stage_a_failed`、`stage_a_missing`） | `server.incident_reasons` | `stage_a_missing` |
| 研判失败与只出阶段 A（失败类型，含 `lease_expired`） | `server.research_runs.error.kind` | `research_ended` |
| 研判结论（停止原因） | `server.research_runs.output.stop_reason` | `research_concluded` |
| 入队跳过（`budget`、`storm`、`capped`、`no_model_route`）与被取代（`superseded`） | `server.research_queue` | `research_ended` |
| 不进入阶段 B（`not_researched`，每个版本一次） | `server.incident_reasons` | `research_ended` |
| 自愈 PR 的处理结果 | `server.remediation_attempts.code` | `remediation_attempt` |
| 通知的送达、最后一次编辑、放弃与不推送 | `server.incident_reasons` | `notify` |
| 事件 issue 开出、跳过与失败（`opened`、`external_root`、`rate_limit`、`failed`） | `server.incident_reasons` | `issue` |
| 事件恢复、重开、被抑制（说明为抑制规则的原因或告警源静默）与写入失败（`persist_failed`） | `server.incident_reasons` | `incident_state` |
| 反馈的原因码（ADR 0174） | `server.feedback.reason_code` | `feedback` |

- `server.incident_reasons`（`incident` 轨道迁移 7）：事件、事件版本、阶段、原因码、说明（错误摘要等，最多 1000 字）、关联对象、时刻；`once_key` 不为空时同一事件、同一阶段、同一原因码只写一次。级别不存库，读出时按登记表。
- `GET /v1/incidents/{ref}/timeline` 的每条记录带 `code` 与 `level`（契约 2.39.0）；没有原因码的条目（告警、变更、卡、提议等）两者都为 null。说明里有错误信息或渠道应答原文的条目按不可信文本显示。
- 写入原因码的地方同时计数 `srenautix_terminal_states_total{stage,code,level}`，在事务里写入的在提交后计数；登记表里的每个原因码启动时导出 0。自身告警 `SreNautixAbnormalTerminalStates`：level 为 error 的原因码 15 分钟内增加 3 次以上，标签带 stage 与 code。

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

证据基线（ADR 0153，`stage_a.novelty`）：判为异常的卡在同一实体上、按同样长度的窗口在事件之前的时段重新执行，结果写进卡的 `novelty`。时段是对照时段 `comparisons`（默认 `1h`、`24h`、`7d`，即事件前 1 小时、24 小时、7 天的同一时段）加上 `span`（默认 `7d`）内均匀分布的 `samples`（默认 28）个时段，与事件窗口重叠的不取，早于 `stage_a.metrics_retention` 的不取。得出结论的样本少于 `min_samples`（默认 8）时为 `unknown`；否则下面任一项成立即为常态（`routine`），都不成立为明显异常（`novel`）：

1. 样本中判为异常的比例不低于 `abnormal_share`（默认 0.5）；
2. 条件在样本中出现过，并且事件窗口的主值落在样本主值的 `[1 − quantile, quantile]` 分位区间内（默认 0.95）；
3. 条件在样本中出现过，主值的单位是计数或速率，与对照时段主值的最大值相差不到 `ratio` 倍（默认 3）。

取样本的期限是 `timeout`（默认 `15s`），与证据链共用 40 秒的整体期限；没有取完的样本不计入。常态的卡照常出现在报告与消息里，研判不把它作为根因或支持证据；规则提议与修复模板的上下文里它按正常给出。`enabled: false` 关闭。指标 `srenautix_stage_a_evidence_novelty_total` 按判定计数。

最低取证集合（ADR 0153）：告警目录条目的 `required_cards` 列出告警触发时必须在告警实体上得出结论的卡（卡所在的证据链必须在条目的 `chains` 中）。阶段 A 报告的 `required_evidence` 记录每条这样的成员告警与没有得出结论的卡；研判之后区分性检查也没有补上时，结论档位只能是 `undetermined`，处置不能是 `act` 或 `ignore`。

规则提议的 CEL 上下文：`incident`（id、version、severity、全部成员共有的 labels、alerts）、`root`（根因实体与组件类型）、`cards`（卡片全局 id → verdict、display_state、value、reason_kind；同一张卡对多个实体执行时取根因上的结果；证据基线判为常态的卡按正常给出）。

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

### 退役与已合并、尚未同步的提交

两类信息从证据数据源的指标推导（ADR 0161），只对本集群（退役按分钟对齐区间并缓存一分钟，未同步按 5 分钟对齐并缓存 5 分钟），数据源报错时跳过这一类并记日志：

| 配置 | 默认 | 内容 |
|---|---|---|
| `changes.kubernetes.retirements` | 开启 | 工作负载被删除或副本缩到 0 并保持是一次 `kind: retire` 的变更（契约 2.33.0），数据来自 kube-state-metrics 的 `kube_deployment_spec_replicas`、`kube_statefulset_replicas`、`kube_daemonset_status_desired_number_scheduled` 与 `up` |
| `changes.pending_sync.enabled` | 开启 | Argo CD 应用处于 OutOfSync 时，从它最后一次 Synced 起合并的、触及它的变更源提交标上 `pending_sync`，数据来自 `argocd_app_info` |
| `changes.pending_sync.lookback` | `72h` | 往前找最后一次 Synced 的范围；更早就一直未同步时取这个范围内的提交 |

退役变更：

- 序列消失至少 5 分钟才算删除；kube-state-metrics 自己没有数据（全部副本数序列一起中断）时不推导。`group_within` 内同一命名空间或同一个管理应用的退役合成一次，目标是管理应用与工作负载；
- `scrape_jobs`：退役之前一小时内的目标全部是被退役工作负载的 Pod、之后没有目标的抓取 job。报这些 job 没有目标的告警（在拓扑里没有对象锚点）由这次退役解释；
- `planned_by`：退役之前 24 小时内最近一次触及这些工作负载、管理应用或其上层应用的变更源提交，标出计划内的退役，通知写成"计划内退役 <提交>"并链接到提交；
- 根因候选是管理应用（没有时是工作负载），退役变更在研判中作为这个候选的支持证据，档位最高 likely。

已合并、尚未同步的提交列进应用上的告警（ArgoCDManualAppDrift 之类）所在的事件，不受变更窗口限制，不把告警归并，也只让这个应用成为根因候选；通知把它们合成一句"N 个已合并、尚未同步的提交"。

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

卡片窗口以事件首次触发为锚点。长期事件（评估时刻晚于锚点加卡片的 `window.after`）的窗口终点取评估时刻（已恢复的事件取恢复时刻），起点不早于终点减去 `stage_a.card_window_max`（默认 `24h`），也不早于评估时刻减去 `stage_a.metrics_retention`（指标数据源的保留期，不填时不限）。指标只在窗口后段才有数据时，卡按这些数据判定，不算观测失明（ADR 0149）。

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
  categories: [release_rollback, config_resource, alert_rule]
  conclusions: [likely, evidence_consistent]
  title_prefix: null            # 默认取 notify.prefix
  rejected_cooldown: 7d         # 同一模板对同一组文件的修改被人拒绝后，这段时间内不再提出
```

`categories` 中写了 `topology_coverage` 时 server 去掉它并在日志里记录弃用警告：没有告警目录条目的告警改为覆盖缺口 issue（见"事件 issue"一节，ADR 0171）。

需要 `github_app`（读仓库）与 gateway 策略中启用的 `gitops_pr`（ADR 0108）。主实例每 30 秒取最近结束、结论等级在 `conclusions` 中的研判（上一轮没有结束时跳过这一轮）：

1. 按研判输出判断准入条件（ADR 0170，见下文），整次研判都不满足时记一行跳过；
2. 求适用的修复模板（领域包 `remediations.yaml`），模板的类别不满足准入条件时记为跳过；按布局经 GitHub REST 只读地读取仓库，生成补丁；
3. 在内存中校验：路径在布局里、修改前内容与基准提交一致、补丁应用后与计划一致、修改后的 JSON/YAML 能解析、不超过 65536 字符；之后检查仓库事实；
4. 按修改去重（ADR 0155，见下文）；
5. 提交 `gitops_pr` 提议（来源 rule，规则 `srenautix/remediation-pr`；策略为 gitops_pr 列出自动执行规则 `remediation-pr` 时自动签发），分支 `srenautix/<事件前 8 位>-<类别>-<补丁摘要>`，标题带 `[影子]` 等前缀；
6. PR 描述分 结论、证据、改了什么、验证计划、回滚、研判运行 六段（`<!-- srenautix:pr=<段> -->` 标记），末尾 `Refs #<事件 issue>`；
7. gateway 开出 PR 后（执行事件里的 `PR <url> #<n>`，或按分支查询），事件 issue 里回链，通知消息的修复段落显示 PR 链接。

每次研判每个模板只处理一次，结果记在 `server.remediation_attempts`（proposed、skipped、rejected、failed 与原因码、原因）与治理审计 `remediation.attempt`（带原因）；指标 `srenautix_remediations_total{category,outcome,code}`、`srenautix_gitops_pulls_total{via}`；控制台的事件时间线显示每条处理结果（`remediation_attempt`）。分支前缀、每小时上限、reviewers 与 main 的守护在 gateway 策略里，不在 server 配置中；server 从不写 Git。

**准入条件**（ADR 0170）：发布回退与配置资源这两类修改系统本身，四项同时满足才开 PR；告警调优修改的是告警本身，只看良性依据。

| 条件 | 判断时机 | 跳过代码 |
|---|---|---|
| 研判输出的根因范围 `cause_scope` 为 local 或 configuration（研判已按确定性依据校正） | 模板匹配之前，按研判 | `cause_scope` |
| 结论有支撑卡（`consistency_detail` 的 `support_refs` 与 `model_judged_refs`），不只是成员告警与变更 | 同上 | `topology_only` |
| 支撑卡中至少一张的查询是运行时证据：指标、日志、数据库统计，或 `kube_*` 只读检查 | 同上 | `no_runtime_evidence` |
| 补丁修改的文件在基线上都存在，研判根因由 GitOps 仓库负责（仓库声明的组件，或管理它们的 GitOps 应用） | 计划校验之后，按模板 | `no_repo_fact` |
| 告警调优：处置为 ignore，依据（研判输出的 `ignore_basis`）为 `stage_a`、`evidence_normal` 或 `impact_normal` | 模板匹配之前，按研判 | `not_benign` |

卡的引用按研判运行时的证据解析：检查产生的卡取研判输出的 `check_cards`，阶段 A 的卡按 `evidence_index` 的 `<卡片>@<实体>` 在研判针对的事件版本的报告里找，阶段 A 重算改变编号时仍然找到同一张卡。两类都不满足时整次研判记一行（key `-`）；只有一类不满足时，这一类的模板各记一行跳过。没有开出的修复仍然在研判的修复建议与事件 issue 里。

**修改去重**（ADR 0155）：去重键是（仓库，变更哈希）。变更哈希由规范化补丁与修改定位一起计算：规范化补丁只含每个文件的路径与增删的行，基准提交前进、行号与上下文变化后同一个修改的哈希不变；修改定位是模板 edits 声明的目标在变量替换之后的值（文件、`document` 的 kind 与 name、`locate`，例如 `spec.groups[*].rules[alert=<告警名>]`），同一个文件里增删的行相同、改的是不同规则的补丁哈希不同。每个提议在 `server.remediation_changes` 记一行，状态按提议、`gitops_pulls` 与 GitHub 上 PR 的当前状态（GET pulls/{n}）在判断时刷新：

| 已有的同一个修改 | 原因码 | 处理 |
|---|---|---|
| 提议还没有开出 PR | `duplicate_pending` | 不提议；登记这次触发，PR 开出后照下一行处理 |
| PR 打开 | `duplicate_open` | 不提议；在 PR 上评论这次触发（事件、研判运行与 `Refs` 新事件的 issue，带 `<!-- srenautix:trigger=<事件> -->` 标记，同一事件只评论一次），新事件的 issue 里回链 PR，PR 描述补上它的 Refs |
| PR 关闭且没有合并，或提议在审批时被人拒绝 | `rejected_before` | 不再自动提出；人重新打开 PR 后按打开处理 |
| 同一模板对同一组文件的另一个修改在 `rejected_cooldown` 内被拒绝 | `rejected_cooldown` | 冷却期内不提出 |

PR 已合并、提议被策略拒绝、过期、绑定过时或执行失败（没有开出 PR）的修改不算重复。记录在 PostgreSQL 里，server 重启后照常生效；没有记录的旧提议在每轮开始时按 `remediation_attempts` 补登记。加入定位之前的记录（`hash_version` 1，只含规范化补丁）按旧哈希参与 `duplicate_open`、`duplicate_pending`；`rejected_before` 要求旧哈希相同并且定位相同，定位相同由旧补丁在它的基准提交上是否改动了新修改的每个定位确认，确认后这一行记下定位。PR 评论与 issue 关联失败时退避重试，最多 8 次；写入治理审计 `remediation.trigger_comment`，状态变化写 `remediation.change_state`。

**模板上下文里的告警**（ADR 0155）：每条成员告警带归属组件对应的具体对象（`component_object`）与是否描述集群之外的上游（`external`：组件类型声明了 external，或命中 `notify.digest.external_roots` 开启时的 `components`、`alert_labels`）。`noisy-alert-relax` 不降级外部上游的告警。

## 变更源

事件引擎把首次触发前 30 分钟内、触及事件组件的变更放进事件（`incident.changes`），并作为根因排序的一项（DESIGN §5）。变更来自配置的变更源：GitHub 仓库与 SQL 审计表（见下一节）。hub 镜像不带 git，Git 变更源只支持托管在 GitHub 上的仓库（`integrations/github`，ADR 0096），经 `github_app` 的安装令牌用 REST API 读取：

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

- 每次同步读取分支在回看窗口内的提交（`GET /repos/{repo}/commits`，按页读取，最多 1000 个），再读取每个提交的 diff（`GET /repos/{repo}/commits/{sha}`）中改动的文件，按路径前缀映射到拓扑节点；读过的提交不重复读取。合并提交不取（与 `git log --no-merges` 相同），时间取提交时间，链接为提交在 GitHub 上的页面。变更的 `paths` 记命中的路径前缀（契约 2.37.0），用于展示关联依据。
- App 需要该仓库的 Contents 只读权限。
- 多集群时用 `cluster_id` 指定变更所属的集群，不填时为 server 的 `cluster_id`。
- 同步只在主实例上进行；有新变更时立即重算事件。某个变更源同步失败时发布 `DatasourceUnavailable` 条件（subject `changes:<id>`），其他变更源不受影响。
- `kind: git`（通用 git 远端）不支持，配置时 server 启动失败并说明改用 `kind: github`；`changes.cache_dir` 不再使用。

### SQL 审计表变更源

经管理接口或直接写库生效的运行时配置改动（停用一个导出目的地、发布一份路由配置）不经过 Git 与发布，前面两类变更源看不到它们。业务库里有这类改动的审计记录时，`changes.sql_audit` 把每条记录作为一次 `kind: runtime_config` 的变更（契约 2.29.0，`integrations/sql-audit`，ADR 0151）。默认没有，不连接任何业务库。

```yaml
changes:
  sql_audit:
    - id: app-db                       # 变更的 source，change_id 为 <id>:<查询 id>:<键>
      connection:                      # 与 optimization.dbstats 同样的写法
        host: app-pg-rw.app-data.svc
        database: app
        user: srenautix_stats
        password_file: /etc/srenautix/secrets/sql-audit-app-db/password
      group_within: 2m                 # 同一对象在这段时间内改动又改回原来的取值时不算变更
      queries:
        - id: export-targets
          table: srenautix_audit.export_target_changes   # <schema>.<名称>：表、视图，或返回审计记录的函数
          function: true                       # table 是函数时以回看窗口的起止两个 timestamptz 为参数调用
          key: id                              # 行的唯一键
          time: occurred_at                    # timestamp 或 timestamptz
          object: target_id                    # 被改动的对象
          action: action
          actor: actor_id                      # 可选
          value: state                         # 可选：改动之后对象的取值（jsonb 时摘要只列出变化的键）
          # previous_value: 可选，改动之前的取值所在的列；不写时取同一对象上一条记录的取值
          details: [name]                      # 可选：另外写进摘要的列
          components:                          # 按顺序取第一条匹配的规则；都不匹配的记录不算变更
            - match: { action: [export_target.purge] }
              targets: ['Deployment:app/worker']
            - targets: ['StatefulSet:app/gateway']
```

- **查询**：只有声明的关系名、函数名与列名（小写的普通标识符，加双引号引用）进入 SQL，读取时间列落在回看窗口（`lookback`）内的行，按时间排序，每个查询最多 1000 行。每个查询在单独的只读事务中执行（`statement_timeout` 3 秒，`lock_timeout` 200 毫秒），连接池最多 1 个连接，空闲 60 秒关闭。
- **权限**：角色能读取声明之外的任何业务关系（表、视图、物化视图、外部表）时不读取，变更源状态记下 `DatasourceOverPrivileged` 与能读取的关系，与 dbstats 的不变量 14 相同。与 `optimization.dbstats` 用同一个连接（host、port、database、user 相同）时，dbstats 的权限自检同样放行声明的表与视图。
- **授权的做法**：给角色一个返回审计记录的函数（`function: true`）。函数的属主是超级用户、`SECURITY DEFINER`、`SET search_path = pg_catalog, pg_temp`，函数体用 `RETURN QUERY EXECUTE … USING` 按时间窗只查出需要的行与列；角色只有这个函数的 `EXECUTE` 与 schema 的 `USAGE`，读不到任何业务关系。审计表开着行级安全（包括 FORCE）也能经函数读取，时间窗在函数里就用上审计表的索引。函数体是动态查询，PostgreSQL 不登记它对表与列的依赖：业务的迁移删改这些列时不会被它阻止，之后读取失败只记在变更源状态里。视图也可以，但视图依赖它引用的列，业务的迁移删除这些列、改变列的类型或重建表时会失败。
- **示例函数**（审计日志按 `resource_type` 区分资源，`payload` 是改动之后的资源）：

  ```sql
  CREATE SCHEMA srenautix_audit;
  REVOKE ALL ON SCHEMA srenautix_audit FROM PUBLIC;
  CREATE FUNCTION srenautix_audit.export_target_changes(from_at timestamptz, to_at timestamptz)
    RETURNS TABLE (id text, occurred_at timestamptz, target_id text, action text, actor_id text, state jsonb, name text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
    BEGIN
      RETURN QUERY EXECUTE
        'SELECT id::text, occurred_at, resource_id::text, action::text, actor_id::text,
                payload - ''version'', payload ->> ''name''
           FROM public.admin_audit_log
          WHERE resource_type = ''export_target'' AND occurred_at >= $1 AND occurred_at <= $2'
        USING from_at, to_at;
    END $fn$;
  REVOKE ALL ON FUNCTION srenautix_audit.export_target_changes(timestamptz, timestamptz) FROM PUBLIC;
  GRANT USAGE ON SCHEMA srenautix_audit TO srenautix_stats;
  GRANT EXECUTE ON FUNCTION srenautix_audit.export_target_changes(timestamptz, timestamptz) TO srenautix_stats;
  ```
- **变更**：`source` 为变更源 id，`refs` 为 `<查询 id>/<对象>` 与动作，`revision`、`previous_revision` 为改动之后与之前的取值（超过 80 个字符时取 sha256 的前 12 位），`summary` 写动作、取值的变化与 `details`。
- **没有变化与往返**：与发布的标签抖动相同（ADR 0142）：同一对象从一条记录起 `group_within` 之内回到这条记录之前的取值，这几条记录都不算变更，包括新旧取值相同的一条记录。之前写入的变更随后变得不成立时（往返的后半条晚一轮读到），从回看窗口内删除。
- **排序**：与其他变更相同：在问题开始之前（或容差之内）、变更窗口内的变更解释它目标上的告警，进入事件，给目标先验与近期变更两项；晚于目标上问题开始超过容差的不参与排序（ADR 0142）。
- **阶段 A 与研判**：变更出现在事件的时间线里（`<source> runtime_config <查询 id>/<对象> <动作>`），通知标题写 `运行时配置 <查询 id>/<对象> <动作>`。研判输入的相关变更里，运行时配置变更回看到首次触发前 24 小时并全部保留（它的影响常常滞后）；只要有这类变更，研判上下文就多出一段“运行时配置变更（首要假设）”，要求第一个假设以它们为原因提出并设计区分性检查去验证或排除。没有这类变更时提示词不变。
- chart 的 `changes.sqlAudit` 生成这一节：每一项的 `existingSecret`（键 `passwordKey`，默认 `password`）挂载到 server 的 `/etc/srenautix/secrets/sql-audit-<id>/password`；`networkPolicy.sqlAuditEgressTo` 限定 server 到业务库的出站。

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
- 只读访问仓库：分支引用（`git/ref/heads`）、文件与目录（`contents`）、提交列表与单个提交（修复补丁与拓扑覆盖的计划、变更源），以及两个完整提交 sha 的比较（主动优化的验证循环判断 Argo 应用同步的版本是否包含合并提交，ADR 0146 §2.6）。

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

- **什么时候开**：阶段 A 或已完成的研判的处置判断为 `escalate`；已完成的研判处置为 `act` 而没有提议（修复是修改仓库，按修复模板开 PR 或按修复建议修改，ADR 0162），原因记为 `repo_change`；或者有需要改仓库的修复提议（带 `incident_id` 的拓扑覆盖 PR、`gitops_pr` 提议）。被抑制、已合并的事件不开。
- **内容**：与通知同一份报告（ADR 0125，`docs/server/notify.md`）的全文：现状与时间线、关键问题（结论档位与四个条件的依据）、拓扑联系、解决方案与验证方法、证据链（每个假设的全部支持卡与相反卡、已执行的检查、排除的信号、无法判定的卡、成员告警与变更，带控制台与来源链接）。正文第一行是事件标记 `<!-- srenautix:incident=<id> -->`，随后是开 issue 的原因。标题是一句话现状（根因组件与症状），带标题前缀。
- **正文更新**：研判结束、事件恢复或证据变化后，后台循环重新生成正文，与上次写入的不同（`server.github_issues.body_hash`）时就地更新（`srenautix_github_issues_total{outcome="body_updated"}`）；只处理 `lookback` 内更新过的事件。
- **标题更新**（ADR 0142）：标题是根因与头条症状，它们变了就在同一次 PATCH 里改标题（`server.github_issues.title`、`github.issue_retitled`、`srenautix_github_issues_total{outcome="title_updated"}`），否则按开出时的根因搜不到这个 issue。同一事件每小时最多改一次标题，根因或症状来回抖动时不跟着来回改，没到时间的标题留到之后的轮次。按标记找回、或这一版之前开出的 issue 先读回一次 GitHub 上的标题。PATCH issue 只允许改标题与正文。
- **去重**：每个事件最多一个 issue（`server.github_issues` 以 incident_id 为主键）。开 issue 的请求超时或连接断开时，重试先按事件标记在仓库中找回已开的 issue，不重复开。
- **后续进展**：issue 开出之后结束的研判（新的结论档位与根因）、事件恢复、关联的 PR 与 gitops_pr 提议各追加一条评论，按 (事件, 键) 去重；评论同样带标记，重试时找回已写入的评论。
- **关联**：server 发起的拓扑覆盖 PR 与 gitops_pr 提议的参数描述里写 `Refs #<issue>`（跨仓库时 `owner/name#<issue>`），GitHub 在 issue 上显示关联；PR 先于 issue 开出时，issue 开出后给 PR 描述补上 Refs（`github.pr_refs`）。gitops_pr 的 Refs 在创建提议时写入参数，随参数一起被审批；幂等键按调用方给出的参数计算。
- **限速**：最近 1 小时已开满 `max_per_hour` 个 issue（事件 issue 与覆盖缺口 issue 合计）时，新的事件记为 `skipped`，只记录（`github.issue_skipped`、`srenautix_github_issues_total{outcome="skipped_rate_limit"}`、日志），之后不再为它开 issue。评论不受限速。
- **外部上游**（ADR 0147）：根因是外部上游且没有业务影响的事件（判定见 `docs/server/notify.md` 的“外部上游的周期汇总”）不开 issue，进入通知的周期汇总。事件未恢复时每 10 分钟再判定一次，期间出现业务影响就照常开出；恢复后记为 `skipped`（`github.issue_skipped` 的 `reason: external_root`、`srenautix_github_issues_total{outcome="skipped_external"}`）。需要改仓库的修复提议（`repo_change`）不受影响。
- **失败与重试**：GitHub 返回错误或不可达时按退避重试（30 秒起，每次翻倍，最长 30 分钟），最多 8 次，用尽后记为 `failed`（`github.issue_failed`）。最近 1 小时内重试 3 次以上或放弃的 issue 与评论使状态条显示 `ChannelDeliveryFailed`（channel `github-issues`）。
- 主实例运行后台循环；控制台发起拓扑覆盖 PR、提交 gitops_pr 提议时在当前副本上立即尝试开一次。每次开出、跳过、放弃、评论与补 Refs 写入治理审计；开出、跳过与重试用尽另写一条终态记录（`opened`、`external_root`、`rate_limit`、`failed`），进入事件时间线。
- 指标：`srenautix_github_issues_total{repo,outcome}`（opened、skipped_rate_limit、skipped_external、retry、failed、body_updated）、`srenautix_github_issue_comments_total{repo,outcome}`（posted、retry、failed）。

### 关闭的跟踪

配置了 GitHub App 时，主实例每 10 分钟刷新打开的自愈 PR（`server.remediation_changes` 中状态为 `open` 的修改）与事件 issue（`server.github_issues` 中打开、还没有记下关闭的），每个仓库每轮各最多 30 个，最久没有检查的在前（ADR 0174）：

- PR 关闭且没有合并：修改记为 `rejected`，写入隐式反馈 `pr_closed`（渠道 `github`，提交者 `github:<关闭者>`，原因是关闭之前的最后一条人工评论，关联提议所属的研判）与评测候选（ADR 0175）。去重判断时读取到的关闭同样写入。
- issue 以 not planned 关闭：记下 `closed_at` 与 `state_reason`，写入隐式反馈 `issue_not_planned` 与评测候选；以 completed 关闭只记下关闭时刻与原因。issue 的状态不变，进展评论照常追加。每次关闭写入治理审计 `github.issue_closed`。
- 单个 PR 或 issue 的 GitHub 请求失败只记日志，下一轮再读取。这两种隐式反馈不算已绑定账号，不进入研判提示词的人工反馈，也不算事件的最新反馈。

### 覆盖缺口 issue

开启 `issues` 时，没有命中任何告警目录条目（也没有拓扑覆盖）的成员告警是覆盖缺口（ADR 0171）。缺口不开自愈 PR，每个（集群，告警名）在同一个仓库开一个 issue，由人决定是否补齐：

- **登记**：后台循环（`issues.interval`）扫描 `lookback` 内更新过、没有被抑制或合并的事件，把分类里没有目录条目、仍在事件里的成员告警记入 `server.coverage_gaps`（每个缺口一行）与 `server.coverage_gap_incidents`（缺口出现过的事件）。
- **内容**：标题 `<前缀> 覆盖缺口：告警 <告警名> 没有告警目录条目（集群 <集群>）`；标签为 `issues.labels` 加 `coverage`；正文第一行是标记 `<!-- srenautix:coverage=<集群>/<告警名> -->`，写明出现次数（事件数）、首次与最近一次出现、最近一次触发的标签、涉及事件（最多 20 个，链接到控制台）、补齐目录条目或拓扑覆盖的步骤与控制台拓扑覆盖页的入口。
- **再次出现**：缺口出现在新的事件里时，只在 issue 下追加一条评论（标记 `<!-- srenautix:coverage-comment=<集群>/<告警名> -->`），列出新的事件与累计数。评论之前读取 issue 的状态：人已关闭时缺口记为 `closed`，之后不再评论，也不再为这个告警开 issue，新的事件只在状态库里计数。
- **限速**：与事件 issue 共用 `max_per_hour`（同一仓库最近 1 小时开出的两类 issue 合计）。达到上限时缺口保持 `pending`，10 分钟后再试。
- **失败与重试**：创建请求的结果未知（超时、连接中断、5xx）时记为 `unknown`，下一次先按标记在仓库中找回，找回的 issue 把已登记的事件补一条评论；结果明确的失败按退避重试，最多 8 次，用尽后记为 `failed`。开出、找回、放弃、评论与关闭写治理审计（`github.coverage_issue_opened`、`github.coverage_issue_failed`、`github.coverage_issue_comment`、`github.coverage_issue_closed`）。
- 指标：`srenautix_coverage_issues_total{repo,outcome}`（opened、recovered、deferred、retry、failed、commented、closed）。

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
