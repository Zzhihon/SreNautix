# 控制面

## apiserver

- 5xx 比例与 p99 延迟同时上升：先看 etcd 卡。etcd 写盘慢或频繁选举时，apiserver 的写请求会超时。
- 只有个别实例掉线：看该实例所在节点的 node-health 证据链。
- 准入 webhook 超时也会表现为 5xx：查 `apiserver_admission_webhook_rejection_count` 与 webhook 所在工作负载。

## etcd

- fsync p99 超过 0.5 秒：etcd 与其他负载共用磁盘，或磁盘本身降级。看节点的 node-filesystem 证据链中的磁盘 IO。
- 频繁选举：成员之间网络抖动或磁盘慢。
- 数据库接近配额：执行碎片整理（defrag），并检查是否有对象在被大量写入（例如 Event、Lease）。

## 处置

控制面组件不在 SreNautix 的动作目录中，修复由人工完成。
