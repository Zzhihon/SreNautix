# Envoy Gateway

## 上游 5xx 与健康端点

- 没有健康端点：后端 Service 没有就绪的 Pod，或 BackendTrafficPolicy 的健康检查判为不健康。
- 5xx 只出现在一条路由：后端自身报错；全部路由同时出现：Envoy 代理自身资源不足。
- `egctl x status httproute -n <命名空间>` 查看路由是否被 Gateway 接受。

## 监听器证书

证书由 Secret 提供；cert-manager 管理时转到 cert-manager 的证据链。
