# 通知与聊天渠道

server 角色把每个事件的阶段 A 报告与阶段 B 研判推送到聊天渠道（DESIGN §11），并把渠道里的审批、拒绝、撤销、反馈与账号绑定交回 server 处理。代码在 `apps/srenautix/src/notify/` 与 `apps/srenautix/src/channels/`。

## 消息模型

- 一个事件在每个群里只有一条消息，内容变化时就地编辑。
- 阶段 A 判为 ignore、原因是 `planned_retirement`（全部成员告警由计划内的退役解释，没有业务影响告警，ADR 0167）的事件不发新消息；控制台与事件 issue 照常记录，之前已经发出消息的事件照常编辑。
- 消息由 server 生成渠道无关的 `NotifyMessage`（`contract/integrations/notify/v1/notify.schema.json`，`notify/compose.ts`），渠道适配器负责渲染（ADR 0125）：
  1. 头部：配置的前缀（`notify.prefix`，例如影子部署写 `[影子]`）、严重度与加粗的一句话现状（根因组件与症状）、事件状态、稳定标签、首次触发时间；
  2. 横幅一行：例如"模型研判中""状态库降级""模型输出无效"；
  3. 各段依次为现状（问题陈述与时间线）、业务关键信号（见下文）、关键问题（结论档位与四个条件的依据、处置判断）、拓扑联系（从根因到每个受影响组件的路径与边的类型）、解决方案（提议、建议与验证方法）、证据链（按假设分组的证据卡、已执行的检查、排除的信号、无法判定的卡）。
- 数值与时刻只取自确定性数据：事件、阶段 A 报告、研判输出（账本、检查、结论阶梯）、变更与动作目录。模型写的文字只有假设机制、结论摘要、修复建议、无法判定的原因，以斜体显示并标注【模型】，worker 已经删除其中无法核实的数值。
- 块带 `scope`：`summary` 只在聊天里，`full` 只在事件 issue 里。聊天消息是摘要，issue 正文是全文，控制台有全部卡片与序列。
- 每张证据卡带控制台卡片详情的链接（`/incidents/<id>?tab=evidence#card-<n>`）与数据源查询的链接（`links.metrics_explore_url`、`links.logs_explore_url` 模板，带查询与时间窗）；告警带 generatorURL 或 Alertmanager 链接（`links.alertmanager_url`）；变更带变更来源、Argo CD 应用（`links.argocd_url`）或 Git 提交（`links.git_commit_url`）的链接。没有配置时只有控制台链接。模板占位符为 `{query}`、`{query_json}`、`{from}`、`{to}`、`{from_ms}`、`{to_ms}`、`{range}`、`{revision}`。
- 告警、日志、变更里的原文是不可信文本：只作为文字出现，Telegram 中按 HTML 转义，飞书与 issue 中按各自的 Markdown 规则转义；原文不会变成按钮、链接或格式。告警注解原文（summary，没有时为 description）放在注明来源的引用块中：头条症状告警的第一条摘要在聊天消息的现状段里也出现，issue 引用最多 3 条不同的摘要。
- Telegram 用 `parse_mode=HTML`：只使用 `b`、`i`、`code`、`a`、`blockquote`（证据链为可展开的引用块）。文本上限按解析后的 4096 个 UTF-16 code unit 计算，超限时从优先级最低的段（最近操作、证据链、拓扑联系、时间线）的末尾逐块删减，段末写"其余内容见控制台"，整段删完时只留一行省略说明；头部与现状不删减。实体数超过 100 时依次放弃等宽、强调与链接的格式。实体列表序列化后的总大小另有上限（Telegram 实测约 10000 字节，超过时整条消息 400 `ENTITIES_TOO_LONG`），按 9000 字节分配：链接的地址计入大小，按输出顺序分配，放不下的长链接（例如 Grafana Explore 形式的告警来源）只留文字（ADR 0145）。
- 飞书卡片用 markdown 元素写富文本，证据链放在折叠面板里；超过卡片大小上限时按优先级省略整段。

## 业务关键信号

