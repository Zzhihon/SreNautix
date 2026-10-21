# 安装 SreNautix

SreNautix 以一个 Helm chart 发布：`oci://ghcr.io/zzhihon/charts/srenautix`。chart 与两个镜像共用一个版本号：

| 制品 | 地址 | 内容 |
|---|---|---|
| 中心镜像 | `ghcr.io/zzhihon/srenautix` | server、worker、mcp 三个角色，内置领域包，控制台 |
| 分支镜像 | `ghcr.io/zzhihon/srenautix-spoke` | reader、gateway 两个角色 |
| chart | `oci://ghcr.io/zzhihon/charts/srenautix` | 全部角色与三种安装配置 |

三种安装配置对应 chart 中的三份 values 预设（DESIGN §1.3）：

| 配置 | 文档 | 部署的角色 | 适用场景 |
|---|---|---|---|
| observe | [observe.zh-CN.md](observe.zh-CN.md) | server、worker、PostgreSQL | 首次试用，1 小时内出成绩单，没有写操作 |
| standard | [standard.zh-CN.md](standard.zh-CN.md) | observe 加 reader、gateway、审计用 MinIO | 2–50 人的团队 |
| compliance | [compliance.zh-CN.md](compliance.zh-CN.md) | standard 加三权分立、通行密钥、WORM 审计、专用节点池、镜像签名校验 | 等保与国内私有化部署 |

隔离网络中的安装见 [offline.zh-CN.md](offline.zh-CN.md)。在 Kind 上体验全部功能与级联故障场景见 [../kind/README.zh-CN.md](../kind/README.zh-CN.md)。

## 公共前提

- Kubernetes ≥1.27；启用 gateway（standard、compliance）要求 ≥1.30，chart 在更低的版本上渲染失败。
- 数据库：CNPG operator（chart 创建 `postgresql.cnpg.io/v1` Cluster），或外部 PostgreSQL 16 及以上。
- 一个 Prometheus 兼容的查询端点（Prometheus、VictoriaMetrics、Mimir、Thanos）与 Alertmanager。
- 发布前校验镜像签名：见 [../release/README.zh-CN.md](../release/README.zh-CN.md)。

## chart 生成的凭证

以下凭证在首次安装时生成，升级时用 `lookup` 沿用已有值，卸载时保留（`helm.sh/resource-policy: keep`）。每一项都可以用对应的 values 改为引用已存在的 Secret：

| Secret | 内容 | 挂载到 | 改用已有 Secret |
|---|---|---|---|
| `<release>-service-tokens` | 键 `worker`、`reader`、`gateway`：调用 server 的 token；键 `server`：server 调用 worker 的 token；键 `server.sha256`：前者的 sha256 | 每个角色只挂自己的键；worker 另挂 `server.sha256` | `serviceTokens.existingSecret` |
| `<release>-callers` | 键 `callers.yaml`：worker、reader、gateway 的 token 的 sha256，加 `callers.extra` | server | `callers.existingSecret` |
| `<release>-ingest-tokens` | 每个告警接入源一个 bearer token（`ingest.sources[].id` 为键） | server | `ingest.existingSecret` |
| `<release>-audit-key` | 治理审计链检查点签名密钥（键 `private.pem`，Ed25519） | server | `secrets.auditSigningKey.existingSecret` |
| `<release>-gateway-audit-key` | 执行审计链检查点签名密钥（键 `private.pem`，Ed25519） | gateway | `secrets.gatewayAuditSigningKey.existingSecret` |
| `<release>-pg-role-<角色>` | CNPG 模式下 server、worker 库角色的口令（自定义名称不能与 CNPG 占用的 `<cluster>-server`、`-ca`、`-replication`、`-app`、`-superuser` 重名） | 对应角色 | `database.cnpg.passwordSecrets.<角色>` |
| `<release>-minio-root`、`<release>-minio-audit-<角色>` | 审计用 MinIO 的管理员与 server、gateway 的写入账号 | MinIO、server、gateway | 改用外部 S3（`audit.sink=s3`） |

