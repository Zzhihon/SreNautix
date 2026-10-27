# 控制台

SreNautix 控制台是 server 角色提供的单页应用（DESIGN §1.1、§12）。代码在三个目录：

| 目录 | 内容 | 许可 |
|---|---|---|
| `packages/ui` | `@srenautix/ui`：设计令牌、文案、原语、领域组件、数据端口与共享视图（收件箱、事件详情、研判运行明细、审批页） | Apache-2.0 |
| `web/console` | 控制台本身：路由、会话、外壳与全部页面 | AGPL-3.0-or-later |
| `plugins/grafana-app` | Grafana 应用插件：嵌入收件箱、事件详情与研判运行明细，可以反馈，审批跳转到控制台 | Apache-2.0 |

设计取舍见 ADR 0070（共享组件与数据端口）、0071（路由、页面状态与实时数据）、0072（Grafana 插件的打包与后端代理）、0073（端到端测试）、0154（告警链接）。

## 页面

| 分组 | 页面 | 路径 | 数据 |
|---|---|---|---|
| 值班 | 事件收件箱 | `/incidents?state&feedback&severity&disposition&suppressed&cluster` | `listIncidents`（含盲区时段与被抑制的计数）、`listConditions` |
| 值班 | 事件详情 | `/incidents/<id 或标签>?tab=evidence|hypotheses|timeline|runs` | 事件、阶段 A、证据快照、时间线、根因子图、研判、反馈（两个维度加原因码，拒绝时原因必选，ADR 0174）、提议 |
| 值班 | 告警链接 | `/alerts?l.<标签名>=<标签值>&…&cluster` | `lookupAlert`：找到后替换为事件详情页，找不到时写明原因并给出收件箱入口（见下文"告警链接"） |
| 值班 | 研判运行明细 | `/runs/<run_id>`；提示词 `/runs/<run_id>/prompts`、原始提示词 `/runs/<run_id>/prompts/raw`（auditor、admin） | `getResearchRun`、`getResearchManifest`、`getRedactedPrompts`、`getRawPrompts` |
| 处置 | 动作队列 | `/actions?tab=pending|running|history` | `listProposals`、`batchApprove`（只限同类型、同集群的 L 档） |
| 处置 | 审批页 | `/actions/<proposal_id>` | `getProposal`（ProposalDetail）、`approveProposal`、`rejectProposal`、`undoProposal`、`reauthLocal` |
| 度量 | 回放与评测 | `/eval?mode=snapshot|reconstructed&report` | 成绩单（含机制命中、证据扎根、安全违规、误推送、误开 issue、误开 PR，每行带环境指纹，另列各指纹的组成，ADR 0180）、门禁（误推送上限、机制命中下限）、版本趋势、成本估算、用例浏览器；管理员另有评测候选列表（`listEvalCandidates`、`confirmEvalCandidate`、`dropEvalCandidate`，ADR 0175） |
| 度量 | Agent 健康与成本 | `/health?cost=day|incident|model` | P0 记分卡、运行指标、成本、出境账本 |
| 系统 | 拓扑 | `/topology?view=coverage|neighborhood|diff` | 覆盖表、未映射告警与覆盖 PR、邻域图、版本差异 |
| 系统 | 集群 | `/clusters`、`/clusters/<id>` | reader 与 gateway 的连接、版本、准入自检、熔断开关、informer 新鲜度、状态条件 |
| 系统 | 集成、领域包、策略与目录、模型与出境 | `/integrations`、`/packs`、`/policies`、`/models` | 只读展示 Git 来源、SHA 与漂移；模拟器与软暂停；硬停止只给操作说明 |
| 治理 | 审计、用户与角色、设置 | `/audit`、`/users`、`/settings` | 两条审计链、角色绑定与权限解释、聊天账号绑定码、渠道、保留期、订阅、API token |

所有页面的过滤条件、标签页与集群都写在 URL 里。头部有集群切换、搜索、语言、主题与用户；头部下方是不可关闭的状态条，集群准入自检失败、gateway 失联或熔断时显示红色的"仅提议"。

## 告警链接

Alertmanager 等外部通知只知道告警的标签。控制台的 `/alerts?l.<标签名>=<标签值>&…` 收到一条告警的全部标签后，由中心按接入时的规则计算身份标签与指纹（去掉 `alertgroup` 与 `ingest.external_labels`，ADR 0117），取这个指纹开始时间最晚的一条告警，经事件成员关系与别名链打开所属的事件：合并过的事件打开吸收它的事件，已恢复的事件照常打开。找不到时页面显示身份标签、指纹与原因：

