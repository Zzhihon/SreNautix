# 0144 时间点拓扑查询按索引取、子图逐跳取、并发合并与缓存；拓扑历史按保留期压缩

## 背景

真实事件（Zzhihon/SreNautix#13 第 1 项）：CCHP 影子升级到 9c6d0b1 后，srenautix-pg 的 CPU 贴着 1 核的 limit，节流率 83%。10-21 只有 0.03 核，10-22 涨到 0.6–0.9 核，10-23 09:00 起稳定在 0.97–1.0 核。负载来自 server 对 `server.topology_events` 的时间点拓扑查询，几条并发，单条 5–15 秒，最长 28 秒；共享的 observability 节点因此触发 NodeCPURunQueueHigh（每核排队从 0.29 升到 0.70–0.78）。连带后果：

- reader 的 hello 因语句超时在 07:44–07:58 连续失败（#7 复现），拓扑快照拖到 07:58:57Z 才应用；
- 同步后通知循环失败 28 次、事件 issue 循环失败 38 次；
- worker 取研判上下文超时，进程以未处理的 TimeoutError 退出（认领循环的兜底见 552df42）。

### 本地复现

不连集群。integration 测试用的 PostgreSQL 18（本机，不限 CPU），灌入与 CCHP 同等规模的数据：11,019 个节点、33,833 条边，4 天历史，每天约 5 万条事件（Pod 替换约 2 万条、runtime 边的置信度更新 3 万条），共 246,460 行，表加索引 123 MB。查询用 EXPLAIN (ANALYZE, BUFFERS) 分析，代码路径用 server 自己的 `TopologyStore` 计时。

找到三处成本，都随历史总量线性增长，再乘以调用次数：

1. **每条拓扑变更都扫全表**（`applyOne` 找上一条打开的行）。条件写的是 `op LIKE '%_upsert'`，推不出部分索引 `topology_open_idx` 的条件 `op IN ('node_upsert', 'edge_upsert')`，于是：
   - 边：Seq Scan 全表，单条 35 ms；
   - 节点：Bitmap Heap Scan 全部节点行，扫 24,618 行，单条 56 ms。

   500 条变更要 10.0 秒。这些变更与 reader 的游标行锁（`FOR UPDATE`）在同一个事务里：reader 重连后上传快照时，一批几千条差异会让事务持锁几十秒到几分钟。这段时间里 hello 等同一行锁，超过 30 秒的 statement_timeout 就失败，这就是 #7。
2. **时间点查询扫全部历史**（`at(t, version)`）：
   - 条件是 `valid_from <= t AND (valid_to IS NULL OR valid_to > t OR EXISTS(关闭它的事件在版本之后))`，只能按 `seq <= v` 或 `valid_from <= t` 取出几乎全部历史，再逐行过滤：`Rows Removed by Filter: 199,424`；
   - 排序的数据量超过 work_mem，落盘做外部归并（11 MB）；
   - 单条 89–253 ms。
3. **通知与事件 issue 的每一轮，为每个事件各取一次整张拓扑**。`subgraphOf`（根因子图）先 `at(updated_at, topology_version)` 取整张拓扑，再在内存里展开两跳：
   - 通知的 `desired()` 对推送范围内的全部事件、每种语言各做一次；
   - 事件 issue 每 30 秒对每个事件做一次；
   - 70 个事件一轮要 11.0 秒数据库时间（本机不限 CPU）。在 1 核、节流 83% 的 CCHP 上，一轮还没跑完下一轮就开始了，并发的几条整表查询互相拖慢到 5–15 秒。

   研判上下文（`neighborhood`）也是先取整张拓扑。

10-21 → 10-23 的增长与此一致：事件随时间累积，三处成本都随之线性增长；同时事件数也在增长。

## 决定

### 1. 变更只按索引找上一条（`TopologyStore.applyOne`、`openKeys`）

- `op LIKE '%_upsert'` 改为 `op IN ('node_upsert', 'edge_upsert')`，走 `topology_open_idx`。
- 新事件先插入（`RETURNING seq`），再关闭上一条，并把新事件的 seq 记到上一条的 `closed_seq`。

### 2. 时间点查询（`at`）

**closed_seq**：关闭这一行的事件的 seq。"版本 v 时这一行仍然打开"就是 `closed_seq > v`，不再为每一条已关闭的行查找关闭它的事件。

查询分成三个互不重叠的部分，`UNION ALL` 后按 seq 排序：

| 部分 | 条件 | 索引 |
|---|---|---|
| 仍然打开 | `valid_to IS NULL` | `topology_open_idx` |
| t 之后才关闭 | `valid_to > t` | `topology_closed_idx (cluster_id, valid_to, valid_from)` |
| t 之前关闭，但关闭它的事件在版本 v 之后 | `valid_to <= t AND closed_seq > v` | `topology_closed_seq_idx (cluster_id, closed_seq, seq)` |

三部分都另有 `seq <= v AND valid_from <= t`。耗时与时刻 t 存在的行数加上 t 之后关闭的行数成正比，与历史总量无关。

**合并与缓存**：

- 同一个 (集群, 版本, 时刻) 的结果不会再变（之后的事件只会关闭行，`closed_seq > v` 的行照样算打开），所以并发的同键查询合并为一次，结果缓存 30 秒，最多 4 份。缓存只是为了限制内存。
- 时刻不早于最后一条事件（`max(valid_from, valid_to)`）、版本是当前版本时，结果就是当前打开的行，与具体时刻无关，键记为"当前"。事件引擎每 15 秒的 `at(now)` 在没有新事件时直接命中。
- 调用方拿到自己的数组副本。

