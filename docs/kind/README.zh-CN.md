# 在 Kind 上体验 SreNautix

`deploy/kind/` 用一条命令拉起完整的体验环境，并提供 DESIGN §14.1 的六个级联故障场景。

## 环境内容

| 组件 | 说明 |
|---|---|
| Kind 集群 `srenautix` | Kubernetes 1.35，1 个控制面 + 3 个工作节点（标签 `srenautix.io/zone=a/b/c`），kindnet 实现 NetworkPolicy |
| kube-prometheus-stack | Prometheus、Alertmanager、Grafana、kube-state-metrics、node-exporter；告警规则保持上游原样 |
| Loki、Alloy | Alloy 经 Kubernetes API 读取全部 Pod 日志写入 Loki |
| Tempo | metrics-generator 生成服务图指标写入 Prometheus |
| metrics-server | HPA 使用 |
| CNPG operator | SreNautix 的 PostgreSQL |
| 演示业务 `shop` | web → api → postgres，独立的 checkout；api 有 HPA（2–4）与 PDB |
| 背景噪声 | `traffic/loadgen` 持续访问 web；`batch/nightly-export` 约三分之一失败；`batch/flaky-worker` 每 15 分钟退出一次 |
| `monitoring/alert-sink` | SreNautix 自身告警的接收方，收到的告警写入日志 |
| SreNautix | standard 配置，gateway 冻结；告警经 AlertmanagerConfig 送到 server |

全部 chart 版本与镜像 digest 固定在 `deploy/kind/versions.env` 与 `deploy/kind/images/kustomization.yaml`。

## 资源

Docker 至少 4 CPU、10 GiB 内存、25 GiB 磁盘。磁盘有限的机器上建议直接使用 GitHub Actions 的 `kind-e2e` 工作流（手动触发，可指定场景）。

## 使用

```bash
deploy/kind/up.sh                       # 创建集群并安装全部组件
deploy/kind/scenario.sh list            # 列出场景
deploy/kind/scenario.sh run db-oom-crashloop   # 注入 → 等待预期告警 → 恢复
deploy/kind/down.sh                     # 删除集群与 Kind 节点镜像
```

| 环境变量 | 含义 |
|---|---|
| `SRENAUTIX_VERSION` | 镜像标签，例如 `sha-<7 位提交>`；为空时使用 chart 的 `appVersion` |
| `SRENAUTIX_CHART`、`SRENAUTIX_CHART_VERSION` | 使用已发布的 chart（`oci://ghcr.io/zzhihon/charts/srenautix`）代替仓库中的 chart |
| `SRENAUTIX_LLM_SECRET` | 模型密钥文件；为空时 worker 没有模型路由，事件只出阶段 A |
| `HOLD` | `scenario.sh run` 在恢复前保持故障的秒数 |
| `SCENARIO_STATE_DIR` | 注入、确认、恢复时间的记录目录，默认 `.scratch/kind-scenarios` |

Grafana：`kubectl --context kind-srenautix -n monitoring port-forward svc/kps-grafana 3000:80`（admin / srenautix-kind）。控制台：`kubectl --context kind-srenautix -n srenautix port-forward svc/srenautix-server 8080:8080`。

## 场景

| 场景 | 注入 | 预期告警 | 根因（标准答案） |
|---|---|---|---|
| `node-notready-storm` | 停止 `srenautix-worker2` 的 kubelet | KubeNodeNotReady、KubeNodeUnreachable | `Node:srenautix-worker2` |
| `db-oom-crashloop` | 报表任务让 postgres OOM，同时 web 发布新镜像（干扰项） | KubePodCrashLooping | `StatefulSet:shop/postgres` |
| `bad-config-rollout` | checkout 发布引用无效配置 | KubePodCrashLooping | `Deployment:shop/checkout` |
| `coredns-scaled-to-zero` | CoreDNS 缩到 0 | KubePodCrashLooping（CoreDNS 自身无告警） | `Deployment:kube-system/coredns` |
| `networkpolicy-deny` | 新增只放行 DNS 的出站策略 | KubePodCrashLooping | `NetworkPolicy:shop/api-egress-lockdown` |
| `hpa-at-max` | 外部流量增加到 12 个不间断客户端 | KubeHpaMaxedOut | `HorizontalPodAutoscaler:shop/api` |

完整的标准答案（根因集合、粒度、机制、处置判断、干扰项）在 `eval/scenarios/<场景>.yaml`，格式见 `eval/scenarios/README.zh-CN.md`。新增场景时在 `deploy/kind/scenarios/<场景>/scenario.sh` 中定义 `EXPECTED_ALERTS`、`VERIFY_TIMEOUT` 与 `inject`、`recover` 两个函数，并添加对应的标准答案文件。
