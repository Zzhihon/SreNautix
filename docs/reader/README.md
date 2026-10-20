# reader

reader 是分支镜像 `srenautix-spoke` 的只读角色（`--role=reader`），每个被管集群部署一个副本。它在本集群内做五件事，全部经出站连接与中心交互：

| 功能 | 说明 | 设计依据 |
|---|---|---|
| 拓扑 | 只读 informer 把集群对象转换成带 `valid_from` / `valid_to` 的拓扑事件，推送给中心；对象名按规范编码进入组件键，无法生成键的对象只跳过它自己 | [ADR 0030](../adr/0030-reader-topology-extraction.md)、[ADR 0031](../adr/0031-reader-hub-protocol.md)、[ADR 0034](../adr/0034-component-key-name-escaping.md) |
| 告警对账 | 每 60 秒读取本集群 Alertmanager 与 `ALERTS` / `ALERTS_FOR_STATE`，转发给中心 | ADR 0031 |
| 声明式证据查询 | 只执行查询模板清单中声明过的模板，带范围、步长、序列数、字节、超时、并发与熔断限制 | [ADR 0032](../adr/0032-declared-evidence-queries.md) |
| 历史重建与实体解析 | 用 kube-state-metrics 历史重建过去的拓扑；按 informer 缓存 → 24 小时墓碑 → kube-state-metrics 历史解析 Pod IP 与组件 | [ADR 0033](../adr/0033-ksm-history-topology.md) |
| 时钟参考 | 测量本地时钟与 apiserver 的偏差，心跳上报 apiserver 参考时间 | ADR 0031 |
| 对象健康状态 | 每 30 秒上报当前不健康的对象（Pending、Init、CrashLoop、rollout 停滞、PDB 阻塞驱逐、Job 失败）与进入该状态的时间，阈值由中心的集群状态检测器判断 | [ADR 0035](../adr/0035-reader-object-health.md) |

## 运行

```
srenautix-spoke --role=reader --config=/etc/srenautix/config.yaml
```

Pod 名从环境变量 `POD_NAME` 读取（Downward API），作为 `reader_id` 上报。

## 配置

```yaml
cluster_id: edge-1                 # 必填，集群标识
listen: ":8080"                    # /metrics、/healthz、/readyz
hub:
  url: https://srenautix.example   # 必填
  token_file: /var/run/srenautix/hub-token   # 必填，每次请求重新读取
  ca_file: /etc/srenautix/hub-ca.crt         # 可选，为空时使用系统根证书
  timeout: 30s
kubeconfig: ""                     # 为空时使用 Pod 的 ServiceAccount
datasources:                       # Prometheus HTTP API 兼容的数据源
  - name: metrics
    url: http://vmsingle.monitoring.svc:8428
    http:                          # Prometheus common 的 HTTP 客户端配置
      authorization:
        credentials_file: /var/run/srenautix/metrics-token
query_manifest: /etc/srenautix/packs/queries.yaml   # 查询模板清单；不挂载时拒绝全部声明式查询
limits:                            # 全部可选，未填写的取默认值
  max_range: 7d
  min_step: 1s
  max_points: 11000
  max_series: 1000
  max_bytes: 16777216
  timeout: 10s
  concurrency: 8
  breaker_failures: 5
  breaker_window: 60s
  breaker_open_for: 30s
alerts:                            # 多集群模式的告警对账；单集群安装不需要
  alertmanager_url: http://alertmanager.monitoring.svc:9093
  metrics_datasource: metrics
  interval: 60s
  max_alerts: 10000
history:                           # kube-state-metrics 历史重建
  datasource: metrics
  matchers: 'cluster="edge-1"'     # 多个集群写入同一后端时追加的标签匹配
  step: 5m
  chunk: 24h                       # 必须是 step 的整数倍
  max_window: 15d
crd_rediscover: 1m
clock_interval: 1m
heartbeat_interval: 15s
health_interval: 30s               # 上报不健康对象的间隔
request_workers: 16
```

配置文件按严格模式解析，未知的键直接报错。

## 查询模板清单

```yaml
version: 1
pack_lock: sha256:<64 位十六进制>
queries:
  - id: workload/restarts
    dialect: promql                  # promql 或 metricsql
    expr: sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace="$namespace"}[$window]))
    params:
      namespace: {type: label_value}
      window: {type: duration, max: 1h}
    limits: {}                       # 可选：max_range、max_series
    content_hash: sha256:<见下文>
```

