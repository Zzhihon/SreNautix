## 现象

StatefulSet `api-gateway`（命名空间 `shop`，limit 4.0 GiB，GOMEMLIMIT 3865470566，GOMAXPROCS=2，镜像 `registry.example/api-gateway:1.42.0`）在最近 48h 内 3 次内存终止：

| 时间 (UTC) | Pod | 分类 | 说明 |
|---|---|---|---|
| 11-01 07:53:00 | api-gateway-0 | 容器 limit 触发 | 存活堆贴着 GOMEMLIMIT，GC 连续运行也收不回：占用的是存活数据；内存峰值 3.3 GiB，容器 CPU 最高 1.15 核（GOMAXPROCS 2 的 57%） |
| 11-02 00:09:14 | api-gateway-3 | 容器 limit 触发 | 存活堆贴着 GOMEMLIMIT，GC 连续运行也收不回：占用的是存活数据；内存峰值 3.3 GiB，容器 CPU 最高 1.1 核（GOMAXPROCS 2 的 55%） |
| 11-02 00:44:22 | api-gateway-0 | 容器 limit 触发 | 存活堆贴着 GOMEMLIMIT，GC 连续运行也收不回：占用的是存活数据；内存峰值 3.3 GiB，容器 CPU 最高 1.1 核（GOMAXPROCS 2 的 55%） |

结论（主因/次因/置信度）：

- **主因（置信度中高）**：大请求体整体转换与整段拼接。大请求体整体解码进堆，归档写入时整段拼接，并发的大请求叠加，超出请求体预算预留的余量。
- **另一种触发（置信度中）**：api-gateway-0 11-01 07:53:00 由不可重试的拒绝被反复重试主导。不可重试的上游拒绝仍被重试，每次尝试都让同一条归档记录变大，记录一直没有收尾。
- **排除为主因（置信度中）**：导出任务的内存看门狗，是次要加重因素，见 §3。

## 1. 证据

