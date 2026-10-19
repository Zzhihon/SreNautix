# Argo CD

## 应用不健康或未同步

1. `argocd app get <app>` 查看哪些资源不健康、哪些资源有差异。
2. 不健康的资源通常是 Deployment 或 StatefulSet 没有就绪，转到对应工作负载的证据链。
3. 未同步：自动同步被关闭、同步窗口禁止同步，或者同步失败。

## 同步失败

- `ComparisonError`：渲染失败（Helm values 错误、Kustomize 引用缺失、仓库不可达）。
- `SyncError`：apiserver 拒绝了资源（准入策略、配额、不可变字段）。
- 回退：在 Git 中回退提交；`argocd_app_sync` 固定到指定 revision。

## 目标集群断开

检查集群凭证是否过期，以及 Argo CD 到目标 apiserver 的网络。
