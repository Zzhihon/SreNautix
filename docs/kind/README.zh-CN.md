# 在 Kind 上体验 SreNautix

`deploy/kind/` 用一条命令拉起完整的体验环境，提供 DESIGN §14.1 的六个级联故障场景，以及第二阶段（发现、分析、自愈 PR）的五个端到端场景。

## 环境内容

| 组件 | 说明 |
|---|---|
| Kind 集群 `srenautix` | Kubernetes 1.35，1 个控制面 + 3 个工作节点（标签 `srenautix.io/zone=a/b/c`），kindnet 实现 NetworkPolicy |
| kube-prometheus-stack | Prometheus、Alertmanager、Grafana、kube-state-metrics、node-exporter；告警规则保持上游原样 |
| Loki、Alloy | Alloy 经 Kubernetes API 读取全部 Pod 日志写入 Loki |
| Tempo | metrics-generator 生成服务图指标写入 Prometheus |
| metrics-server | HPA 使用 |
| CNPG operator | SreNautix 的 PostgreSQL |
| 本地 Git 服务 `gitlocal` | 后端是真实的 bare 仓库，提供 git smart HTTP 与 GitHub REST 的子集（GitHub App 的安装令牌、Git Data、PR、issue），见 `deploy/kind/gitlocal/main.go`；仓库 `kind/gitops` 的初始内容是 `deploy/kind/gitops` |
| Argo CD | 从 `kind/gitops` 同步演示业务 `shop`（`apps/shop`）与 shop 的告警规则（`platform/observability/rules`） |
| 演示业务 `shop` | web → api → postgres，独立的 checkout；api 有 HPA（2–4）与 PDB；api 与 checkout 的 initContainer `wait-for-migrations` 等待本次发布的迁移 Job（`shop-migrate-<发布 ID>`）；发布输入是 `apps/shop/release.json` |
| 背景噪声 | `traffic/loadgen` 持续访问 web；`batch/nightly-export` 约三分之一失败；`batch/flaky-worker` 每 15 分钟退出一次 |
| `monitoring/alert-sink` | SreNautix 自身告警的接收方，收到的告警写入日志 |
| SreNautix | standard 配置，gateway 冻结（集群动作只提议，`gitops_pr` 只改 Git）；检测器、事件 issue、GitHub 变更源与自愈 PR 指向 `kind/gitops` |

全部 chart 版本与镜像 digest 固定在 `deploy/kind/versions.env`、`deploy/kind/images/kustomization.yaml` 与 `deploy/kind/gitops/apps/shop/kustomization.yaml`。

`kind/gitops` 的 main 只由人工身份（`kind-operator`，gitlocal 的管理员令牌）提交；SreNautix 的 GitHub App 只能向 `srenautix/*` 分支推送并开 PR，gitlocal 拒绝经 REST 合并 PR。gitlocal 记录每一次引用变更的身份，场景据此检查补偿控制。

## 资源

Docker 至少 4 CPU、10 GiB 内存、25 GiB 磁盘。磁盘有限的机器上建议直接使用 GitHub Actions 的 `kind-e2e` 工作流（手动触发，可指定场景）。工作流中每个场景在自己的 Kind 集群里运行（矩阵，最多 6 个并行）；环境拉起与不变量 12 在单独的 `invariants` job 中运行一次。每个场景的诊断 artifact 是 `kind-e2e-diagnostics-<场景>`。场景脚本声明 `KNOWN_GAP`（引用跟踪 issue 与产品缺陷）时为已知缺口：照常运行、断言不变、收集诊断，失败时只留下警告，不让整次运行判红；`deploy/kind/scenario.sh known-gaps` 列出这些场景（目前 release-bad-image、unmapped-alert，见 #5），缺陷修复后删除声明。

## 使用

```bash
deploy/kind/up.sh                       # 创建集群并安装全部组件
deploy/kind/scenario.sh list            # 列出场景
deploy/kind/scenario.sh run db-oom-crashloop   # 注入 → 等待预期告警 → 恢复
SRENAUTIX_CHECKS=1 deploy/kind/scenario.sh run release-stuck-init   # 另外检查发现、分析与自愈 PR
deploy/kind/down.sh                     # 删除集群与 Kind 节点镜像
```

| 环境变量 | 含义 |
|---|---|
| `SRENAUTIX_VERSION` | 镜像标签，例如 `sha-<7 位提交>`；为空时使用 chart 的 `appVersion` |
| `SRENAUTIX_LOCAL_IMAGES` | 使用本地构建并 `kind load` 的镜像 `srenautix.local/srenautix:<标签>` 与 `srenautix.local/srenautix-spoke:<标签>` |
| `SRENAUTIX_LLM_REPLAY` | 为 1 时 worker 的模型路由指向集群内的录制回放服务 `llm-replay`（需要 `SRENAUTIX_LOCAL_IMAGES`），`kind-e2e` 使用 |
| `SRENAUTIX_CHART`、`SRENAUTIX_CHART_VERSION` | 使用已发布的 chart（`oci://ghcr.io/zzhihon/charts/srenautix`）代替仓库中的 chart |
| `SRENAUTIX_LLM_SECRET` | 模型密钥文件；为空时 worker 没有可用的模型，事件只出阶段 A |
| `SRENAUTIX_CHECKS` | 为 1 时，声明了 `SRENAUTIX_ROOT` 的场景在告警出现后检查 SreNautix 的三个环节 |
| `HOLD` | `scenario.sh run` 在恢复前保持故障的秒数 |
| `SCENARIO_STATE_DIR` | 注入、确认、恢复时间的记录目录，默认 `.scratch/kind-scenarios` |

