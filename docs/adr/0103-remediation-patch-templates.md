# 0103 修复补丁模板：领域包声明改什么，server 配置改哪里

## 背景

`gitops_pr` 动作（以 GitHub App 在 `srenautix/` 分支上提交补丁并开 PR，从不合并）已经在动作目录里，但没有任何东西生成补丁。常见的修复有四类：发布回退、配置与资源（副本数、HPA 上限、request/limit）、告警规则（阈值、持续时间、严重度）、拓扑与领域包覆盖。它们改的内容与仓库无关（"发布输入指回某个镜像 digest"、"某条告警规则的 severity"），改的位置却因仓库而异：同样的发布输入，一个仓库放在 `apps/<应用>/prod/release.json`，另一个放在 `apps/<应用>/release.json`；告警规则可能是一个 PrometheusRule 文件，也可能是一个目录下的多个 VMRule。为每个仓库写一套模板既重复，也无法在演示环境与生产环境之间复用测试。

## 决定

1. **模板属于领域包**（契约 2.13.0，`remediations.yaml` → `RemediationsFile`）。模板只引用仓库角色（例如 `gitops`）与文件角色（`release_input`、`autoscaling`、`workloads`、`alert_rules`、`pack_alerts` 等），并写明：适用条件 `when`（CEL：`incident`、`root`、`cards`、`alerts`、`params`）、计划时的输入（本包 metrics 信号的 instant 查询，`entity` 求查询的实体，默认根因）、可选的 Git 历史、`let` 与 `skip_if`、对文件角色的修改 `edits`、改动说明 `change`、验证计划 `verify`（合并同步后应判为正常的卡片与时限）与回滚方法 `rollback`。加载时检查 CEL、ICU 文案的参数、点路径语法、inputs 引用的信号与 verify 引用的卡片。
2. **布局属于 server 配置**：`remediation.repositories.<仓库角色>` 写仓库、基准分支与 `files`（文件角色 → 路径或 glob、`json`/`yaml` 格式、逻辑字段 → 点路径，契约 `RepositoryLayout`）。同一套模板在不同仓库上只靠布局区分；布局缺少模板用到的文件角色时模板跳过。模板中的 `files.<角色>` 总是文档列表（glob 匹配的全部文件与多文档 YAML 的全部文档展开），模板因此不依赖内容在一个文件还是多个文件里。
3. **计划在 packs-sdk**：`applicableRemediations(set, ctx)` 求适用的模板；`planRemediation(set, key, ctx, {repo, layout}, ds, at)` 读仓库、查输入、求值、修改文件并生成补丁，或返回跳过原因（`not_applicable`、`layout_missing`、`input_failed`、`evaluation_error`、`skip_if`、`target_not_found`、`ambiguous_target`、`no_change`）。仓库通过 `RepoReader`（`head`、`read`、`list`、`history`）读取：server 用 GitHub REST 实现（镜像里没有 git，ADR 0096），`GitRepoReader` 读本地克隆，用于测试与离线验证。计划不写任何仓库。
4. **补丁格式**：每个文件带 `diff --git` 头的 unified diff，直接作为 `gitops_pr` 的 `params.patch`；`base` 是计划读取的提交，用于 `base_head` 预检。修改只替换目标值（YAML 按 CST 范围原地替换，JSON 按原格式写标量），注释、缩进、键顺序与其他文档不变；每次修改后重新解析并核对值。目标不存在、不唯一或已经是目标值时模板跳过，不生成空补丁。
5. **上下文**：`research` 是触发计划的研判结论 `{disposition, level}`（契约 Disposition 与 ConclusionLevel），没有研判时为 null；`cards` 的键是卡片全局 id（`<包>/<链>/<卡>`），同一张卡在多个实体上执行时取最严重的结论（abnormal > undeterminable > normal）；`alerts` 是成员告警的 alertname、labels、annotations、entity 与契约 `AlertClassification` 的 role、source、catalog_entry、chronic；`incident` 是契约 Incident（模板用到 `components`）。
6. **内置 `gitops` 包**提供四类模板：`release-to-serving-version`（发布输入改回 Git 历史中最近一次指向就绪 Pod 镜像 digest 的版本；仓库被改回旧版本、集群仍在运行新版本时，这个动作就是前滚）、`hpa-max-replicas-raise` 与 `memory-limit-raise`、`noisy-alert-relax`（研判结论为不需要处理，或长期 critical 告警在没有症状告警的事件里触发时，降为 warning 并延长 `for`）、`alert-catalog-entry`（未命中告警目录的告警按工作负载、component 或 service 标签加条目）。阈值与卡片列表都是 `params`，可由用户层覆盖。

## 结果

- 模板测试在两种布局（多文档 YAML、规则目录 glob 与 VMRule；每类一个文件与 PrometheusRule）的 Git 仓库上生成补丁，补丁都能 `git apply --check` 到基准提交，应用后发布输入与目标提交的内容逐字节相同。
- 用户在自己的包里写模板时与内置模板受同样的加载检查；server 何时计划、PR 描述、审批与限速不在模板里。
- 证据卡函数库新增 `max_in(list, from, to)`，发布链的开始前后对比卡用它取窗口两侧的峰值。
