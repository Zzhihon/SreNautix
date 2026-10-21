# 0126 修复模板按研判根因匹配，并展开到具体对象

## 背景

自愈 PR（ADR 0108）的上下文里只有一个根因，修复模板的 `when` 与 `inputs`、`let` 都按它判断与取数。发现环节的根因（事件根因）按收敛规则确定，常常是管理工作负载的对象：Kind 的 config-resource-oom（kind-e2e 39628044289）中，事件根因是 Argo Application `argocd/shop`，阶段 B 的结论是 likely，研判根因是 Deployment `shop/checkout`。`memory-limit-raise` 只对 Deployment、StatefulSet、DaemonSet 适用，要在根因工作负载上取 OOMKilled 的容器、改仓库里这个工作负载的内存 limit。

研判根因还有两种形态模板用不上：

- 研判结论可以停在 Service（流量入口）上，模板需要的是它背后的工作负载；
- 结论等级低于 likely 时（inconclusive、undetermined），研判根因只是排名第一的假设，用它改仓库没有依据。

`memory-limit-raise` 的 `when` 还要求 `workload/pod-restarts/memory` 卡异常。kind-e2e 39666613594 收集的卡片判定里，根因已经是 Deployment `shop/checkout`，这张卡在 checkout 的 Deployment 上是正常，在 Pod 上无法判定（没有工作集样本），模板因此不适用。原因有两层：

- 卡片的 OOM 信号 `container_oom_events` 按备选的顺序选中了 cAdvisor 的 `container_oom_events_total`。这个计数挂在容器的 cgroup 上，被 OOM 终止后马上被替换的容器常常来不及采到这次增长；kube-state-metrics 的最近终止原因 `OOMKilled` 在环境里也有，却没有被用上；
- Kind 的 checkout 把缓存写进内存卷（`emptyDir.medium: Memory`），内存卷在容器重启之间保留，第一次 OOM 之后每次重启都在容器初始化时失败（StartError，"container init was OOM-killed"），最近终止原因很快不再是 `OOMKilled`。场景的事实（eval/scenarios/config-resource-oom.yaml）是"新 Pod 反复 OOMKilled"。

## 决定

1. **根因的选择**（`remediationRootKey`）：研判结论的等级是 likely 或 evidence_consistent、并且给出了根因时，模板匹配与目标解析使用研判的 `root_component`；其余情况（`remediation.conclusions` 包含 inconclusive 时的低等级研判、没有根因的结论）使用事件根因。
2. **展开到具体对象**（`ComponentExpander.concrete`，按研判时刻的拓扑）：
   - 由控制器拥有的对象（Pod、ReplicaSet）沿 owned_by 取顶层属主；
   - Service 沿 selects 取它选中的 Pod，再取这些 Pod 的顶层属主；只有一个工作负载时展开为它，多个时保留 Service；
   - 其余组件是对象本身，uid 取拓扑节点。

   展开后的对象是上下文的 `root`（kind、namespace、name 与组件类型），模板的 `when`、`inputs` 的默认实体与 `let` 都用它。
3. **卡片不变**：上下文的卡片仍是事件当前版本阶段 A 报告的全部卡（全局 id 对应最严重的结论）。阶段 A 对每个成员告警的实体与告警归属的组件都执行证据链（ADR 0097），研判根因上的卡已经在其中。
4. **提议绑定不变**：提议的 `binding.root_component` 仍是事件根因，提议服务按事件核对绑定（ADR 0108 §13）。PR 标题与描述里的根因名称取第 1 条选出的根因。
5. **诊断**：每次处理写一行 info 日志 `自愈 PR 的模板匹配`，带展开后的根因、异常卡的 id 与适用的模板。kind-e2e 的诊断另收集每个事件版本的阶段 A 卡片判定（`stage-a-cards.tsv`）。
6. **OOM 信号取并集**：workload 包的 `container_oom_events` 的第一个备选是 cAdvisor 计数的增长与 kube-state-metrics 最近终止原因为 `OOMKilled` 的并集（按 namespace、pod、container 去重）；两个指标只有一个时用它。
7. **Kind 的 checkout 把缓存放在进程内存里**（常驻在 shell 变量里），不再用内存卷：缓存超过上限时每次启动都在预热中被 OOMKilled，与场景的事实一致。

## 结果

- 实现在 `apps/srenautix/src/remediation/service.ts`（`RESEARCH_ROOT_LEVELS`、`remediationRootKey`）与 `apps/srenautix/src/topology/expand.ts`；`TopologyStore` 增加 `targets`、`uidOf`；`packs/workload/signals.yaml` 与 `deploy/kind/gitops/apps/shop/workloads.yaml`。
- 集成测试（真实 PostgreSQL、Prometheus 与内存中的 GitHub）：事件根因是 Application、研判根因是 Deployment 时，`memory-limit-raise` 把 checkout 容器的限制从 32Mi 调到 48Mi，补丁只改这一行；结论为 inconclusive 时退回事件根因，没有适用模板；研判根因是 Service 时展开为它选中的 Deployment。
- 领域包测试（真实 Prometheus）：cAdvisor 计数没有增长、最近终止原因只在 2 分钟内是 `OOMKilled` 的 Pod，内存卡判为异常。
- 契约不变。