| 时间 (UTC) | Pod | 指标 / 日志 | 数值 | 依据 | 查询 |
|---|---|---|---|---|---|
| 11-01 07:53:00 | api-gateway-0 | heap_inuse / GOMEMLIMIT | 828 MiB → 3.3 GiB / 3.6 GiB | 观测 | `go-runtime/heap_inuse{namespace="shop"}` |
| 11-01 07:53:00 | api-gateway-0 | RSS / limit | 3.8 GiB / 4.0 GiB | 观测 | `workload/container_memory_rss{namespace="shop"}` |
| 11-01 07:53:00 | api-gateway-0 | 容器 CPU（代替 GC CPU） | 容器 CPU 最高 1.15 核（GOMAXPROCS 2 的 57%） | 推断（代替） | `workload/container_cpu_cores{namespace="shop"}` |
| 11-01 07:53:00 | api-gateway-0 | 节点可用内存 | 55.0% | 观测 | `workload/pod_node_memory_available{namespace="shop"}` |
| 11-02 00:09:14 | api-gateway-3 | heap_inuse / GOMEMLIMIT | 811 MiB → 3.3 GiB / 3.6 GiB | 观测 | `go-runtime/heap_inuse{namespace="shop"}` |
| 11-02 00:09:14 | api-gateway-3 | RSS / limit | 3.8 GiB / 4.0 GiB | 观测 | `workload/container_memory_rss{namespace="shop"}` |
| 11-02 00:09:14 | api-gateway-3 | 容器 CPU（代替 GC CPU） | 容器 CPU 最高 1.1 核（GOMAXPROCS 2 的 55%） | 推断（代替） | `workload/container_cpu_cores{namespace="shop"}` |
| 11-02 00:09:14 | api-gateway-3 | 节点可用内存 | 55.0% | 观测 | `workload/pod_node_memory_available{namespace="shop"}` |
| 11-02 00:44:22 | api-gateway-0 | heap_inuse / GOMEMLIMIT | 787 MiB → 3.3 GiB / 3.6 GiB | 观测 | `go-runtime/heap_inuse{namespace="shop"}` |
| 11-02 00:44:22 | api-gateway-0 | RSS / limit | 3.8 GiB / 4.0 GiB | 观测 | `workload/container_memory_rss{namespace="shop"}` |
| 11-02 00:44:22 | api-gateway-0 | 容器 CPU（代替 GC CPU） | 容器 CPU 最高 1.1 核（GOMAXPROCS 2 的 55%） | 推断（代替） | `workload/container_cpu_cores{namespace="shop"}` |
| 11-02 00:44:22 | api-gateway-0 | 节点可用内存 | 55.0% | 观测 | `workload/pod_node_memory_available{namespace="shop"}` |
| 11-01 07:23–07:53 | api-gateway-0 | 活跃请求 | 23 → 2（峰值 29） | 观测 | `shop/active_requests{namespace="shop"}` |
| 11-01 07:23–07:53 | api-gateway-0 | 请求体转换字节 | 3.8 MiB/s → 488 KiB/s（峰值 4.6 MiB/s） | 观测 | `shop/body_bytes_rate{namespace="shop"}` |
| 11-01 07:23–07:53 | api-gateway-0 | 归档日志积压 | 50.3 MiB → 198 MiB（峰值 198 MiB） | 观测 | `shop/archive_backlog_bytes{namespace="shop"}` |
| 11-01 07:23–07:53 | api-gateway-0 | 导出推迟 | 0.03/s → 0/s（峰值 0.03/s） | 观测 | `shop/export_deferred_rate{namespace="shop"}` |
| 11-01 23:39–11-02 00:09 | api-gateway-3 | 活跃请求 | 24 → 7（峰值 29） | 观测 | `shop/active_requests{namespace="shop"}` |
| 11-01 23:39–11-02 00:09 | api-gateway-3 | 请求体转换字节 | 3.7 MiB/s → 113 MiB/s（峰值 113 MiB/s） | 观测 | `shop/body_bytes_rate{namespace="shop"}` |
| 11-01 23:39–11-02 00:09 | api-gateway-3 | 归档日志积压 | 52.6 MiB → 1.4 GiB（峰值 1.4 GiB） | 观测 | `shop/archive_backlog_bytes{namespace="shop"}` |
| 11-01 23:39–11-02 00:09 | api-gateway-3 | 导出推迟 | 0/s → 0.045/s（峰值 0.045/s） | 观测 | `shop/export_deferred_rate{namespace="shop"}` |
| 11-02 00:14–00:44 | api-gateway-0 | 活跃请求 | 23 → 6（峰值 29） | 观测 | `shop/active_requests{namespace="shop"}` |
| 11-02 00:14–00:44 | api-gateway-0 | 请求体转换字节 | 3.4 MiB/s → 104 MiB/s（峰值 104 MiB/s） | 观测 | `shop/body_bytes_rate{namespace="shop"}` |
| 11-02 00:14–00:44 | api-gateway-0 | 归档日志积压 | 52.1 MiB → 1.1 GiB（峰值 1.1 GiB） | 观测 | `shop/archive_backlog_bytes{namespace="shop"}` |
| 11-02 00:14–00:44 | api-gateway-0 | 导出推迟 | 0/s → 0.043/s（峰值 0.043/s） | 观测 | `shop/export_deferred_rate{namespace="shop"}` |
| 11-01 07:35–07:44 | api-gateway-0 | upstream_failure_not_retryable | 89 条，status_code 最高 400 | 观测 | `{pod=~".+"} \|= "executor_upstream_failure"` |
| 11-01 23:43–11-02 00:41 | api-gateway-0、api-gateway-3 | request_end | 11 条，duration_ms 最高 11.9 min，request_body_bytes 最高 50.3 MiB | 观测 | `{pod=~".+"} \|= "request_end"` |
| 11-02 00:07–00:43 | api-gateway-0、api-gateway-3 | request_body_budget_tuned | 3 条，live_heap_bytes 最高 2.6 GiB，held_bytes 最高 1006 MiB，memory_budget_bytes 最高 2.6 GiB | 观测 | `{pod=~".+"} \|= "request_body_budget_tuned"` |
| 11-02 00:08–00:43 | api-gateway-0、api-gateway-3 | archive_spool_full | 2 条，log_usage_bytes 最高 2.1 GiB，log_budget_bytes 最高 2.0 GiB | 观测 | `{pod=~".+"} \|= "request_archive_spool_full"` |
| 10-31 12:00–11-02 12:00 | 全部 | 请求体转换字节 与内存高 | 支持度 59.0%，提升 22.7，反例 41.0%，相关 0.87，lead 0.83 / lag 0.75 | 推断（统计） | `shop/body_bytes_rate{namespace="shop"}` |
| 10-31 12:00–11-02 12:00 | 全部 | 归档日志积压 与内存高 | 支持度 67.1%，提升 25.8，反例 32.9%，相关 0.88，lead 0.83 / lag 0.75 | 推断（统计） | `shop/archive_backlog_bytes{namespace="shop"}` |
| 10-31 12:00–11-02 12:00 | 全部 | 导出推迟 与内存高 | 支持度 0.0%，提升 0，反例 100.0%，相关 0.25，lead 0.21 / lag 0.24 | 推断（统计） | `shop/export_deferred_rate{namespace="shop"}` |

