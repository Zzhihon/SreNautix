# 0033 从 kube-state-metrics 历史重建拓扑

## 背景

观察模式要在安装后 1 小时内用过去 14 天的数据给出成绩单（DESIGN §14.5），回放也要知道事件发生时的拓扑（§4.1）。安装之前 informer 没有运行，过去的拓扑只能从 kube-state-metrics 的历史序列推出。实体解析的最后一层同样依赖它（§3.3）：告警引用的 Pod IP 在 informer 缓存与墓碑里都查不到时，按历史回查。

Prometheus 与 VictoriaMetrics 对区间查询的处理不同：VictoriaMetrics 把起点对齐到步长，两者的回看窗口与陈旧标记规则也不同。直接用裸选择器做区间查询，两种后端会在区间边界上差出一个步长。

## 决定

1. **指标与推出的节点和边**：

   | 指标 | 节点与边 |
   |---|---|
   | `kube_node_info` | Node |
   | `kube_pod_info` | Pod（带 UID）、`runs_on` Node |
   | `kube_pod_owner` | `owned_by` ReplicaSet / StatefulSet / DaemonSet / Job / Node |
   | `kube_replicaset_owner`、`kube_job_owner` | `owned_by` Deployment / CronJob |
   | `kube_pod_spec_volumes_persistentvolumeclaims_info` | `mounts` PVC |
   | `kube_persistentvolumeclaim_info` | `bound_to` PV |
   | `kube_persistentvolume_info` | `provisioned_by` CSIDriver |
   | `kube_service_info` | Service |

   kube-state-metrics 不输出 owner 的 API 组，只识别内置控制器的 Kind；其他 owner 不产生边。节点键与关系名与 informer 相同（ADR 0030），事件的 `source` 为 `ksm_history`。
2. **采样方式**：窗口起点与终点对齐到步长（默认 5 分钟），每个指标查询 `last_over_time(<选择器>[<步长>])`，点 t 表示对象在 `(t − 步长, t]` 内出现过。显式窗口不依赖两种后端各自的回看与陈旧规则，两者得到相同的点。
3. **区间**：相邻点相差一个步长视为连续存在，区间写作 `[首点 − 步长, 末点]`，下限不早于窗口起点；末点等于窗口最后一个点时，区间延续到窗口之外，`valid_to` 为空。同名 Pod 重建后 UID 不同，按两个节点分别计算区间。
4. **分段**：每个指标按 24 小时一段查询，单次查询的序列数与响应体上限放宽到 5 万条与 128 MiB，超时 60 秒；整个窗口最长 15 天。某个指标在整个窗口里没有任何序列时，列入 `missing_metrics`，中心据此提示覆盖缺口。
5. **事件身份**：事件序号在本次结果内从 1 编排，是独立于实时拓扑的版本空间。`event_id` 由集群、操作、节点或边、`valid_from` 确定（UUID v5），同一窗口重复重建得到相同的 ID，中心可以去重。
6. **按 IP 回查**：`last_over_time(kube_pod_info{pod_ip="<IP>"}[10m])` 在给定时刻求值，跳过 `host_network="true"` 的 Pod（它们共用节点 IP）。

## 结果

- 同一份 kube-state-metrics 数据在 Prometheus 与 VictoriaMetrics 上重建出逐字节相同的事件（测试 `TestRebuildFromKubeStateMetricsOnPrometheusAndVictoriaMetrics`）。
- 区间精度是一个步长：对象出现与消失的时刻最多偏差 5 分钟，满足按事件时间窗口归并的需要；需要更细的精度时可以调小步长，代价是查询点数线性增加。
- 配置引用、NetworkPolicy、路由与 Operator 约定的边在 kube-state-metrics 中没有对应信息，重建的拓扑只包含结构性边；回放报告把这类用例标为"重建"（DESIGN §14.2）。
