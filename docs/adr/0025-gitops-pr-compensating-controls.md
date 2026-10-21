# 0025 gitops_pr：唯一的 Git 写入路径、补偿控制与冻结

## 背景

自愈 PR 把研判结论落成仓库改动，由人审阅合并。有两类 PR：

- 自愈 PR：发布回退、配置与资源调整、告警规则调优、拓扑与领域包覆盖；
- 控制台发起的拓扑覆盖 PR。

之前有两条写 Git 的路径。gateway 的 `gitops_pr` 执行器带签名审批、at-most-once 与审计链；server 的拓扑覆盖 PR 则直接用 GitHub App 推送。两条路径各自实现"只推 `srenautix/*`、从不合并"，以后补充的控制要写两份。

不变量 12 原先要求 base 分支有分支保护，没有时 `gitops_pr` 停用。有的组织的 GitHub 套餐对私有仓库不提供分支保护，App 的安装令牌在技术上可以直接写入 base。这时需要用代码强制的补偿控制代替分支保护，并且每一项都可以测试。

`srenautix-freeze` 熔断开关用于暂停 gateway 对集群的写入。PR 不写集群，只在人合并之后才生效。

## 决定

1. **唯一的 Git 写入路径**：SreNautix 对 Git 的全部写入都经 gateway 的 `gitops_pr` 执行器，补偿控制只在 `internal/spoke/gateway/github` 中实现一份。
   - server 只提交 `gitops_pr` 提议：自愈 PR 由自动执行规则（例如 `remediation-pr`）批准，拓扑覆盖 PR 由控制台的发起人批准。PR 地址经执行事件回传。
   - server 的 GitHub App 客户端只保留 issue、评论、读取 PR、给 PR 描述补 `Refs`，以及变更源的读取。它没有建分支、提交、开 PR 与合并的能力，由它自己的请求白名单保证。
2. **不变量 12**：`gitops_pr` 从不合并。base 分支有分支保护，或者在 gateway 策略中登记了经批准的补偿控制：
   ```yaml
   gitops:
     repositories:
       - repository: owner/name
         base: main
         compensating_controls:
           approved_by: <批准人>
           approved_at: "<日期>"
           reference: <出处>
   ```
   两者都没有时，条件 `GitBaseGuarded` 为 False，预检 `base_guarded` 失败。补偿控制是：
   - **请求白名单**：没有合并接口，也没有删除、移动或改写已有引用、写文件内容的接口。客户端不提供合并方法。被拦下的请求不发出，计入 `srenautix_gitops_denied_requests_total{reason}`，并写入执行审计链。
   - **只新建 `srenautix/` 分支**：
     - 分支名匹配 `^srenautix/[a-z0-9][a-z0-9._/-]{0,120}$`，不含 `..`。默认是 `srenautix/<执行 ID>`，提议可以给出 `srenautix/<事件>-<类别>`。
     - 只能新建引用，不能移动已有引用。
     - 分支已存在时预检 `branch_free` 失败。
   - **推送前后核对 base**：
     - 推送前读取 base，它必须等于审批绑定的提交；推送后再次读取 base 与新分支。
     - base 在两次读取之间前进时不开 PR，执行以 `failed/base_moved` 结束，计入 `srenautix_gitops_pushes_total{result="base_moved"}`。
     - 已推送的分支留在仓库中，因为 gateway 不能删除分支。
   - **审计**：两次核对、推送、开 PR、请求审阅、关闭 PR，以及被拦下的请求，每一项都在操作之后立即写入执行审计链。审计写入失败时操作中止。
   - **按小时限速**：
     - 每个仓库在最近一小时内开出 PR 的执行数达到 `gitops.max_prs_per_hour`（默认 2）时，工单以 `gitops_rate_limited` 拒绝，计入 `srenautix_gitops_rate_limited_total`。
     - 按执行记录计数，与 at-most-once 用同一份记录。
     - 中心把被拒的工单记为跳过，不再补开。
   - **main watchdog**：
     - 每 `gitops.main_watchdog.interval`（默认 5 分钟）读取 base 分支在 `lookback`（默认 24 小时）内的提交，下面两类是非人工提交：
       - 由机器人写入的提交（author 或 committer 是机器人），且不属于任何由人合并的 PR；
       - 由机器人合并的提交（PR 的 `merged_by` 是机器人）。
     - 人在网页上合并 `srenautix/` 分支的 PR 时，提交的 author 是 App、committer 是 `web-flow`，PR 由人合并，所以不是非人工提交。
     - `allowed_bots` 可以豁免其他机器人，但不能豁免 gateway 自己的 App。
     - 发现非人工提交时：
       - 计入 `srenautix_git_main_unexpected_commits_total{repo,actor}` 与 gauge `srenautix_git_main_unexpected_commits{repo}`；
       - 条件 `GitMainWatchdog` 为 False，由 chart 的告警规则覆盖；
       - 回看窗口内预检 `main_watchdog` 失败，不再推送。
     - 周期检查随安全检查运行。预检 `main_watchdog` 不依赖周期检查的时机：距上一次成功检查已满一个间隔（或从未检查过）时，预检先当场检查一次，判定总是基于不早于一个间隔的结果；当场检查失败同样视为未通过。周期检查与预检的检查串行进行，同一个提交只判定、计数一次。
     - 条件 `GitMainWatchdog` 在超过 3 倍的 max(检查间隔, 安全检查周期) 没有成功检查时为 False（`check_failed`）。
   - **审阅人**：PR 只请求策略中该仓库的 `reviewers`。提议给出的 `reviewers` 必须是它的子集，否则预检 `reviewers_allowed` 失败。
