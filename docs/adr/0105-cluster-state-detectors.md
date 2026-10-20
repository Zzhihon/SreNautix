# 0105 集群状态检测器：对象状态由 reader 或 informer 上报，server 按阈值合成告警

## 背景

告警规则只覆盖写过规则的问题。2026-10-20 的发布事故里，Pod 卡在等待迁移的 initContainer、rollout 停滞、PDB 阻塞驱逐在 CCHP 都有对应的规则，但在别的集群上这些规则未必存在。用户决定：检测器覆盖全部命名空间、只读、复用 reader 的 informer，发现的问题与告警一样进入事件。

## 决定

1. **分工**：对象状态由看得见对象的一方上报：多集群由 reader（`POST /v1/spoke/reader/health`，reader 协议的 ReaderHealth，spoke-gateway ADR 0035），单集群由 server 自己的 informer（`detectors/health.ts`，同一套判定）。上报只列出"现在不健康"的对象与进入该状态的时间（`since`），不判断阈值；阈值、命名空间过滤、去重与合成告警只在 server 上做，改阈值不需要动 reader。
2. **状态与 since**：
   - `pod_pending`：Pending，没有待完成的 init 容器（未调度、拉镜像、创建容器）；since 为 PodScheduled=False 的时间，否则为创建时间；
   - `pod_init`：有 init 容器未完成；since 为创建时间与 Initialized 条件变化时间中较晚的；
   - `crash_loop`：任一容器 waiting.reason 为 CrashLoopBackOff；since 为第一次看到的时间；
   - `rollout_stalled`：Deployment 的 Progressing 为 ProgressDeadlineExceeded（since 为条件时间），或 updated、available 少于期望（since 为第一次看到）；StatefulSet 的 ready 少于期望或 updateRevision 未滚完；DaemonSet 的 updated、available 少于 desired；
   - `pdb_blocking`：expectedPods > 0 且 disruptionsAllowed = 0；since 为 DisruptionAllowed=False 的时间；附带它选中的工作负载；
   - `job_failed`：Failed 条件为 True。
   "第一次看到"只在内存里记录，进程重启后从重启时间算起，偏向晚报而不是误报。
3. **阈值与合成告警**（server 配置 `detectors`，默认关闭）：状态持续超过阈值（`pod_init_after`、`pod_pending_after` 默认 10m，`rollout_stalled_after` 15m，`crash_loop_after` 5m，`pdb_blocked_after` 10m，`job_failed` 立即）时，合成一条 `source: detector` 的告警：告警名 `SreNautixPodPending`、`SreNautixPodInitStuck`、`SreNautixCrashLoop`、`SreNautixRolloutStalled`、`SreNautixPdbBlockingEviction`、`SreNautixJobFailed`；开始时间是"进入状态 + 阈值"，与告警规则的 `for` 相同；标签带标签契约的 `entity`、`entity_kind` 与对象标签，`role: cause`；摘要与说明写明原因、停住的容器、副本数等。合成告警走与告警规则相同的接入路径（实体解析、alert_state、唤醒事件引擎）。
4. **去重**：同一对象上，同类的告警规则（默认表按状态列出 kube-prometheus 与 CCHP 的常见告警名，`equivalent_alerts` 可追加）正在触发时不合成；已经合成的随之恢复。"同一对象"指告警的实体或组件就是这个对象；Pod 的状态（CrashLoop 除外）也接受落在它属主工作负载上的同类规则。
5. **恢复**：完整的上报（`complete: true`）里没有这个状态时，合成告警恢复；不完整的上报（reader 的列表超过上限、informer 尚未同步）不据此恢复。
6. **指标**：`srenautix_detector_last_scan_timestamp_seconds{cluster_id}`、`srenautix_detector_findings{cluster_id,kind}`、`srenautix_detector_alerts_total{cluster_id,kind}`、`srenautix_detector_scan_errors_total{cluster_id}`；检测延迟 `srenautix_incident_detection_seconds{source}`（首个症状到事件创建，source 为 alert 或 detector）。

## 结果

- 没有告警规则的集群也能发现卡住的 Pod、停滞的发布、CrashLoop、阻塞驱逐的 PDB 与失败的 Job，并和告警一样收敛、研判。
- 有规则时检测器让位给规则，不产生重复事件。
- 检测器只读；reader 需要额外 watch PodDisruptionBudget（chart 的只读 RBAC 已包含）。
