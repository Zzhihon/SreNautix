# 身份与权限（server）

server 角色负责控制台的登录、会话、角色授权和聊天账号绑定（DESIGN §9.2、§13）。代码在 `apps/srenautix/src/identity/`。

## 配置

`config.yaml` 中的 `identity` 段：

| 键 | 默认值 | 含义 |
|---|---|---|
| `local_admin.username` | — | 本地管理员用户名 |
| `local_admin.password_hash_file` | — | 口令哈希文件（挂载的 Secret） |
| `local_admin.totp_secret_file` | — | TOTP 密钥文件，内容是 base32 字符串 |
| `oidc.issuer` | — | OIDC 身份提供方地址，server 从 `/.well-known/openid-configuration` 读取端点 |
| `oidc.client_id` | — | 客户端 id |
| `oidc.client_secret_file` | — | 客户端密钥文件 |
| `oidc.scopes` | `openid profile email groups` | 请求的 scope |
| `oidc.groups_claim` | `groups` | ID Token 中组或部门的声明名 |
| `oidc.name_claim` | `preferred_username` | 显示名的声明名 |
| `bindings_dir` | — | 角色绑定目录（从 Git 挂载） |
| `session_idle` | `30m` | 空闲超时 |
| `session_absolute` | `12h` | 累计超时 |
| `lockout_failures` | `5` | 窗口内允许的失败次数 |
| `lockout_window` | `15m` | 失败计数窗口 |
| `lockout_duration` | `15m` | 锁定时长 |

OIDC 的回调地址是 `<public_url>/v1/auth/oidc/callback`，在身份提供方登记这个地址。`public_url` 同时用于校验 Origin。

### 创建本地管理员

口令哈希用镜像自带的命令生成，口令从标准输入读取，至少 12 个字符：

```bash
printf '%s' '<口令>' | node /app/apps/srenautix/dist/main.js admin hash-password
```

输出形如 `scrypt$32768$8$1$<salt>$<hash>`，写入 `password_hash_file` 对应的 Secret。

TOTP 密钥是 20 字节随机数的 base32 编码，例如：

```bash
python3 -c 'import base64, os; print(base64.b32encode(os.urandom(20)).decode())'
```

把它写入 `totp_secret_file` 对应的 Secret，并在验证器应用中添加（SHA1、6 位、30 秒）。也可以用 `otpauth://totp/SreNautix:<用户名>?secret=<密钥>&issuer=SreNautix` 生成二维码。

## 登录方式

| 方式 | 用途 |
|---|---|
| 本地管理员 | 首次引导。必须同时提供口令和 TOTP。第一次 OIDC 登录成功后，本地管理员只作为紧急入口：登录后会话的 `break_glass` 为 true，控制台显示横幅，所有操作都写入治理审计 |
| OIDC | 日常登录。授权码流程，带 PKCE（S256）、`state` 与 `nonce`。一次性状态存在 PG，10 分钟有效，用一次即删除 |

LDAP/AD 以及飞书、钉钉、企业微信 SSO 经 Dex 或 Keycloak 接入，对 server 来说都是 OIDC。

身份提供方跳回回调地址是跨站导航，`SameSite=Strict` 的会话 cookie 不会随这次请求发送，所以回调总是新建一个会话；重新认证时同样新建会话，`auth_time` 取 ID Token 中的值。

### 锁定与 TOTP 重放

- 失败按用户名计数。`lockout_window` 内失败达到 `lockout_failures` 次，锁定 `lockout_duration`；锁定期间即使凭据正确也返回 423。
- TOTP 接受前后各一个时间步。同一个用户名的每个时间步只能使用一次，重放的码按失败处理。
- 判断时间一律用 PG 的 `now()`。

## 会话

