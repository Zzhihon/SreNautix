# 0162 处置 act 的确定性依据：研判根因上的修复模板与仓库声明的运行中组件

## 背景

部署方的重建标注集有 17 个分析用例，其中 16 个标注了处置。标注对处置的定义是：act 表示有可以经 Git 或动作目录执行的处置；escalate 表示需要应用代码或人决定；ignore 表示外部上游或已确认不是故障。在 da46bd6 上把两条路由各一次的录制离线重算（复用模型响应，阶段 A 与研判输入按 da46bd6 重建），处置准确率 primary 7/16、fallback 8/16。

32 次有处置标注的运行里错了 17 次，按原因归类：

| 类别 | ADR 0138 中决定结果的规则 | primary | fallback |
|---|---|---|---|
| 研判根因是 GitOps 仓库声明的运行中组件（CNPG Cluster），结论 likely，有规则判定的支持卡，修复是修改仓库中它的配置，但没有对应的修复模板；模型给出 escalate 或 undetermined，标注为 act | escalate 与 undetermined 保持模型的取值；act 只认提议、规则提议与修复模板 | 4 | 3 |
| 研判没有选中根因，或根因停在迁移 Job 上（标注根因是 pg 的受管角色） | act 需要选中的根因与依据 | 2 | 2 |
| 模型调用失败，没有输出 | — | 2 | 0 |
| 模型按动作目录的提议（重建 Pod、滚动重启）或适用的发布回退模板给出 act，标注为 escalate | act 有提议或模板即成立 | 1 | 2 |
| 良性用例的模型带了提议（放宽 HPA 上限），ignore 不带修复 | ignore 要求没有有效提议 | 0 | 1 |

第一类是最大的一类（7/17）。修复模板只覆盖发布回退、HPA 上限与内存 limit，CNPG 的参数、归档并发、受管角色这一类配置修复没有模板；模型对"要改配置但还不知道改哪一项"的事件一律给 escalate，代码保持模型的取值。这类事件的处置路径是明确的：根因组件的期望状态在 GitOps 仓库里，修复就是修改仓库中它的声明，改什么写在修复建议里。

## 决定

### 1. 处置依据增加 `declared`

server 计算的处置依据（`disposition_facts`，ADR 0138）增加 `declared`（契约 2.34.0，`eval-snapshot.schema.json` 的 `DispositionFacts.declared`）：候选根因中由 GitOps 仓库声明的运行中组件。

- 组件展开到具体对象（与修复模板的根因相同，ADR 0126），沿 owned_by 取顶层属主；顶层属主有 managed_by 边指向 GitOps 应用时，这个组件由仓库声明；
- 管理着候选根因的 GitOps 应用本身排除在外：它是变更的载体，应用的应用（app of apps）管理它时也一样。事件根因是应用时，它展开到根因实体（应用管理的一个工作负载），所以组件键本身是应用时同样排除；拓扑里应用的 kind 带 API 组，组件键里可能不带，按同一个对象比较（kind 不区分大小写、忽略 API 组）。逻辑组件（`component:*`）排除在外；
- 旧版 server 与旧快照没有这个字段，按空列表处理。

conclude 的提示词在"集群外部组件"之后列出账本中未被推翻的假设的根因里的仓库声明组件。

### 2. 不论模型给出什么都给 act 的确定性依据

结论阶梯与最低取证集合（ADR 0153）之后，观测失明与 ignore 的依据（ADR 0138）优先；之后以下任一项成立时处置为 act，模型给出的处置不论是什么：

1. **研判根因上有适用的修复模板**：研判根因 likely 及以上，修复模板使用的根因（就是研判根因）上有适用的 `release_rollback` 或 `config_resource` 模板。server 会按模板开出修复 PR（ADR 0126），处置与之一致。
2. **研判根因与发现根因都是仓库声明的运行中组件**：研判根因 likely 及以上并在 `declared` 中，事件的发现根因也在 `declared` 中，并且选中的假设有规则判定的支持卡（结论阶梯的 `support_refs`，常态的卡不算，ADR 0153）。
   - 发现根因是 GitOps 应用或逻辑组件（例如 `component:release`）时，事件由一次变更引起。回退还是向前修复，要由发布回退模板的检查（正在服务的版本、发布输入的历史）或人决定，这一项不成立；
   - 选中的假设只有成员告警支持时，没有证据说明根因的状态异常（例如业务高峰时 HPA 顶到上限而负载没有饱和），这一项不成立。

