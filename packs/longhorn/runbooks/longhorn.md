# Longhorn

## 卷 degraded 或 faulted

1. Longhorn UI 或 `kubectl -n longhorn-system get volumes.longhorn.io` 查看副本状态。
2. degraded：某个副本所在节点或磁盘不可用；节点恢复后 Longhorn 自动重建副本，期间磁盘 IO 上升。
3. faulted：全部副本都不可用，卷无法挂载；从最近的快照或备份恢复。

## 存储将满

- 节点存储将满时新副本无法调度。扩容磁盘，或调整 `storage-over-provisioning-percentage` 与 `storage-minimal-available-percentage`。
- 卷实际用量包含快照；清理不再需要的快照。
