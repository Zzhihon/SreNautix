# 0118 本地管理员登录的 TOTP 开关

## 背景

本地管理员用口令加 TOTP 登录（DESIGN §13）。有的部署在控制台前面已经有一层访问控制，例如 Cloudflare Access 之类的零信任代理。这时运维希望本地管理员登录不再要求第二个验证码。

另一方面，审批断言（ADR 0020）的 H 档服务签名要携带重新认证凭据，本地管理员的凭据方式是 `local_totp`。如果只凭口令登录的会话也能签发 `local_totp`，H 档审批就失去了第二因子。

## 决定

1. **配置**：server 配置 `identity.local_admin.totp_required`，默认 `true`，与原有行为相同；Helm 值 `identity.localAdmin.totpRequired`。
2. **关闭时的登录**：
   - 本地管理员只凭用户名与口令登录，请求体的 `totp` 可以省略，提交了也不校验。
   - 失败计数与锁定照常。
   - 会话的 `mfa` 为 false，`auth.login` 审计记录里写明 `mfa: false`。
   - Secret 中的 `totp_secret` 照常挂载、加载，不删除。
3. **可见**：
   - server 每次启动打一条警告日志。
   - `GET /v1/auth/providers` 的 `local_admin.totp_required` 为 false；控制台登录页不显示验证码输入框，显示"TOTP 已关闭"，设置页同样显示。
   - 开关的变化写入治理审计链（`identity.local_admin_totp`，记录新值与旧值）。启动时与上一次记录的值比较：没有记录时视为 `true`，所以一直要求 TOTP 的安装不产生这条记录。并发启动的副本只记录一次。
4. **审批断言不变**：
   - 重新认证（`POST /v1/auth/reauth`）不受这个开关影响，总是要求口令加 TOTP。重新认证成功后，会话的 `mfa` 变为 true（只升不降）。
   - 只凭口令登录的本地管理员会话没有 `local_totp` 凭据。审批 H 档提议时返回 `reauth_required`，先重新认证。
   - L 档审批不需要重新认证凭据，照旧。
   - OIDC 会话（`oidc_max_age`）不受影响。
   - ADR 0020 中 `local_totp` 的含义不变：签发它的会话一定在 5 分钟内校验过 TOTP。

## 结果

- 控制台前面有访问控制时，日常进入只需口令。H 档审批仍需第二因子，也就是重新认证时输入 TOTP。
- 关闭状态始终可见（日志、控制台、审计链），不会悄悄生效。
- 关闭后本地管理员的安全性取决于口令与前面的访问控制。不使用这类访问控制的部署应保持默认值。
