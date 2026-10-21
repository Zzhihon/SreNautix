# 通知与聊天渠道

server 角色把每个事件的阶段 A 报告与阶段 B 研判推送到聊天渠道（DESIGN §11），并把渠道里的审批、拒绝、撤销、反馈与账号绑定交回 server 处理。代码在 `apps/srenautix/src/notify/` 与 `apps/srenautix/src/channels/`。

## 消息模型

- 一个事件在每个群里只有一条消息，内容变化时就地编辑。
- 消息由 server 生成渠道无关的 `NotifyMessage`（`contract/integrations/notify/v1/notify.schema.json`，`notify/compose.ts`），渠道适配器负责渲染（ADR 0125）：
  1. 头部：配置的前缀（`notify.prefix`，例如影子部署写 `[影子]`）、严重度与加粗的一句话现状（根因组件与症状）、事件状态、稳定标签、首次触发时间；
  2. 横幅一行：例如"模型研判中""状态库降级""模型输出无效"；
  3. 五段，依次为现状（问题陈述与时间线）、关键问题（结论档位与四个条件的依据、处置判断）、拓扑联系（从根因到每个受影响组件的路径与边的类型）、解决方案（提议、建议与验证方法）、证据链（按假设分组的证据卡、已执行的检查、排除的信号、无法判定的卡）。
- 数值与时刻只取自确定性数据：事件、阶段 A 报告、研判输出（账本、检查、结论阶梯）、变更与动作目录。模型写的文字只有假设机制、结论摘要、修复建议、无法判定的原因，以斜体显示并标注【模型】，worker 已经删除其中无法核实的数值。
- 块带 `scope`：`summary` 只在聊天里，`full` 只在事件 issue 里。聊天消息是摘要，issue 正文是全文，控制台有全部卡片与序列。
- 每张证据卡带控制台卡片详情的链接（`/incidents/<id>?tab=evidence#card-<n>`）与数据源查询的链接（`links.metrics_explore_url`、`links.logs_explore_url` 模板，带查询与时间窗）；告警带 generatorURL 或 Alertmanager 链接（`links.alertmanager_url`）；变更带变更来源、Argo CD 应用（`links.argocd_url`）或 Git 提交（`links.git_commit_url`）的链接。没有配置时只有控制台链接。模板占位符为 `{query}`、`{query_json}`、`{from}`、`{to}`、`{from_ms}`、`{to_ms}`、`{range}`、`{revision}`。
- 告警、日志、变更里的原文是不可信文本：只作为文字出现，Telegram 中按 HTML 转义，飞书与 issue 中按各自的 Markdown 规则转义；原文不会变成按钮、链接或格式。告警注解原文只在 issue 里，放在注明来源的引用块中。
- Telegram 用 `parse_mode=HTML`：只使用 `b`、`i`、`code`、`a`、`blockquote`（证据链为可展开的引用块）。文本上限按解析后的 4096 个 UTF-16 code unit 计算，超限时从优先级最低的段（最近操作、证据链、拓扑联系、时间线）的末尾逐块删减，段末写"其余内容见控制台"，整段删完时只留一行省略说明；头部与现状不删减。实体数超过 100 时依次放弃等宽、强调与链接的格式。
- 飞书卡片用 markdown 元素写富文本，证据链放在折叠面板里；超过卡片大小上限时按优先级省略整段。

## 发送队列与限流

- 期望状态写在 `server.notify_messages`（每个群 × 每个事件一行）：期望内容与哈希、已呈现的哈希、渠道消息 id、优先级通道、下次尝试时间。这张表就是持久化的发送队列；进程重启后从这里继续。
- 同步循环每 5 秒（事件、提议、反馈变化时立即）重新渲染全部需要消息的事件，只更新内容有变化的行；投递循环每秒把期望与已呈现不同的行发出或编辑。两个循环只在主实例上运行。
- 每个渠道一个令牌桶：

  | 渠道 | 默认速率 | 配置键 |
  |---|---|---|
  | Telegram | 每个群每分钟 20 条 | `notify.telegram.messages_per_minute` |
  | 飞书 | 每个应用每分钟 100 条、每秒 5 条 | `notify.feishu.messages_per_minute`、`messages_per_second` |