**并发上限**：每个进程同时在库上执行的时间点查询（`at`、`subgraph`、`neighborhood`）不超过 2 条，其余排队。server 是唯一查询拓扑的角色，chart 默认单副本，所以这也是对库的全局上限；多副本时上限按副本数相乘。

### 3. 子图逐跳取（`subgraph`、`neighborhood`）

根因子图与研判上下文的两跳邻域不再取整张拓扑。每一跳只取与上一跳的键相连的边（`topology_edge_from_idx`、`topology_edge_to_idx`），最后取子图里的节点（新索引 `topology_key_idx`）与两端都在子图里的边。

- 结果与在 `at(t, v)` 的整张拓扑上逐跳展开相同，包括跳数、发现顺序与边的顺序。
- 子图结果同样合并与缓存：10 分钟，最多 512 份。通知与事件 issue 每一轮为同一批事件版本重复取，只有新的事件版本查库。

### 4. 拓扑历史压缩（`compact`，每小时）

- 删除在保留期 `topology.history_retention`（默认 14 天）之前已经关闭的行：被新内容替换的状态、已删除对象的最后状态，以及删除事件本身。按集群、每批 5,000 行删除，不长时间持锁。
- 每个键的事件链是连续的，被删的行在保留期开始时都已不存在。所以保留期内任一时刻、任一版本的拓扑与压缩前相同。仍然打开的行不删。
- 更早的时刻只剩下保留期开始时仍然存在的对象，影响如下：
  - 超过保留期的事件版本，它的子图可能缺少当时存在、之后被删的对象；
  - 重建包（ADR 0110）导出更早的拓扑时同样只剩这些，缺的部分由 kube-state-metrics 历史补上。

  14 天覆盖通知的保留期（默认 6 小时）、事件 issue 的回看与控制台的 14 天告警统计。
- 发布推导（`changes.kubernetes`）比较的是同一个键相邻的两条事件，后一条在同步窗口里，前一条在那个时刻才关闭，在保留期内，不受影响。
- 同一个任务先补齐 `closed_seq`：N-1 版本的二进制在滚动升级期间关闭的行没有记它（部分索引 `topology_unclosed_idx`，平时为空）。

### 5. 迁移（topology 轨道 v4，expand）

- 加列 `closed_seq`，用 `lead(seq) OVER (PARTITION BY cluster_id, item, key ORDER BY seq)` 为已有的历史补齐，然后建四个索引。
- 迁移里 `SET LOCAL statement_timeout = 0`。复现数据（24.6 万行）上整个迁移 5.6–6.5 秒。

### 6. 指标

- `srenautix_topology_query_seconds{query, source}`：时间点查询耗时。query 为 at、subgraph、neighborhood；source 为 db、cache、shared。
- `srenautix_pg_statement_timeouts_total{pool}`：server 与 worker 连接池里因 statement_timeout 被取消的语句数（SQLSTATE 57014 且消息是 statement timeout，用户取消不计）。
- `srenautix_topology_compacted_rows_total`：压缩删除的行数。

## 结果

本地复现数据，本机 PostgreSQL 18，不限 CPU。CCHP 的 srenautix-pg 是 1 核且被节流，绝对值会更大，比例可以参考。

| 场景 | 之前 | 之后 |
|---|---|---|
| 500 条拓扑变更（reader 推送、快照差异） | 10,026–12,598 ms | 164–424 ms |
| 单条变更找上一条（边） | 35 ms（Seq Scan） | 0.075 ms（Index Scan） |
| 通知 / 事件 issue 一轮：70 个事件的根因子图 | 11,027–13,707 ms | 第一轮 1,850–2,038 ms（单个子图 20–46 ms），之后 3 ms（缓存） |
| `at(now)`，没有新事件（事件引擎） | 75–87 ms | 0–1 ms（"当前"缓存） |
| `at(now)`，不走缓存 | 72–77 ms | 77–130 ms（与当时存在的行数成正比，不随历史增长） |
| `at(t, v)`，t 为 1–90 小时前 | 86–259 ms | 67–196 ms |
| `at(t, v)` 24 小时前的 EXPLAIN ANALYZE | 471 ms：Bitmap Heap Scan 取出 19.7 万行、`Rows Removed by Filter: 152,272`，外部归并排序 11 MB | 82 ms：三部分分别走 `topology_closed_idx`、`topology_closed_seq_idx` 与打开的行 |
| 6 条相同的并发 `at(t, v)` | 506–655 ms | 1 ms（合并） |
| 6 条不同的并发 `at(t, v)` | 423–693 ms | 417–543 ms（同时最多 2 条在库上执行） |

两次测量（区间的两端）分别在两份同规模的复现数据上。

正确性：

- 31 组 (时刻, 版本) 上，新旧查询的结果逐项相同，含顺序，子图也相同（复现数据）；
- integration 测试在一段随机历史上对 48 组 (时刻, 版本) 做同样的对照，并覆盖合并、缓存、并发上限、压缩、迁移补齐与超时计数。

不采用的做法：

- **周期快照加增量**：需要再维护一张表，以及快照与增量的一致性。三部分分别走索引之后，单条查询已经与历史总量无关；整张拓扑的主要调用方（子图）改成逐跳取之后不再需要整张拓扑。
- **btree_gist 区间索引**（`tstzrange(valid_from, valid_to) @>`）：需要扩展，CNPG 的库角色不一定有建扩展的权限；三部分的 btree 已经够用。
- **提高 statement_timeout**：只会让排队更长，不减少负载。