参数类型：`label_value`、`label_values`（需要 `max_items`）、`duration`（需要 `max`）、`number`、`enum`（需要 `values`）。`content_hash` 用 `query.ContentHash` 计算（方言、表达式、按名称排序的参数声明、模板级限制），reader 加载时重新计算并核对。表达式里的每个 `$参数` 都必须声明，每个声明的参数都必须被使用。

## 权限

reader 的 ServiceAccount 只需要 `get`、`list`、`watch`，不含 Secret：

| API 组 | 资源 |
|---|---|
| `""` | pods、nodes、namespaces、services、configmaps、persistentvolumeclaims、persistentvolumes |
| `apps` | replicasets、deployments、statefulsets、daemonsets |
| `batch` | jobs、cronjobs |
| `discovery.k8s.io` | endpointslices |
| `networking.k8s.io` | ingresses、networkpolicies |
| `argoproj.io` | applications |
| `kustomize.toolkit.fluxcd.io` | kustomizations |
| `gateway.networking.k8s.io` | httproutes |
| `postgresql.cnpg.io` | clusters |

另外需要非资源 URL `/version` 的 `get`（时钟测量）。自定义资源的权限可以按集群实际安装的组件给出，缺少的资源不会启动 informer。

ConfigMap 的值只在进程内用于匹配 Service DNS 名，不进入任何输出。

## 健康检查

| 路径 | 含义 |
|---|---|
| `/healthz` | 进程存活 |
| `/readyz` | 全部 informer 已同步且没有未恢复的 watch 错误。中心不可达不影响就绪：reader 继续维护本地拓扑，恢复后以快照补齐 |
| `/metrics` | Prometheus 指标 |

## 状态条件

心跳上报以下条件，控制台集群页显示（DESIGN §12.4）：

| 条件 | True 的含义 |
|---|---|
| `InformersFresh` | 全部 informer 已同步，watch 错误之后 resourceVersion 已经再次前进 |
| `TunnelConnected` | 拓扑同步会话已建立，快照已被中心应用 |
| `ClockSkew` | 与 apiserver 的时钟偏差不超过 2 秒 |
| `QueryManifest` | 查询模板清单已挂载并通过校验 |
| `AlertReconcile` | 最近一次对账的各部分都读取成功 |

中心把这些条件以 role `reader` 写入状态条件（契约 2.9.0 起属于 `Condition.type` 的取值），控制台状态条显示条件不为 True 的项。没有挂载查询模板清单（chart 的 `roles.reader.queryManifestConfigMap` 为空）时 `QueryManifest` 为 False（`NotMounted`），状态条一直显示"查询模板清单未加载"：reader 拒绝声明的证据查询，中心的证据卡改由 server 直接查询数据源。

reader 超过 `topology.reader_offline_after`（server 配置，默认 60 秒，即 4 个心跳周期）没有心跳时，server 清除它之前上报的条件，状态条只显示一条 `TunnelConnected`（原因 `ReaderOffline`，"reader 离线"）；reader 恢复心跳后由新的条件覆盖。server 自己所在的集群拓扑不经 reader（`topology.source` 不是 `reader`，例如 reader 已关闭）时，这个集群的 reader 条件全部清除，不显示离线。

## 指标

