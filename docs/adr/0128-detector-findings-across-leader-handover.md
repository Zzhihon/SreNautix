# 0128 检测器的发现在主实例切换时保持触发

## 背景

CCHP 影子升级到 11ce9d8 时（Zzhihon/SreNautix#6），7 个 PDB 发现的合成告警在 15:18:39 被旧的 server Pod 标成 resolved，`server.detector_findings` 里它们仍是活跃的，新的主实例也没有重新触发。检测器（ADR 0105）只在发现第一次出现时写入触发告警，之后以发现表为准：发现表里有、告警已经恢复的发现，再也不会被触发。

能让告警恢复、发现表却不变的路径有三条：

1. **对账**：60 秒对账（DESIGN §3.1）把本地触发中、两个告警源（Alertmanager 与 `ALERTS_FOR_STATE`）里都没有的告警结束。检测器合成的告警不在任何告警源里，每次对账都会被结束。Kind 的诊断里检测器告警在触发后几十秒内恢复（kind-e2e 39628044289 的 SreNautixRolloutStalled 33 秒、SreNautixJobFailed 37 秒），而对象仍然不健康。
2. **退出**：进程退出时先中止 informer，再清理定时器。正在执行的一轮检测拿到的可能是已经停止的 informer 的缓存，写入"全部恢复"之后，连接池关闭，发现表的删除没有执行。
3. **进入时间从头算起**：CrashLoopBackOff 与发布停滞没有对应的条件时间，进入时间由上报方在内存里记录（`FirstSeen`）。新的主实例（或 reader）重启后，进入时间从重启时间算起，还没到阈值，完整上报里的状态因此不合成告警，已触发的发现被当作"不再成立"恢复。

## 决定

1. **对账不结束检测器告警**：对账比较的本地告警（`firingAlertIds`）不含 `source = detector` 的告警。合成告警只由检测器恢复。
2. **不是主实例时不写入**：`DetectorService` 带一个 `active` 判断，server 传入"是主实例且没有在退出"。一轮检测开始时与写入之前各判断一次，不成立时不写入任何告警。informer 停止之后 `healthObjects()` 返回 null（与首次 list 完成之前相同），退出中的进程不上报对象状态。
3. **重新确认仍然成立的发现**：每轮检测把发现表与 `alert_state` 对照。发现仍然成立、对应的告警（同一指纹与开始时间）却不在触发时，以原来的告警重新触发：告警 id 不变，事件里的成员回到触发。之后照常由检测器在状态消失时恢复。指标 `srenautix_detector_refired_total{cluster_id}`，日志 `检测器的发现仍然成立，重新触发告警`。
4. **已触发的发现不因进入时间重置而恢复**：对象仍在完整上报里、状态有阈值、命名空间允许，只是按新的进入时间还没到阈值（`belowThreshold`）时，已经触发过的发现保持，第 3 条照常适用。没有触发过的发现仍按阈值判断，偏向晚报。

## 结果

- 实现在 `apps/srenautix/src/detectors/service.ts`、`ingest/store.ts`（`firingAlertIds`）、`topology/informer.ts` 与 `roles/server.ts`；契约不变。
- 集成测试（真实 PostgreSQL 与接入路径）：对账读到的告警源里没有检测器告警时它仍在触发；`active` 为 false 的实例在完整上报为空时也不写入；告警被标成恢复、新主实例的上报从重启时间算起时，同一个告警重新触发，之后对象恢复时照常恢复。envtest 上 informer 停止之后 `healthObjects()` 为 null。单元测试覆盖 `belowThreshold`。
