# 0140 停在前置步骤的发布：一次性 Job 自成变更，变更的作用对象进入候选

## 背景

第二阶段评测里，migration-owner-bypassrls-1、-2 两个用例在两条路由上都是 0/6，召回@3 也没有命中。标注的根因是数据库：CCHP v1.0.7 给租户表启用 FORCE ROW LEVEL SECURITY，迁移前检查要求迁移账号是 SUPERUSER 或带 BYPASSRLS，CNPG 管理的角色没有，迁移 Job 在执行任何迁移之前失败，数据库与运行版本都没有变化。`roots` 是 pg Cluster 与管理它的 Argo 应用，`discovery_roots` 另外接受迁移 Job 与 `component:release`。研判的范围是事件的根因、候选与组件，数据库不在里面，模型就没有去查它。

48747db 的发现回放（本地重建包，不连集群）：

| 用例 | 事件 | 主事件根因 | 主事件候选 | 变更 |
|---|---|---|---|---|
| bypassrls-1 | `unlabelled`（ArgoWorkflowsReleaseFailed），`Job:cchp-prod/cchp-migrate-5ec966adda08`（KubeJobFailed，cause） | 空 | 空 | 窗口内没有 cchp-prod 的发布 |
| bypassrls-2 | `component:release`（ArgoWorkflowsReleaseFailed、CCHPReleaseBreakerOpen、CCHPPostDeployAnomaly），迁移 Job（KubeJobFailed，change） | `component:release` | `component:release` | 同上 |

bypassrls-1 的两个事件各有一条故障告警，主事件按"先创建"取到没有根因的那一个。

ADR 0104 §13 已经让迁移 Job 经 `egress_to` 作用在数据库上，在这两个用例里没有生效，原因有三层：

1. **没有发布可挂**：§13 把发布开始之前的 Job 挂到之后的发布上。迁移前检查失败，发布没有走到工作负载，新的 ReplicaSet 与版本标签变化都没有，推导不出发布，迁移 Job 无处可挂。
2. **作用对象只解释数据库上的告警，不产生候选**：§13 让数据库上在变更窗口内开始的告警由发布解释。这两次数据库自己没有任何告警（是权限配置问题），数据库进不了候选。
3. **数据**：见"数据与标注"。重建包里失败的迁移 Job 只来自 kube-state-metrics 历史，没有标签，也没有 `egress_to` 边。

前两层是通用问题：任何"发布流水线先跑一次性 Job（迁移、预检、schema 检查），Job 失败，发布停止"的故障都是这样。发布流水线的告警没有对象，Job 的失败告警只指向 Job，Job 访问的数据库既不是成员也不是候选。

## 决定

1. **一次性 Job 自成一次变更**（`changes.kubernetes`，`deriveRollouts`）：满足以下条件的 Job 生成一次 `source: kubernetes`、`kind: other` 的变更。
   - 新建，并且没有属主。CronJob 的 Job 是例行任务；Operator 与 Helm 创建的 Job（CNPG 的 initdb 与 join、HelmChart 的 install）是它们的内部步骤。这些都有属主，不算。
   - 没有挂到任何发布（§13 的四档）。
   - 之后 `preStepWithinMs`（默认 30 分钟）内，同一命名空间没有发布。发布之前的 Job 即使因为候选不唯一没有挂上，也属于那次发布，不另成变更。

   变更的目标是 Job 与它的管理应用。时间是 Job 新建的时刻，`change_id` 取 Job 的拓扑序号，不与发布的冲突。之后出现发布并挂上这个 Job 时，它成为发布的一部分，这次变更不再生成：变更每次从拓扑事件重算，不落库。发布流水线的告警（角色 change、没有对象）按 ADR 0104 §5 归到它：这次变更有影响（Job 的失败告警由它解释）。
2. **落在变更自己目标上的告警**：失败的迁移 Job 常常被流水线删掉（重试前删掉同名 Job），删掉之后它的告警在拓扑里没有锚点。原来的规则在这时把它当作没有对象的告警处理：
   - 只按命名空间归到最近的变更，可能是同一命名空间里另一个 Job 的变更；
   - 变更的"影响"只认有锚点的告警，这次变更就不再有影响，流水线告警随之脱离。

   改为：告警的组件就是某次变更自己的目标（命名空间伪组件除外）时，先归到这次变更，并且算作这次变更的影响。