Grafana：`kubectl --context kind-srenautix -n monitoring port-forward svc/kps-grafana 3000:80`（admin / srenautix-kind）。控制台：`kubectl --context kind-srenautix -n srenautix port-forward svc/srenautix-server 8080:8080`。`kind/gitops` 的状态（issue、PR、评论、引用变更审计）：`kubectl --context kind-srenautix get --raw /api/v1/namespaces/gitlocal/services/gitlocal:3000/proxy/_test/state`。

## 场景

| 场景 | 注入 | 预期告警 | 根因（标准答案） | 修复 PR |
|---|---|---|---|---|
| `node-notready-storm` | 停止 `srenautix-worker2` 的 kubelet | KubeNodeNotReady、KubeNodeUnreachable | `Node:srenautix-worker2` | |
| `db-oom-crashloop` | 报表任务让 postgres OOM，同时 web 发布新镜像（干扰项） | KubePodCrashLooping | `StatefulSet:shop/postgres` | |
| `bad-config-rollout` | checkout 发布引用无效配置 | KubePodCrashLooping | `Deployment:shop/checkout` | |
| `coredns-scaled-to-zero` | CoreDNS 缩到 0 | KubePodCrashLooping（CoreDNS 自身无告警） | `Deployment:kube-system/coredns` | |
| `networkpolicy-deny` | 新增只放行 DNS 的出站策略 | KubePodCrashLooping | `NetworkPolicy:shop/api-egress-lockdown` | |
| `hpa-at-max` | 外部流量增加到 12 个不间断客户端 | KubeHpaMaxedOut | `HorizontalPodAutoscaler:shop/api` | |
| `release-stuck-init` | 人工提交发布 r2，迁移失败，新 Pod 停在 `wait-for-migrations` | ShopMigrationFailed、ShopRolloutIncomplete | 发布 r2（Argo 应用 shop、迁移 Job、api、checkout） | 发布回退：`apps/shop/release.json` |
| `release-bad-image` | 人工提交发布 r3，镜像没有 HTTP 服务 | KubePodCrashLooping、ShopRolloutIncomplete | 发布 r3（Argo 应用 shop、api） | 发布回退：`apps/shop/release.json` |
| `config-resource-oom` | 人工提交把 checkout 的内存缓存调到超过内存上限 | KubePodCrashLooping、ShopRolloutIncomplete | `Deployment:shop/checkout` | 配置与资源：`apps/shop/workloads.yaml` |
| `alert-too-sensitive` | api 的一个容器正常退出一次 | ShopPodRestarted（for 0m、critical） | `Deployment:shop/api`，处置为忽略 | 告警规则调优（`noisy-alert-relax`）：`platform/observability/rules/shop.yaml` |
| `unmapped-alert` | 人工新增只带 `service` 标签的告警 ShopCatalogStale | ShopCatalogStale | 接入时为逻辑组件 `component:catalog`；研判指向 `Deployment:shop/api` | 拓扑与领域包覆盖（`alert-catalog-entry`）：`srenautix/packs/kind-shop/` |

后五个场景在 `SRENAUTIX_CHECKS=1` 时依次检查（`deploy/kind/srenautix-checks.sh`）：

1. **发现**：注入之后与场景相关的事件不超过 `SRENAUTIX_MAX_INCIDENTS`（背景噪声的命名空间不计），其中有一个事件的根因匹配 `SRENAUTIX_ROOT`；
2. **分析**：该事件有证据卡，阶段 B 研判完成且结论为 `likely` 或 `evidence_consistent`（模型响应来自 `deploy/kind/scenarios/<场景>/llm/` 的录制）；
3. **自愈 PR**：`kind/gitops` 上出现该事件的 `srenautix/*` 分支 PR，描述含结论、证据、改动、验证计划、回滚五节与 `Refs #<issue>`，issue 带 `srenautix` 标签并有回链 PR 的评论，改动的文件匹配 `SRENAUTIX_PR_FILES`；
4. **补偿控制**：注入之后 App 机器人只改动过 `srenautix/*` 分支，main 只有人工提交，没有经 REST 的合并请求。

场景恢复由人工身份提交回退（例如把 `release.json` 改回 r1），SreNautix 的 PR 保持未合并。`SRENAUTIX_CHECKS=1` 时每个场景注入之前等告警投递链路正常（Alertmanager 5 分钟内没有通知失败，没有 `Alertmanager*FailedToSendAlerts`）；每个场景恢复之后等它注入的故障告警（`EXPECTED_ALERTS`）在 Prometheus 中消失、在 SreNautix 中 resolved，再开始下一个场景；持续的背景告警不阻塞。这两项等待不能让同一集群中相继运行的场景互不影响：SreNautix 把 30 分钟内（`rca-params` 的 `adjacency` 与 `change_window` 默认值）沿拓扑或同一次变更（例如环境拉起时 Argo CD 的首次同步同时触及 api、checkout、web）相连的告警归为一个事件，上一个场景的事件即使已经结束，也会吸收几分钟后下一个场景的告警，下一个场景就不会出现自己的根因事件。本地在同一集群中连续运行场景时，场景之间至少间隔 30 分钟，或者每个场景重建集群（`kind-e2e` 采用后者）。没有故障时 shop 不应产生告警（例如 CPU limit 不低于单个请求的单线程消耗，避免 CPUThrottlingHigh）。

完整的标准答案（根因集合、粒度、机制、处置判断、干扰项）在 `eval/scenarios/<场景>.yaml`，格式见 `eval/scenarios/README.zh-CN.md`。新增场景时在 `deploy/kind/scenarios/<场景>/scenario.sh` 中定义 `EXPECTED_ALERTS`、`VERIFY_TIMEOUT` 与 `inject`、`recover` 两个函数（需要检查 SreNautix 时另外声明 `SRENAUTIX_*`），并添加对应的标准答案文件。