最低取证集合有缺口时这两项都不成立（ADR 0153）。

模型给出 act 时，原有的依据照常有效：有效提议、规则提议，或修复模板使用的根因（档位低于 likely 时为事件根因）上适用的修复模板；再加上第 2 项。依据都不成立时按严重度改写为 escalate 或 undetermined，说明写进 `validation_notes`。其余情况下 escalate（需要应用代码、外部服务方或人决定）与 undetermined 保持模型的取值。

conclude 提示词对 act 的说明改为上述依据，并要求模型在选中仓库声明的组件时，在 root_fix 修复建议中写明要改的对象、字段与修改方向，或写出确定它们的只读检查。

### 3. act 而没有提议的事件开 issue 跟进

事件 issue（ADR 0095）原来只为处置 escalate 的事件登记。处置为 act、研判没有提议的事件，修复是修改仓库：按修复模板开 PR 时，PR 流程已按 `repo_change` 登记 issue；没有模板时，修复建议里的修改要有人跟进。issue 扫描对已完成、处置为 act、`output.proposals` 为空的研判按 `repo_change` 登记 issue，与 PR 流程的登记是同一行（每个事件一个 issue）。有提议的 act 由提议的审批流程处理，不开 issue。

### 4. 评测

重建评测的快照带 `declared`（`reconstructCase` 与 server 用同一个 `dispositionFacts`）。成绩单、计分口径不变。

## 结果

- 实现：`apps/srenautix/src/research/disposition.ts`（`actBasis`、`ruleSupport` 输入）、`research/controller.ts`、`remediation/facts.ts`（`declared`；`RootCardScope.resolve` 公开）、`research/prompt.ts`（处置依据段）、`prompts/{zh,en}.ts`、`github/issues.ts`（扫描）；契约 2.34.0。
- 测试：单元测试覆盖两项依据各自的条件（档位、发现根因、规则判定的支持卡、最低取证集合、观测失明与 ignore 优先）、模型给出 act 时的第 2 项依据与改写说明、`declared` 的计算（GitOps 应用与逻辑组件不算）、提示词段只列账本中的根因；集成测试检查重建快照的 `declared`（真实 VictoriaMetrics 与 PostgreSQL）、act 没有提议时按 `repo_change` 开 issue、有提议时不开（真实 PostgreSQL，内存中的 GitHub API）。
- 快照模式：重构基线的 20 份录制（ADR 0146 第 5 项）复用模型响应离线重算，逐字段一致 20/20。每份录制有 1 次调用的请求体不同，是 conclude 提示词里 act 的说明；快照没有 `disposition_facts`，两项新依据都不会成立。
- 重建模式离线重算，同一份录制在 da46bd6 与本项改动（基于 da46bd6，含 ADR 0163）上各重算一次（primary 是 #17 基线录制，fallback 是本项在 fca23b2 上的录制）：

| 路由 | 代码 | top-1 | 召回@3 | 处置 | 良性 ignore | 良性 evidence_consistent |
|---|---|---|---|---|---|---|
| primary | da46bd6 | 13/15 | 13/15 | 7/16 | 0/2（2 次模型调用失败） | 0 |
| primary | 本项改动 | 13/15 | 13/15 | 11/16 | 0/2（同上） | 0 |
| fallback | da46bd6 | 13/15 | 13/15 | 8/16 | 1/2 | 0 |
| fallback | 本项改动 | 13/15 | 13/15 | 11/16 | 1/2 | 0 |

  两次重算逐字段比较，处置的不同只有 barman 三个用例（两条路由）与 pg-lock（primary）由 escalate 或 undetermined 改为 act（第 2 项依据，规则判定的支持卡 3–28 张），validation_notes 多一条说明；一条 act 被改写的说明文字变长。其余的不同都与处置无关：primary 的 release-false-rollback 因为 conclude 提示词变长，裁剪多裁掉了 51 张与结论无关的证据卡摘要；两张卡（release-false-rollback 的 card:61、release-rollback-failed 的 card:68）在一次重算里证据基线的样本没有在期限内取完（unknown），另一次取完判为常态，支持卡因此少一张；两张检查卡的表格中取值相同的行顺序不同。

  本项改动合入前 main 前进到 b98558d（研判提示词说明告警角色、变更时间线增加下线与已合并未同步的提交）。同一批录制在 b98558d 上重算，处置与 da46bd6 相同（7/16、8/16）；在 rebase 之后的本提交上重算时，数据源的连接中断：primary 18 份录制完成 14 份，其中 13 份有效；fallback 完成 15 份，其中 11 份有效（其余因为数据源不可达失败）。有效的运行中，处置与 b98558d 相比只有上面的有意改动（primary 的 barman 三个用例与 pg-lock、fallback 的 barman 三个用例改为 act），没有其他处置变化。快照模式在本提交上逐字段一致 20/20，与 b98558d 的重算输出相同。

