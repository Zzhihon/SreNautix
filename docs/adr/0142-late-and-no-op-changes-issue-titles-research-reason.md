# 0142 没有改动、晚于症状的变更不参与根因排序；issue 标题跟随事件；研判镜像的原因取自队列

## 背景

真实事件（Zzhihon/SreNautix#12）：CCHP cchp-prod 的 gateway 从 2026-10-23 15:48Z 起 OOM 循环，gateway-3 重启 131 次。影子事件 b18629a6，标签 `StatefulSet:cchp-prod/gateway:2026-10-23T15:40:00Z`，到 v116 仍在触发，对应 cchp-k8s-ops#249。运行版本 1066ca9。暴露了三个问题。

1. **没有改动、晚于症状的变更参与了根因排序**。变更 `kubernetes:cchp:153695` 发生在 17:42:07Z，内容是 release-id 标签往返 `canary-3cc28887b49f → 无 → canary-3cc28887b49f`，`revision` 与 `previous_revision` 相同，比首个 OOM（15:48:30Z）晚将近 2 小时。
   - 推导：`deriveRollouts` 把两次标签变化合成一次发布。版本取新取值（canary），旧版本取旧取值（canary），两者相同仍然写出。
   - 收敛：OOM 循环里每次重启都有新的告警触发，17:42 之后开始的告警落在发布目标 gateway 上，`changeExplains` 只比较这一条告警的开始时间，于是由这次变更解释，变更进入事件。
   - 排序：`recent_change` 只要求变更不早于分组开始前 30 分钟，没有上限。分组里没有 symptom 角色的告警，覆盖率与先于症状两项都是 0。gateway 与管理它的 Argo 应用都得到变更先验 1 与近期变更 1，都是 0.35，根因有歧义，处置为升级。
2. **issue 标题不随事件更新**。#249 的标题停在开出时那一刻（`Application.argoproj.io:argocd/cchp-prod：ArgoCDProdSyncFailed`）。ArgoCD 的两条告警在 v10/v11 就已经离开事件，正文后来一直在原地更新（ADR 0125），标题没有，按 gateway 搜不到这个 issue。原因是 server 的 GitHub 白名单只允许 PATCH issue 的正文（ADR 0132 那一轮与 1e66375 放行了正文）。
3. **`server.research_runs.reason` 全部记成 `new_incident`**，队列里实际是 `root_changed`、`fingerprint_changed`。查明是 server 写镜像时写错，不是读取时用错字段：镜像（`scheduler/worker-events.ts`）从 worker 的 `research.concluded` / `research.failed` 事件取原因，契约里这两个事件没有 `reason` 字段，代码写的是 `p.reason ?? 'new_incident'`，一律落到默认值；`ON CONFLICT` 也不更新原因。worker 自己的 `worker.research_runs.reason` 取自认领的任务，是对的。

issue 的第 4 项（研判全部 `stage_a_only`：模型调用经过 CCHP 的 gateway，gateway 出故障时所有路由按故障域提前熔断）是第二阶段章程 §4 第 11 条设计出来的行为，需要用户决定独立的模型路由，本 ADR 不处理。

## 决定

### 1. 标签抖动不是发布（`changes.kubernetes`，`deriveRollouts`）

- 同一工作负载上连续的版本标签变化，从第一次起 `groupWithinMs`（默认 2 分钟）之内回到第一次变化之前的取值时，这几次变化都去掉。比较的是全部版本标签（`revision_labels`），不只是第一个变化的标签。工作负载最后的版本与之前相同，没有任何东西被换掉。
- 合成之后只有版本标签变化、新旧版本都唯一且相同的一组也不是发布（标签在两个工作负载之间挪动，或抖动跨过了上面的判定）。
- Pod 模板变化（新 ReplicaSet、新 ControllerRevision）不受影响：标签往返的同时有新 ReplicaSet 时仍是发布，版本取 Pod 模板哈希。
- 抖动之后真的换了版本，只算换版本的那一次。去掉标签之后超出合成范围才加回，两次都照常算，它们的新旧版本不同。
- 一次性 Job（ADR 0140）判断"之后有没有发布"时，抖动不算发布。前置 Job 的挂接（ADR 0104 §13）同理。

### 2. 晚于自己目标上问题的变更不解释、不加分（core）

