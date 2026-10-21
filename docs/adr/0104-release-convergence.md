# 0104 发布事故收敛：从拓扑推导发布变更，Pod 告警归到工作负载，没有锚点的告警归到变更

## 背景

2026-10-20 16:30Z 的一次发布事故（16:24 control、worker 退回旧版本，新 Pod 卡在等待迁移的 initContainer，回滚失败）在影子环境里拆成了 15 个以上的事件：按 Pod（`pod:…/control-…`、`pod:…/worker-…`）、`Deployment:`、`application:argocd/…`、`Namespace:` 与 6 个 `unlabelled:`。原因：

1. 没有变更：没有配置变更源时引擎拿不到任何变更，发布不能成为根因候选；
2. Pod 级告警的组件是 Pod 本身，同一工作负载的不同 Pod 各成一组；
3. kube-state-metrics 导出的告警带的是导出器自己的 `pod`、`container` 标签，按标签推断把实体当成导出器的 Pod，找不到后落到命名空间伪组件；
4. 告警里 CRD 的 kind 不带 API 组（`application`），拓扑键带组（`Application.argoproj.io`），对不上；
5. 发布流水线、部署后检查这类告警没有对象（`entity_kind: none`），在拓扑里没有锚点，各自成组。

## 决定

1. **从拓扑推导发布**（`changes.kubernetes`，默认开启）：informer 与 reader 写入的拓扑事件里，工作负载（Deployment、StatefulSet、DaemonSet）的版本标签变化（默认 `app.kubernetes.io/version`、`helm.sh/chart`，可追加，例如 CCHP 的 `cchp.io/release-id`），以及属主早已存在的 Deployment 出现新的 ReplicaSet（Pod 模板变化），都是一次发布的组成部分。`group_within`（默认 2 分钟）内、同一版本取值或同一个管理应用（`managed_by`）的变化合成一次 changes/v1 变更：`source: kubernetes`、`kind: rollout`，目标是这些工作负载与管理它们的 Argo/Flux 应用，摘要写明哪个标签从什么变成什么。回滚到旧 ReplicaSet 时没有新的 ReplicaSet，只能从版本标签看出来。推导出的变更不落库，每次重算从拓扑事件计算，`change_id` 取第一条拓扑事件的序号，重复计算结果相同。
2. **Pod 级告警归到工作负载**：收敛时告警的组件沿 owned_by 取到顶层（Pod → ReplicaSet → Deployment），事件的成员与组件列表都用这个组件；实体仍是 Pod，证据卡照样按 Pod 执行。
3. **导出器的抓取标签不当成对象**：`job` 与 `container` 都是导出器名、`pod` 以它开头时，按标签推断与告警目录的 `name_labels` 都跳过 `pod`、`container`，改用 `deployment`、`poddisruptionbudget` 等描述对象的标签。新增 `poddisruptionbudget` 的推断。
4. **CRD kind 不带组也能找到拓扑节点**：查找拓扑节点时，没有点的 kind 也匹配 `<kind>.<组>`，实体的 kind 取拓扑里的写法。
5. **没有锚点的告警归到变更**：拓扑中没有对象锚点、或只落在命名空间伪组件上的告警，在一次变更之后、变更窗口加时间相邻的范围内（默认 60 分钟）触发，且满足下面任一条时归到告警之前最近的那次变更：角色是 change（发布流水线、部署后检查之类），并且这次变更有影响（至少一条有锚点的告警由它解释：在变更窗口内触发，组件就是或依赖变更目标）；告警的命名空间就是变更目标所在的命名空间；与已经归到这次变更的告警逻辑归属相同（同一个组件键，或同一个 `component` 标签）。归到不同变更的同名告警不再因同名而合并，两次发布各自的部署后检查分属两次发布。
6. **没有对象的告警归入逻辑组件**：解析不出对象、也没有命名空间、但带 `component` 标签的告警（发布流水线、业务主题之类）归入同名的逻辑组件 `component:<值>`（与领域包告警目录的 `kind: component` 相同），不再成为 `unlabelled` 事件。影子环境 48 小时内组件为空的 21 条告警全部属于这一类（`entity_kind: none`，component 为 provider、release、gateway），12 个 unlabelled 事件（占 56 个事件的 21%）都由它们产生。没有 `component` 标签、只带 `service` 标签的告警（业务主题的规则、聚合掉了命名空间的服务级规则，例如 Kind 的 `ShopCatalogStale{service="catalog"}`）同样归入 `component:<service>`，与领域包告警目录按 `service` 标签建条目一致；`component` 标签优先，带命名空间的告警仍归命名空间伪组件（抓取目标的 `service` 标签不当作逻辑组件）。
7. **变更类候选的先验**：变更目标作为根因候选时使用 rca-params 的 `role_priors.change`（默认 1）与 `weights.recent_change`（默认 0.15），可在领域包或用户层覆盖；能解释全部症状的候选仍然排在前面。