**GitOps 部署**：Argo CD 等工具渲染 Helm 时 `lookup` 返回空，chart 每次渲染都会生成新的随机值，每次同步都会轮换 token 与签名密钥。这类部署必须为上表的前五项提供已存在的 Secret（例如 SealedSecret）。`serviceTokens.existingSecret` 与 `callers.existingSecret` 必须同时提供，`callers.yaml` 中的 sha256 与 token 对应，格式见 `apps/srenautix/src/identity/callers.ts`：

```yaml
callers:
  - {id: worker, kind: worker, token_sha256: <sha256(worker token)>}
  - {id: spoke-<clusterId>-reader, kind: spoke, role: reader, cluster_id: <clusterId>, token_sha256: <sha256(reader token)>}
  - {id: spoke-<clusterId>-gateway, kind: spoke, role: gateway, cluster_id: <clusterId>, token_sha256: <sha256(gateway token)>}
```

服务签名密钥（L 档审批签名，server 持有私钥）由安装方生成并提供，observe 以外的配置必填；gateway 信任的公钥写进 `roles.gateway.approverKeys`（Ed25519 公钥 32 字节的 base64url，不带填充）：

```bash
openssl genpkey -algorithm ed25519 -out private.pem
kubectl -n srenautix create secret generic srenautix-service-signing --from-file=private.pem
openssl pkey -in private.pem -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=\n'
```

## 各角色的配置

chart 为五个角色生成配置文件（地址、端口、挂载路径、集群 id 等部署事实），再与 `roles.<角色>.config` 深度合并。安装方需要补充的业务配置：

| 角色 | 必须给出 | 配置的键 |
|---|---|---|
| worker | `llm.routes`（模型路由，`api_key_file` 指向 `/etc/srenautix/secrets/llm/<键>`）、`budget.daily_tokens` | `apps/srenautix/src/research/config.ts` |
| mcp | `public_url`、`authorization_server`、`clients`（外部调用方 token 放在 `roles.mcp.clientTokensSecret`） | `apps/srenautix/src/roles/mcp.ts` |
| gateway | `roles.gateway.policy`（本集群的 gateway 策略）、`roles.gateway.approverKeys`；启用 `gitops_pr` 时加 `roles.gateway.githubApp.existingSecret`（键 `app-id`、`installation-id`、`private-key.pem`）与 `roles.gateway.githubApp.slug`（App 的 URL 名称，不是敏感信息，gateway 首次取令牌前用 `GET /app` 核对；不写时从 Secret 的 `slug` 键读取） | `internal/spoke/gateway/run.go`、`docs/gateway/README.md` |
| reader | 无；声明的证据查询清单放在 `roles.reader.queryManifestConfigMap` | `internal/spoke/reader/config.go` |
| server | 无；通知渠道等写在 `roles.server.config`。GitHub App（拓扑覆盖 PR、事件 issue、GitHub 变更源共用）：`roles.server.githubApp.{existingSecret, appId, installationId, apiUrl}`，server 只挂载 Secret 的 `private-key.pem`（可以与 gateway 共用同一个 Secret），chart 生成 `github_app`；覆盖 PR 的仓库写在 `roles.server.config.topology.override_pr.repo`，事件 issue 用 `issues`，变更源用 `changes.sources`（`kind: github`）；出站 443 由 `networkPolicy.githubEgressTo` 限定。App 权限：issues、pull_requests 写，contents 读 | `apps/srenautix/src/config/server.ts` |

境外模型路由（`in_domain=false`）没有打开 `roles.worker.config.llm.allow_cross_border` 时，安装照常完成，worker 启动时禁用这些路由；安装结束时的说明会列出被禁用的路由（ADR 0062）。

## 登录与角色绑定

控制台的权限来自角色绑定（`identity.bindings`，DESIGN §13），登录只确定身份。没有任何绑定的用户登录后，所有读取接口都返回 403。

