# 控制台缺口修复与受控问答入口（A1 + B1）

本文件记录 `feat/console-gaps-and-ask` 的边界与后续批次。事实以源码、契约和 live 证据为准。

## 问题

线上 SreNautix 控制台（Cloudflare Access 后的 `srenautix-cchp-k8s.autobits.cc`，live 为 SreNautix `sha-9583103`、Argo revision `3c8b2a0`）三个页面报 404：

- `/eval`：`listEvalReports: 404 not_found: 没有这个接口`，主体空白。
- `/health`：`getAgentHealth`、`getAgentCost`、`getEgressLedger` 三处红框。
- `/models`：`getAgentRoutes` 一处红框。

根因不是页面路由 404，也不是升级没跟上。`apps/srenautix/src/console-bff/routes-system.ts` 的 `forward()` 把 9 条路由原样转发给 worker，worker 只注册 `/v1/events`、`/v1/runs/*`、`/healthz`，其余落到 `apps/srenautix/src/api/http.ts` 的 `没有这个接口`。从 `efd024f` 到 `61a905c` 共 98 个提交，这 9 个 handler 从未实现；知识库条目 `ke-20261025-bff-forwarded-routes-missing-backend-handler` 在 10-25 已定位并同意方案 A，但没有落地。

`/topology` 不是 404：它用的 4 个 `/v1/topology/*` 接口 server 都已实现。无 `?cluster=` 时是设计内的 `topology.need_cluster` 空状态，头部下拉默认「全部集群」不会自动选单集群。

## 本批次范围

### B1：补齐页面数据

- 9 个接口在 worker 侧实现（worker 持有模型密钥与 `worker.*` 数据，server 的 BFF 保持原样转发）。
- 有数据的真出数据：`/v1/agent/health`、`/v1/agent/cost`、`/v1/models/routes`、`/v1/egress/ledger` 从 `worker.llm_calls`、`worker.research_runs`、`worker.daily_usage*`、`worker.route_state` 聚合。
- 确实没有存储的 4 个评测接口返回明确的「未启用」，页面不再显示红色报错。评测用例是文件目录（`apps/srenautix/src/eval/store.ts` 的 `CaseStore`），server 侧只有 `server.eval_candidates` 表，没有 `eval_reports` / `eval_results` / `eval_trend` 表。不造表、不造数据。
- 加「转发路由 ⊆ 后端路由」契约测试，堵住同类缺口。
- 单集群时 `/topology` 自动带 `?cluster=`，集群选择器默认选中唯一集群。

### A1：事件页受控问答（后端 API）

`POST /v1/incidents/{ref}/ask`，权限复用 `research.request`，不新增权限常量。

定位是「对既有研判结果的受控解释」，不是自由聊天：

- 不新调模型、不新开 LLM 调用面、不读 Secret、不给写权限。
- 返回体由阶段 A 报告（`StageAReport`）、最新阶段 B 运行结论、已存在的候选动作组成，带固定 `limited: true`。
- 两者都无时，复用 `scheduler.admit(..., 'manual')` 触发一次既有阶段 B 队列，返回 `202 { run_id, merged, limited: true }`。
- 问题文本按不可信数据处理：只回显与计长度，不拼进 SQL、不拼进提示词、不变成动作参数；审计只记长度。
- 答案里的动作只是候选，不创建提议、不执行。落成动作必须走 `propose_action_v1` / `POST /v1/proposals` 的「只提议不执行」边界，再经 `approve → 断言 → gateway`。

约束来源：`POSITIONING.zh-CN.md:72`（不做「和集群聊天」）、`:51`（外部 Agent 只能提议）、`DESIGN.zh-CN.md:1309`（不提供通用数据源代理）、`DESIGN.zh-CN.md:1183`（MCP 默认关闭）、`roles/worker.ts:33-34`（worker 唯一持有模型密钥）。

## 后续批次（本批次不做）

1. **网页 UI**：`packages/ui/src/views/IncidentView.tsx` 增加一个新 tab 或面板，用 `hub.POST('/v1/incidents/{ref}/ask')` 提交问题并渲染 `stage_a` / `research` / `candidate_actions`。文案加在 `web/console/src/messages/*.json` 与 `packages/ui` 的文案表。写请求要带 CSRF token（现有 `hub` 客户端已处理）。
2. **Telegram `/ask`**：`apps/srenautix/src/channels/telegram/updates.ts` 的 `message()` 目前只认 `/link <码>` 与「对 ForceReply 提示的回复」。新增 `/ask <事件短码> <问题>`，只放行已绑定账号（`ChatLinks`）且在允许的 chat 内，回复内容复用同一个受控问答结果。需要把 `config/server.ts` 的 `updates` 从默认 `none` 切到 `webhook` / `polling`，并核对与现有 bot 的冲突。
3. **标注反哺**：把每次提问与用户是否采纳记成标注样本，接入回放评测，直接补第二阶段 G1/G2 未达标的研判质量。

## 部署边界

本分支只改 SreNautix 源码与契约。上线需要经过：签名发布 → cchp-k8s-ops 的 `platform/srenautix/app/versions.json` 与 `Chart.yaml` 更新 → `srenautix` 这个 Argo Application 同步。任何集群操作前按项目契约写明操作、作用领域、影响范围、收益、风险，并核对业务可用性。本分支不涉及 `cchp-prod` 业务链路。

## 验证

- `pnpm contract:gen` 与 `pnpm contract:check`（契约与 generated 文件一致）。
- 定向 vitest：worker 页面路由、转发覆盖、ask 路由。
- `tsc -p tsconfig.build.json --noEmit`。
- 全量 `pnpm ci` 与 kind-e2e 由 CI 执行；本机磁盘余量低于构建锁要求时不跑全量构建。