| 指标 | 说明 |
|---|---|
| `srenautix_reader_condition{type}` | 状态条件（1 为 True） |
| `srenautix_reader_informer_synced{resource}` | informer 是否已完成首次同步 |
| `srenautix_reader_informer_last_event_timestamp_seconds{resource}` | 最近一次对象变化的时间 |
| `srenautix_reader_informer_last_resource_version_change_timestamp_seconds{resource}` | resourceVersion 最近一次前进的时间 |
| `srenautix_reader_informer_watch_errors_total{resource}` | list/watch 错误次数 |
| `srenautix_reader_topology_events_total{op}` | 产生的拓扑事件数 |
| `srenautix_topology_invalid_keys_total{source,kind}` | 无法生成合法组件键而跳过的对象次数；`source` 是 informer 资源名或 kube-state-metrics 指标名，非法的 kind 记为 `invalid`（ADR 0034） |
| `srenautix_topology_extract_errors_total{source}` | 字段无法解析或提取出错而跳过的对象次数 |
| `srenautix_reader_unhealthy_objects{state}` | 最近一次上报中各状态的不健康对象数（ADR 0035） |
| `srenautix_reader_topology_nodes`、`srenautix_reader_topology_edges` | 当前节点数与边数 |
| `srenautix_reader_tombstones` | 保留中的墓碑数 |
| `srenautix_reader_topology_pushed_seq` | 中心已确认的拓扑序号 |
| `srenautix_reader_topology_buffered_events` | 等待推送的事件数 |
| `srenautix_reader_topology_resyncs_total` | 上传完整快照的次数 |
| `srenautix_reader_tunnel_connected` | 拓扑同步会话是否已建立 |
| `srenautix_reader_tunnel_errors_total{op}` | 到中心的请求失败次数 |
| `srenautix_reader_query_requests_total{datasource,origin,result}` | 查询请求数，`origin` 为 declared 或 builtin，`result` 为 ok 或错误码 |
| `srenautix_reader_query_duration_seconds{datasource}` | 查询耗时 |
| `srenautix_reader_query_inflight{datasource}` | 正在执行的查询数 |
| `srenautix_reader_query_breaker_state{datasource}` | 熔断器状态：0 关闭，1 半开，2 打开 |
| `srenautix_reader_query_truncated_total{datasource}` | 被截断的查询数 |
| `srenautix_reader_query_clamped_total{datasource,clamp}` | 被调整过范围或步长的查询数 |
| `srenautix_reader_query_response_bytes{datasource}` | 后端响应体大小 |
| `srenautix_reader_alert_reconcile_total{source,result}` | 告警对账读取次数 |
| `srenautix_reader_alert_reconcile_alerts{source}` | 最近一次对账读到的告警数 |
| `srenautix_clock_skew_seconds{peer="apiserver"}` | 本地时钟减去 apiserver 时钟（秒） |
| `srenautix_reader_clock_skew_uncertainty_seconds` | 时钟偏差测量的半宽误差 |
| `srenautix_reader_build_info{version}` | 版本 |

建议的告警：`srenautix_reader_tunnel_connected == 0` 持续 5 分钟；`srenautix_reader_condition{type="InformersFresh"} == 0` 持续 5 分钟；`abs(srenautix_clock_skew_seconds) > 2`；`srenautix_reader_query_breaker_state == 2`。

## 测试

集成测试使用真实的依赖，缺少时直接失败：

| 环境变量 | 内容 |
|---|---|
| `KUBEBUILDER_ASSETS` | setup-envtest 下载的 kube-apiserver 与 etcd（`make envtest-assets`） |
| `SRENAUTIX_TEST_BIN` | `prometheus`、`promtool`、`alertmanager`、`victoria-metrics-prod`、`vmalert-prod` 所在目录（`.github/scripts/install-test-binaries.sh`） |

```
KUBEBUILDER_ASSETS=... SRENAUTIX_TEST_BIN=... go test ./internal/spoke/reader/...
```

| 测试 | 覆盖 |
|---|---|
| `topology` | 贡献累计、占位节点与对象节点、序号与 `valid_from` 单调 |
| `kube` | envtest 上的全部边类型、自定义资源晚于 reader 安装、派生边撤回、墓碑、事件流与快照一致 |
| `query` | Prometheus 与 VictoriaMetrics 上的同一批模板、参数转义与注入、全部拒绝原因、范围与步长调整、截断、超时、并发上限、熔断、字节上限 |
| `history` | 两种后端重建出逐字节相同的事件、同名 Pod 重建、按 IP 回查跳过 hostNetwork Pod |
| `alerts` | Prometheus 与 vmalert 两种规则引擎、Alertmanager v2、读取失败与截断 |
| `hub/hubtest` | 进程内测试中心按契约拒绝不合规的请求体 |
| 包 `reader` | 端到端：envtest、Prometheus、Alertmanager、按契约校验的进程内中心；首次快照、增量、响应丢失后的重试、中心不可达、中心状态重置、全部读取请求类型、心跳与指标 |

进程内测试中心（`internal/spoke/reader/hub/hubtest`）独立实现中心一侧的语义，用 `contract/gateway/v1/reader.openapi.yaml` 校验每个请求与响应：路由、参数与鉴权由 kin-openapi 校验，请求体与响应体由 JSON Schema 2020-12 校验器按 OpenAPI 文档中的位置编译。
