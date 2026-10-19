# 容器内存接近 limit

## 现象

- `working set 占 limit` 卡异常：容器内存 working set 的峰值超过 limit 的 90%。
- 常伴随 `OOMKilled` 终止原因和 CrashLoopBackOff。

## 判断

1. 看 `内存不足日志` 卡：应用日志里是否有 `out of memory`、`cannot allocate memory`。
2. 看同一时段的发布：新版本的内存基线是否上升。
3. 看请求量：内存随请求量上升，说明 limit 偏小；请求量平稳而内存持续上升，说明有泄漏。

## 处置

- 单个 Pod 反复 OOM，并且控制器还有至少 2 个就绪副本：批准 `pod_restart` 提议，由控制器重建。
- 新版本导致：回滚发布。
- limit 偏小：在 Git 中调整 limit 后同步。