- 优先级通道：审批与新的 critical 事件（urgent）→ 风暴摘要（digest）→ 编辑（edit）→ 恢复（recovery）。令牌不足时低优先级的消息推迟。
- 同一条消息两次编辑之间至少间隔 `edit_gap`（Telegram 默认 3 秒，飞书默认 1 秒，飞书单条消息更新上限 5 QPS），间隔内的多次变化只发送最新内容。
- 渠道返回 429（Telegram）或 230020（飞书）时按 `retry_after` 暂停整个渠道；渠道不可达时内容留在库中，恢复后补发；要编辑的消息已被删除（Telegram）或撤回、超过 14 天（飞书 230011、230031）时改为发送新消息；其他 4xx 记录在 `last_error`，5 分钟后重试；token 或应用凭证无效时进程退出。
- 消息第一次成功送达时，server 记下其中提议的 `first_delivered_at`，提议的 TTL 从这一刻开始计算。

## 事件风暴

5 分钟内某个群有 3 个以上新事件要推送时开启一次风暴：另发一条汇总消息，逐行列出事件与待审批的提议；风暴期间新事件的消息静默发送并列入汇总。5 分钟内没有新事件并入则风暴结束；汇总消息在 `notify.resolved_retention`（默认 6 小时）内继续随状态编辑。

## 状态库不可用时

阶段 A 降级通道调用 `NotifyService.sendDirect()`：不经过 PG，直接渲染并发送，消息带"状态库降级"横幅，不带回调按钮；同一事件后续的报告编辑同一条消息（渠道消息 id 保存在内存）。PG 恢复后 `backfill()` 把这些消息写回 `notify_messages`，之后的同步按期望状态继续编辑同一条消息。

## 按钮与账号绑定

| 按钮 | 出现条件 | 处理 |
|---|---|---|
| 批准 | L 档的待审批提议 | 只限已绑定的账号；H 档提议只显示"在控制台审批" |
| 拒绝 | 待审批提议 | 必须填写理由：Telegram 以提及点击者开头、带 ForceReply 的提示，只有点击者 5 分钟内的回复（≤500 字）作为理由；飞书在卡片表单里填写 |
| 撤销 | 已执行、校验中或校验通过、可撤销的提议 | 提交撤销提议并由点击者批准（L 档） |
| 结论对 / 结论错 | 研判已有根因结论 | 结论错时给出真实根因（从本次研判的拓扑组件中选择，Telegram 回复组件名，`-` 表示不知道），null 根因按"只否定结论"记录 |
| 处置对 / 处置错 | 有处置判断 | 处置错时选择正确的处置判断 |
| 恢复确认 | 事件已恢复 | 记为隐式反馈 `resolved_confirm` |
| 在控制台打开 | `public_url` 为 https 时 | URL 按钮 |

- 账号绑定：在控制台取一次性绑定码（`POST /v1/auth/link-code`），在群里或私聊发送 `/link <绑定码>`（飞书在群里 @机器人 发送）。飞书可以开启 `auto_link_union_id`：聊天账号的 union_id 与控制台用户的 union_id 一致时自动绑定。
- 只有绑定过的账号能审批与反馈；群成员身份本身没有任何权限。审批人的作用域按目标所在的命名空间计算（`docs/server/identity.md`）。
- 回调的 `callback_query.id`（Telegram）与 `event_id`（飞书）只处理一次，重复投递只补应答；每个按钮由第一个回调独占，双击不会产生第二次操作。按钮的含义存在 `server.notify_buttons`，Telegram 的 `callback_data` 只有 `b:` 加 16 个字符的短 id；飞书按钮的值带 server 的 HMAC 签名，密钥由应用密钥派生，轮换应用密钥后旧卡片的按钮失效。

## Telegram

配置键在 `notify.telegram`：`bot_token_file`、`chats`（超级群 id 与语言）、`updates`、`webhook_secret_file`。

