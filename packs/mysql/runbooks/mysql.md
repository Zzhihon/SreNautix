# MySQL

## 不可用与连接

- 实例掉线：看 Pod 的重启与 OOM；InnoDB 恢复时间与 redo 日志大小有关。
- 连接接近 `max_connections`：`SHOW PROCESSLIST` 找出占用最多的客户端；`Sleep` 状态多说明连接池上限过大。

## 复制

- IO 线程停止：主库不可达或复制账号失效；SQL 线程停止：执行出错，`SHOW REPLICA STATUS` 查看 `Last_SQL_Error`。
- 延迟持续增长：副本的写入能力跟不上（单线程复制、大事务）。
- Galera 节点未就绪：节点处于 Donor/Desynced 或与集群失去仲裁。

## 慢查询

结合 `performance_schema.events_statements_summary_by_digest` 找出耗时最高的语句。