主因分组的大请求（只列 request_id、组织前缀与数值；请求体字节最多的是组织 7f3c9a2b…（91%））：

| 时间 (UTC) | Pod | request_id | 组织 | 路径 | 请求体 | 时长 |
|---|---|---|---|---|---|---|
| 11-02 00:28:09 | api-gateway-0 | `01940049-0000-7000-8000-000000000049` | `7f3c9a2b…` | `/v1/responses` | 50.3 MiB | 9.8 min |
| 11-01 23:58:05 | api-gateway-3 | `01940045-0000-7000-8000-000000000045` | `7f3c9a2b…` | `/v1/responses` | 48.9 MiB | 6.7 min |
| 11-02 00:09:01 | api-gateway-3 | `01940099-0000-7000-8000-000000000099` | `7f3c9a2b…` | `/v1/responses` | 45.0 MiB | 5.0 min |
| 11-02 00:06:12 | api-gateway-3 | `01940047-0000-7000-8000-000000000047` | `7f3c9a2b…` | `/v1/responses` | 44.0 MiB | 3.9 min |
| 11-02 00:41:02 | api-gateway-0 | `01940052-0000-7000-8000-000000000052` | `7f3c9a2b…` | `/v1/responses` | 42.0 MiB | 2.7 min |
| 11-01 23:51:40 | api-gateway-3 | `01940044-0000-7000-8000-000000000044` | `7f3c9a2b…` | `/v1/responses` | 40.0 MiB | 8.5 min |
| 11-02 00:33:51 | api-gateway-0 | `01940050-0000-7000-8000-000000000050` | `7f3c9a2b…` | `/v1/responses` | 38.0 MiB | 5.2 min |
| 11-02 00:21:44 | api-gateway-0 | `01940048-0000-7000-8000-000000000048` | `7f3c9a2b…` | `/v1/responses` | 34.0 MiB | 10.9 min |
| 11-01 23:43:10 | api-gateway-3 | `01940043-0000-7000-8000-000000000043` | `7f3c9a2b…` | `/v1/responses` | 33.1 MiB | 11.9 min |
| 11-02 00:38:27 | api-gateway-0 | `01940051-0000-7000-8000-000000000051` | `c0ffee12…` | `/v1beta/models/m:streamGenerateContent` | 20.0 MiB | 3.2 min |

## 2. 机制与代码位置

- **大请求体整体转换与整段拼接**（主因）：大请求体整体解码进堆，归档写入时整段拼接，并发的大请求叠加，超出请求体预算预留的余量（推断，领域包声明的机制）
- **不可重试的拒绝被反复重试**（另一种触发）：不可重试的上游拒绝仍被重试，每次尝试都让同一条归档记录变大，记录一直没有收尾（推断，领域包声明的机制）
- **导出任务的内存看门狗**（排除为主因）：看门狗按进程的堆对象计量，把其他请求的垃圾算进导出任务（推断，领域包声明的机制）

