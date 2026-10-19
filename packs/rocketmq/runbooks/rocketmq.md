# RocketMQ

## 消费积压

- 积压持续增长：消费者处理能力不足、消费者实例掉线，或消费失败后反复重试。
- 广播模式与集群模式的积压含义不同，结合 `msgModel` 标签判断。

## broker

- 提交日志磁盘超过 `diskMaxUsedSpaceRatio`（默认 75%）后 broker 开始清理，超过 85% 后拒绝写入。
- 发送线程池排队过久：磁盘写入慢、页缓存竞争（`pagecache_lock_time_mills` 上升）。
