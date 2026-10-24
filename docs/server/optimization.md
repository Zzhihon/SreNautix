# 主动优化（server）

目标驱动的主动优化（ADR 0146）在 server 上的部分：目标运行的准入、基线与差距、候选发现、交给 worker 分析、建议的门槛与投递、
合并或部署之后的验证。worker 上的分析见 [docs/worker](../worker/README.md#主动优化的目标任务)。

默认关闭。`optimization.enabled: false` 时只有读取接口可用，写接口返回 503；server 不创建 runner、建议与验证循环，
不连接 dbstats，不读取业务仓库。

## 配置

```yaml
optimization:
  enabled: true
  title_prefix: "[优化]"
  repositories:
    business:                                  # 业务仓库：只读代码，写入只有 issue 与评论（ADR 0146 §6.4）
      repo: CCH-HQ/claude-code-hub-plus
      default_branch: dev
      code:                                    # 契约 CodeLayout（pack.schema.json）
        version: { rule: running, release_input: release_input, field: business_commit }
        root: ""
        include: ["**/*.go", "**/*.ts", "**/*.tsx", "**/*.sql"]
        languages: [go, typescript]
        anchors: [{ kind: sql, paths: ["internal/**", "db/**"] }]
  dbstats:                                     # 一个 CNPG Cluster 主库的只读统计连接（§3.3）
    cluster: Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres   # 这个数据库对应的拓扑组件键
    host: cchp-postgres-rw.cchp-data.svc
    database: cchp
    user: srenautix_stats
    password_file: /etc/srenautix/secrets/dbstats/password
  argo: { namespace: argocd }                  # 验证循环读取 Application（需要 list 权限）；不配置时合并即开始验证窗口
  loop_interval: 60s                           # 目标运行、建议与投递的间隔；验证循环固定 10 分钟
  limits:                                      # 主动分析的后端查询上限（§6.1）
    dbstats: { concurrency: 1, per_hour: 60, statement_text_per_hour: 6 }
    metrics: { concurrency: 2, per_hour: 600 }
    github: { concurrency: 2, per_hour: 1000 }
```

- 业务仓库需要 `github_app`（与 ops 仓库共用同一个安装），并且不能同时是 ops 仓库。
- ops PR 的仓库与布局取 `remediation.repositories`：模板按仓库角色引用（`repository: gitops`），布局文件的角色
  （`postgres_clusters`、`workloads` 等）写在仓库的 `files` 里。
- 没有配置 `dbstats` 时，读 dbstats 的卡能力缺失、无法判定；exporter 的指标信号照常可用。

## 一次目标运行

1. **准入**（每 `loop_interval` 一轮，只在主实例上）：预算 → 风暴 → 范围内的 critical 事件 → 负载保护 → 每个目标每 6 小时最多
   1 次运行。不满足时运行 `deferred`，原因写在运行上（`budget`、`storm`、`incident`、`load_guard`、`rate_limit`）。
   预算取 worker 上报的比例：优化用途用尽，或全部用途达到当日上限的 60% 时推迟；没有 worker 上报过优化用途时按用尽处理。
2. **dbstats 的两次采样**：领域的诊断卡或份额卡读 dbstats 时，先在范围内的组件上执行一遍取得第一次采样，运行推迟约
   5 分钟（`deferred`，原因 `sampling`），之后再算。采样器按运行保存在内存中，server 重启后重新采样。
3. **基线与差距**：按领域的指标在范围内的组件上取按小时的值（只用指标信号的固定查询，区间不超过 14 天、每个查询不超过 50 条
   序列），基线不足时运行 `failed`（`baseline_insufficient`），没有差距时 `concluded`（`no_gap`），都不调用模型。
4. **候选发现**：领域的诊断卡与份额卡在组件上各执行一次，按行得到逻辑实体（语句、表等），按"份额 × 差距"排序，前 3 个进入分析；
   验证期与冷却期内的发现跳过。进入分析的语句类发现按 queryid 经 dbstats `statements.text` 取规范化语句，写进
   `entity.labels.statement`（业务 issue `slow-statement` 的 sql 锚点；取不到时这个模板按 `no_anchor` 跳过）。
5. **交给 worker**：运行的输入（目标、基线、差距、候选、诊断卡与份额卡、领域的查询模板、拓扑、门槛）保存在
   `server.goal_runs.context`，任务进入研判队列（`subject_type: goal`），排在全部事件任务之后，同时最多 1 个，空闲槽位不少于
   2 个时才认领。队列任务结束而运行没有输出时（租约多次过期），运行记为 `failed`（`internal`）。
6. **建议**（worker 交回输出之后）：每个档位达到 `likely` 的发现，按领域的 ops 修复模板与业务 issue 模板计划，依次经过门槛 G1–G6；
   每次运行最多 2 个通过。模板变量 `finding_cards` 总是带着发现自己的诊断卡与份额卡（收益估算读它们的 `observations`），
   模板的 `inputs` 读指标（主动优化的时钟窗口为 32 天）。
7. **投递**：ops PR 只经 gateway 的 `gitops_pr` 提议（规则 `srenautix/optimization-pr`）；业务 issue 只经业务仓库角色的白名单，
   与事件 issue 同一套去重：创建结果未知（连接中断、5xx）时下一次先按正文的标记 `srenautix:recommendation=<id>` 找回，
   不会重复开 issue。

## worker 的任务接口

只有 worker 可以调用（服务 token，`kind: worker`）。

| 方法与路径 | 内容 |
|---|---|
| `POST /v1/research/claim` | 认领结果带 `subject_type`（`incident` 或 `goal`） |
| `GET /v1/research/tasks/{run_id}/goal-context` | 目标运行的输入 |
| `POST /v1/research/tasks/{run_id}/goal-query` | 区分性检查：`{template, args, finding}`。模板只能是这次运行的领域模板，参数按模板的 schema 校验，在发现挂到的组件上执行，经主动分析的信号量、配额与负载保护；没有执行时返回 422 |
| `POST /v1/research/tasks/{run_id}/optimization` | 交回运行输出（按契约 `OptimizationOutput` 校验，结论只能引用进入分析的发现） |
| `POST /v1/research/tasks/{run_id}/optimization-failed` | 没有输出就结束：`{kind, message}`，运行与目标记为 `failed` |
| `POST /v1/research/budget` | 全部用途的比例 `used_ratio`，另有 `purposes.optimization` |

## 验证循环

每 10 分钟一轮，只读取 `recommended` 与 `verifying` 的建议（ADR 0146 §2.6）：

- **ops PR**：gateway 开出的 PR（`server.gitops_pulls`）合并之后，读取 Argo CD 的 Application（`optimization.argo.namespace`），
  找到 `spec.source(s)` 的 `repoURL` 与 `path` 管理被修改文件的应用，等它们 `Synced`、`Healthy`，并且同步的版本包含合并提交
  （GitHub `compare/<合并提交>...<版本>`）；GUC 另外经 dbstats `settings.get` 核对新值已经生效。之后开始验证窗口。
  PR 未合并即关闭为 `rejected`（`unmerged`），提议被拒绝同样。
- **业务 issue**：以 `not planned` 关闭为 `rejected`；以 `completed` 关闭即开始验证窗口。
- **窗口结束**：与基线按"星期 × 小时"匹配的时段比较；改善不低于预期下界的 50% 并超出噪声带为 `improved`，守护指标恶化超过 10%
  为 `regressed`，其余为 `no_effect`。结果写回建议与发现（`fixed`、`no_effect`、`regressed`），在 PR 或 issue 上评论，
  发出 `outcome.verified`。`regressed` 的 ops PR 由 server 提交 revert 的 `gitops_pr` 提议（标题前缀 `[回退]`），补丁是投递时
  补丁的反转，由人审阅合并。
- 建议被拒绝时发现进入领域的冷却期（`gates.cooldown`，默认 30 天）；目标上没有等待或验证中的建议时，有 `improved` 为
  `achieved`，否则 `not_achieved`。

## 后端查询的上限与负载保护

- 每个后端一个信号量与每小时配额（`optimization.limits`），事件研判与主动分析共用信号量，事件研判优先。
- 领域的 `load_guards` 是证据卡，声明保护的后端（例如 dbstats）。每次直接查询这个后端之前执行（结果缓存 1 分钟），
  卡异常或无法执行时查询不发出，结果为 `load_guard`。保护卡在后端对应的实体上执行：dbstats 为 `optimization.dbstats.cluster`。
- dbstats 适配器启动时与每小时检查角色能否读取任何业务表，能读取时集成不可用（`DatasourceOverPrivileged`）。同一个连接（host、port、database、user 相同）上的 SQL 审计表变更源声明的关系不算（`changes.sql_audit`，ADR 0151）。

| 指标 | 含义 |
|---|---|
| `srenautix_optimization_backend_queries_total{backend,outcome}` | 主动分析发往后端的查询（`ok`、`error`、`quota`、`load_guard`） |
| `srenautix_optimization_backend_query_seconds{backend}` | 查询耗时（含等待信号量） |
| `srenautix_optimization_guard_trips_total{guard}` | 负载保护卡异常的次数 |

## GitHub 与 Kubernetes 权限

- 业务仓库角色的白名单见 ADR 0146 §6.4：读代码与目录树，创建 issue、追加评论、只改 issue 的标题与正文，读 issue、评论、
  提交与比较；其余请求（PR、写文件、分支、标签、关闭 issue）在发出之前以 `GitHubDenied` 拒绝。
- ops 仓库角色增加一项只读请求：两个提交 sha 的比较（验证循环用）。
- 验证循环读取 `applications.argoproj.io`（list），chart 需要给 server 的 ServiceAccount 这项权限。

## 与 ADR 0146 的差异

1. **ops 仓库角色的比较请求**：ADR §6.4 的 ops 白名单没有比较，验证循环判断同步版本是否包含合并提交需要它（只读，两边都是提交 sha）。
   server 另需 `applications.argoproj.io` 的 list 权限，chart 还没有渲染这项权限；在加上之前不要配置 `optimization.argo`
   （不配置时 ops PR 合并即开始验证窗口），配置了而读取失败时验证循环按 30 分钟重试。
2. **业务 issue 的验证起点**：ADR §2.6 要求发布输入（`release_input`）的版本对应的业务提交包含修复提交；第一阶段以 issue
   `completed` 关闭作为起点，`release_input` 的 `running` 规则留到第二阶段。
3. **按用途记账**：ADR §5.3 写的是 `worker.daily_usage` 增加 `purpose` 列；实现为新表 `worker.daily_usage_purpose`
   （主键为日期与用途），`daily_usage` 保持全部用途的合计。加列需要改主键，属于收缩迁移；新表只扩展。
4. **dbstats 检查的速率**：区分性检查的 dbstats 模板如果需要速率，而它的请求（例如按 queryid 过滤）在这次运行里没有采样过，
   只有一次采样，结果无法判定（例如 `postgres/statement-detail`）。
5. **模型输出 schema**：`contract/model/optimize-hypothesize.schema.json`、`optimize-conclude.schema.json` 是新增的模型 schema，
   没有提升契约版本（模型 schema 不属于组件间的接口）。

此外：每周的差距更新评论（ADR §4.6）还没有实现。