3. **变更的作用对象**（core `actsOn`）：取变更目标中的 Job 经 `egress_to` 访问的组件，值为边的置信度。§13 的前置 Job 与第 1 条的一次性 Job 都算；按第 4 档 `namespace_window` 弱推导挂上的 Job 不算（同 §13）。变更自己的目标与枢纽不算：网络策略总会放行 DNS，CoreDNS 是所有工作负载共用的基础设施，不是迁移写入的对象。§13 原来写明 DNS 不算，但代码没有排除。`changeExplains` 改用它，§13 解释数据库告警的行为不变。
4. **作用对象进入根因候选**（`rankRoot`）：迁移失败的原因可能在迁移本身，也可能在它写入的数据库（权限、锁、容量）。发现环节分不出是哪一种，两者都要进入研判的范围。作用对象作为候选：
   - 来源记为 `change`（契约的枚举不变）；
   - 角色先验与"近期变更"两项都乘以访问边的置信度（网络策略推断的边是 0.6），所以排在变更本身之后，不抢根因；
   - 覆盖率仍按变更能解释的症状计算；
   - 实体取组件在拓扑中的对象。

不采用的做法：

- **按 workflow_template 把没有组件标签的流水线告警映射到发布组件**：bypassrls-1 的 ArgoWorkflowsReleaseFailed 只带 `name="cchp-release"`，这是 Argo Workflows 指标 `argo_workflows_workflowtemplate_triggered_total` 的 `name` 标签。按 `name` 推断对象太宽，其他指标的 `name` 指的是别的东西。即使映射到 WorkflowTemplate，得到的也是 WorkflowTemplate 与管理它的 release-workflows 应用：既不是标注的根因，也没有任何变更把它连到 cchp-prod 应用。现在的规则已经带 `component: release`，按 ADR 0104 §6 归到 `component:release`。缺标签的只是 10-16 修改规则之前的告警。
- **只让失败 Job 的作用对象进入候选，不生成变更**：bypassrls-2 的流水线告警仍然自成一个 `component:release` 事件，并且是主事件（三条故障告警里占两条），数据库只出现在另一个事件的候选里。
- **新的候选来源 `acts_on`**：要改契约的枚举、控制台与研判提示词。`change` 的含义（"有触及它的变更"）已经覆盖作用对象。
- **按名称前缀从旧 Job 继承 `egress_to` 边**（见"数据与标注"）：属于猜测，不是拓扑事实。

## 回放

17 个标注故障的发现回放，代码 48747db 与本 ADR，领域包取 cchp-k8s-ops origin/main `a7396a2` 的导出副本，重建包不变（4 个新包、13 个旧包）：

| 指标 | 48747db | 本 ADR |
|---|---|---|
| 通过 | 14/17 | 14/17 |
| 根因命中 | 14/15 | 14/15 |
| 每次故障的事件数（平均 / 最多） | 1.76 / 5 | 1.71 / 5 |
| unlabelled | 7/60 | 7/59 |
| 16:30Z 发布事故（release-rollback-failed）事件数 | 1 | 1 |

- 只有 bypassrls-2 改变：事件数 2 → 1。迁移 Job 在 04:05 自成变更，KubeJobFailed、ArgoWorkflowsReleaseFailed、CCHPPostDeployAnomaly 与 CCHPReleaseBreakerOpen 归到同一个事件。05:05 Job 被删除之后，第 2 条使它们仍在一起。
- 分析时刻（04:20）的主事件：根因由 `component:release` 变为迁移 Job，候选是迁移 Job 与 `component:release`，都在 `discovery_roots` 内。
- 其余 16 个用例逐行相同，包括 pg 类（pg-sync、pg-lock、barman×3）与 3 个发布用例。
- 13 个旧包没有 `kube_job_owner`，CronJob、CNPG 等创建的 Job 在回放中没有属主，会被当作一次性 Job 生成变更。这与线上不同，在 17 个用例里都没有告警落在这些 Job 上。

**模拟现在 reader 的数据**：10-20 起，影子环境的状态库记录 cchp-prod 的迁移 Job，带标签，并按 NetworkPolicy `cchp-prod/migration-to-postgresql` 生成 `egress_to` 边，指向 pg Cluster 与 CoreDNS，置信度 0.6（release-rollback-failed 包里的 `cchp-migrate-147f17829ea1` 等）。在 scratchpad 的包副本里给两个失败的迁移 Job 加上同样的两条边，原始包与标注不动：

| 输入 | 代码 | bypassrls-1 | bypassrls-2 | 17 条通过 |
|---|---|---|---|---|
| 加边 | 48747db | 2 个事件，根因空 | 3 个事件 | 13/17 |
| 加边 | 本 ADR | 2 个事件，根因空 | 1 个事件；04:20 候选：迁移 Job、`component:release`、pg Cluster（0.21） | 14/17 |
| 加边，Job 新建时刻取 01:22 | 本 ADR | 1 个事件，根因迁移 Job；01:35 候选：迁移 Job、pg Cluster（0.21） | 同上 | 15/17 |

