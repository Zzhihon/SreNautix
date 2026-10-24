# 治理审计链（server）

server 维护治理审计链（DESIGN §16.3），记录登录与失败、角色与策略变更、审批断言、聊天账号绑定、MCP 调用、出境清单等治理事件。每个集群的 gateway 另有一条执行审计链，格式见 `contract/gateway/v1/audit-record.schema.json`。代码在 `apps/srenautix/src/store/audit*.ts`。

## 记录格式

每条记录一行 JSON：

| 字段 | 含义 |
|---|---|
| `chain` | 固定为 `governance` |
| `seq` | 从 1 开始连续递增 |
| `prev_hash` | 上一条记录的 `hash`；第一条为 `sha256:` 加 64 个 0；恢复后新开的链段第一条为锚定哈希 |
| `at` | PG 的 `now()` |
| `kind` | 事件类型，例如 `auth.login`、`auth.login_failed`、`auth.reauth`、`auth.logout`、`chat.link_code`、`chat.unlink` |
| `actor` | 主体 id；匿名的登录失败为 `anonymous` |
| `data` | 事件内容 |
| `canon_version` | `jcs-sha256-v1` |
| `hash` | `sha256:` 加 `sha256(JCS(除 hash 以外的全部字段))` 的十六进制，JCS 即 RFC 8785 |

追加记录与对应的状态变更写在同一个事务里，用事务级 advisory lock 串行化链头，并发写入时 `seq` 连续、链不分叉。

`kind` 的取值：

| `kind` | 内容 |
|---|---|
| `auth.login`、`auth.login_failed`、`auth.reauth`、`auth.logout` | 登录、失败、重新认证与登出 |
| `chat.link_code`、`chat.unlink` | 聊天账号绑定 |
| `approval.issued`、`approval.rejected` | 审批断言的签发与拒绝；通行密钥签名的断言带 `proof: webauthn` 与 `credential_id` |
| `api_token.create`、`api_token.revoke` | 控制台 API token |
| `settings.update`、`pause.set` | 设置与软暂停 |
| `prompt.raw.read` | 读取原始提示词（`data.run_id`） |
| `integration.test` | 集成实例的连接测试（实例、是否通过、失败的能力） |
| `topology.override_pr` | 为未映射告警发起的覆盖规则 PR（规则、分支、PR 地址、提交、关联的事件与 issue） |
| `github.issue_opened`、`github.issue_skipped`、`github.issue_failed` | 事件 issue 的开出（仓库、编号、地址、原因、是否按标记找回）、因限速跳过、重试用尽 |
| `github.issue_comment`、`github.pr_refs` | 事件 issue 上的进展评论（键、地址），给关联的 PR 补 Refs |
| `github.issue_retitled` | 事件 issue 的标题随根因与头条症状更新（仓库、编号、原标题、新标题；ADR 0142） |
| `mcp.call` | MCP 调用方（调用方文件中 `kind: external, channel: mcp` 的 token）的每个请求：`caller_id`、`method`、`route`、`params`、`status`、`idempotency_key`，创建提议时带 `proposal_id`，被拒绝时带 `error`（错误码与原因）。记录在响应发出之前写入，写入失败时请求以 500 结束 |

## 检查点

导出循环每隔 `checkpoint_interval` 为链头签一个检查点：

```json
{"chain":"governance","seq":27,"hash":"sha256:…","at":"…","key_id":"k1","algorithm":"ed25519","canon_version":"jcs-sha256-v1","signature":"<base64>"}
```

签名输入是除 `signature` 以外全部字段的 JCS 序列化。签名密钥是 Ed25519 私钥（PEM），例如：

```bash
openssl genpkey -algorithm ed25519 -out checkpoint.pem
```

写入 `checkpoint_key_file` 对应的 Secret。校验时用它的公钥。

## 存储与导出

记录先写入 PG 表 `server.governance_audit`，再由导出循环写入对象存储：

| 对象 | 内容 |
|---|---|
| `<prefix>records/<起始 seq>-<结束 seq>.jsonl` | 一批连续的记录，每行一条 |
| `<prefix>checkpoints/<seq>.json` | 检查点 |
| `<prefix>segments/<起始 seq>.json` | 链段：`{start_seq, anchor_seq, anchor_hash, reason, created_at}` |

`seq` 在对象名中补零到 12 位，按名称排序即按顺序。

`config.yaml` 的 `audit` 段：

| 键 | 默认值 | 含义 |
|---|---|---|
| `s3.endpoint` | — | S3 兼容的对象存储地址，例如集群内的 MinIO |
| `s3.region` | `us-east-1` | 区域 |
| `s3.bucket` | — | 桶 |
| `s3.prefix` | `governance/` | 对象名前缀 |
| `s3.access_key_file`、`s3.secret_key_file` | — | 访问密钥文件 |
| `s3.force_path_style` | `true` | 路径风格的地址（MinIO 需要） |
| `checkpoint_key_file` | — | 检查点签名私钥 |
| `checkpoint_interval` | `10m` | 检查点间隔 |
| `export_lag_threshold` | `5m` | 导出延迟超过这个值时，状态条显示 `AuditExportLagging` |

### 对象锁定

桶在创建时开启对象锁定（`ObjectLockEnabledForBucket`），并设置默认保留期。合规配置要求 COMPLIANCE 模式、至少 180 天；标准配置可以用 GOVERNANCE 模式。开启对象锁定后桶自动开启版本控制：已写入的版本在保留期内不能删除或覆盖，同名的再次写入产生新版本。`srenautix audit verify` 读取每个对象的当前版本，改写过的内容在哈希或链接上不一致，会被报告出来；原始版本仍保留在对象的版本历史中。

### 没有对象存储

标准配置可以不配置 `audit.s3`，这时记录只保存在 PG 中，指标 `srenautix_audit_export_lag_seconds{chain="governance"}` 为 0，控制台持续提示审计没有导出到 PG 之外。合规配置必须配置对象存储。

## 恢复后的链段

从备份恢复 PG 后（DESIGN §15.3），server 新开一个链段：在 `server.governance_segments` 中写入 `start_seq`（新链段第一条的 seq）、`anchor_seq` 与 `anchor_hash`（审计汇中最后一条记录），之后的第一条记录以 `anchor_hash` 作为 `prev_hash`。校验时链段边界处的连续性以锚定哈希为准。

## 校验

```bash
node /app/apps/srenautix/dist/main.js audit verify --config=/etc/srenautix/config.yaml [--source=s3|pg]
```

默认校验对象存储中的副本；没有配置对象存储时校验 PG。命令检查：

- `seq` 连续；
- 每条记录的哈希正确；
- 每条记录的 `prev_hash` 等于上一条的 `hash`，链段第一条等于锚定哈希；
- 每个检查点的签名有效，并且与对应记录的哈希一致。

结果以 JSON 输出 `{records, checkpoints, segments, head, errors}`，`errors` 不为空时退出码为 2。