## 3. 排除项与反例

- **导出任务的内存看门狗**：48 小时内它处于高位的 43 个样本中 100.0% 内存不高（反例）；主因分组的发生之前最后 2 分钟它仍在上升，可能是压垮的最后一下（推断）。

## 4. 修复方向与运维侧选项

业务代码：

- [ ] 大请求体流式处理，或每个请求只转换一次
- [ ] 归档写入按长度预分配，单条记录内缓存的结果设上限
- [ ] 不可重试的 400 终止重试
- [ ] 看门狗按任务自身的字节计量

运维侧选项（只列出，不执行，由人决定）：

| 选项 | 作用领域 | 影响范围 | 收益 | 风险 |
|---|---|---|---|---|
| 降低单个请求体的转换上限 | 网关请求准入 | 超过上限的大请求返回 413 | 单个请求的转换内存有上限 | 有业务影响，长上下文请求失败 |
| 提高内存 limit | StatefulSet 资源 | 节点内存分配，request 等于 limit | OOM 的门槛提高 | 要和节点容量一起评估，机制仍在 |
| 导出全部交给独立的导出进程 | 归档导出的位置 | 网关不再执行导出任务 | 网关里没有导出任务的临时分配 | 导出进程的内存与并发要够 |

## 5. 未验证

- api-gateway-0 11-01 07:53:00：没有 GC CPU 指标，用容器 CPU 作为 GC 连续运行的依据
- api-gateway-3 11-02 00:09:14：没有 GC CPU 指标，用容器 CPU 作为 GC 连续运行的依据
- api-gateway-0 11-02 00:44:22：没有 GC CPU 指标，用容器 CPU 作为 GC 连续运行的依据
- 大请求体整体转换与整段拼接的机制来自领域包声明，与指标、日志的关系由统计得出，没有在运行中验证
- 不可重试的拒绝被反复重试的机制来自领域包声明，与指标、日志的关系由统计得出，没有在运行中验证
- 堆里具体是哪些对象需要堆画像。保留的画像（SreNautix 不取出）：
  - api-gateway-0（11-02 06:37:22）：`/var/lib/app/heap-profiles/heap-20261102T063722Z-2883MiB.pb.gz`；取出：`kubectl -n shop cp api-gateway-0:/var/lib/app/heap-profiles/heap-20261102T063722Z-2883MiB.pb.gz ./heap-20261102T063722Z-2883MiB.pb.gz -c gateway`；分析：`go tool pprof -sample_index=inuse_space -top heap-20261102T063722Z-2883MiB.pb.gz`
  - api-gateway-0（11-02 00:43:50）：`/var/lib/app/heap-profiles/heap-20261102T004350Z-3290MiB.pb.gz`；取出：`kubectl -n shop cp api-gateway-0:/var/lib/app/heap-profiles/heap-20261102T004350Z-3290MiB.pb.gz ./heap-20261102T004350Z-3290MiB.pb.gz -c gateway`；分析：`go tool pprof -sample_index=inuse_space -top heap-20261102T004350Z-3290MiB.pb.gz`
  - api-gateway-3（11-02 06:17:24）：`/var/lib/app/heap-profiles/heap-20261102T061724Z-2330MiB.pb.gz`；取出：`kubectl -n shop cp api-gateway-3:/var/lib/app/heap-profiles/heap-20261102T061724Z-2330MiB.pb.gz ./heap-20261102T061724Z-2330MiB.pb.gz -c gateway`；分析：`go tool pprof -sample_index=inuse_space -top heap-20261102T061724Z-2330MiB.pb.gz`

相关：#98 #101 #104 #107 

---
由 SreNautix 技能 oom-rootcause 1.0.0（摘要 `sha256:fixture`，运行 [00000000-0000-4000-8000-000000000001](https://srenautix.example.test/skills/runs/00000000-0000-4000-8000-000000000001)）只读生成；同一根因再次出现时在这里评论。