容差 `CHANGE_ONSET_TOLERANCE_MS` 取 10 分钟，即 kube-state-metrics 的两个步长。推导出的变更时间可能比真实时刻晚：回退推导的发布与 Job 是 5 分钟步长，新的版本要等下一个样本才看得到，发布流水线的前置步骤又在版本变化之前。

- **问题开始时间**（`converge`，`PreparedAlert.onset`）：同一组件上的告警按时间相邻（默认 30 分钟）首尾相接成链，取链上最早的开始时间。forecast、meta 与长期告警不计。命名空间伪组件与没有组件的告警只取自己的开始时间。
- **解释**（`changeExplains`）：原来只要求告警在变更之后的窗口内开始。现在告警所在组件的问题开始时间早于变更超过容差时，变更也不解释它。这样，重新触发的告警（OOM 循环里每次重启都重新触发）不再被之后的变更解释，变更也不会因此进入事件。收敛与排序用同一个函数。
- **排序**（`rankRoot`，`lateChange`）：分组里的变更，如果它自己的目标上有一段问题，在变更之前超过容差就已经开始，并且持续到变更前后（链上的告警在变更时刻仍在触发，或结束不到一个时间相邻），这次变更就不参与排序：
  - 不产生变更候选；
  - 不给变更先验与近期变更；
  - 作用对象（ADR 0140）也不进候选。

  变更仍留在分组里，事件的相关变更照常列出。这里的"自己的目标"是变更触及的组件，不含作为其他目标管理应用的组件（ADR 0104 §14），也不含命名空间伪组件。
- ADR 0140（失败的一次性 Job 自成变更）不变：bypassrls-1 的 KubeJobFailed 比 Job 的变更早 2 分钟，在容差内，不算晚到。这条告警是否被解释，仍按它自己的开始时间判断，与原来相同。ADR 0141 的访问边规则不涉及。

不采用的做法：

- **按分组里最早的告警判断"晚到"**（第一版实现）：分组里别的组件早就在触发的告警，会让一次真正的发布也变成晚到。release-false-rollback 的分组里有 `Node:appservice-03` 上从 10-16 22:53 起一直触发的 CCHPGatewaySingleNode，10-18 07:25 的发布因此不再加分，根因从 cchp-prod 应用变为节点（不命中）。onboarding-rls-window 的根因由应用变为 worker。所以只看变更自己的目标。
- **容差取一个步长（5 分钟）**：release-migration-deadlock 的 gateway 告警 06:22 开始，kube-state-metrics 在 06:30 的样本里才出现新修订（流水线 06:20 开始，ADR 0104 §11 的回退推导）。差 8 分钟，变更不再解释这些告警，事件由 2 个变为 3 个。
- **只处理 revision 与 previous_revision 相同的变更**：第 1 条已经让这次变更不再生成，但晚于症状的变更不只来自标签抖动。真实的发布也可能在问题开始之后发生，例如为了缓解而扩容或回滚，它们同样不是问题的原因。

### 3. issue 标题跟随根因与头条症状（`github/issues.ts`、`github/app.ts`）

- 标题就是报告的头条：根因组件加触发中的头条症状（`notify/compose.ts`）。每轮重新生成正文时也重新生成标题，与上次写入的不同就在同一次 PATCH 里改标题。PATCH 只带变化的字段。
- 同一事件的标题每小时最多改一次（`TITLE_MIN_INTERVAL_MS`），根因或症状来回抖动时不跟着来回改。开出不算修改。没到时间的标题留到之后的轮次，正文照常更新。
- 状态：`server.github_issues.title`（上次写入的标题）与 `title_updated_at`（github 轨道迁移 3）。按标记找回的 issue 从列表取标题；这一版之前开出的 issue 库里没有标题，先 `GET` 读回一次，相同就不改。#249 升级后的第一轮会读回旧标题，并改成 gateway。
- 白名单：PATCH issue 允许 `title`、`body` 的任意非空组合；关闭、标签、指派等其他字段仍然拒绝。PATCH PR 仍只允许描述。
- 审计 `github.issue_retitled`（原标题、新标题），指标 `srenautix_github_issues_total{outcome="title_updated"}`。

### 4. 研判镜像的原因取自队列（`scheduler/worker-events.ts`）

