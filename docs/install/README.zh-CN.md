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
| gateway | `roles.gateway.policy`（本集群的 gateway 策略）、`roles.gateway.approverKeys`；启用 `gitops_pr` 时加 `roles.gateway.githubApp.existingSecret`（键 `app-id`、`installation-id`、`slug`、`private-key.pem`） | `internal/spoke/gateway/run.go`、`docs/gateway/README.md` |
| reader | 无；声明的证据查询清单放在 `roles.reader.queryManifestConfigMap` | `internal/spoke/reader/config.go` |
| server | 无；通知渠道等写在 `roles.server.config` | `apps/srenautix/src/config/server.ts` |

worker 写进研判清单的 `code_sha` 取发布时写入 chart 的注解 `srenautix.io/code-sha`；使用仓库中的 chart 时设置 `codeSha`。CI 的 `role-configs` 任务用各角色自己的解析代码检查生成的配置，`install-e2e` 任务在 Kind 上实际安装 standard 配置并要求全部 Pod Ready。

## 告警接入

每个接入源的地址是 `http://<release>-server.<命名空间>.svc:8080/v1/ingest/<id>`，请求带 `Authorization: Bearer <token>`，token 在 `<release>-ingest-tokens` 的同名键中。Alertmanager 的接收方建议 `group_wait` ≤30 秒。使用 prometheus-operator 时可以打开 `alertmanagerConfig.enabled`，由 chart 生成 AlertmanagerConfig；SreNautix 自身的告警（标签 `srenautix_self="true"`）会先路由到 `selfMonitoring.receiver` 指定的其他接收方。
