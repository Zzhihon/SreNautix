# 0154 告警链接：按标签集打开告警所属的事件

## 背景

Alertmanager 的通知（尤其是邮件）是 SreNautix 之外的兜底渠道。值班人员从一封告警邮件出发，要能直接打开这条告警在 SreNautix 里所属的事件。Alertmanager 不知道 SreNautix 的事件 id；它自己的 `.Fingerprint` 对原始标签集做哈希，包含 `alertgroup` 与 Prometheus 的 external labels，所以和 SreNautix 的告警指纹（`ingest/normalize.ts` 的 `fingerprint`，只算身份标签，ADR 0117）不同。Alertmanager 的模板语言也没有哈希函数，模板里算不出 SreNautix 的指纹。

## 决定

1. **链接格式**：控制台路由 `/alerts?l.<标签名>=<标签值>&…`，每个标签一个参数，可以带 `cluster` 限定集群。Alertmanager 模板直接用 `.Labels.SortedPairs` 生成，不需要运算与哈希。`docs/console/alertmanager-links.tmpl` 提供 `srenautix.alert_url`：标签名与标签值都经 `urlquery` 转义；同一个定义既用于纯文本正文，也用于邮件 HTML 的 `href`（html/template 认出 href 里的 `urlquery`，不重复转义）。链接里保留 `alertgroup` 与 external labels，中心计算身份时去掉它们。

2. **中心接口** `GET /v1/alerts/lookup?l.<标签名>=<标签值>&…[&cluster_id=]`（契约 2.32.0 的 `lookupAlert`）：
   - 直接解析原始查询串：缺少 `l.alertname`、同一个标签出现两次、出现其他参数、`cluster_id` 不合法时返回 400。
   - 对收到的标签执行与接入相同的 `identityLabels()` 与 `fingerprint()`，取 `server.alert_state` 中这个指纹开始时间最晚的一条告警（按 `starts_at`，索引 `alert_state_fp_idx`）。
   - 经 `server.incident_members` 找到它所属的事件：仍是成员的关系优先，没有时取它离开过的、最近更新的事件；再经 `resolveIncidentRef` 沿别名链解析，合并过的事件解析到吸收它的事件。已恢复的事件照常返回。
   - 认证与授权与其他读接口相同（`Auth.reader`），只读。事件按 `incidentTarget`、还没有归入事件的告警按它的组件所在命名空间判断读取范围。

3. **结果**（`AlertLookup.outcome`）：

   | outcome | 含义 |
   |---|---|
   | `incident` | 找到所属事件 |
   | `not_received` | 中心没有收到过这个身份标签集的告警 |
   | `not_grouped` | 收到了告警，事件引擎还没有把它归入事件 |
   | `not_visible` | 告警或事件不在调用方的读取范围内；告警与事件的内容都不返回 |
   | `self_alert` | 带 `ingest.self_label`，接入时丢弃 |
   | `ignored` | Watchdog（`ingest.watchdog_alertname`）、InfoInhibitor、`severity=none`，接入时丢弃 |

   每个结果都带身份标签、不计入身份的标签名与指纹，值班人员能看出链接里的标签与中心收到的有什么不同。告警状态表与事件不会被清理，所以没有"超出保留期"这一类结果。

4. **控制台页面**：`/alerts` 调用 `lookupAlert`，找到时以 replace 方式跳转到 `/incidents/<id>`（后退不回到链接页）；找不到时显示原因、身份标签、不计入身份的标签、指纹与告警 id，并给出事件收件箱的入口。`not_grouped` 每 5 秒重查一次，归入后自动跳转。

5. **查询串按原文保留**：TanStack Router 的默认规则把像 JSON 的值转成数字、布尔与 null，再序列化回地址栏（`1.0` 变成 `1`），标签集与指纹随之改变。控制台的路由改用自己的 `parseSearch`、`stringifySearch`：`l.` 开头的参数按原文保留（重复的也保留，交给中心拒绝），其余参数沿用默认规则。

6. **未登录与 cookie**：会话 cookie 是 `SameSite=Strict`，从邮件点开链接时第一次导航不带 cookie；单页应用加载后发出的同源请求带 cookie，所以页面照常认出会话。没有会话时跳转到登录页，`return_to` 带着完整的链接；本地管理员登录后按 href 导航回去（查询串经同一个 `parseSearch`），OIDC 登录经 server 跳转回去。`return_to` 只接受站内路径，`//` 开头的视为站外。

## 结果

- 任何能渲染 Go 模板的通知渠道（邮件、Slack、Telegram 等）都能给每条告警附上 SreNautix 链接，不需要知道事件 id，也不需要 SreNautix 回写 Alertmanager。
- 事件合并、拆分、恢复之后，旧邮件里的链接仍然打开正确的事件。
- 测试：
  - `apps/srenautix/test/unit/alert-lookup-query.test.ts`：查询串中的 `&`、`/`、`=`、`?`、空格（`+` 与 `%20`）、非 ASCII 与像数字、布尔、null 的值原样读取；链接的指纹与接入的指纹相同；不合法的查询返回 400。
  - `apps/srenautix/test/integration/alert-lookup.test.ts`：真实 Prometheus（带 external label `prometheus`，规则标签带 `alertgroup` 与特殊字符）→ 真实 Alertmanager → webhook 接入 server，同一个接收器用 `alertmanager-links.tmpl` 发邮件到真实 SMTP 服务；纯文本与 HTML 正文的链接相同，经 server 打开告警所属的事件；只读其他命名空间的调用方得到 `not_visible`。另一组在真实 PG 上经接入与事件引擎生成事件，覆盖合并、已恢复、尚未归入、读取范围、集群过滤与接入时丢弃的告警。
  - `web/console/src/search.test.ts`：路由查询串的往返。
  - 控制台 e2e（ADR 0073）：带 `alertgroup` 与 external label 的链接打开种子事件，后退不回到链接；没有收到过的告警显示原因、原文标签值与收件箱入口；接入时丢弃的告警显示原因；关闭 TOTP 的 server 上未登录打开链接，登录后回到链接并打开事件。