每条事件消息在现状之后、关键问题之前有一段粗体标题的“业务关键信号”（ADR 0148，Telegram、飞书与 issue 同样的结构）。它从阶段 A 的卡与研判的检查卡里挑出和业务服务紧密相关的五类信号：

| 类别 | 内容 |
|---|---|
| 存储 | PVC 与卷容量、IO、对象存储 |
| 内存 | 使用占 limit、OOM |
| CPU | 使用、节流、HPA 饱和 |
| 流量负载 | 请求量、错误率、延迟 |
| 阻塞 | 队列积压、锁等待、Pending 与 Init 卡住、PDB 阻塞驱逐、rollout 停滞 |

- 卡的类别取卡片定义的 `category`（契约 2.27.0；内置的 workload、node、postgres、kubernetes-core 包的主要卡片都写了）；没有时按卡片 id、再按证据链 id 里的词推断（`docs/packs/README.zh-CN.md`），推断不出的卡不进入这一段。
- 只列异常的卡，以及正常但主值不低于阈值 80% 的卡（标“接近阈值”）。同一对象上的同一张卡只列一次，异常的优先。
- 一行一项：类别、对象、卡片标题、数值（等宽）与阈值（等宽）、命中的条件说明（已经写出数值时省略）、异常起点或窗口。类别按上表的顺序，同一类里异常的在前，再按数值相对阈值从高到低。
- 聊天消息每类最多 2 项，其余写一行“其余：内存 1 项、阻塞 8 项，见控制台”；issue 是全文。没有任何一项时整段不出现。段的删减优先级高于其他段（最后删减），实体与长度仍按上面的统一预算。

## 外部上游的周期汇总

根因是集群之外的上游（例如模型服务方 provider、model）时，集群内没有可处置的对象，逐条推送只会刷屏（ADR 0147）。这类事件：

- 不单独推送，也不开 issue（`docs/server/README.md` 的事件 issue 一节）；已经推送过的事件消息照常编辑。
- 每个周期（`period`，默认 1 小时，按 UTC 对齐即整点）结束 1 分钟后，在每个群发一条汇总，静默发送，之后不再编辑：
  1. 标题：`外部上游汇总 10:00–11:00 UTC`；
  2. 本时段有问题的上游数与上一时段的对比（新增、持续、未恢复、已恢复）；
  3. 业务影响：本时段触发过、与其中某个上游事件相关的业务影响告警（`notify.business_impact_alerts`，见下一节）与其他事件异常的影响卡，每项写明相关的上游与依据（例如“在上游 柚子 的事件开始后 21 分钟开始”“拓扑路径 Deployment:shop/checkout → payments”）；没有时写明“无”与所用的告警条件；
  4. 每个上游一行：名称、根因上的关键数值（最多 2 张有值的卡，例如故障率、首字延迟；没有时写告警名）、本时段新触发的成员告警数与上一时段的次数、恢复情况；critical 带“[严重]”，因业务影响已即时推送的写明；
  5. 上一时段有问题、本时段没有告警的上游。
- 每个时段的统计在周期结束后算一次，存进 `server.notify_external_windows`，汇总消息与下一时段的对比用同一份；周期结束超过半个周期（例如进程停了）的时段不再补发。
- 例外：外部上游的事件仍在触发、同时有与它相关的业务影响时照常即时推送，横幅写“上游故障已影响业务：<信号>（<依据>）”（ADR 0150）。业务影响按每个上游事件分别判定：
  - 本事件异常的影响卡（`impact: true`），依据写“本事件的影响卡”；
  - 同一集群里触发中的业务告警，或其他非外部上游的触发中事件里异常的影响卡，满足下面任一条才算：
    - 时间窗：告警（或影响卡所在的事件）在上游事件开始后 `within` 之内开始，依据写“在上游事件开始后 N 分钟开始”。开始早于上游事件的告警不算，例如从前一天起一直触发的 SLO 工单告警；
    - 拓扑：告警的组件（或影响卡所在事件的根因）沿依赖边在 `topology_hops` 跳以内到达上游根因，依据写组件级的路径。展开规则与根因排序的可达性相同：枢纽不展开，访问边（`egress_to`）之后不再展开，命名推断的边不算。上游根因不在拓扑里（只来自告警的 provider）时只按时间窗判定。

