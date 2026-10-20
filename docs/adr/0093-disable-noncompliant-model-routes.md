# 0093 不合规的模型路由在启动时禁用，worker 照常就绪

## 背景

worker 启动时为每条模型路由构造客户端，出站模块（`Egress.client`）对不允许出站的路由抛出 `EgressBlocked`。国内配置（`llm.allow_cross_border: false`）下只要有一条 `in_domain: false` 的路由，整个 worker 就启动失败。install-e2e 就因此失败（`路由 primary 在境外（in_domain=false），当前配置禁止出境`）。

阶段 A 不依赖模型（DESIGN §1、§7）。worker 起不来时，server 的研判任务一直排队到租约超时，控制台看不到原因，只有 Pod 的 CrashLoopBackOff；而路由配置错误本身只影响阶段 B。

## 决定

1. **禁用而不是拒绝启动**：worker 启动时按出站策略划分路由（`partitionRoutes`）。不允许的路由记为禁用，不构造客户端，也不进入模型层，所以不会被选中、探测或调用。每条禁用的路由记一条 error 日志，暴露 `srenautix_llm_route_disabled{route,reason}` 为 1；`srenautix_llm_routes_available` 是可用路由数。worker 照常就绪（`/readyz` 只看迁移与蜜标停止）。
2. **出站检查不放宽**：`Egress.assertRouteAllowed` 不变，`Egress.client` 仍然拒绝构造不合规路由的客户端，出站模块对每个请求仍然再检查一次。评测命令与测试用的 `buildRuntimes` 保持严格，有路由被禁用时直接抛出。
3. **没有可用路由时只出阶段 A**：
   - worker 每分钟向 server 上报路由可用情况（`POST /v1/research/routes`）。在 5 分钟有效期内上报过的 worker 全部没有可用路由时，阶段 B 不入队，队列记为 `skipped`，原因 `no_model_route`；手动触发同样跳过。
   - 上报到达之前已入队的任务由 worker 兜底：认领后不调用模型，记为 `stage_a_only`，`research.failed` 的 `kind` 为 `breaker_open`，消息说明哪些路由被禁用、为什么。
   - 通知横幅写明原因：`只出确定性报告：没有可用的模型路由（全部被出站策略禁用）`，或 worker 兜底时的具体消息。
4. **状态条件**：server 以 role `worker` 发布 `ModelRouteBreakerOpen`，subject 为路由 id，原因 `EgressPolicy`；没有可用路由时原因为 `EgressPolicyNoRoute`，消息中说明阶段 B 不运行。控制台状态条与 `condition.changed` 事件中都能看到。

## 考虑过的方案

- **继续拒绝启动**：配置错误马上暴露，但阶段 B 的配置问题拖垮了 worker 的全部功能，原因只在 Pod 日志里。chart 在渲染时已经检查境外路由与 `allow_cross_border` 是否一致，在安装阶段拦截明显的配置错误。
- **新增条件类型 `ModelRouteDisabled` 与失败类别 `no_model_route`**：语义更准确，但需要契约升级，控制台、事件消费方都要跟着改。被禁用的路由在效果上等于一个一直打开、不会自动恢复的熔断器，复用 `ModelRouteBreakerOpen` 与 `breaker_open` 加上原因字段已经能说明情况，server 也已经把 `breaker_open` 镜像为 `stage_a_only`。如果以后需要按类型区分，再走契约升级。
- **启动后改了配置就自动启用**：路由配置在启动时读取，改配置需要重启 worker，与现有的配置加载方式一致。

## 结果

- worker 在路由配置不合规时也能就绪；只要还有一条可用路由，阶段 B 照常运行，只是少了被禁用的路由。
- 被禁用的路由在任何情况下都不会被调用：`test/unit/llm-session.test.ts` 证明它不进入模型层、构造不出客户端、请求在出站模块里被拦下；`test/integration/worker-route-disabled.test.ts` 在启动探测打开的情况下证明该路由的服务端全程收不到请求。
- 多副本 server 时，路由上报只到达其中一个副本；没有收到上报的副本不跳过阶段 B，由 worker 兜底，结果相同，只是多一次排队。
- 运维需要关注 `srenautix_llm_route_disabled` 与状态条件：被禁用的路由不会让 worker 失败，配置错误可能更晚被发现。
