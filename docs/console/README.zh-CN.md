# 控制台

SreNautix 控制台是 server 角色提供的单页应用（DESIGN §1.1、§12）。代码在三个目录：

| 目录 | 内容 | 许可 |
|---|---|---|
| `packages/ui` | `@srenautix/ui`：设计令牌、文案、原语、领域组件、数据端口与共享视图（收件箱、事件详情、研判运行明细、审批页） | Apache-2.0 |
| `web/console` | 控制台本身：路由、会话、外壳与全部页面 | AGPL-3.0-or-later |
| `plugins/grafana-app` | Grafana 应用插件：嵌入收件箱、事件详情与研判运行明细，可以反馈，审批跳转到控制台 | Apache-2.0 |

设计取舍见 ADR 0070（共享组件与数据端口）、0071（路由、页面状态与实时数据）、0072（Grafana 插件的打包与后端代理）、0073（端到端测试）。

## 页面

| 分组 | 页面 | 路径 | 数据 |
|---|---|---|---|
| 值班 | 事件收件箱 | `/incidents?state&feedback&severity&disposition&suppressed&cluster` | `listIncidents`（含盲区时段与被抑制的计数）、`listConditions` |
| 值班 | 事件详情 | `/incidents/<id 或标签>?tab=evidence|hypotheses|timeline|runs` | 事件、阶段 A、证据快照、时间线、根因子图、研判、反馈、提议 |
| 值班 | 研判运行明细 | `/runs/<run_id>`；提示词 `/runs/<run_id>/prompts`、原始提示词 `/runs/<run_id>/prompts/raw`（auditor、admin） | `getResearchRun`、`getResearchManifest`、`getRedactedPrompts`、`getRawPrompts` |
| 处置 | 动作队列 | `/actions?tab=pending|running|history` | `listProposals`、`batchApprove`（只限同类型、同集群的 L 档） |
| 处置 | 审批页 | `/actions/<proposal_id>` | `getProposal`（ProposalDetail）、`approveProposal`、`rejectProposal`、`undoProposal`、`reauthLocal` |
| 度量 | 回放与评测 | `/eval?mode=snapshot|reconstructed&report` | 成绩单、门禁、版本趋势、成本估算、用例浏览器 |
| 度量 | Agent 健康与成本 | `/health?cost=day|incident|model` | P0 记分卡、运行指标、成本、出境账本 |
| 系统 | 拓扑 | `/topology?view=coverage|neighborhood|diff` | 覆盖表、未映射告警与覆盖 PR、邻域图、版本差异 |
| 系统 | 集群 | `/clusters`、`/clusters/<id>` | reader 与 gateway 的连接、版本、准入自检、熔断开关、informer 新鲜度、状态条件 |
| 系统 | 集成、领域包、策略与目录、模型与出境 | `/integrations`、`/packs`、`/policies`、`/models` | 只读展示 Git 来源、SHA 与漂移；模拟器与软暂停；硬停止只给操作说明 |
| 治理 | 审计、用户与角色、设置 | `/audit`、`/users`、`/settings` | 两条审计链、角色绑定与权限解释、聊天账号绑定码、渠道、保留期、订阅、API token |

所有页面的过滤条件、标签页与集群都写在 URL 里。头部有集群切换、搜索、语言、主题与用户；头部下方是不可关闭的状态条，集群准入自检失败、gateway 失联或熔断时显示红色的"仅提议"。

## 界面约定

- 状态一律是图标加文字，颜色只是辅助；"无法判定"与"能力缺失"用虚线边框。
- 空状态写明原因：没有数据、过滤条件排除、接入中断、没有配置、没有权限分别显示，接入中断时引用对应的状态条件与开始时间。
- 模型生成的内容（研判摘要、假设机制、修复建议、审批理由）标注"模型生成"，审批理由折叠并灰色显示"模型生成，未经验证"。
- 证据卡默认显示研判当时的快照（模型所见）；实时重跑的结果并排显示，标注"非模型所见"。
- 告警、日志、变更的原文只作为文本显示，放在注明来源的引用样式里。

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

测试启动一次性 PostgreSQL（`SRENAUTIX_PG_BIN`，默认 Homebrew 的 postgresql@18）、envtest、server 角色与 `vite preview`，种子全部经真实接口写入，见 ADR 0073。调试时可以先运行 `node --conditions=@srenautix/source --import tsx e2e/run-hub.ts` 保持后端运行，再用 `SRENAUTIX_E2E_REUSE_HUB=1` 运行测试。

## Grafana 插件

构建：`pnpm --filter @srenautix/grafana-app build`，产出 `plugins/grafana-app/dist`（`module.js`、`plugin.json`、linux/amd64 与 linux/arm64 后端，以及当前平台的后端）。要求 Grafana 11.6.11+、12.0.10+、12.1.7+ 或 12.2.5+。配置项见 `plugins/grafana-app/README.md`。

插件 e2e 在真实 Grafana 上运行（`SRENAUTIX_GRAFANA_HOME` 指向解压后的官方发行包，默认 `.scratch/grafana`）：

```bash
SRENAUTIX_ENVTEST_DIR=<envtest 二进制目录> pnpm --filter @srenautix/grafana-app e2e
```