- 会话保存在服务端表 `server.sessions`，只存会话 id 的 sha256。cookie 为 `__Host-srenautix_session`，带 `Path=/; Secure; HttpOnly; SameSite=Strict`。
- 空闲超过 `session_idle` 或创建后超过 `session_absolute` 即失效。`GET /v1/auth/session` 返回的 `expires_at` 取两者中较早的时间。
- 改变状态的请求（POST、PUT、PATCH、DELETE）必须同时满足：`Origin` 等于 `public_url` 的 origin；`X-CSRF-Token` 等于会话的 CSRF token（来自 `GET /v1/auth/session` 或登录响应）。任一项不满足返回 403。
- 匿名的登录请求带 `Origin` 时同样要求等于 `public_url`。

### 重新认证（H 档审批）

H 档审批要求 5 分钟内重新认证过：

- 本地管理员：`POST /v1/auth/reauth`，请求体 `{password, totp}`，成功后更新会话的 `auth_time`。与登录共用失败计数和锁定。
- OIDC 用户：浏览器打开 `GET /v1/auth/oidc/start?max_age=0&return_to=<当前页面>`，身份提供方要求重新登录，回调后新会话的 `auth_time` 为本次登录时间。ID Token 的 `auth_time` 早于本次请求时拒绝。

## 接口

契约中的接口见 `contract/openapi.yaml` 的 `auth` 标签：`/v1/auth/providers`、`/v1/auth/login`、`/v1/auth/oidc/start`、`/v1/auth/oidc/callback`、`/v1/auth/session`、`/v1/auth/reauth`、`/v1/auth/logout`、`/v1/auth/link-code`。

控制台“用户与角色”页另外使用以下接口：

| 接口 | 权限 | 返回 |
|---|---|---|
| `GET /v1/role-bindings` | `users.read` | `{revision, bindings: [RoleBinding + file]}` |
| `POST /v1/permissions/explain` | 已登录；解释其他主体时需要 `users.read` | 请求体 `{subject: {id, groups} \| null, permission, target: {cluster, namespace, labels} \| null, tier: "L" \| "H" \| null}`；返回 `{allowed, subject, permission, target, tier, revision, entries}`，`entries` 逐条列出每个绑定的 `subject_match`、`grants_permission`、`scope_match`、`tier_ok` 与原因 |
| `GET /v1/users` | `users.read` | 登录过的用户：主体 id、显示名、身份来源、组、命中的角色绑定、聊天账号绑定、首次与最近登录时间 |
| `GET /v1/chat-links` | 已登录 | 当前用户的聊天账号绑定 |
| `DELETE /v1/chat-links/{channel}/{channel_user_id}` | 本人，或有 `settings.write` | 解除绑定，写入治理审计 |

## 角色绑定

角色绑定从 Git 挂载到 `bindings_dir`，目录下每个 `*.yaml` / `*.yml` 文件：

```yaml
bindings:
  - subject: { kind: group, name: sre }        # kind: user | group
    role: approver
    scope:
      clusters: [prod]                          # "*" 匹配任意集群
      namespaces: [shop, pay]                   # "*" 匹配任意命名空间，也覆盖集群级对象
      component_labels: { team: payments }      # 可省略
    max_risk_tier: L                            # 只对有审批权限的角色有意义
```

- `user` 的 `name` 是主体 id：OIDC 用户为 `oidc:<sub>`，本地管理员为 `local:<用户名>`。本地管理员属于组 `srenautix:local-admin`。Grafana 插件转发的请求以映射到的 OIDC 用户为主体（见下文"Grafana 插件"）。
- `group` 的 `name` 是 ID Token 中 `groups_claim` 的取值。
- 目录中的 `REVISION` 文件（git-sync 等工具写入的提交 SHA）作为版本显示；没有这个文件时，版本是全部文件内容的 sha256。
- 未知字段、未知角色或格式错误都会让 server 启动失败。

一个目标的授权按绑定逐条判断，任意一条同时满足“主体匹配、角色包含该权限、目标在作用域内、风险上限覆盖档位”即允许。集群级对象（没有命名空间）只由 `namespaces` 含 `*` 的绑定覆盖。审批在执行时由 gateway 按目标 UID 所在的命名空间再检查一次。

