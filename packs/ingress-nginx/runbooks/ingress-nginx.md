# ingress-nginx

## 5xx

- 502/504：后端没有就绪的 Endpoints，或后端处理超时；转到后端工作负载的证据链。
- 503：没有可用的后端（Service 选择器不匹配、全部 Pod 未就绪）。
- 500：后端自身报错。

## 延迟

延迟只在部分 Ingress 上升：后端慢；全部 Ingress 一起上升：控制器 CPU 不足或连接数打满。

## 配置重载失败

`kubectl logs` 查看控制器日志中 `Error reloading NGINX`；常见原因是 snippet 注解语法错误。
