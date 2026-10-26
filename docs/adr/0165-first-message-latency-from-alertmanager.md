# 0165 首条消息时延从告警第一次出现在 Alertmanager 算起

## 背景

`srenautix_first_message_latency_seconds`（ADR 0159）从事件的计时起点算起，计时起点是告警源给出的开始时刻。vmalert 把开始时刻记为求值时刻减去 `-rule.evalDelay`（默认 30 秒）再按组间隔对齐，告警出现在 Alertmanager 时已经比开始时刻晚 30 秒到一个组间隔加 30 秒（ADR 0159 §4 的并行运行中为 31.6–59.4 秒）。这一段发生在规则引擎里，SreNautix 和其他值班系统都要等它结束才能看到告警。

部署方判定"首条消息不超过 60 秒"时，从告警进入 Alertmanager 的时刻算起，规则引擎的回溯用另一个指标单独看（`srenautix_ingest_delay_seconds`，ADR 0160）。Alertmanager 的 API 不给出告警第一次到达的时刻（`updatedAt` 随规则引擎每次重发而变化），所以 SreNautix 记下自己第一次在 Alertmanager 中看到每个告警的时刻：快速轮询每 5 秒一次（ADR 0160），误差不超过一个轮询间隔。

## 决定

### 1. `alert_state.alertmanager_seen_at`

告警第一次在 Alertmanager 中被看到的时刻（ingest 迁移 2，expand）。接入层的告警（`RawAlert.alertmanagerSeenAt`）带上这一次看到的时刻：

| 路径 | 看到的时刻 |
|---|---|
| Alertmanager 与 Grafana 的 webhook | 请求到达的时刻 |
| 完整对账、快速轮询读 Alertmanager v2 的活动告警 | 读到应答的时刻 |
| reader 推送的快照中的 Alertmanager 部分 | 快照的读取时刻 `taken_at` |
| 规则引擎的 `ALERTS_FOR_STATE`、夜莺、通用 webhook、集群状态检测器 | 没有（null） |

- 写入时取已有值与这一次的最早一个（`LEAST`，忽略 null）：webhook、完整对账、快速轮询谁先看到就记谁，之后的写入不会推迟它，也不会清掉它。
- 本地已有、还没有这个时刻的触发中告警（例如先由 `ALERTS_FOR_STATE` 补写，之后才出现在 Alertmanager 中）：完整对账在 Alertmanager 中读到它时补上；仍然没有看到的，完整对账把它们交给快速轮询（`ReconcileResult.unseen`），快速轮询读到时补上。只在出现这种告警时写状态库，快速轮询仍然不读状态库。
- 迁移时已有的行：Alertmanager、Grafana 与对账来源的告警取第一次写入的时刻 `received_at`（这一列出现之前，三种路径第一次看到告警就写入；对账来源里由规则引擎补写的告警无法区分，同样取这个时刻），其他来源为 null。

### 2. 首条消息时延增加标签 `clock`

`srenautix_first_message_latency_seconds{business_impact, origin, clock}`：

| `clock` | 起点 |
|---|---|
| `onset` | 事件的计时起点（ADR 0159） |
| `alertmanager` | 送达时成员告警（含已经离开的）`alertmanager_seen_at` 的最小值；拆分出的事件为拆分时刻 |

- 两个口径在同一次送达时各记一次；成员告警都没有 `alertmanager_seen_at` 时只记 `onset`。
- 拆分出的事件两个口径都从拆分时刻算：拆分前这些告警已经随原事件发出过消息。
- "首条消息不超过 60 秒"按 `clock="alertmanager"` 判定。查询需要带上 `clock`，否则两个口径的样本会加在一起。

## 结果

- 实现：`ingest/{migrations,normalize,store,service,reconcile}.ts`、`detectors/service.ts`、`notify/{ports,source,engine}.ts`、`metrics.ts`、`roles/server.ts`。
- 测试：
  - `test/unit/ingest-normalize.test.ts`：Alertmanager 与 Grafana 的 webhook、Alertmanager API 记下读到的时刻，夜莺与通用 webhook 为空；
  - `test/integration/ingest-e2e.test.ts`（真实 Prometheus 与 Alertmanager）：webhook 到达的时刻；完整对账与快速轮询补写的告警记下读到应答的时刻；本地已有、没有这个时刻的告警由完整对账与快速轮询补上，之后不再改；写入顺序不同时保留最早的一次，不来自 Alertmanager 的写入不改它；
  - `test/integration/ingest-reader-reconcile.test.ts`：reader 快照里 Alertmanager 的告警记下读取时刻，只在规则引擎中的告警交给快速轮询；
  - `test/integration/alert-seen-migration.test.ts`：迁移按来源补上已有行的时刻；
  - `test/integration/notify-first-message.test.ts`：两个口径的时延，拆分出的事件都从拆分时刻算，集群状态检测器的事件只记 `onset`。
