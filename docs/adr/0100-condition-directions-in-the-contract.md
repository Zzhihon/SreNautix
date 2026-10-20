# 0100 状态条件的方向由契约定义，分支条件只保留当前实例并随心跳过期

## 背景

1. gateway 的心跳条件 True 表示该项正常（ApiserverThrottled、Freeze 例外），server 的状态条条件 true 表示问题正在发生。server 用一张写死的映射换算，其中 ClockSkew 写成了 True 为异常，而 gateway 上报 `ClockSkew=True, reason=within_limit` 表示时钟正常，控制台把正常的时钟显示成了问题。chart 的自身告警（files/conditions.yaml）与 reader 的换算各自又写了一份方向。
2. gateway 的条件以 Pod 名为 subject 写入；换 Pod 或换主之后旧 Pod 的条件行一直留着。reader 的条件只增不删，新的 reader 不再上报的类型也留着。

## 决定

1. **方向表在契约里**：`contract/conditions.json`（schema `schemas/condition-directions.schema.json`，契约 2.10.0）列出每个角色（server、worker、mcp、gateway、reader）的条件来源、正常时的取值 `healthy`，以及按类型的覆盖：`healthy`（方向不同的类型）、`alert: false`（预期的运行模式，例如冻结，状态条照常显示，自身告警不告警）、`strip_type`（gateway 心跳条件在状态条上的类型，null 不转发）。`@srenautix/contract` 生成常量 `CONDITION_DIRECTIONS`。
2. **按表换算**：server 换算 gateway 与 reader 的心跳条件、集群页的准入自检与冻结、reader 的 informer 新鲜度都按这张表；Unknown 与表外的取值算异常。控制台显示的是 server 换算后的 Condition（status true 表示问题），不再自己判断方向。
3. **chart 用同一张表**：`files/conditions.json` 是契约文件的逐字节副本（单元测试与 `deploy/helm/check.sh` 比较），自身告警 `SreNautixConditionActive` 与看板的异常条件由它生成。指标取值为 1 当且仅当条件的 status 为 true 或 True。
4. **只保留当前实例**：每次心跳替换该角色在该集群的全部条件：gateway 的 subject 是上报的 Pod 名（Lease 持有者，只有 leader 发心跳），这次心跳没有列出的条件与其他实例的行一并删除；reader 同样替换。
5. **随心跳过期**：reader 与 gateway 用同一套过期规则（状态条件循环每 15 秒，时限 `topology.reader_offline_after`，默认 60 秒）：心跳超时的集群清除该角色的条件，reader 另留一条 TunnelConnected/ReaderOffline；gateway 离线由集群页的"仅提议"显示。没有任何心跳记录的集群上残留的条件也清除。

## 结果

- 时钟正常的 gateway 不再在状态条上显示 ClockSkew；冻结在状态条上照常显示但不告警。
- 新增条件类型时只改契约的方向表（以及协议的枚举），server、控制台与 chart 一起生效；单元测试要求方向表覆盖 gateway 与 reader 协议里的每个条件类型。
