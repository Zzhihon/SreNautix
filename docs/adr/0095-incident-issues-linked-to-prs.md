# 0095 需要人跟进的事件在 GitHub 开 issue，并与修复 PR 互相关联

## 背景

研判得出"需要人跟进"的结论时，结论只出现在聊天消息与控制台里，负责仓库的 DevOps 看不到，也无法把后续的修复 PR 和这次事件对应起来。用户决定按现有权限安装 GitHub App（cchp #133：issues、pull_requests、contents、actions 写），要求在仓库里开 issue 说明问题，PR 与 issue 互相关联。

## 决定

1. **开 issue 的条件**：阶段 A 或已完成的研判的处置判断为 `escalate`；或者有需要改仓库的修复提议（带 `incident_id` 的拓扑覆盖 PR、`gitops_pr` 提议）。由 `issues.enabled` 开启，默认关闭。
2. **身份**：只用 GitHub App 的安装令牌（`github_app`，拓扑覆盖 PR、事件 issue 与 GitHub 变更源共用），不接受个人令牌。2.5 版写在 `topology.override_pr.github` 里的 App 身份在解析时迁移过来。
3. **一个事件一个 issue**：`server.github_issues` 以 incident_id 为主键。正文第一行是事件标记；开 issue 的请求结果未知（超时、连接断开）时，重试先按标记在仓库中找回，不重复开。后续进展（研判结束、事件恢复、关联的 PR 与提议）追加为评论，按 (事件, 键) 去重，评论同样带标记。
4. **内容**：结论、关键证据卡摘要、控制台链接，带配置的标签（默认 `srenautix`）；标题前缀默认取 `notify.prefix`，影子期间为 `[影子]`。
5. **限速**：每个仓库最近 1 小时最多新开 `max_per_hour` 个 issue。超出的事件记为 `skipped`，只记录（审计、指标、日志），之后不再为它开 issue，避免告警风暴之后集中开一批。评论不受限速。
6. **关联**：server 发起的拓扑覆盖 PR 先确保事件有 issue，PR 描述写 `Refs #<issue>`（跨仓库为 `owner/name#<issue>`）；issue 暂时开不出时 PR 照常开出，issue 开出后由后台循环给 PR 描述补 Refs。gitops_pr 提议在创建时把 Refs 写进参数的 `body`（gateway 开 PR 时作为描述），随参数一起被审批，幂等键仍按调用方给出的参数计算。issue 里以评论回链 PR 与提议。
7. **失败与重试**：退避重试（30 秒起翻倍，最长 30 分钟），最多 8 次，用尽后记为 `failed`。积压的失败以 `ChannelDeliveryFailed`（channel `github-issues`）显示在状态条上。开出、跳过、放弃、评论与补 Refs 都写治理审计。
8. **契约**：`createTopologyOverridePr` 的请求增加可选的 `incident_id`，响应增加 `issue_url`（可为 null），契约升到 2.7.0。issue 的编号与地址目前不进入事件的契约对象；控制台需要显示时再加。

## 考虑过的方案

- **由事件驱动发评论（每次状态变化入队一条）**：漏掉一次事件就永远缺一条评论。改为每轮按数据库中的状态计算应有的评论并去重发出，重启或失败后自然补齐。
- **按标题或搜索接口去重**：搜索索引有延迟，标题会被人修改；事件标记加上数据库主键更可靠。
- **限速之后延后开出**：风暴结束后会集中开出一批过时的 issue，所以超出的只记录。
- **gateway 的 gitops_pr 由 gateway 自己写 Refs**：gateway 不知道事件的 issue，也不应访问 issues；由 server 在提议参数里写入，审批覆盖了描述内容。gitops_pr 仍受不变量 12 约束（要求分支保护），保持关闭。

## 结果

- DevOps 在仓库里看到需要跟进的事件、证据与修复 PR 的关联；同一事件的进展集中在一个 issue 里。
- App 需要 Issues 与 Pull requests 写权限；没有开启时行为与之前相同。
- 被限速跳过的事件只在审计与指标里可见，需要时由人手动开 issue。