- **本地管理员是破窗账号**：用于首次安装后的引导和身份提供方不可用时的紧急入口，口令加 TOTP 登录（Secret 的键 `password_hash` 由 `srenautix admin hash-password` 生成，`totp_secret` 是 base32 密钥）。启用 `identity.localAdmin.existingSecret` 时，chart 在绑定中加一个 `local-admin.yaml`：组 `srenautix:local-admin` → `admin`，合规配置三权分立时为 `sys-admin`，作用域为全部集群与命名空间。
- **控制台前面已有访问控制时可以关闭 TOTP**：控制台前面有 Cloudflare Access 之类的访问控制时，可以设置 `identity.localAdmin.totpRequired: false`，本地管理员只凭口令登录（ADR 0118）。
  - Secret 中的 `totp_secret` 保留。
  - server 启动时打警告，控制台登录页与设置页显示"TOTP 已关闭"，开关的变化写入治理审计（`identity.local_admin_totp`）。
  - H 档审批仍需用口令加 TOTP 重新认证。
  - 没有这类访问控制时保持默认值 `true`。
- **接入 OIDC 之后收窄本地管理员**：为日常用户按组写绑定，然后设置 `identity.localAdmin.bindAdmin: false`（本地管理员仍能登录，但没有权限，需要时再打开），或在 `identity.bindings` 中写一个同名的 `local-admin.yaml` 缩小角色与作用域（chart 以用户写的为准）。本地管理员的每次登录都写入治理审计，建议对它设置告警。
- 绑定由 GitOps 同步时（`identity.bindingsConfigMap`），chart 不生成 `local-admin.yaml`，需要在那个 ConfigMap 中自行加入。

## 领域包

内置领域包在中心镜像的 `/app/packs`；用户的包以 ConfigMap 挂载（`packs.userConfigMaps`，每项是 ConfigMap 名或 `{configMap, pack}`，一个 ConfigMap 放一个包，子目录中的文件以 `<子目录>__<文件名>` 为键，见 `docs/packs/README.zh-CN.md`）。OCI 仓库中经 cosign 签名的包写在 `packs.oci.sources`（每项含 `repository`、固定的 `digest`，以及 `key_file` 或 `certificate_identity` + `certificate_oidc_issuer`）。中心镜像带有 cosign 与 oras，chart 为 server 挂载可写的拉取目录 `/var/cache/srenautix/packs`（emptyDir，容量 `packs.oci.cacheSize`）。公钥放在 `packs.oci.keySecret` 指定的 Secret 中，`key_file` 写 `/etc/srenautix/secrets/pack-keys/<键>`。私有仓库的凭证放在 `packs.oci.dockerConfigSecret`（类型 `kubernetes.io/dockerconfigjson`），以 `DOCKER_CONFIG` 提供给 oras 与 cosign。仓库与 Rekor 的出站地址可以用 `networkPolicy.packRegistriesEgressTo` 限定。

worker 写进研判清单的 `code_sha` 取发布时写入 chart 的注解 `srenautix.io/code-sha`；使用仓库中的 chart 时设置 `codeSha`。CI 的 `role-configs` 任务用各角色自己的解析代码检查生成的配置，`install-e2e` 任务在 Kind 上实际安装 standard 配置并要求全部 Pod Ready。

## 组件之间的连通

chart 自带的 NetworkPolicy（`networkPolicy.enabled`，默认打开）按下表放行，其余入站与出站都拒绝。自己维护网络策略（例如关闭 chart 的 NetworkPolicy，改用 Cilium 或平台统一的策略）时，下表每一行都要同时放行发起方的出站与接收方的入站。server 与 worker 之间是双向的：两个方向的连接都由各自主动发起，只放行其中一个方向，阶段 B 的研判结果就回不到 server。

