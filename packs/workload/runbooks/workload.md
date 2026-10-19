# 工作负载

## 重启与 OOM

- `重启与终止原因` 卡给出最近一次终止原因：`OOMKilled` 看 `内存占 limit 与 OOM` 卡；`Error` 看应用日志；退出码 137 而不是 OOMKilled 通常是存活探针失败后被杀。
- CrashLoopBackOff 时重建 Pod 不会解决问题，先找出启动失败的原因。

## 调度与启动

- 无法调度：看 `节点 requests 占可分配量` 与 `命名空间配额` 卡，以及 Pod 的亲和性、污点容忍和 PVC 绑定。
- ImagePullBackOff：镜像名或标签错误、镜像仓库不可达、拉取凭证过期。
- CreateContainerConfigError：引用的 ConfigMap 或 Secret 不存在。
- init 容器卡住：确认它等待的依赖已经恢复后，批准 `pod_restart` 提议重建 Pod。

## 发布

- Deployment 有副本长期不可用：新版本的就绪探针失败或资源不足；必要时回滚。
- StatefulSet 有副本停在旧版本：`OnDelete` 更新策略需要手动删除 Pod，或者某个序号的 Pod 一直未就绪阻塞了滚动更新。

## 容量

- HPA 顶到上限：调高 `maxReplicas` 前确认节点余量。
- 配额接近上限：扩容和滚动更新都会被拒绝。
