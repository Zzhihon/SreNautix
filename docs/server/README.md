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
  local_admin: { username: admin, password_hash_file: …, totp_secret_file: … }
  bindings_dir: /etc/srenautix/role-bindings
audit:
  checkpoint_key_file: /etc/srenautix/secrets/audit/ed25519.pem
  s3: { endpoint: http://minio:9000, bucket: srenautix-audit, access_key_file: …, secret_key_file: … }
```

- `callers.tokens_file` 列出服务调用方（worker、各分支的 reader 与 gateway、外部提议方、Grafana 插件），只保存 token 的 sha256，格式见 `apps/srenautix/src/identity/callers.ts`。
- 本地管理员的口令哈希：`printf '%s' '<口令>' | node apps/srenautix/dist/main.js admin hash-password`；TOTP 密钥是 20 个随机字节的 base32 编码（例如 `python3 -c 'import base64,os;print(base64.b32encode(os.urandom(20)).decode())'`），在验证器应用中按 SHA1、6 位、30 秒添加。
- 签名密钥：`openssl genpkey -algorithm ed25519 -out ed25519.pem`；审批签名的公钥写入各 gateway 的 approver-keys（ADR 0020）。

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

## 单活工作

事件引擎、准入、通知的同步与投递、Telegram 长轮询、告警对账、提议过期与状态条件只在主实例上运行（`leader.mode=lease` 时用 Kubernetes Lease 选主，持有者为 Pod 名）。接口、webhook 与渠道回调在每个副本上都可以处理。

## 一次告警的处理

1. webhook 写入 `alert_state` 与接入日志，经 `NOTIFY` 唤醒主实例；60 秒对账补回遗漏并结束告警源中已经没有的告警。
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

阶段 A 执行哪些卡：

1. 根因（有歧义时前两个候选）的组件类型声明的证据链，实体为根因组件。
2. 每个成员告警的告警目录条目声明的证据链，实体为告警解析出的实体。
3. 只执行 `applies_to.kinds` 包含实体类型的卡；同一张卡对同一实体只执行一次，根因的卡排在前面。

卡片窗口以事件首次触发时间为锚点，终点不晚于当前时间。取数经 `datasources.prometheus`（`concurrency` 张卡同时执行，单个查询超时 `timeout`），标签档案每小时自动探测一次，信号备选的选择缓存 10 分钟。整个证据链的期限是 40 秒，超过期限时未完成的卡不进入报告。PG 不可用时降级通道照样执行证据卡，组件类型取最后一次成功对账时的拓扑。

规则提议的 CEL 上下文：`incident`（id、version、severity、全部成员共有的 labels、alerts）、`root`（根因实体与组件类型）、`cards`（卡片全局 id → verdict、display_state、value、reason_kind；同一张卡对多个实体执行时取根因上的结果）。

加载失败的处理：

- 单个包校验不通过（例如规则引用了动作目录中没有的动作）：只禁用这个包，其余包照常加载。
- `requires` 中的能力缺失，或者依赖的包被禁用：整个包禁用；`optional` 中的能力缺失时相应的卡显示"能力缺失"。
- 配置了 `packs.lock_file` 而加载的内容与之不一致：不加载任何包。

以上情况都发布 `PackLoadFailed` 条件（subject 为包名），控制台"领域包"页（`GET /v1/packs`）列出原因。证据数据源的标签档案探测失败时发布 `DatasourceUnavailable`（subject `evidence-metrics`），查询按规范标签名照常发出。

排除规则（`chains.yaml` 的 `excludes`）只在本次执行过的证据链上求值，上下文与规则提议相同；按声明顺序第一条命中时 disposition 为 `ignore`，报告中记录规则引用 `<pack>/<chain id>#excludes[<序号>]`。求值出错的规则不命中，计入 `srenautix_stage_a_rule_errors_total`。

## 变更源

事件引擎把首次触发前 30 分钟内、触及事件组件的变更放进事件（`incident.changes`），并作为根因排序的一项（DESIGN §5）。变更来自配置的变更源，目前支持通用 git（`integrations/git`，GitHub、GitLab、Gitee、Gitea 等）：

```yaml
changes:
  cache_dir: /var/lib/srenautix/changes   # 每个变更源一个只读克隆，可以是 emptyDir
  interval: 60s                           # 同步间隔
  lookback: 24h                           # 每次同步回看的时长，按 change_id 去重
  sources:
    - id: gitops
      kind: git
      url: https://git.example.com/org/gitops.git
      ref: origin/main
      http_token_file: /etc/srenautix/secrets/changes/gitops-token   # 只读令牌，以 Basic 认证发送（用户名 http_username，默认 x-access-token）
      link_template: https://git.example.com/org/gitops/commit/{sha}
      paths:
        - { prefix: apps/shop/api/, targets: ['Deployment:shop/api'], kind: gitops_sync }
```

- ssh 克隆用 `deploy_key_file`，必须同时给出 `known_hosts_file`，只信任其中的主机密钥。
- 凭证经环境变量交给 git，不出现在命令行参数中。克隆不检出文件（`--no-checkout --filter=blob:none`），只读取提交与路径。
- 多集群时用 `cluster_id` 指定变更所属的集群，不填时为 server 的 `cluster_id`。
- 同步只在主实例上进行；有新变更时立即重算事件。某个变更源同步失败时发布 `DatasourceUnavailable` 条件（subject `changes:<id>`），其他变更源不受影响。
- 镜像中需要 `git`（ssh 克隆还需要 `ssh`）。

## 阶段 B 的输入与查询模板

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
