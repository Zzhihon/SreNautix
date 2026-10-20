# 0062 chart 的渲染期校验与运行时降级的分工

## 背景

chart 在 `templates/validate.yaml` 中用 `fail` 拒绝错误配置，安装前就能看到原因。有一类配置不会让进程起不来，进程自己会降级运行并通过指标说明原因。境外模型路由（`in_domain=false`）是典型的例子：`llm.allow_cross_border` 没有打开时，worker 在启动时禁用这些路由（`srenautix_llm_route_disabled{reason="cross_border"}`，条件 `model_route_disabled`）；一条可用路由都没有时，事件只出阶段 A 的结论，server 发布 `ModelRouteBreakerOpen`（`EgressPolicyNoRoute`）。阶段 A 不依赖模型。

如果在渲染期拒绝这类配置，就等于禁止了一个受支持的运行方式：例如出境审批还没有结论时，先只运行阶段 A。

## 决定

1. **渲染期 `fail` 只用于以下配置**：进程会拒绝启动或反复重启的配置；违反安全不变量的配置（例如 gateway 的审计写入 PG、合规配置放宽治理开关）；chart 自己生成的资源之间互相矛盾的配置（例如策略启用了 `roles.gateway.actions` 中没有的动作）。
2. **运行时会降级、且降级有指标与告警的配置，chart 只给出警告**。警告写在 `NOTES.txt` 中，`helm install`、`helm upgrade` 结束时打印。警告内容包括：受影响的对象、对应的指标，以及降级后的行为。
3. **境外路由按第 2 项处理**。境外路由没有 `allow_cross_border` 时，NOTES 列出将被禁用的路由 id；全部路由都会被禁用时，另外说明只出阶段 A。chart 的默认值仍是不允许出境；安装文档的示例在使用境外路由时显式设置 `allow_cross_border: true`。

## 结果

- 只运行阶段 A 的安装（没有可用模型路由，或出境尚未批准）可以照常完成，worker 处于 Ready 状态。
- GitOps 工具（Argo CD 等）不显示 `NOTES.txt`。这类部署依赖 worker 的 `model_route_disabled`、`no_model_route` 条件，以及 server 的 `ModelRouteBreakerOpen` 事件来发现问题。
- 以后新增的校验按第 1、2 项判断归哪一类；如果进程的降级行为改为拒绝启动，对应的检查要从警告改回 `fail`。
