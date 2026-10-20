# 0024 准入自检的频率与探针标记

## 背景

不变量 3 要求 gateway 只在准入策略确实生效时执行动作。自检的做法是为每个启用的准入策略提交一个违规的 `dryRun=All` ActionExecution，要求它被对应的策略拒绝（ADR 0023）。自检在两个地方运行：

- 每次执行之前；
- 每个安全检查周期（15 秒），结果决定 gateway 是否只提议，并通过心跳上报。

每个探针都是一次返回 403 的 apiserver 请求。启用 3 个策略时，每 15 秒 3 次，每 10 分钟约 120 次。这会抬高 apiserver 的 4xx 指标，干扰按 403 计数的"准入拒绝"告警和回滚判断。

gateway 的 RBAC 有意不包含 `admissionregistration.k8s.io`（chart 的 `_rbac.tpl` 禁止这个 API 组），它不能监听策略和 Binding 对象的变化，只能靠探针发现策略失效。

## 决定

1. **周期检查改为可配置**：gateway 配置项 `gateway.admission_self_check_interval`，取值为 Go duration，范围 1s 到 1h，默认 `1m`。
   - 安全检查仍然每 15 秒运行一次，负责熔断开关、时钟偏差、策略重新加载与心跳。
   - 准入自检在两个条件同时满足时才发探针：距上一次自检已满这个间隔，并且上一次自检通过。不满足时沿用上一次的结果。
2. **以下情况立即探测，不受间隔限制**：
   - 启动后的第一次安全检查；
   - 启用的准入策略集合变化，即 Git 中的 gateway 策略启用或停用了用到不同准入策略的动作；
   - 上一次自检失败之后的每个安全检查周期，使策略恢复后 gateway 在一个周期内退出只提议；
   - 每次执行之前。这一项与周期无关：策略被删除或改成 Warn 之后，下一次执行前的自检失败，工单以 `propose_only` 拒绝，gateway 随即转为只提议。

   因此间隔只影响"策略失效但没有工单"期间只提议状态出现的时间，不影响执行是否受准入策略约束。不变量 3 中"60 秒内转为只提议"对应默认间隔；调大间隔时这个时间相应变长，执行仍然逐次受检。
3. **探针可识别**：探针请求可以从 apiserver 指标和审计日志中排除。
   - 指标：探针是 `dryRun=All` 请求，在 `apiserver_request_total` 中带 `dry_run="All"`。准入拒绝类告警应使用 `dry_run=""` 只统计真实写入，例如 `sum by (resource) (rate(apiserver_request_total{code="403",dry_run=""}[5m]))`。
   - 审计日志：探针对象名固定为 32 个 `0`（ActionExecution 的名称必须等于执行 ID，CRD 校验不允许前缀），并带 `srenautix.io/admission-probe=<策略短名>` 标签，请求 URI 含 `dryRun=All`。

## 结果

- 默认配置下，周期探针数降为每分钟一轮，即每个启用的策略每分钟一次，是原来的四分之一。配合 `dry_run=""` 过滤，探针不再出现在准入拒绝告警中。
- 执行路径的保证不变：每次执行前都探测。
- 测试：
  - `test/invariants` 的 `TestInvariant03SelfCheckCadence` 把间隔设为 1 小时，覆盖以下行为：
    - 安全检查周期之间不发探针；
    - 删除 Binding 后，执行前的自检拒绝工单；
    - 恢复 Binding 后，gateway 在几个安全检查周期内恢复；
    - 停用动作后立即重新探测。
  - `TestInvariant03NoSelfCheckNoExecution` 使用 1 秒的间隔，仍然验证 60 秒内转为只提议。