- 实际调用：本项改动（基于 da46bd6）在同一标注集上两条路由各调用一次（`new-primary-trace`、`new-fallback-trace`，合计 2,177,937 token），并把这两份录制在最终代码上离线重算（下表"重算"一行）。基线是两份录制本身（primary efd024f、fallback fca23b2，录制时的代码）：

| 路由 | 代码 | top-1 | 召回@3 | 选择性准确率 | 处置 | 良性 ignore | 良性 evidence_consistent | 失败 |
|---|---|---|---|---|---|---|---|---|
| primary | 录制（efd024f） | 13/15 | 13/15 | 13/14 | 7/16 | 0/2 | 0 | 1 |
| primary | 实际调用 | 12/15 | 12/15 | 12/13 | 11/16 | 2/2 | 0 | 1 |
| primary | 实际调用的录制在最终代码上重算 | 12/15 | 12/15 | 12/13 | 12/16 | 2/2 | 0 | 1 |
| fallback | 录制（fca23b2） | 13/15 | 13/15 | 13/14 | 8/16 | 1/2 | 0 | 0 |
| fallback | 实际调用 | 13/15 | 13/15 | 13/14 | 11/16 | 1/2 | 0 | 0 |
| fallback | 实际调用的录制在最终代码上重算 | 13/15 | 13/15 | 13/14 | 11/16 | 1/2 | 0 | 0 |

  - primary 少的一条 top-1 是一个外部上游首字延迟用例的 conclude 调用流空闲超过 30 秒（模型服务），录制里这个用例命中；
  - 实际调用时首次启用行级安全的发布用例（primary）的研判根因是 worker Deployment，事件根因是管理它的 GitOps 应用，应用展开到根因实体（control Deployment）后被算作仓库声明的组件，第 2 项依据成立，给出 act（标注 escalate）。组件键本身是应用时排除（第 1 条）之后，重算为 escalate；
  - 仍然错的处置：迁移账号缺少 BYPASSRLS 的两个用例（4 次）；发布迁移与线上流量互锁的用例（2 次，发布回退模板在 gateway 上适用，标注 escalate）；首次启用行级安全的发布用例（fallback，模型带了 `rollout_pause`、`pod_restart` 两条有效提议）；业务高峰 HPA（fallback，模型带了 `hpa_bounds_set` 提议，ignore 不带修复）；外部上游首字延迟用例（primary，模型调用失败）。

## 遗留

- **根因在仓库声明的运行中组件上、修复要改应用代码的事件会是 act**。第 2 项依据不区分"改仓库中的配置"与"改应用的镜像"：例如应用缺陷让 Deployment 反复崩溃、发现根因就是这个 Deployment 时，处置为 act。这类事件按第 3 条开 issue，修复建议写明要改的是应用代码；标注集中没有这类用例。
- **两次 BYPASSRLS**：研判没有选中根因，或根因停在迁移 Job 上，标注的根因（pg 的受管角色）没有出现在假设里，属于发现与研判，不在处置推导里解决。
- **良性 HPA 用例的模型提议**：fallback 在证据全部正常时仍提议放宽 HPA 上限，ignore 不带修复，处置留在 escalate。是否在 ignore 的依据成立时删除模型的提议，需要另行决定。
- **原生 sidecar 的 OOM 没有证据卡**：barman 插件以带 `restartPolicy: Always` 的 init 容器运行，被 OOM 终止记在 `kube_pod_init_container_status_last_terminated_reason`，workload 包的内存与重启卡只读 `kube_pod_container_status_*`，研判看不到 sidecar 的 OOM。
