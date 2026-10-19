# Flux

## 未就绪

1. `flux get all -A --status-selector ready=false` 列出未就绪的对象。
2. 源对象（GitRepository、HelmRepository、OCIRepository）未就绪：仓库不可达或凭证失效，下游的 Kustomization 与 HelmRelease 会停在旧版本。
3. Kustomization 未就绪：构建失败或健康检查超时；HelmRelease 未就绪：安装或升级失败，查看 `flux logs`。

## 暂停

`flux suspend` 的对象不会调和。动作目录中的 `flux_resume` 可以恢复调和。

## 调和耗时

耗时上升：源仓库变大、依赖链变长，或 apiserver 慢。
