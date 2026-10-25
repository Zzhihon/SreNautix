# 0160 两轮完整对账之间快速轮询 Alertmanager 的新增告警

## 背景

只用对账接入、不改动 Alertmanager 路由的部署（ADR 0117 之后的常见做法），告警从出现在 Alertmanager 到写入 `alert_state` 要等下一轮完整对账。完整对账每轮读 Alertmanager v2 的活动告警、规则引擎的 `ALERTS_FOR_STATE` 与 `ALERTS{alertstate="firing"}`，再读状态库里本地触发中的告警，补写缺的、结束没有的。

一次 24 小时的运行中对账间隔为 15 秒，35 个对账接入的事件等待对账 0.2–13.0 秒（均值 7.3 秒），阶段 A 自身 0.1–1.1 秒。规则引擎的回溯（ADR 0159 §4）占 31.6–59.4 秒，SreNautix 不能改变；能缩短的是等待对账这一段。

可选的做法：

| 做法 | 等待 | 代价 |
|---|---|---|
| 完整对账改为 5 秒一轮 | ≤5 秒 | 规则引擎的两条查询与状态库的读取都变成 3 倍 |
| Alertmanager webhook 推送 | 分组等待（`group_wait`，常见 30 秒）之后才推送 | 改动告警路由；比 15 秒对账更晚 |
| 只读 Alertmanager 的快速轮询 | ≤ 轮询间隔 | 每轮一次 Alertmanager 的 HTTP 请求（内存中的告警列表） |

## 决定

`ingest.reconcile.additions_interval`（默认 `5s`，`0s` 关闭），只在配置了 `alertmanager_url` 时生效：

1. 每轮 `GET /api/v2/alerts?active=true&silenced=true&inhibited=true&unprocessed=true`，与完整对账相同的过滤（自身告警、Watchdog、`isIgnorable`）。
2. 只补写身份指纹不在"已知集合"里的触发中告警，写入路径与完整对账相同（`IngestService.write`，`source=reconcile`，唤醒事件引擎）。
3. 已知集合取最近一轮完整对账之后本地触发中的告警（`ReconcileResult.firing`：本地的、加上本轮补写的、去掉本轮结束的），加上快速轮询自己补写的。完整对账成功之前不轮询；不是主实例时清空，重新成为主实例后等一轮完整对账。
4. 不结束任何告警，不读状态库与规则引擎；结束告警与 `ALERTS_FOR_STATE` 的补写仍由完整对账负责。上一轮没有结束时跳过本轮。
5. 指标：`srenautix_ingest_reconcile_repairs_total{kind="added_fast"}`；`srenautix_ingest_delay_seconds{path}` 记对账新补写的告警从告警源的开始时刻到写入的时长（`full` 与 `fast`），规则引擎的回溯在这里可见。

## 影响

- 状态库：只在出现新告警时写入，与完整对账补写的是同一批告警，写入次数不变；没有新增读取。规则引擎与 VictoriaMetrics：没有新增查询。Alertmanager：每 5 秒一次只读请求。
- 按 24 小时运行的数据模拟（快速轮询与实际对账同相位，补写时刻取告警出现后的第一个 5 秒点）：对账接入事件的阶段 A 时延均值 48.4 → 43.7 秒，p95 70.2 → 62.5 秒，超过 60 秒的 6 → 5 个；剩下的都来自求值相位靠后的规则组，规则引擎的回溯本身已有 57–59 秒。
- 完整对账与快速轮询同时补写同一条告警时，第二次写入是状态不变的 upsert，不产生新版本。
- 测试：`test/integration/ingest-e2e.test.ts`（真实 Alertmanager：完整对账之前不轮询、只补写新增、补写过的不再写、不结束告警、失去主实例后等完整对账）。