| 原因 | 说明 |
|---|---|
| 没有收到过这条告警 | 告警没有路由到接入源，或者链接里的标签与告警源发出的不一致 |
| 还没有归入事件 | 已经收到，事件引擎还没有分组；页面每 5 秒重查，归入后自动打开事件 |
| 不在读取范围内 | 告警或事件的命名空间不在用户的角色绑定里 |
| 自身的元告警、不进入事件 | 带 `ingest.self_label` 的告警，以及 Watchdog、InfoInhibitor、`severity=none`，接入时丢弃 |

Alertmanager 的模板见 `docs/console/alertmanager-links.tmpl`：把其中的 `srenautix.console_url` 改成控制台地址，加进 Alertmanager 的 `templates`，在通知正文里对每条告警调用 `srenautix.alert_url`：

```
{{ range .Alerts }}{{ template "srenautix.alert_url" . }}
{{ end }}
```

邮件的 HTML 正文写成 `<a href="{{ template "srenautix.alert_url" . }}">…</a>`。标签名与标签值经 `urlquery` 转义；HTML 正文由 html/template 渲染，它认出 href 里的 `urlquery`，不重复转义。登录会话的 cookie 是 `SameSite=Strict`，从邮件点开链接时第一次导航不带 cookie，单页应用加载后同源请求会带上；没有登录时先进入登录页，登录后回到这个链接。

## 界面约定

- 状态一律是图标加文字，颜色只是辅助；"无法判定"与"能力缺失"用虚线边框。
- 空状态写明原因：没有数据、过滤条件排除、接入中断、没有配置、没有权限分别显示，接入中断时引用对应的状态条件与开始时间。
- 模型生成的内容（研判摘要、假设机制、修复建议、审批理由）标注"模型生成"，审批理由折叠并灰色显示"模型生成，未经验证"。
- 证据卡默认显示研判当时的快照（模型所见）；实时重跑的结果并排显示，标注"非模型所见"。
- 告警、日志、变更的原文只作为文本显示，放在注明来源的引用样式里。
- 事件详情时间线的变更记录在原文之前显示代码计算的关联分级、依据与回退（强关联、中等关联、弱关联，ADR 0169），数据来自 `TimelineEntry.change_link`。
- 终态记录（阶段 A 缺失、研判没有结论、通知、事件 issue、事件状态、自愈 PR）在说明之前显示原因码与级别（正常、留意、异常，ADR 0172），数据来自 `TimelineEntry.code` 与 `level`；级别为留意与异常的记录，泳道标记与种类标签按级别着色。原因码的说明由 server 写在 `text` 里。

## 开发

```bash
pnpm install
pnpm --filter @srenautix/ui test          # 组件测试（真实 Chromium，自动安装到 .scratch/ms-playwright）
pnpm --filter @srenautix/console test     # 文案完整性
pnpm --filter @srenautix/console dev      # 开发服务器，/v1 转发到 SRENAUTIX_HUB_URL（默认 http://127.0.0.1:8080）
pnpm --filter @srenautix/console build    # 产出 web/console/dist，由 server 的控制台入口提供
```

## 端到端测试

```bash
SRENAUTIX_ENVTEST_DIR=<envtest 二进制目录> pnpm --filter @srenautix/console e2e
```

测试启动一次性 PostgreSQL（`SRENAUTIX_PG_BIN`，默认 Homebrew 的 postgresql@18）、envtest 与 server 角色（同时提供接口与 `web/console/dist`），种子全部经真实接口写入，见 ADR 0073。调试时可以先运行 `node --conditions=@srenautix/source --import tsx e2e/run-hub.ts` 保持后端运行，再用 `SRENAUTIX_E2E_REUSE_HUB=1` 运行测试。

## Grafana 插件

构建：`pnpm --filter @srenautix/grafana-app build`，产出 `plugins/grafana-app/dist`（`module.js`、`plugin.json`、linux/amd64 与 linux/arm64 后端，以及当前平台的后端）。要求 Grafana 11.6.11+、12.0.10+、12.1.7+ 或 12.2.5+。配置项见 `plugins/grafana-app/README.md`。

插件 e2e 在真实 Grafana 上运行（`SRENAUTIX_GRAFANA_HOME` 指向解压后的官方发行包，默认 `.scratch/grafana`）：

```bash
SRENAUTIX_ENVTEST_DIR=<envtest 二进制目录> pnpm --filter @srenautix/grafana-app e2e
```

后端额外启动一个 OIDC 身份源：Grafana 管理员的邮箱对应其中一个账号，测试先让该账号在控制台登录一次，server 才会接受插件代表这个邮箱发出的请求。调试时可以运行 `node --conditions=@srenautix/source --import tsx e2e/run-stack.ts` 保持整套环境运行。
