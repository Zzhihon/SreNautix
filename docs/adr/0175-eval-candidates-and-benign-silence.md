# 0175 评测候选与健康场景的度量

## 背景

部署方的评测标注（`eval/labels.ts`，ADR 0110）全部靠人从报告里整理，人工给出的反馈与关闭进不了评测集；控制台"加入评测"按钮调用的 `POST /v1/runs/{run_id}/eval-case` 由 server 转发给 worker，worker 没有实现，返回 404。

评分上，良性标注在重建中没有形成事件时按失败计：每条路由每次运行都记为一次未命中，健康场景里系统保持沉默反而扣分。评测也没有度量系统在健康场景里打扰人的三种方式：推送消息、开 issue、开 PR。

## 决定

### 1. 评测候选

新表 `server.eval_candidates`（`proposals` 轨道版本 4，只增不删）：候选 id、集群、事件与事件版本、研判运行、来源（`feedback`、`pr_closed`、`issue_not_planned`、`console`）、来源引用、原因码与原因、建议的标注类型（`benign`、`incident`、`abstain` 或待定）、控制台填写的用例集、状态（`pending`、`confirmed`、`dropped`）、确认的标准答案、处理人与时间。同一事件同一来源只有一个（唯一约束），之后的同类反馈不再生成。

生成规则（`proposals/candidates.ts`，与反馈同一事务）：

| 来源 | 条件 | 建议类型 |
|---|---|---|
| `feedback` | 原因码是 `false_positive`、`not_actionable`、`known_issue`、`planned_change`、`transient_self_resolved`、`worse_than_baseline`：事件本身不需要处理，健康场景应当沉默 | `benign` |
| `feedback` | 原因码是 `wrong_fix` | 待定 |
| `pr_closed` | 自愈 PR 关闭且没有合并（ADR 0174） | 待定：关闭的 PR 可能是良性告警，也可能是真实事件的错误修复 |
| `issue_not_planned` | 事件 issue 以 not planned 关闭（ADR 0174） | 待定 |
| `console` | 控制台的"加入评测" | 点击者选择的类型 |

其余原因码（`external_upstream`、`duplicate`、`poor_wording`、`other`）与没有原因码的反馈不生成候选。

- **加入评测**：`POST /v1/runs/{run_id}/eval-case` 由 server 实现（`console-bff/routes-eval.ts`），按契约原有的请求与响应：研判取 server 的研判镜像，还没有镜像时取研判队列；生成来源 `console` 的候选，`case_id` 为候选 id，`snapshot_status` 为 `queued`。研判不存在时 404，同一事件已有控制台来源的候选时 409。权限与契约声明的角色相同（`feedback` 权限）：候选还要经管理员确认才进入标注。
- **管理员处理**（`eval.write` 权限，契约的 `listEvalCandidates`、`confirmEvalCandidate`、`dropEvalCandidate`）：确认时选定类型、根因、处置与机制，约束与标注文件相同：`incident` 至少一个根因；`benign` 的根因为空、处置为 `ignore`；`abstain` 的根因为空、处置为 null。只有待确认的候选可以确认或放弃，其余返回 409。三种操作都写入治理审计。控制台评测页对管理员显示候选列表（按状态切换），带确认与放弃。

### 2. 导出与合并

标注文件仍然只由部署者本地维护（含部署方集群的事实）。两个命令把候选接进去：

- `srenautix eval candidates export --state <只读库连接文件> --since <时刻> [--until <时刻>] --out <文件>`：以只读会话读取这段时间内生成、没有放弃的候选。确认的按事件生成完整标注：id 为 `candidate:<候选 id>`，标题为事件标签；窗口从首次触发之前 15 分钟到结束（仍在触发时为最后一次更新）之后 5 分钟；分析时刻为研判开始的时刻，没有研判时为首次触发之后 1 分钟；`fault_alerts` 取仍在事件里的成员告警（告警名加身份标签，去掉告警名与外部标签，去重）；`evidence` 写明来源：关闭的 PR 与 issue 为链接（`pr`、`issue`），其余为 `state` 类的 `<来源>:<引用>`，说明里有候选 id、原因码、确认人与原因。每条按标注 schema 校验。待确认的候选列在 `pending` 一节供查看。文件按集群标出每条标注。
- `srenautix eval label merge --candidates <文件> --labels <文件>`：只合并集群与标注文件相同的标注；id 已存在的不改动（人可能已经修改过）；合并后按标注 schema 校验全文件，不通过时不写入；以 YAML 文档追加，原有的注释与格式保留。再合并一次没有变化。

### 3. 健康场景的沉默

