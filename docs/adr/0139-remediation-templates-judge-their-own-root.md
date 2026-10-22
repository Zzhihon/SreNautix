# 0139 修复模板按根因自己的卡适用

## 背景

ADR 0138 让代码推导处置，适用的修复模板可以支撑 act，重建评测也按模板匹配统计 PR 触发。用 aq-full3 的 102 份 trace 离线重算之后，模板匹配暴露出过宽的问题（Zzhihon/SreNautix#10）。CCHP 影子环境已经打开自愈 PR，带着这些问题上线会对 CCHP 开出错误的 PR。

- **`release-to-serving-version` 只看全局的卡**：上下文的 `cards` 是阶段 A 全部卡按卡片 id 取最严重的结论（ADR 0126 §3），模板的 `when` 只问"有没有任何一张 init 或 ReplicaSet 卡异常"。事件里只要有一个工作负载卡住，任何根因都适用：onboarding 的处置依据里，Node、PVC、HPA、PodDisruptionBudget、Service、Workflow 与几十个 Argo 应用都列着这个模板。
- **init 卡把正常启动算成"反复失败"**：`workload/release/init-waiting` 的第二条规则数 `kube_pod_init_container_status_waiting_reason` 在窗口内出现过的 init 容器，没有区分原因。新 Pod 的 init 容器在创建之后、开始运行之前处于 `PodInitializing`（或 `ContainerCreating`），滚动发布时 kube-state-metrics 常常正好采到这一刻，窗口内的最大值就把正常启动判成"1 个 init 容器在反复失败"。10-14 metrics-scrape 的 gateway 就是这样：Kubernetes 事件里 gateway-1、gateway-0 的 init 容器 05:09:44、05:10:29 启动，4 到 5 秒后主容器启动，整个窗口没有 BackOff 或 Failed 事件，卡片却判为异常。onboarding 的 worker 上这张卡也是同样的"反复失败"、运行时长 0，研判根因是 worker 时发布回退模板因此适用，处置从 escalate（正确）变成 act。
- **StatefulSet 没有"滚动停在半路"的卡**：`replicasets` 卡只适用于 Deployment，gateway（StatefulSet）的发布卡住只能靠 init 卡判断。只看根因自己的卡之后，release-rollback-failed 中 gateway 为根因的运行会失去这个模板，而那次事故的标注修复正是发布回退。

## 决定

1. **根因自己的卡**：模板上下文增加 `root_cards`，形状与 `cards` 相同，只含属于模板根因（ADR 0126 选出、展开到具体对象的根因）的卡。一张卡属于根因，当它的实体沿 owned_by 的顶层属主
   - 就是根因：根因本身、它拥有的 ReplicaSet 与 Pod；
   - 由根因管理：根因是 Argo 或 Flux 应用时，managed_by 指向它的工作负载及其 Pod；
   - 管理根因：管理根因的 GitOps 应用本身的卡（不含这个应用管理的其他对象）；
   - 根因是逻辑组件时（没有拓扑上的属主与成员，ADR 0104 §6），是事件组件中的工作负载，与发布回退模板取正在服务的版本的实体（`inputs.serving`）相同。

   server 的自愈 PR、研判输入的处置依据与重建评测都用 `RootCardScope`（`remediation/facts.ts`）计算，属主与管理应用分别取 `TopologyStore.ownerOf` 与 managed_by 边（重建评测取重建拓扑的同名关系）。`cards` 不变，仍是全局的卡。
2. **`release-to-serving-version` 只看 `root_cards`**：`params.stuck_cards`（init 与 ReplicaSet 卡）在根因上有一张异常，或者 `params.rollout_cards`（Deployment、StatefulSet、DaemonSet 的发布进度卡）在根因上异常、并且判定明细 `missing`（窗口结束时未就绪或不可用的副本数）大于 0。只因 spec 变更判为异常的发布进度卡不算。为此上下文的卡带上判定明细 `observations`（契约 EvidenceResult.observations，同一张卡取最严重的那一份结果的明细）。
3. **init 卡只数失败**：`workload` 包的 `init_container_waiting` 排除等待原因 `PodInitializing` 与 `ContainerCreating`，只数 CrashLoopBackOff、拉取镜像失败、配置错误等失败原因。

## 结果

- 实现：`packages/packs-sdk/src/remediation/{plan,compile}.ts`（`root_cards`、`RemediationCard.observations`）、`apps/srenautix/src/remediation/{facts,render,service}.ts`、`api/routes-research.ts`、`roles/server.ts`、`eval/{reconstruct,phase2}.ts`；`packs/gitops/remediations.yaml`、`packs/workload/signals.yaml`。契约不变。
- 测试：`RootCardScope` 的四种归属与缓存（单元）、发布回退模板在节点根因与根因上正常时不适用、StatefulSet 的发布进度卡按 `missing` 适用（packs-sdk，真实 Prometheus）、init 卡在启动时的 `PodInitializing` 下正常、CrashLoopBackOff 下异常（workload 夹具）。
- 离线重算见 Zzhihon/SreNautix#10 的关闭评论与下文"验证"。

## 验证

隧道断开期间不能重建阶段 A（证据卡要查 CCHP 的 VictoriaMetrics），离线重算改为从每个用例 trace 的第一次 hypothesize 提示词取阶段 A 的卡（完整放入与只列判定的卡的并集；只写摘要的卡都是正常或无法判定、且不在候选根因上），经伪造的证据执行器交给被测提交的 `reconstructCase`，事件、告警与拓扑仍按被测提交从重建包重放。用 dd85e76 自己跑这个方法，102 行的处置、模板匹配与处置依据与 dd85e76 用 VictoriaMetrics 重建的结果逐行相同。

规则改变而没有原始序列的卡按提示词里的结论与展示值推出新结论：init 卡只因"反复失败"判为异常、运行时间不到 10 分钟的改为正常（metrics-scrape 由 10-14 的事件证实；10-16 的事件没有导出，onboarding 的 worker 按同一机制处理）；发布进度卡的 `missing` 取展示值。
