# 0117 Prometheus 的 external labels 不属于告警身份

## 背景

告警的身份（指纹、`alert_id = <指纹>@<开始秒>`）取全部标签，只去掉 `__name__`、`alertstate`、`alertgroup`。同一条告警经两条入口进入 server：

- Alertmanager webhook（以及对账读取的 Alertmanager API）：Prometheus 发给 Alertmanager 的告警带着它的 external labels。kube-prometheus-stack 默认加 `prometheus=<命名空间>/<名称>`，高可用部署还加 `prometheus_replica`。
- 规则引擎（`ALERTS_FOR_STATE` 与 reader 推送的规则快照）：external labels 只在发出时附加，规则引擎自己的告警不带。

Kind 的 kind-e2e 39595887396 里，ShopPodRestarted 经 webhook 进来时带 `prometheus="monitoring/kps-prometheus"`，开始时间 12:13:13.312；12:13:57 reader 对账读到同一条规则告警时不带这个标签，开始时间 12:13:13。两者指纹不同，对账把它当成本地没有的告警补写了一份，事件从 v1 升到 v2。再加上自愈 PR 在这个竞态里被永久跳过（ADR 0108 §13），alert-too-sensitive 一直没有 PR。

## 决定

1. **external labels 不计入身份**：配置 `ingest.external_labels`，默认 `[prometheus, prometheus_replica]`。core 的 `identityLabels`、`isIdentityLabel` 与 server 的 `fingerprint`、`identityLabels` 都按它去掉这些标签。webhook、通用接入源、Alertmanager API 对账、规则快照对账与重建包导出用同一套规则，server 启动时设定一次（`setExternalLabels`）。存下的告警标签里也不再有这些标签。
2. **已经存下的重复告警在下一次对账时合并**：对账按当前规则重新计算本地触发中告警的身份。身份与开始秒都相同的两条只保留一条：优先保留存下的指纹已经符合新规则的那一条，其余以对账时刻结束，日志记"合并重复存下的告警"。同一条告警之前按带 external labels 的指纹存下、之后又按新指纹写入时，也按这条规则合并。
3. **升级时的一次性影响**：升级后第一次收到带 external labels 的告警时，按新指纹写入新的一份，旧的一份在下一次对账中结束。所在事件因此会多一个版本：新的一份加入，旧的一份离开。不另做数据迁移，因为告警标签存在 `alert_state.labels` 里，对账本身就能认出重复。

## CCHP

CCHP 的告警由 VictoriaMetrics 的 vmalert 计算，不是 kube-prometheus-stack 的 Prometheus：

- `platform/observability/metrics/collectors.yaml` 的 VMAlert 没有设置 `-external.label`，所以 vmalert 发给 vmalertmanager 的告警与写回 vmsingle 的 `ALERTS` 带着同一组标签；
- vmagent 的 `externalLabels: {cluster: cchp}` 加在抓取的序列上，进入告警表达式的结果之后，两条入口都带着它，不会造成分歧。

所以 CCHP 不会因为 external labels 存下重复告警，unlabelled 统计与事件版本抖动也不受这个问题影响。影子环境的状态库可以用"同一 `alertname`、同一开始秒、标签只差 `prometheus`/`prometheus_replica` 的触发中告警"查一次，隧道恢复后核实。以后 CCHP 改用 Prometheus，或给 vmalert 加 external label 时，把对应标签加到 `ingest.external_labels`。

## 结果

- 同一条告警经 webhook 与对账得到同一个指纹，对账不再补写第二份，事件也不再因此升版本。
- 测试 `apps/srenautix/test/integration/external-labels.test.ts`：按 Kind 的标签与时序，webhook 带 external labels、对账不带，只存一份；修复前按旧指纹存下的重复告警在对账时合并；配置的标签都不计入身份。
