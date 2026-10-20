# 0035 reader 上报不健康的对象（集群状态检测器）

## 背景

有的问题没有对应的告警规则，例如 Pod 卡在 Init 或 Pending、rollout 停滞、CrashLoop、PDB 阻塞驱逐、Job 失败。中心的集群状态检测器需要把它们当作告警来源，与告警一样进入事件。多集群模式下，中心没有成员集群的凭证，对象状态只能由各集群的 reader 上报。

## 决定

1. **只上报事实，不判断阈值**：reader 每 `health_interval`（默认 30 秒）以 `POST /v1/spoke/reader/health` 上报当前不健康的对象，以及每个对象进入该状态的时间（`since`）。阈值、去重、合成告警都在中心（`detectors.*`），reader 没有检测器配置。
2. **判定来源**：只读 informer 缓存，不额外请求 apiserver。reader 为此增加 PodDisruptionBudget（`policy/v1`）的 informer，它不进拓扑。各状态的判定与 `since` 写在契约 `ObjectHealth` 的说明中：
   - `pod_pending`、`pod_init`、`rollout_stalled`（ProgressDeadlineExceeded）、`pdb_blocking`、`job_failed` 的 `since` 取 Kubernetes 条件的变化时间或对象的创建时间；
   - `crash_loop` 与按副本数判定的 `rollout_stalled`，Kubernetes 不给出开始时间，`since` 取 reader 第一次看到的时间。这个时间记在内存中，对象恢复后清除，reader 重启后从重启时间重新计算。
3. **属主**：Pod 的 `owner` 是沿 controller 链的顶层 owner，与拓扑的组件一致：
   - 经 ReplicaSet 到 Deployment；
   - Job 到 CronJob；
   - 静态 Pod 到 Node；
   - CNPG 实例到 Cluster。

   PDB 的 `targets` 是它选中的 Pod 的顶层 owner（去重、排序）。组件键按 ADR 0034 编码，无法生成键的对象跳过并计入 `srenautix_topology_invalid_keys_total{source="health"}`。
4. **完整性**：上报最多 2000 个对象，按键与状态排序。超出上限、或 informer 不新鲜时，`complete` 为 false，中心不据此清除已有的发现。
5. **观测**：`srenautix_reader_unhealthy_objects{state}` 是最近一次上报中各状态的对象数。上报失败计入 `srenautix_reader_tunnel_errors_total{op="health"}`。

## 结果

- 没有告警规则时，这些问题也能进入事件；告警规则存在时，中心按对象与状态去重。
- 上报量与不健康对象的数量成正比，健康的集群每 30 秒只发一个空列表。
- `crash_loop` 的持续时间在 reader 重启后从头计算；中心的阈值可能因此晚一些触发。