| 发起方 | 接收方 | 端口 | 用途 | 收紧出站的 values |
|---|---|---|---|---|
| worker、reader、gateway、mcp | server | 8080 | 认领研判任务、上报模型路由与心跳（worker）；分支隧道与心跳（reader、gateway）；提议与查询（mcp） | |
| server | worker | 8080 | 拉取研判事件流 `/v1/events` 与运行明细 `/v1/runs/*`（worker 只接受 server） | |
| server、worker | PostgreSQL | 5432（外部 PG 为 `database.external.port`） | 各自的 schema；`db-bootstrap` Job 同样连接 | |
| server、worker、reader | 数据源（Prometheus、Alertmanager、Loki、Tempo） | 数据源的服务端口 | 证据查询、ALERTS 与 Alertmanager 对账 | `networkPolicy.datasourcesEgressTo` |
| gateway | Prometheus | 服务端口 | 执行后校验（`gateway.metrics_url`） | `networkPolicy.gatewayMetricsEgressTo` |
| server、gateway | 审计对象存储 | 9000（自带 MinIO）或外部 S3 的端口 | 治理审计链（server）与执行审计链（gateway） | `networkPolicy.auditEgressTo`（外部 S3） |
| worker | 模型端点 | 443 | 阶段 B 的模型调用 | `networkPolicy.modelsEgressTo`，或 Cilium 的 `networkPolicy.cilium.modelFQDNs` |
| server | 聊天渠道、OIDC 提供方 | 443 | 通知、审批回调、登录 | `networkPolicy.channelsEgressTo` |
| server、gateway | GitHub API | 443 | server：覆盖规则 PR、事件 issue、变更源；gateway：`gitops_pr`（设置了各自的 `githubApp` 时） | `networkPolicy.githubEgressTo` |
| server | OCI 仓库与 Rekor | 443 | 签名领域包（设置了 `packs.oci.sources` 时） | `networkPolicy.packRegistriesEgressTo` |
| server（`clusterRead`）、worker、reader、gateway、mcp | kube-apiserver | `networkPolicy.apiServerPorts`（443、6443） | 只读拓扑与查询；gateway 执行动作 | `networkPolicy.apiServerCIDRs` |
| 所有角色 | 集群 DNS | 53（UDP、TCP） | 解析 | `networkPolicy.dns` |
| Alertmanager、Grafana 等告警源，浏览器，聊天渠道的回调 | server | 8080 | 告警接入 `/v1/ingest/<id>`、控制台、webhook | `networkPolicy.serverIngressFrom`（入站来源） |
| 外部 MCP 调用方 | mcp | 8080 | MCP 协议 | |
| Prometheus 等采集方 | server、worker、gateway、mcp；reader | 9090；reader 为 8080 | `/metrics` | `networkPolicy.metricsIngressFrom`（入站来源） |
| kubelet | server、worker、gateway；mcp、reader | 8081；mcp、reader 为 8080 | 存活与就绪探针 | |
| CNPG operator | PostgreSQL 实例 | 8000、5432 | 实例管理（自带 PG） | `database.cnpg.operatorNamespace` |
| MinIO 初始化 Job | MinIO | 9000 | 建桶、对象锁与写入账号（自带 MinIO） | |

CI 的 `install-e2e` 在打开 NetworkPolicy 的 Kind 集群上检查：其他命名空间的 Pod 连不上 worker 的 API；server 能读取 worker 的事件流；注入一条告警后研判经 worker 的事件流回到 server，经 server 能读到运行明细；全部 Pod 就绪之后 server 没有"读取 worker 事件流失败"的日志。

## 发现：检测器与发布变更