外部上游的判定：完成的研判给出的根因（没有时为发现根因）的组件类型声明了 `external: true`（拓扑里没有的实体，例如只来自告警的 provider，按 kind 与名字匹配领域包的组件类型），或者根因在 `components` 中，或者事件的全部成员告警都满足 `alert_labels`。

```yaml
notify:
  digest:
    external_roots:
      enabled: true            # 默认开启；false 时全部事件照常逐条推送
      period: 1h               # 5m 到 24h
      components: [component:provider]   # 另外按外部上游处理的根因（例如按主题聚合的逻辑组件）
      alert_labels: { theme: [provider] } # 全部成员告警都满足时按外部上游处理
      business_impact:                    # 业务影响告警取 notify.business_impact_alerts（下一节）
        impact_cards: true                # 异常的影响卡算业务影响
        within: 30m                       # 在上游事件开始后这么久之内开始的才算相关
        topology_hops: 6                  # 组件沿依赖边这么多跳以内到达上游根因时也算相关；0 时不按拓扑判定
```

chart 的顶层 values `notifyDigest.externalRoots`（键名为驼峰）生成这一节，`roles.server.config.notify.digest` 中同名的键优先。

## 业务影响告警

`notify.business_impact_alerts` 定义哪些告警算业务影响告警（ADR 0166），下面几处都用它：

- 外部上游汇总的业务影响与“上游故障已影响业务”的即时推送（上一节）；
- 处置推导：事件里有触发中的业务影响告警、并且有异常的证据卡时，阶段 A 与阶段 B 都不给 ignore（ADR 0163）；
- 计划内退役判为 ignore 的前提：事件成员中没有业务影响告警，不论状态（ADR 0167）；
- 首条消息时延的 `business_impact` 标签（下文“指标”）。

每项是一个匹配器：`labels` 的每个标签都取列出的值之一，并且 `exclude_labels` 中任何一个标签都不取列出的值；告警满足任一项即为业务影响告警。只看告警的标签，严重度也按 `severity` 标签写在 `labels` 里。不配置时没有业务影响告警。

```yaml
notify:
  business_impact_alerts:
    - labels: { layer: [L0, L1, L2], severity: [critical] }
      exclude_labels: { component: [provider] }   # 外部上游自己的告警不算业务受影响
```

弃用的写法在解析前转换，并在日志里记一条警告，下一个版本不再接受：

| 弃用的写法 | 转换为 |
|---|---|
| `notify.digest.external_roots.business_impact.alert_labels: X`（没有给出 `notify.business_impact_alerts` 时） | `notify.business_impact_alerts: [{labels: X}]`；不再隐含 `severity: critical`，需要时写进 `labels` |
| `notify.digest.external_roots.business_impact.alert_labels` 与 `notify.business_impact_alerts` 都给出 | 旧键不生效 |
| `notify.business_impact_alerts` 中标签条件本身的项，例如 `{severity: [critical]}` | `{labels: {severity: [critical]}}` |

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
- 渠道返回 429（Telegram）或 230020（飞书）时按 `retry_after` 暂停整个渠道；渠道不可达时内容留在库中，恢复后补发；要编辑的消息已被删除（Telegram）或撤回、超过 14 天（飞书 230011、230031）时改为发送新消息；Telegram 的 message is not modified 按已呈现处理；token 或应用凭证无效时进程退出。
- 渠道拒绝内容本身的永久错误（Telegram 的 400，上面几种与群不存在、没有发言权限除外，例如 `ENTITIES_TOO_LONG`、can't parse entities；飞书 230001、230025、230099）：去掉格式与链接，按纯文本重试一次（Telegram 保留键盘；飞书卡片只保留标题与正文文字）；仍被拒绝时放弃这一版内容（`abandoned_at`、`abandoned_reason`），不再重试，不计入投递失败与 `ChannelDeliveryFailed`，记 `srenautix_notify_abandoned_total`；期望内容变化后重新尝试。其他 4xx 记录在 `last_error`，5 分钟后重试。
- 事件恢复或合并后，它的消息最多再编辑 5 次（渠道作出应答的编辑，含被拒绝的），之后的内容放弃（原因 `ended_edit_cap`）；事件重新触发后计数清零。
- 每行记下产出期望内容的渲染器版本（`render_version`）。进程启动后第一次同步之前，旧版本渲染、还没有呈现、没有放弃的期望内容按当前代码重新渲染，恢复后超过保留期的事件也一样（用已结束状态的模板）——同步只渲染还需要消息的事件，不会再换掉它们的旧内容（ADR 0145）。
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
| `srenautix_notify_abandoned_total` | `channel`、`reason`（entities_too_long、message_too_long、parse_error、bad_request、invalid_param、content_too_long、invalid_card、ended_edit_cap） |
| `srenautix_notify_pending` | `channel` |
| `srenautix_notify_callbacks_total` | `channel`、`action`、`outcome` |
| `srenautix_first_message_latency_seconds` | `business_impact`（true、false）、`origin`（new、split）、`clock`（onset、alertmanager） |