8. **变更输入覆盖仍可见的告警**：引擎（与 eval 的重建）读取的变更从 `changeInputFrom` 给出的时刻开始：仍在触发或在回看窗口内的告警中最早的开始时间，再往前一个变更窗口加时间相邻；不早于 24 小时前。变更与告警的关联本来就按告警的开始时间计算，之前只读"现在之前一个窗口"，发布一小时后离开输入，已经归到它的无对象告警（发布失败、回滚失败、worker 无可用副本）被拆成新的事件。
9. **告警的组件在接入时取顶层属主**：接入时找到的对象沿 owned_by 取到顶层属主（Pod → ReplicaSet → Deployment，含 24 小时内删除的边），写入告警的 `component`；实体仍是对象本身。收敛时对象还在拓扑里就按对象取属主（结果相同），对象已被删除（新版本替换了 Pod）时用接入时的属主，仍在回看窗口内的告警留在原来的事件里。集群状态检测器的去重相应地只把落在属主工作负载本身（实体不是 Pod）上的同类规则当作覆盖，同一工作负载其他 Pod 上的规则不算。

11. **informer 空窗时从 kube-state-metrics 推导发布**：server 重启、与 reader 断连、刚安装时，拓扑里没有这段时间新建的 ReplicaSet，发布推导不出来。2026-10-18 的一次发布就是这样：当天状态库没有 acme-prod 的 ReplicaSet，发布告警被归到另一个命名空间里无关的发布，工作负载告警被一个持续两天的节点事件吸收。
    - `changes.kubernetes.ksm_fallback`（默认开启）从证据数据源的 kube-state-metrics 补上，用到 `kube_replicaset_created`、`kube_replicaset_owner{owner_kind="Deployment"}` 与 `kube_deployment_created`，取窗口内的最后一个值。
    - 满足以下条件的 ReplicaSet 视为一次发布：在 [from, to] 内创建；属主 Deployment 的创建时间早于它一分钟以上；拓扑里从来没有记录过。
    - 管理应用取拓扑里属主的 `managed_by` 边，经同一个 `deriveRollouts` 合成发布变更。`change_id` 为 `kubernetes:<集群>:ksm-<哈希>`，与拓扑事件的序号不冲突。
    - 拓扑里记录过的 ReplicaSet 仍只由拓扑事件推导，两个来源不重复。
    - 只对本集群；数据源不可用时跳过，结果缓存一分钟。
    - eval 的重建用同样的规则（ADR 0110）。

10. **依赖合并要求开始时间相近**：不同对象上的两条告警只因依赖关系合并时，开始时间相差不能超过时间相邻的 4 倍（默认 2 小时）。已经持续触发数小时的告警（资源请求接近上限、全天的扩容顶格）不是之后才开始的新故障的起因；没有这条时，正确解析到 CNPG Cluster 的 WAL 归档失败经 Pod 运行在的节点被前一晚开始的节点容量事件吸收，全天的 HPA 顶格事件也吸收过发布事故。

12. **同一组件的不同对象按依赖关系合并**：两条告警落在同一组件的不同对象上（CNPG 集群的主库与备库 Pod、同一 Deployment 或 StatefulSet 的不同 Pod），开始时间相差不超过时间相邻的 4 倍时合并，与第 10 条的依赖合并相同。ADR 0012 只合并同一实体，或一方可达另一方的告警。同一组件的 Pod 之间没有依赖边，Pod 的告警归到工作负载之后（第 2、9 条），同一个根因就分成了几个事件：2026-10-15 的 CNPG 主库 OOM 故障里，cchp-postgres-2 的 OOM 与主库重启是一个事件，cchp-postgres-1 的 postmaster 重启是另一个，两个事件的根因都是 Cluster；2026-10-14 发布后的抓取失败里，gateway 的 3 个 Pod 与 control 的 2 个 Pod 各自成为事件。枢纽（每个节点上都有的 CNI 之类）与命名空间伪组件除外，它们的不同对象常常各自出故障；归到不同变更的告警也不因此合并。在 17 个标注故障的发现重放上，事件数平均从 2.35 降到 2.12，通过数从 11 增加到 12，没有变差的用例。

