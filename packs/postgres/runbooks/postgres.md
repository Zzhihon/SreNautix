# PostgreSQL

## 主库切换

1. `主库切换` 卡给出切换前后的主库。CNPG 的切换原因看 Cluster 的事件与实例日志（`kubectl cnpg status <cluster>`）。
2. 切换前 10 分钟的饱和度：锁表、连接、内存、WAL 生成；任一越线都可能让健康检查失败而触发故障转移。
3. 切换后应用仍报错：连接池没有重连、LISTEN 连接断开后没有重新订阅。

## 连接与锁

- 连接接近 `max_connections`：按应用拆分的连接表找出占用最多的应用；空闲连接多说明连接池上限过大。
- 长事务：`pg_stat_activity` 中 `xact_start` 最早的会话，确认后 `pg_terminate_backend`。
- 锁等待：`pg_blocking_pids()` 找出阻塞链的根会话。

## WAL 与归档

- 归档失败：对象存储凭证、网络或桶策略；归档恢复前 pg_wal 会持续增长。
- 待归档段堆积：归档进程跟不上 WAL 生成（压缩占满 CPU、对象存储慢）。
- pg_wal 过大还可能来自不活跃的复制槽。

## 备份

- 最近一次备份失败：查看 Backup 对象的状态与错误信息。
- 超过 36 小时没有成功备份：确认 ScheduledBackup 存在且没有暂停。

## 处置

`cnpg_switchover` 属于可补偿动作，需要在控制台审批（H 档）。
