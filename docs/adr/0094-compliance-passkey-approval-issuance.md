# 0094 合规配置 H 档审批的通行密钥签发流程

## 背景

ADR 0020 第 4 条规定了通行密钥证明（`webauthn_ed25519`）的格式与 gateway 的校验规则：`clientDataJSON.challenge` 是 `sha256(JCS(断言))`，签名覆盖 `authenticatorData ‖ sha256(clientDataJSON)`，凭据登记在审批人公钥文件（`approver-keys`）中并属于断言的 `approver_principal`。ADR 0044 第 3 条规定合规配置下 H 档要求通行密钥、server 不签发服务签名。契约有 `POST /v1/auth/webauthn/assertion-options` 与 `approveProposal` 的 `webauthn` 字段，但 server 没有实现，合规配置下 H 档提议无法审批。

## 决定

1. **挑战即断言**：`assertion-options` 在提议当前状态下构造待签名的断言（`issued_at` 为请求时刻，`expires_at` 按 ADR 0044 第 4 条），挑战取 `sha256(JCS(断言))` 的 base64url。断言连同挑战保存在 `server.webauthn_challenges`（PG，多副本共享），5 分钟内有效，同一审批人对同一提议再次请求时旧挑战作废。返回的 options 带 `rpId`、`userVerification: required`、超时 2 分钟，`allowCredentials` 为该审批人登记的凭据。
2. **审批时按 gateway 的规则校验**：`approve` 带 `webauthn`（`PublicKeyCredential` 的 JSON）时，按 `clientDataJSON` 中的挑战取回保存的断言，组成 `webauthn_ed25519` 信封，用与 gateway 相同的 `verifyEnvelope`（来源白名单、rpIdHash、UP 与 UV、凭据属于审批人、签名）和绑定、时效检查校验。通过后挑战标记为已用，信封进入工单队列，治理审计记录凭据 id。失败时挑战不作废，审批人可以重试；签名正确的挑战只能用一次。
3. **其余检查不变**：H 档只能在控制台，输入目标名，5 分钟内重新认证过（DESIGN §13 要求"还必须"使用通行密钥，所以两者都要），提议人不能审批自己的提议，审批人作用域覆盖目标命名空间。
4. **凭据来源**：server 读取与 gateway 相同的审批人公钥文件（`approvals.approver_keys_file`，来自 Git，每 60 秒重新加载）。文件缺失、不合法或没有 `webauthn` 设置时，server 照常启动，H 档审批返回 409 并说明原因，集成页的 `approve.h_tier` 显示不可用。

## 考虑过的方案

- **随机挑战，审批时再构造断言**：不符合 ADR 0020（挑战必须是断言的哈希），gateway 无法把签名和断言对应起来。
- **挑战保存在内存**：多副本时请求 options 与提交审批可能落在不同副本。
- **在控制台登记通行密钥**：契约没有登记接口；审批人公钥由 Git 评审合入，与 gateway 的信任来源一致。登记接口如需提供，另走契约变更。

## 结果

- 合规配置下 H 档可以审批，gateway 能独立校验审批人本人的签名，server 被攻破时无法伪造 H 档断言。
- 凭据限于 Ed25519（COSE -8，ADR 0020）。常见的平台通行密钥（ES256）不能用，需要支持 Ed25519 的安全密钥。
- 断言在 options 请求时就确定了 `issued_at`，审批人需要在挑战有效期内完成签名。
