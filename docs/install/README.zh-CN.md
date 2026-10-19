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

以下凭证在首次安装时生成，升级时沿用，卸载时保留（`helm.sh/resource-policy: keep`）：

| Secret | 内容 | 挂载到 |
|---|---|---|
| `<release>-service-tokens` | worker、mcp、reader、gateway 调用 server 的 bearer token | 各自的角色，只挂自己的键 |
| `<release>-callers` | 上述 token 的 sha256 清单，加 `callers.extra` | server |
| `<release>-ingest-tokens` | 每个告警接入源一个 bearer token（`ingest.sources[].id` 为键） | server |
| `<release>-audit-key` | 治理审计链检查点签名密钥（Ed25519） | server |
| `<release>-gateway-audit-key` | 执行审计链检查点签名密钥（Ed25519） | gateway |
| `<release>-pg-<角色>` | CNPG 模式下三个库角色的口令 | 对应角色 |
| `<release>-minio-root`、`<release>-minio-audit-<角色>` | 审计用 MinIO 的管理员与 server、gateway 的写入账号 | MinIO、server、gateway |

服务签名密钥（L 档审批签名，server 持有私钥，gateway 持有公钥）由安装方生成并提供，observe 以外的配置必填：

```bash
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
kubectl -n srenautix create secret generic srenautix-service-signing \
  --from-file=private.pem --from-file=public.pem
```

## 告警接入

每个接入源的地址是 `http://<release>-server.<命名空间>.svc:8080/v1/ingest/<id>`，请求带 `Authorization: Bearer <token>`，token 在 `<release>-ingest-tokens` 的同名键中。Alertmanager 的接收方建议 `group_wait` ≤30 秒。使用 prometheus-operator 时可以打开 `alertmanagerConfig.enabled`，由 chart 生成 AlertmanagerConfig；SreNautix 自身的告警（标签 `srenautix_self="true"`）会先路由到 `selfMonitoring.receiver` 指定的其他接收方。