| `updates` | 行为 |
|---|---|
| `none` | 只发送与编辑，不接收更新（按钮回调与 `/link` 由别的程序处理）。同一个 bot 已经有其他服务在用 `getUpdates` 或 webhook 时必须用这个模式：Bot API 对同一个 bot 只允许一个更新接收方，第二个接收方会让双方都收到 409 |
| `webhook` | 启动时由主实例调用 `setWebhook`，地址为 `<public_url>/v1/channels/telegram/webhook`，`secret_token` 取自 `webhook_secret_file`；每个请求用常量时间比较 `X-Telegram-Bot-Api-Secret-Token`，不一致时拒绝 |
| `polling` | 主实例长轮询 `getUpdates`，处理完一个更新就把 offset 写入 `server.telegram_poll_state`，重启不会重放 |

只处理 `chats` 中的群；订阅的更新类型只有 `message` 与 `callback_query`。群需要是私有超级群，bot 为管理员；审批人不要开启匿名管理员。

## 飞书

1. 在飞书开放平台创建企业自建应用，开启机器人能力，申请"获取与发送单聊、群组消息"（`im:message`）与"以应用的身份发消息"（`im:message:send_as_bot`）权限；需要自动绑定时再申请获取用户 union_id 的权限。
2. "事件与回调"里把卡片回调（`card.action.trigger`）的请求地址设为 `<public_url>/v1/channels/feishu/callback`，配置 Encrypt Key 与 Verification Token；需要 `/link` 时同时订阅"接收消息"事件（`im.message.receive_v1`），请求地址相同。
3. 把机器人加入目标群，群的 `chat_id` 写入 `notify.feishu.chats`。
4. 挂载 `app_secret_file`、`verification_token_file`、`encrypt_key_file`。

回调校验：配置了 Encrypt Key 时，`X-Lark-Signature` 必须等于 `sha256(timestamp + nonce + encrypt_key + 原始请求体)`，载荷用 `sha256(encrypt_key)` 作 AES-256-CBC 密钥解密；未加密的载荷被拒绝。`url_verification` 回应 `challenge`。`header.token` 必须等于 Verification Token；请求时间戳超出 5 分钟的回调被拒绝；同一 `event_id` 只处理一次。卡片回调在 3 秒内以 toast 应答，卡片内容由投递循环随后更新（卡片带 `config.update_multi=true`）。

## 指标

| 指标 | 标签 |
|---|---|
| `srenautix_notify_messages_total` | `channel`、`op`（send、edit） |
| `srenautix_notify_delivery_failures_total` | `channel` |
| `srenautix_notify_pending` | `channel` |
| `srenautix_notify_callbacks_total` | `channel`、`action`、`outcome` |

## 测试

- Bot API 与飞书开放平台的交互用录制夹具（`apps/srenautix/test/fixtures/{telegram,feishu}/`，按官方文档的请求与响应整理）和真实的本地 HTTP 回放服务测试，不访问外网。
- 飞书签名与加密用官方文档的解密向量，以及用 `openssl enc`、`shasum -a 256`、`openssl dgst -hmac` 独立生成的向量（`signature-vectors.json`）。
- 渲染规则来自原 Go 实现的黄金用例，改写成语言无关的 JSON 夹具（`apps/srenautix/test/fixtures/render/`）。
- 报告的黄金用例是一次真实发布事故（发布后回退失败）在本机重建的事件、阶段 A 报告与研判账本，已脱敏（`apps/srenautix/test/fixtures/report/`）；Telegram HTML 与黄金文件逐字比较。每条 Telegram 消息都按 Bot API 的 HTML 规则解析（标签、属性、嵌套、转义），不合法的 HTML 让测试失败，对应 Bot API 的 400 "can't parse entities"。
- 投递引擎与回调流程在真实 PostgreSQL 上测试：风暴、令牌桶、编辑合并、429 暂停、消息被删除后重发、回调去重与按钮独占、拒绝理由窗口、`/link`、未绑定账号与 H 档提议的拒绝。