13. **发布之前的 Job 是发布的第一步**：CCHP 的发布先由 Argo 的 PreSync 跑迁移 Job（`cchp-migrate-<sha>`），新的 ReplicaSet 要等迁移结束才出现，晚 5 到 10 分钟。故障往往在迁移期间开始，比如 2026-10-19 的死锁、旧 gateway-3 等待迁移，以及 2026-10-16 worker 的 CrashLoop。变更只解释它之后开始的告警，所以这些告警被拆成单独的事件（release-migration-deadlock 4 个事件，onboarding-rls-window 3 个）。
    - **候选**：发布开始之前 30 分钟内新建的 Job，CronJob 创建的除外（属主来自 kube_job_owner 或 informer 的 owned_by）。
    - **三档判定**，按顺序：
      1. **managed_by**：Job 有 managed_by 边时，管理它的应用必须与发布的相同，不同就不挂，也不再往下判定。
      2. **镜像**：Job 没有 managed_by 时，比较它的 Pod 镜像与发布新 ReplicaSet 的 Pod 镜像，digest 或 tag 相同就挂，不同就不挂。镜像来自 Pod 节点的 `images`（契约 2.19.0），kube-state-metrics 历史由 `kube_pod_container_info` 填写。迁移 Job 与 control、worker 用同一个 sha 的镜像，这条信号比命名空间可靠，也能排除同一命名空间里无关的一次性 Job。
      3. **命名空间与时间窗**：前两档都没有数据时（Job 或新 ReplicaSet 的 Pod 没有镜像），Job 与发布的工作负载在同一命名空间，并且这次发布的窗口里只有这一个候选 Job，才挂上。
    - **挂上之后**：发布的时间提前到 Job 新建的时刻，Job 加入发布的目标；`change_id` 不变。变更带上 `attachments: [{target, basis}]`（契约 2.19.0），摘要里写明依据。每个 Job 只挂到它之后最近的那次发布。
    - **弱推导的风险**：第 3 档是按命名空间与时间窗推断的，同一命名空间里一个与发布无关的一次性 Job 会让发布的开始时间提前，并把这个 Job 上的告警归到发布。所以只在窗口里只有一个候选 Job 时才挂，并标为 `namespace_window`，研判与控制台能看出这是弱推导。第 2 档也有一个已知的误判：所有 Pod 都带同一个边车镜像时，镜像比较会把无关的 Job 挂上。
    - **数据来源**：kube-state-metrics 历史重建增加 `kube_job_owner` 与 `kube_pod_container_info`（core `KSM_TOPOLOGY_QUERIES`），server 的状态库与 eval 的重建用同一个 `deriveRollouts`。

    **在重建包上的结果**：两个包都还没有镜像数据（导出时还没有 `kube_pod_container_info`），也没有 kube_job_owner。两次发布的窗口里各有两个候选 Job（`cchp-migrate-<sha>` 与 `cchp-migstat-<sha>-<n>`），按第 3 档都不挂，17 个标注的发现结果不变。把两个 Job 的镜像设为与新 ReplicaSet 相同来模拟第 2 档：
    - release-migration-deadlock：发布时间从 06:27:10 提前到 06:20，gateway 的三条故障告警归到发布，事件数从 4 个降到 3 个，根因是 Argo 应用；
    - onboarding-rls-window：发布时间从 05:45 提前到 05:40，worker 告警归到发布，根因是 Argo 应用。
    
    重新导出（带镜像）之后由 eval 确认。

## 回放

用这次事故的告警与拓扑做回放测试（影子环境 PostgreSQL 只读导出 16:00–19:00Z，脱敏后放在 `apps/srenautix/test/fixtures/incidents/release-rollout-2026-10-20.json`，只用内置领域包）：

- 从拓扑事件推导出 16:24 的发布，目标是 control、worker、gateway 与管理它们的 Argo 应用；
- 16:30–17:01 的发布相关告警（迁移等待、Init 过久、rollout 停滞、副本不可用、Argo 应用、PDB、发布流水线）都在 1 个事件里（验收要求不超过 2 个），这个事件同时包含 15:59 那次发布的 gateway 告警；根因是这次发布的目标（Argo 应用 `argocd/acme-prod`），事件的变更里有 16:24 的发布；
- 没有以 Pod 为根因或组件的事件；kube-state-metrics 导出的副本不可用告警落在 `Deployment:acme-prod/control` 与 `worker` 上。
- 同一窗口里与发布无关的事件（provider 延迟、Ops-Agent 模型不可用、错误预算、其他 Argo 应用的漂移）仍然各自成组。

2026-10-18 的一次发布在重建中还暴露了另一种错误归属：当天没有推导出 acme-prod 的发布，唯一的变更是另一个命名空间里 grafana 的发布（没有任何告警），没有对象的发布告警因为角色是 change 就归到了它。所以角色为 change 的告警只归到有影响的变更；没有影响的变更不吸收它们，它们按逻辑组件（例如 component:release）成组。

eval 用真实数据重建同一次事故（每 30 秒重算，16:24 回退之后 18:37 再次发布），第 8、9 条之前是 3 到 4 个事件：16:24 的发布 17:24 离开变更输入，发布告警与 worker 无可用副本告警被拆出；18:37 替换 Pod 之后，旧 Pod 上的迁移等待告警被拆出。之后是 1 个事件，根因是 Argo 应用。脱敏、只保留发布涉及的命名空间的重建包与标注放在 `apps/srenautix/test/fixtures/eval/`，`test/unit/release-reconstruct.test.ts` 按 eval 的重建方式回放（只用内置领域包）。在 17 个标注故障上没有变差的用例。

## 结果

- 不配置变更源也能把发布作为根因候选；配置了变更源时两者一起参与收敛。
- 没有对象的告警只会归到它之前的变更，不会把没有变更的时段里的告警拉到一起；角色不是 change、也没有命名空间与逻辑归属关联的告警不受影响。
