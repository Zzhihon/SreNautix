# Kafka

## broker 与副本

- broker 数减少：看 broker Pod 的重启与所在节点；分区 leader 会转移到其他 broker。
- 副本不同步：某个 broker 写盘慢或网络慢，追不上 leader；`min.insync.replicas` 不满足时生产者写入失败。

## 消费组积压

- 积压持续增长：消费者处理能力不足、消费者 Pod 不可用，或分区分配不均。
- 积压突然出现在单个分区：该分区的消费者卡住（例如一条消息反复处理失败）。