首条消息时延（ADR 0159、0165）：每个事件在所有渠道目标上的第一条事件消息送达时记一次，两个口径：

- `clock="onset"`：从事件的计时起点算起（新事件为首个告警触发，即告警源给出的开始时刻，含规则引擎的回溯；拆分出的事件为拆分时刻）。
- `clock="alertmanager"`：从成员告警第一次出现在 Alertmanager 的最早时刻算起（`alert_state.alertmanager_seen_at`，见 [server 说明](README.md)"一次告警的处理"）；拆分出的事件同样从拆分时刻算。送达时成员告警都没有在 Alertmanager 中出现过（集群状态检测器、夜莺、通用 webhook 的告警）的事件不记这个口径。"首条消息不超过 60 秒"按这个口径判定，规则引擎的回溯由 `srenautix_ingest_delay_seconds` 单独度量。

送达时事件已有的成员告警中有一条是业务影响告警（`notify.business_impact_alerts`，上文“业务影响告警”）时 `business_impact="true"`；不配置时都是 `false`。进入外部上游周期汇总的事件没有事件消息，不计入。只看一个口径时查询加上 `clock`，例如 `histogram_quantile(0.95, sum by (le) (rate(srenautix_first_message_latency_seconds_bucket{clock="alertmanager", business_impact="true", origin="new"}[1d])))`。

## 测试

- Bot API 与飞书开放平台的交互用录制夹具（`apps/srenautix/test/fixtures/{telegram,feishu}/`，按官方文档的请求与响应整理）和真实的本地 HTTP 回放服务测试，不访问外网。
- 飞书签名与加密用官方文档的解密向量，以及用 `openssl enc`、`shasum -a 256`、`openssl dgst -hmac` 独立生成的向量（`signature-vectors.json`）。
- 渲染规则来自原 Go 实现的黄金用例，改写成语言无关的 JSON 夹具（`apps/srenautix/test/fixtures/render/`）。
- 报告的黄金用例是一次真实发布事故（发布后回退失败）在本机重建的事件、阶段 A 报告与研判账本，已脱敏（`apps/srenautix/test/fixtures/report/`）；Telegram HTML 与黄金文件逐字比较。每条 Telegram 消息都按 Bot API 的 HTML 规则解析（标签、属性、嵌套、转义），不合法的 HTML 让测试失败，对应 Bot API 的 400 "can't parse entities"。
- 业务关键信号的黄金用例是按 cchp-k8s-ops#249 那一类 gateway OOM 事件重建的卡片组合（70 个成员告警、53 张卡，`test/support/gateway-oom-fixture.ts`），内存一类的第一项是 gateway 94% 与 OOM。外部上游的汇总在真实 PostgreSQL 上测试：一小时内多个 provider 的事件只在整点后发 1 条汇总；业务告警触发后仍在触发的上游事件即时推送；汇总正文按 Bot API 的 HTML 规则严格解析。
- 投递引擎与回调流程在真实 PostgreSQL 上测试：风暴、令牌桶、编辑合并、429 暂停、消息被删除后重发、回调去重与按钮独占、拒绝理由窗口、`/link`、未绑定账号与 H 档提议的拒绝。