### 角色与权限

| 权限 | viewer | responder | approver | auditor | admin |
|---|---|---|---|---|---|
| `read` 读取事件、研判、提议 | ✓ | ✓ | ✓ | ✓ | ✓ |
| `feedback` 提交反馈 | | ✓ | ✓ | | ✓ |
| `propose` 人工提议 | | ✓ | ✓ | | ✓ |
| `research.request` 请求重新研判 | | ✓ | ✓ | | ✓ |
| `evidence.rerun` 实时重跑证据卡 | | ✓ | ✓ | | ✓ |
| `approve` / `reject` / `undo` | | | ✓ | | ✓ |
| `audit.read` 读取审计 | | | | ✓ | ✓ |
| `prompt.raw` 查看原始提示词 | | | | ✓ | ✓ |
| `users.read` 查看用户与角色 | | | | ✓ | ✓ |
| `settings.write`、`suppression.write`、`pause.write`、`eval.write`、`api_tokens.write` | | | | | ✓ |

风险上限：`approver` 默认只能审批 L 档，`admin` 默认可以审批 H 档，`max_risk_tier` 可以显式指定。

合规配置把 admin 拆成两个角色，与 auditor 三权分立：

| 角色 | 权限 |
|---|---|
| `sys-admin` | approver 的全部权限，加上 `settings.write`、`suppression.write`、`pause.write`、`eval.write`、`api_tokens.write` |
| `security-admin` | `read`、`users.read`、`audit.read`、`settings.write` |

## 服务调用方

worker、分支的 reader 与 gateway、外部提议方（MCP、API）、Grafana 插件使用 bearer token。`callers.tokens_file` 指向挂载的文件，只保存 token 的 sha256：

```yaml
callers:
  - { id: worker, kind: worker, token_sha256: <64 位十六进制> }
  - { id: spoke-prod-gateway, kind: spoke, role: gateway, cluster_id: prod, token_sha256: … }
  - id: holmes
    kind: external
    channel: api
    actions: [workload_scale, pod_restart]
    namespaces: [shop]
    proposals_per_hour: 30
    token_sha256: …
  - { id: grafana, kind: grafana, token_sha256: … }
```

外部调用方只能提议，不能审批，也不能修改策略。

### Grafana 插件

插件后端用调用方文件中 `kind: grafana` 的 token 转发请求，并在 `X-SreNautix-On-Behalf-Of` 中给出当前 Grafana 用户的邮箱：

1. server 用邮箱（不区分大小写）查找登录过控制台的用户，匹配 OIDC ID Token 的 `email` 声明。用户需要先用 OIDC 登录一次控制台。
2. 恰好匹配一个用户时，以该用户为主体、用最近一次登录时的组按角色绑定授权；没有邮箱、匹配不到或匹配到多个用户时返回 403。
3. 只放行 GET 与提交反馈（`POST /v1/incidents/{ref}/feedback`），其余写操作即使用户的角色允许也返回 403。反馈的 `channel` 记为 `grafana`。

插件自己声明的用户名或组不参与授权。

## 聊天账号绑定

只有绑定过的聊天账号可以在聊天里审批（L 档）和反馈，仅仅是群成员不行。

1. 在控制台登录后调用 `POST /v1/auth/link-code`，得到 8 位绑定码，10 分钟有效。
2. 在聊天里发送 `/link <绑定码>`。绑定码只能使用一次，库里只保存它的 sha256。
3. 同一个聊天账号再次绑定时覆盖原来的绑定。

聊天账号与控制台使用同一个身份源时（例如飞书 SSO 经 Dex 接入，ID Token 带 `union_id`），飞书渠道配置 `auto_link_union_id: true` 后按 `union_id` 自动绑定，不需要绑定码。