- **集群状态检测器**（`detectors.*`，默认关闭）：没有告警规则时也发现 Pod 停在 Init 或 Pending、rollout 停滞、CrashLoop、PDB 阻塞驱逐与 Job 失败，按 `podInitAfter`、`podPendingAfter`、`rolloutStalledAfter`、`crashLoopAfter`、`pdbBlockedAfter` 判定，`namespaces`、`excludeNamespaces` 限定范围，`equivalentAlerts` 列出与发现等价的告警名（同一对象上已有这些告警时不再合成）。单集群安装读 server 自己的 informer，需要 `roles.server.clusterRead`；多集群由 reader 上报对象状态。打开后自身告警增加 SreNautixDetectorStale（10 个扫描周期没有完成扫描）与 SreNautixDetectorScanErrors。
- **发布变更**（`changes.kubernetes.*`，默认开启）：Pod 模板上 `revisionLabels` 中任一标签变化即一次发布，`groupWithin` 内同一版本或同一个管理应用的变化合成一次；发布作为根因候选，同一次发布引起的告警收敛到一个事件。GitOps 仓库若在 Pod 模板上写发布 ID 标签，把它追加到 `revisionLabels`。
- **变更源**（`changes.sources`）：GitHub 上的 GitOps 仓库的提交，按路径前缀映射到组件，需要 `roles.server.githubApp`。

## 自愈 PR 与事件 issue

两部分分别由 server 与 gateway 负责，配置也分开写：

| 配置 | 写在哪里 | 管什么 |
|---|---|---|
| 事件 issue 的仓库、标签、标题前缀、每小时上限、回看窗口 | `issues.*`（server 配置的 `issues`） | 需要人跟进的事件开一个 issue，进展追加评论，与 PR 互相关联；每个事件只开一个，超过上限只记录 |
| 自愈 PR 的类别、结论门槛、目标仓库与文件布局 | `remediation.repository`、`baseBranch`、`files`、`categories`、`conclusions`、`titlePrefix`（server 配置的 `remediation`） | server 判断哪些结论可以生成修复，按领域包的补丁模板生成改动，提交 `gitops_pr` 提议 |
| PR 的审阅人、每小时上限、允许改动的路径、补偿控制、main watchdog | `remediation.reviewers`、`maxPerHour`、`paths`、`compensatingControls`、`mainWatchdog`（chart 写入 gateway 策略的 `gitops` 一节） | gateway 推送 `srenautix/*` 分支、开 PR 并请求审阅，推送前后核对 base，按小时限速，main 出现非人工提交时告警并停止推送 |

issue 没有审阅人；需要的审阅人写在 PR 一侧（`remediation.reviewers`）。gateway 策略来自 `roles.gateway.policy.existingConfigMap` 时，chart 不改写策略，`gitops` 一节由策略自己写，键名见 `docs/gateway/README.md`。启用自愈 PR 需要 `roles.gateway.actions` 含 `gitops_pr`、`roles.gateway.githubApp` 与 `roles.server.githubApp`；base 分支没有分支保护时必须填写 `compensatingControls`。打开后自身告警增加 SreNautixGitMainUnexpectedCommits、SreNautixGitMainWatchdogStale、SreNautixGitopsBaseMoved 与 SreNautixGitopsRequestDenied。

## 评测

评测（`srenautix eval`，见 `docs/eval/README.md`）不随 chart 部署，也不在集群或 CI 中运行：在运维人员的机器上用本仓库的构建执行，读取本地的用例与快照，需要访问集群中的指标或 PostgreSQL 时临时 `kubectl port-forward`，并且只读。模型路由与研判使用的路由相同，密钥从本地文件读取。

评测的 token 不计入 worker 的研判预算（`roles.worker.config.budget.daily_tokens`）。`--max-tokens` 限制单次评测：输入与输出的 token 累计达到上限后不再开始新的运行，成绩单记录跳过的运行与本次用量。按天的评测预算由执行评测的人维护：每次运行前用当天剩余的额度作为 `--max-tokens`，用量以成绩单中记录的为准。

## 告警接入

每个接入源的地址是 `http://<release>-server.<命名空间>.svc:8080/v1/ingest/<id>`，请求带 `Authorization: Bearer <token>`，token 在 `<release>-ingest-tokens` 的同名键中。Alertmanager 的接收方建议 `group_wait` ≤30 秒。使用 prometheus-operator 时可以打开 `alertmanagerConfig.enabled`，由 chart 生成 AlertmanagerConfig；SreNautix 自身的告警（标签 `srenautix_self="true"`）会先路由到 `selfMonitoring.receiver` 指定的其他接收方。
