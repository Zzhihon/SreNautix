# 0108 自愈 PR：server 计划与校验补丁，gateway 开 PR

## 背景

领域包已经能按修复模板生成补丁（ADR 0103），gateway 的 `gitops_pr` 有了补偿控制，冻结期间照常执行，并改为可撤销、L 档、允许自动执行（ADR 0025）。还缺一段：研判给出结论之后，谁在什么时候调用模板，怎样校验补丁，PR 描述写什么，以及 PR 开出后怎样回到事件 issue 和通知里。

## 决定

1. **触发**：主实例每 30 秒取最近 6 小时内结束的研判，条件是 `state=completed`、结论等级在 `remediation.conclusions` 中（默认 likely、evidence_consistent）、还没有处理过。事件已合并、被抑制、版本变化后重新触发了研判（第 10 条）或没有根因时，只记录原因，不处理。
2. **上下文**：`RemediationContext` 由以下几部分组成：
   - 事件；
   - 根因：研判结论的根因组件，没有时取事件根因。组件类型取拓扑节点，没有时按名称匹配；
   - 当前版本阶段 A 报告的卡片：全局 id 对应最严重的结论；
   - 成员告警的分类。
3. **计划**：`applicableRemediations` 给出适用模板，过滤掉 `remediation.categories` 之外的类别，每次研判最多提交 2 个。`planRemediation` 通过 GitHub REST 读取仓库（`GitHubRepoReader`）：
   - head 固定在第一次读取时的提交；
   - read 走 contents；
   - glob 按目录逐层展开，最多 200 次目录请求；
   - history 走 commits?path，再读出各提交时的内容。

   只发 GET。仓库角色在 `remediation.repositories` 里没有配置时，记为跳过。
4. **校验**：server 镜像里没有 git（ADR 0096），补丁在内存里校验：
   - 每个文件的路径落在布局的文件角色里；
   - before 与基准提交的内容逐字节相同；
   - 补丁应用到 before 后与 after 相同；
   - after 能按 JSON 或 YAML 解析（全部文档）；
   - 补丁不超过 gitops_pr 的 65536 字符上限。

   不通过时记为 failed，不提交。kustomize、helm 渲染不在 server 里做：没有完整的工作树，也没有二进制。由 gateway 的 `patch_applies` 预检与仓库自己的 CI、Argo CD 同步负责。
5. **提议**：
   - 用 `gitops_pr` 提议，参数为 repository、base、title、body、patch、branch；
   - 来源为 rule，规则 id 是 `srenautix/remediation-pr`。gateway 策略为 gitops_pr 列出自动执行规则 `remediation-pr` 时，按自动执行签发，否则等待审批；
   - `research_run_id`、`hypothesis_id` 与 `evidence_refs`（结论假设的支持卡）指向研判；
   - 目标 `GitRepository` 的 UID 是 base 分支当前的提交（`GitRepositoryTargets`），gateway 的 `base_head` 预检核对它。计划与提议之间 base 前进时不提交，下一轮按新的 base 重新计划；
   - 分支是 `srenautix/<事件 id 前 8 位>-<类别>-<补丁摘要前 6 位>`，标题是 `<前缀> <模板标题>：<根因名称>`。前缀取 `remediation.title_prefix`，不填时取 `notify.prefix`，影子期间为 `[影子]`；
   - reviewers 不传，由 gateway 取策略中该仓库的 reviewers；
   - 每小时上限、分支前缀与 main 的守护都在 gateway。
6. **PR 描述**分六段，每段前有 `<!-- srenautix:pr=<段> -->` 标记：
   - `## 结论`：研判摘要、等级与根因；
   - `## 证据`：关键证据卡，支持卡在前，然后是异常的和无法判定的，最多 6 张；
   - `## 改了什么`：模板的改动说明、文件列表、模板与基准提交；
   - `## 验证计划`：时限、说明，以及应判为正常的卡；
   - `## 回滚`；
   - `## 研判运行`：控制台的运行与事件链接。

   之后是 `Refs #<issue>` 与 `<!-- srenautix:incident=<id> -->`。开启事件 issue 时，提交前先确保 issue 存在（ADR 0095，`issues.max_per_hour` 限速），描述里写 Refs。超过 7600 字符时先去掉证据卡，再截短改动说明。
7. **PR 关联**（`GitOpsPulls`，所有 gitops_pr 提议，不只是自愈 PR）：
   - gateway 在执行事件消息里写 `PR <url> #<n>`（执行结果与 pr_open 检查）；
   - 消息里没有时，执行进入校验之后按分支查 `GET pulls?head=<owner>:<branch>`；
   - 找到后写入 `server.gitops_pulls` 与治理审计 `gitops.pr_opened`，事件 issue 里回链；
   - 通知消息的修复段落显示 `PR：<url>`，消息带 `notify.prefix`。
8. **冻结只约束集群写入**：gateway 冻结期间以 `GET /v1/spoke/tickets?actions=gitops_pr` 拉取，server 只下发这些动作的工单，其余工单留在队列里。
9. **记录**：
   - `server.remediation_attempts` 按（研判, 模板）一行，结果为 proposed、skipped、rejected 或 failed，带原因码；
   - 治理审计记 `remediation.attempt`；
   - 指标为 `srenautix_remediations_total{category,outcome}` 与 `srenautix_gitops_pulls_total{via}`；
   - 每一行同时写进 info 日志（`自愈 PR 处理结果`，带原因码与原因），Kind 与影子环境的诊断日志里能看到自愈 PR 为什么没有出现。
10. **研判之后事件有了新版本**：新版本只加入了成员，根因、严重度与证据指纹都没变时不会重新研判（DESIGN §2.4 的触发原因），这次研判的结论仍然适用。之前一律记为 incident_changed，这样的事件就再也不会有自愈 PR。Kind 的 alert-too-sensitive 场景（kind-e2e 39542017862）与这条路径相符：研判 04:16:24 结束，04:16:44 对账补进一条告警，之后 10 分钟没有 PR，gitlocal 也没有收到任何写入。现在只有 `research_queue` 里有更高版本的研判触发（含被准入跳过的，例如超过次数上限）时才跳过；否则绑定事件的当前版本，指纹取当前版本阶段 A 报告的指纹，报告还没生成时推迟到下一轮。

## 结果

- 结论可以落到仓库改动时，几分钟内在 srenautix/ 分支上出现一个 `[影子]` PR，描述可以追溯到研判与证据卡，事件 issue 与 Telegram 消息里有链接。合并始终由人决定。
- server 对 GitOps 仓库只读，所有 Git 写入都由 gateway 的 gitops_pr 完成，受补偿控制约束。
- 模板跳过、校验失败与策略拒绝都留有原因，可以在 `remediation_attempts` 与审计里查到，不会静默丢失。
