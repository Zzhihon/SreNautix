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
| `listen.api`（默认 :8080） | 全部 `/v1/*` 接口、webhook、渠道回调、`/healthz`、`/readyz` |
| `listen.metrics`（默认 :9090） | `/metrics`（`srenautix_*`） |
| `listen.probes`（默认 :8081） | `/healthz`、`/readyz` |

## 单活工作

事件引擎、准入、通知的同步与投递、Telegram 长轮询、告警对账、提议过期与状态条件只在主实例上运行（`leader.mode=lease` 时用 Kubernetes Lease 选主，持有者为 Pod 名）。接口、webhook 与渠道回调在每个副本上都可以处理。

## 一次告警的处理

1. webhook 写入 `alert_state` 与接入日志，经 `NOTIFY` 唤醒主实例；60 秒对账补回遗漏并结束告警源中已经没有的告警。
2. 事件引擎用 packages/core 重算并对账事件，写入版本、成员、别名与 outbox。
3. 每个新版本立即出阶段 A：证据卡、规则提议、确定性的处置判断，发布 `stage_a.reported`，消息就地更新。证据卡与规则提议经 `stage-a/ports.ts` 的接口由领域包运行时（packages/packs-sdk）提供；该运行时接入 server 之前，阶段 A 只有收敛后的事件、根因候选、时间线与处置判断。
4. 按触发原因（新事件、根因变化、严重度升高、证据指纹变化）经准入进入阶段 B 队列，worker 认领后研判；研判事件经 server 的事件流发布，消息再次更新。
5. 提议经审批签发断言，分支 gateway 长轮询取走工单并推回执行事件。

## 本地运行与控制台 e2e

控制台的 Playwright e2e 可以这样启动一个真实的 server：

1. 用 `apps/srenautix/test/support/pg-cluster.ts` 的方式（`initdb` + `pg_ctl`）或任意 PostgreSQL 16+，执行 `db bootstrap`，为三个角色设置口令。
2. 按上面的最小配置写 YAML：`topology.source: off`、`ingest.reconcile.enabled: false`、不配置 `worker`；`public_url` 设为控制台的 Origin（CSRF 校验以它为准）。
3. `PGHOST=127.0.0.1 PGSSLMODE=disable PGUSER=srenautix_server … node apps/srenautix/dist/main.js --role=server --config=…`。
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
