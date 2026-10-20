# kind/gitops

Kind 端到端用的 GitOps 仓库，形状与生产中的 GitOps 仓库相同。`deploy/kind/up.sh` 把本目录作为本地 Git 服务（gitlocal）上 `kind/gitops` 仓库的第一个提交，Argo CD 从这里同步。

| 路径 | 内容 | 修复类别 |
|---|---|---|
| `apps/shop/release.json` | 发布输入：`data.image`（`仓库@sha256:…`）与 `data.release_id`；每次发布是一次单独的提交 | 发布回退 |
| `apps/shop/workloads.yaml` | 工作负载、Service、迁移 Job（容器的 `resources` 与 `env`） | 配置与资源 |
| `apps/shop/autoscaling.yaml` | api 的 HPA（`minReplicas`、`maxReplicas`） | 配置与资源 |
| `apps/shop/migrations.yaml` | 每个发布的迁移 SQL | |
| `platform/observability/rules/shop.yaml` | shop 的告警规则（`spec.groups[].rules[]`） | 告警规则调优 |
| `srenautix/packs/kind-shop/` | Kind 的用户领域包 | 领域包覆盖 |
| `srenautix/topology-overrides/` | 拓扑覆盖 | 拓扑覆盖 |
| `argocd/applications/shop.yaml` | Argo CD 应用 shop 与 platform-rules | |

SreNautix 只向 `srenautix/*` 分支推送并开 PR，从不修改 `main`；场景中的发布与恢复由人工身份（`kind-operator`）直接提交到 `main`。