- 48747db 在加边之后反而变差：Job 经 `egress_to` 可达数据库 Pod 所在的节点，KubeJobFailed 与 02:34 起的节点资源请求告警按依赖合并（开始时间相差 91 分钟，在 ADR 0104 §10 的 2 小时之内）。流水线告警自成一个事件，Job 删除后 KubeJobFailed 又单独成为一个事件，一共 3 个。
- 本 ADR：数据库作为第三个候选出现，排在 Job 与发布组件之后；CoreDNS 是枢纽，不进候选。04:20 的主事件里仍有这两条节点资源请求告警，原因是上面的依赖合并，本 ADR 没有改。ADR 0141 处理了这一点：访问边只到被访问的组件为止，Job 不再经数据库的 Pod 到达它们运行的节点。
- bypassrls-1 只加边还不够，原因是 kube-state-metrics 的 5 分钟步长：Job 第一次出现在 01:25 的样本里，KubeJobFailed 01:23:00 开始，ArgoWorkflowsReleaseFailed 01:23:30 开始，都早于变更，变更解释不了它们。报告写明工作流 01:22:28 已经失败，所以 Job 在这之前已经新建；把新建时刻取 01:22 之后，两条告警归到同一个事件。

## 数据与标注

两个用例在现有重建包上做不到让数据库进入候选。依据：

- **失败的迁移 Job 没有 `egress_to` 边**：`cchp-migrate-5ec966adda08`、`cchp-migrate-67a9ece70780` 只在 kube-state-metrics 历史里，标签为空。kube-state-metrics 没有 NetworkPolicy，对象标签只有 `metricLabelsAllowlist` 放行的才导出（CCHP 对 Pod 放行的是 `cchp.io/release-id`，ADR 0104 §13），旧包也没有导出标签，所以重建推不出网络策略的访问关系。当时影子环境的状态库没有记录 cchp-prod 的 Job：10-16 的包里，状态库的 Job 只有 kube-system 与 envoy-gateway-system 的。回放的拓扑里，从这两个 Job 出发只能到它们运行的节点。
- **包里唯一的 Job → 数据库边是陈旧的**：`Job:cchp-prod/cchp-migrate-0bd30933a195 egress_to Cluster`，有效期从 10-11 起，一直没有关闭，Job 节点本身不在包里，是另一个 Job。没有用它。
- **重新导出也补不回来**：10-16 的状态库没有这些 Job，NetworkPolicy 的选择器不在状态库的节点里。kube-state-metrics 的 `kube_job_created` 能给出准确的新建时刻（补上 bypassrls-1 的时序），但补不了访问关系。导出加 `kube_job_created` 留作后续，不在本 ADR。
- **10-16 的旧规则**：bypassrls-1 的 ArgoWorkflowsReleaseFailed 没有 `component`、`role` 标签，KubeJobFailed 没有 `component: workload`，所以前者没有组件，后者按内置目录归为 cause。bypassrls-2（04:05）时规则已经带这些标签。
- 标注没有修改。

线上从 10-20 起有迁移 Job 的 `egress_to` 边。同类故障再发生时：一次性 Job 自成变更，发布流水线告警归到它，数据库作为候选进入研判范围。

## 结果

- 实现：
  - `apps/srenautix/src/changes/kubernetes.ts`：`deriveRollouts` 生成一次性 Job 的变更。server 的 `kubernetesRollouts` 与 eval 的重建共用它。
  - `packages/core/src/converge.ts`：`actsOn`；`changeExplains` 改用它；`changeTargets` 增加"落在变更自己目标上"。
  - `packages/core/src/rank.ts`：作用对象进入候选。
- 测试：
  - `packages/core/test/failed-pre-step.test.ts`：一次性 Job 的变更吸收流水线告警，数据库作为候选排在 Job 之后，DNS 枢纽不算；没有变更时不生效；Job 删除之后仍在一起；弱推导与变更自己的目标不算作用对象；数据库自己的告警由变更解释。
  - `apps/srenautix/test/unit/rollout-pre-steps.test.ts`：一次性 Job 的条件（属主、后续发布、命名空间）与变更的形状。
- 研判没有重新运行。离线重算 trace 只复用旧的模型输出，而研判的输入（根因与候选）变了，重算说明不了效果。bypassrls-2 的研判输入在现有包上的变化：根因由 `component:release` 变为迁移 Job，仍然没有数据库。