- 良性标注在重建中没有形成事件（`mainIncident` 为 null）时记为沉默：每条路由每次运行一条 `state` 为 `silent` 的记录，没有研判、没有模型调用。沉默算作正确，计入 pass@1 与 pass^k；不计处置，也不计入覆盖率、无法判定、选择性准确率与结构化输出失败（这些度量的是研判本身）。良性标注的处置正确与否只在形成事件时计算。
- 其他类型的标注在重建中没有形成事件时照旧按失败计。

### 4. 三个良性度量

只对 `benign` 用例计算，成绩单每行增加 `false_push`、`false_issue`、`false_pr`（契约 `eval-report.schema.json`），沉默的运行计入分母、不计入分子：

- **误推送**：事件按通知规则会推送新消息。规则与 server 相同（`notify/source.ts` 的 `desired`、`notify/engine.ts` 的过滤）：严重度在推送范围内、没有被抑制、阶段 A 不是计划内退役、不是没有业务影响的外部上游。外部上游的分类按这次运行的研判根因（研判完成时取结论选中的根因，否则取事件根因），用 server 同一个 `ExternalRoots`：业务影响取本事件异常的影响卡、与上游事件相关的业务影响告警、其他触发中事件的影响卡。判定在 `eval/push.ts`：
  - 重建评测：业务影响告警与其他事件取自重建包在分析时刻的状态，组件类型与依赖路径取重建拓扑；其他事件的阶段 A 卡只在主事件被分类为外部上游时才计算；
  - 快照评测（`eval --config`、`eval --compare`）：评测配置有 `reconstruct` 部分时按快照判断，只有快照里的事件、阶段 A 报告与成员告警，没有其他事件与依赖路径；没有这一部分时没有推送判定，这些运行不计入分母。
- **误开 issue**：处置为 `escalate`，或处置为 `act` 而研判没有给出提议。
- **误开 PR**：结论 likely 及以上，经过运行级准入（ADR 0170）之后仍有修复模板适用。标注的标准修复是 `alert_rule` 时，`alert_rule` 类的模板就是正确的修复，不算；其他类别照算。模板匹配只有重建评测给出，其余运行不计入分母。

评测配置的 `reconstruct.notify` 给出推送规则，与 server 的 `notify.severities`、`notify.digest` 同一写法与默认值（`config/server.ts` 的 `notifyRules`）；业务影响告警沿用 `reconstruct.business_impact_alerts`。

### 5. 门禁

`evaluateGate` 增加误推送上限（`eval --compare --max-false-push <0–1>`），默认不设。设了上限时，候选在配对用例上的误推送超过上限门禁失败；没有任何带推送判定的良性运行时报错退出，门禁没有依据。成绩单的 `gate` 增加 `false_push` 与 `false_push_max`。控制台评测页每行增加三列，门禁一栏显示误推送与上限。

## 结果

- 契约 2.40.0：`openapi.yaml` 的 `EvalCandidate`、`EvalCandidateConfirm` 与三个候选接口，`promoteEvalCase` 的说明；`eval-report.schema.json` 的三个度量与门禁的两个字段。
- 实现：`proposals/candidates.ts`、`console-bff/routes-eval.ts`（`routes-system.ts` 不再转发加入评测）、`eval/{score,report,phase2,push,candidates,cli,config,labels}.ts`、`notify/external.ts`（业务影响告警的来源可以注入：server 读取状态库，评测读取重建包或快照）、`config/server.ts`、控制台评测页与候选列表。
- 测试：
  - `test/unit/eval-silence.test.ts`：沉默的评分、三个度量的分子分母、成绩行、门禁的上限（默认、超过、不超过、没有依据）、会不会开 PR、推送判定（严重度、抑制、计划内退役、外部上游与业务影响、按研判根因分类）；
  - `test/unit/eval-candidates.test.ts`：候选生成标注、合并（去重、其他集群、注释保留、校验失败不写入）；
  - `test/unit/feedback-reasons.test.ts`：候选的生成规则与确认的约束；
  - `test/integration/eval-reconstruct.test.ts`：良性标注没有形成事件时三次运行都是沉默、没有模型调用，成绩行的 pass^k 与三个度量；形成事件时按推送范围、外部上游与业务影响告警判断；
  - `test/integration/eval-candidates.test.ts`（真实 PostgreSQL）：候选导出（确认的标注、待确认的列表、放弃的不导出、只读会话）与合并；
  - `test/integration/server-e2e.test.ts`：加入评测、重复 409、不存在的研判 404，管理员的列表、确认（约束校验）与放弃，治理审计；
  - `test/integration/eval-cli.test.ts`：门禁默认不设上限、参数错误。