3. **等级**：`gitops_pr` 从 compensable 改为 reversible，最低档位 L，允许自动执行。
   - 理由：PR 本身不改变任何系统，改动只在人审阅并合并后生效，人工合并就是对改动内容的人工审批。撤销是关闭本次开出的 PR；PR 已被合并时撤销转为 `needs_human`，revert 需要新的提议。
   - 爆炸半径固定为 1 个仓库。不变量 7（可补偿与不可逆动作一律人工审批）不变。
4. **冻结只约束集群写入**：`srenautix-freeze` 冻结期间，gateway 仍然执行 `gitops_pr`，其余动作一律不执行。
   - 冻结是只提议的唯一原因时，心跳报 `propose_only: true` 与 `accepts_actions: ["gitops_pr"]`，gateway 以 `GET /v1/spoke/tickets?actions=gitops_pr` 拉取。中心只下发这些工单，其余工单留在队列中。
   - 中心仍下发了其他工单时，gateway 不认领它们；它们没有 `pulled` 事件，解冻后照常处理。
   - 执行前的复核对 `gitops_pr` 以外的动作仍然检查冻结。
   - 有其他只提议原因时（准入自检失败、审计汇不可用、时钟偏差、apiserver 限流、策略加载失败），`gitops_pr` 也不执行。
   - 这个例外写在代码里，只适用于 `gitops_pr`，没有配置开关。
5. **Kind 中的本地 Git 服务**：不变量 12 的测试通过 `/_test` 控制接口驱动 Git 服务，包括建仓库、分支保护、以任意身份推送、推送期间让 base 前进、以任意身份合并、请求记录。
   - 默认连接进程内的实现（`internal/spoke/testenv/github.go`）。
   - 设置 `SRENAUTIX_TEST_GITHUB_API` 时连接 Kind 中的本地 Git 服务，后端是真实的 bare 仓库。两者实现同一组 REST 接口与控制接口，测试代码相同。

## 结果

- 没有分支保护的仓库也可以接收自愈 PR，每一项控制都有测试覆盖（`TestInvariant12GitOpsNeverMerges`）。
- 补偿控制有残余风险：App 的安装令牌泄露后，可以绕过 gateway 直接写入 base。main watchdog 会在一个检查间隔内发现并告警，但不能阻止写入。真正阻止写入只能靠分支保护，组织条件允许时应当开启。
- server 的拓扑覆盖 PR 改为经 gateway，没有启用 `gitops_pr` 的安装不能开拓扑覆盖 PR。
- 冻结期间仍然会开 PR。值班人员需要知道：冻结暂停的是集群写入，不是 SreNautix 的全部输出。