- 写入 `server.research_runs` 时，原因按以下顺序取：
  1. 事件自己带的原因；
  2. `server.research_queue` 里这次任务（`run_id`）的入队原因；
  3. 都没有时（不应出现）才是 `new_incident`。

  `ON CONFLICT` 同时更新原因。
- 已有记录按队列补正（incident 轨道迁移 5），队列里没有的保持原样。
- 不改契约：原因已经在队列里，worker 的事件不需要再带一遍。

## 回放

17 个标注故障的发现回放，只读本地重建包，不连集群。配置是 `eval-cchp.yaml` 的副本：指标地址指向不可达的本机端口，领域包取内置包与 cchp-k8s-ops origin/main `73ca5e3` 的导出副本（`sha256:0312942e…`）。代码分别是 main `9c6d0b1` 与本 ADR。

| 指标 | 9c6d0b1 | 本 ADR |
|---|---|---|
| 通过 | 14/17 | 14/17 |
| 根因命中 | 14/15 | 14/15 |
| 每次故障的事件数（平均 / 最多） | 1.71 / 5 | 1.71 / 5 |
| unlabelled | 7/59 | 7/59 |
| 16:30Z 发布事故（release-rollback-failed） | 1 个事件，根因 cchp-prod 应用，找到发布 | 同左 |

- 17 行逐行相同：事件数、主事件根因、成员、变更、检测延迟、窗口事件数都一样。
- 3 个发布用例（false-rollback、deadlock、onboarding）与 16:30Z 事故的发布都在问题开始之前，或在容差之内，照常是变更根因。
- 10-23 的 gateway 事件不在这批重建包里（包是 10-20 导出的），按它的时序写成了单元测试与集成测试，见"结果"。

## 结果

- 实现：
  - `apps/srenautix/src/changes/kubernetes.ts`：`dropLabelFlaps`、`labelOnlyNoop`。
  - `packages/core/src/converge.ts`：`PreparedAlert.onset`、`CHANGE_ONSET_TOLERANCE_MS`、`changeExplains` 的问题开始时间判定、`lateChange`。
  - `packages/core/src/rank.ts`：排序只用不晚到的变更。
  - `apps/srenautix/src/github/{app,issues,migrations}.ts`：标题同步与白名单。
  - `apps/srenautix/src/scheduler/worker-events.ts`、`apps/srenautix/src/incident/migrations.ts`：研判原因。
- 测试（不带本 ADR 的修改时，除"对照"一类的用例外都失败）：
  - `packages/core/test/late-change.test.ts`：按 10-23 的时序（15:48:30 起 OOM、17:42:07 的往返变更）。
    - 断言：变更不进事件，根因是 StatefulSet gateway，没有歧义，候选只有它。
    - 变更经别的告警进入分组时，不给任何候选先验与近期变更。
    - 对照：变更早于症状或在容差内照常加分；问题在变更之后才开始时照常由变更解释。
  - `apps/srenautix/test/unit/rollout-label-flaps.test.ts`：往返、多次抖动、绕经另一个取值、抖动之后换版本、超出合成范围、标签挪动、同时有新 ReplicaSet。
  - `apps/srenautix/test/integration/kubernetes-rollouts.test.ts`：真实 PostgreSQL 的拓扑事件，按 10-23 的时序推导。
    - 往返不产生变更；
    - 用状态库的拓扑重算，根因是 StatefulSet gateway，没有歧义；
    - 用旧代码推导出的那次变更（revision 与 previous_revision 相同）重算，结果相同。
  - `apps/srenautix/test/integration/github-issues.test.ts`：
    - 根因变了改标题，写审计与指标；
    - 一小时内再变只改正文，过了一小时补上标题；
    - 库里没有标题时先读回，相同就不改。
  - `apps/srenautix/test/unit/github-allowlist.test.ts`：PATCH issue 的标题与正文放行，其他字段与 PR 的标题仍拒绝。
  - `apps/srenautix/test/integration/research-reason-mirror.test.ts`：
    - 结论与失败事件的原因取自队列（root_changed、fingerprint_changed、reopened）；
    - 事件带原因时以事件为准；
    - 迁移 5 补正已有记录。
- 第 4 项（独立于 CCHP 的模型路由）留给用户决定。
