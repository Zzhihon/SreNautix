# 0044 server 签发审批断言的规则

## 背景

审批断言的格式、规范化与 gateway 的校验顺序见 ADR 0020。本记录说明 server 在什么条件下签发、签发什么。

## 决定

1. **提议**：提交时计算幂等键 `sha256(JCS([incident_id, run_id|rule_id|caller_id, action, params]))`，相同键的未结束提议直接返回。绑定 `{incident_version, root_component, evidence_fingerprint}` 必须等于事件当前版本、根因与当前版本有效的证据指纹（阶段 A 或已完成的研判），否则返回 409。目标由参数与拓扑机器推导，UID 取自拓扑。
2. **等级与档位**：取目录的等级与最低档位；`pod_restart` 的目标不由控制器管理时降为 irreversible；compensable 与爆炸半径没有 L 档上限的动作为 H 档；目标属于 gateway 策略声明的 SreNautix 自身依赖时一律 irreversible 加 H 档。
3. **签发条件**：提议待审批、TTL 与硬上限未过、绑定仍然有效；审批人的角色绑定覆盖目标所在的命名空间且风险上限不低于档位；聊天渠道只限已绑定账号且只限 L 档；H 档只能在控制台，必须输入目标名并在 5 分钟内重新认证过，断言附带重新认证凭据（方式、认证时间、会话 id 的哈希）；合规配置下 H 档要求通行密钥，server 不签发；目标 UID 未知或集群 gateway 处于仅提议状态时不签发。
4. **时效**：断言的 `expires_at` 取断言 TTL（默认 15 分钟）与提议剩余 TTL 中较早的一个；提议 TTL 从第一次送达开始计算（默认 2 小时，硬上限 24 小时）。
5. **自动执行**：规则提议在目录允许自动执行、等级可撤销、不是自身依赖、gateway 策略列出了该规则与命名空间时，由 server 以 `approver_principal=auto:<规则名>`、`channel=auto` 签发；每小时上限由 gateway 执行时核对。
6. 每次签发写入治理审计链，并记一条隐式反馈。签发服务签名的私钥只挂载在 server。

## 结果

- 标准配置下 server 被攻破时攻击者可以签出 L 档断言（DESIGN §9.2 的已知缺口）；H 档还需要 5 分钟内的重新认证凭据，gateway 核对其时间。
- TS 实现对 `contract/gateway/v1/testvectors` 的 48 个信封用例给出与 Go 相同的原因码，L、H 两档服务签名与向量逐字节相同。
