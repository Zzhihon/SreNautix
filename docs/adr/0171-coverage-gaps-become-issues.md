# 0171 覆盖缺口改为 issue

## 背景

没有命中任何告警目录条目的告警由自愈 PR 的 `topology_coverage` 类别处理：研判结束后，`gitops` 包的 `alert-catalog-entry` 模板给领域包的告警目录加一条条目，开 PR（ADR 0155）。部署方的影子期里这类 PR 有三个问题：

- 它由研判触发，PR 的标题后缀是研判根因。同一条告警在不同的事件里得到不同的根因，标题各不相同；补丁的去重只认同一个修改，上下文变了以后同一条告警会再开一个 PR；
- 覆盖缺口是告警自身的属性，与这次事件的根因、结论档位无关。研判没有达到 `likely` 时缺口照样存在，却不会被报告；
- 目录条目写什么（角色、实体）往往要人判断。只带分组标签的告警在规则上补实体标签之前，条目给不出实体（ADR 0155 §6），PR 只能被关闭。

这类工作适合交给人跟进，每个缺口一个入口，缺口反复出现时累计在同一个地方。

## 决定

### 1. 不再开 PR

`topology_coverage` 从自愈 PR 的类别中去掉：server 配置的 `remediation.categories` 不再接受它，配置里写了时解析之前去掉并在日志里记录弃用警告（`config/server.ts` 的 `upgradeRaw`），默认值与 chart 的默认值同样去掉。`alert-catalog-entry` 模板留在 `gitops` 包里，领域包测试照常覆盖它；控制台的拓扑覆盖 PR（`POST /v1/topology/overrides/pr`）不受影响。

### 2. 每个缺口一个 issue

`issues` 开启时，server 的后台循环（`issues.interval`）处理覆盖缺口（`github/coverage-issues.ts` 的 `CoverageIssues`），与事件 issue（ADR 0095）、业务 issue（ADR 0146）同一套机制：

- **登记**：`issues.lookback` 内更新过、没有被抑制或合并的事件中，仍在事件里、分类没有命中目录条目的成员告警。缺口以（集群，告警名）为键记在 `server.coverage_gaps`，出现过的事件记在 `server.coverage_gap_incidents`（每个缺口、每个事件一行，同一事件里同名的多条告警取最早开始的一条）。登记不依赖研判，结论档位、处置与这次事件的根因都不影响它。
- **内容**：标题 `<前缀> 覆盖缺口：告警 <告警名> 没有告警目录条目（集群 <集群>）`，不随事件变化；标签为 `issues.labels` 加 `coverage`；正文第一行是标记 `<!-- srenautix:coverage=<集群>/<告警名> -->`，写明出现次数（事件数）、首次与最近一次出现（告警开始触发的时间）、最近一次触发的标签、涉及的事件（最多 20 个，链接到控制台，其余给出事件列表的入口）、补齐的步骤（告警目录条目要写的角色与实体；规则只带分组标签时先在规则上加实体标签；只需要映射到拓扑对象时在控制台的拓扑覆盖页加覆盖）与"不需要补齐时关闭这个 issue"。
- **再次出现**：缺口出现在新的事件里时，在 issue 下追加一条评论，列出这一轮新出现的事件与累计数；一轮里的多个新事件合在一条评论里。评论之前读取 issue 的状态，人已经关闭时缺口记为 `closed`：之后不再评论，也不再为这个告警开 issue，新的事件只在状态库里计数。
- **每小时上限**：与事件 issue 共用 `issues.max_per_hour`，按同一仓库最近 1 小时开出的事件 issue 与覆盖 issue 的合计判断（`github/issues.ts` 的 `openedLastHour`，两类都用它）。事件 issue 达到上限时记为 skipped（ADR 0095，不变）；覆盖缺口达到上限时保持 pending，10 分钟后再试。缺口不随时间过期，推迟之后开出仍然有用，记为 skipped 会让缺口再也不被报告。
- **失败与重试**：创建请求的结果未知（超时、连接中断、5xx）时状态记为 `unknown`，下一次先按标记在仓库中找回；找回的 issue 正文是之前某次创建时的内容，不知道列到了哪个事件，已登记的事件以一条评论追加。结果明确的失败按退避重试（30 秒起，最长 30 分钟），开出最多 8 次，用尽后记为 `failed`。评论失败同样退避重试。
- **审计与指标**：`github.coverage_issue_opened`（含是否找回）、`github.coverage_issue_failed`、`github.coverage_issue_comment`、`github.coverage_issue_closed`；`srenautix_coverage_issues_total{repo,outcome}`。

请求都在 ops 仓库角色的白名单内：开 issue、列出 issue（按标记找回）、读取 issue 的状态、写评论。server 不改 issue 的状态与标签。

### 3. Kind 场景

`unmapped-alert` 不再期望 PR：检查 `kind/gitops` 上有 ShopCatalogStale 唯一的覆盖 issue（标签含 `srenautix` 与 `coverage`），正文或评论列出根因事件，这个事件没有 `srenautix/*` 的 PR（`deploy/kind/srenautix-checks.sh` 的 `check_coverage`，场景声明 `SRENAUTIX_COVERAGE_ALERT`）。

## 结果

- 迁移：`github` 轨道版本 4，新建 `server.coverage_gaps` 与 `server.coverage_gap_incidents`，只增不删。
- 实现：`github/coverage-issues.ts`、`github/issues.ts`（`openedLastHour`）、`roles/server.ts`（`issues` 开启时与事件 issue 一起运行）、`config/server.ts`、`metrics.ts`、`eval/{reconstruct,remediation}.ts`（重建评测的类别去掉 `topology_coverage`，标注类别 `topology_pack` 按没有仓库修复计）、chart 的默认类别、Kind 场景与检查脚本。
- 测试：
  - `test/integration/coverage-issues.test.ts`（真实 PostgreSQL 与内存中的 GitHub）：只登记仍在事件里、没有目录条目的告警；标记、标签、标题、出现次数与时间、标签与事件列表；同一缺口只开一个 issue，新的事件追加一条评论；人关闭之后不再评论、不再重开；创建结果未知时按标记找回并补一条评论；4xx 退避重试与重试用尽；每小时上限与事件 issue 共用（覆盖 issue 推迟、事件 issue 记为 skipped）；英文内容；
  - `test/integration/remediation.test.ts`：没有目录条目的告警不开 PR，开出覆盖 issue，再次出现时只评论；
  - `test/unit/remediation-config.test.ts`：`topology_coverage` 去掉并返回弃用说明，解析不接受它。
