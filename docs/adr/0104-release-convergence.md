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
5. **没有锚点的告警归到变更**：拓扑中没有对象锚点、或只落在命名空间伪组件上的告警，在一次变更之后、变更窗口加时间相邻的范围内（默认 60 分钟）触发，且满足下面任一条时归到告警之前最近的那次变更：角色是 change（发布流水线、部署后检查之类）；告警的命名空间就是变更目标所在的命名空间；与已经归到这次变更的告警逻辑归属相同（同一个组件键，或同一个 `component` 标签）。归到不同变更的同名告警不再因同名而合并，两次发布各自的部署后检查分属两次发布。
6. **变更类候选的先验**：变更目标作为根因候选时使用 rca-params 的 `role_priors.change`（默认 1）与 `weights.recent_change`（默认 0.15），可在领域包或用户层覆盖；能解释全部症状的候选仍然排在前面。

## 回放

用这次事故的告警与拓扑做回放测试（影子环境 PostgreSQL 只读导出 16:00–19:00Z，脱敏后放在 `apps/srenautix/test/fixtures/incidents/release-rollout-2026-10-20.json`，只用内置领域包）：

- 从拓扑事件推导出 16:24 的发布，目标是 control、worker、gateway 与管理它们的 Argo 应用；
- 16:30–17:01 的发布相关告警（迁移等待、Init 过久、rollout 停滞、副本不可用、Argo 应用、PDB、发布流水线）都在 1 个事件里（验收要求不超过 2 个），这个事件同时包含 15:59 那次发布的 gateway 告警；根因是这次发布的目标（Argo 应用 `argocd/acme-prod`），事件的变更里有 16:24 的发布；
- 没有以 Pod 为根因或组件的事件；kube-state-metrics 导出的副本不可用告警落在 `Deployment:acme-prod/control` 与 `worker` 上。
- 同一窗口里与发布无关的事件（provider 延迟、Ops-Agent 模型不可用、错误预算、其他 Argo 应用的漂移）仍然各自成组。

## 结果

- 不配置变更源也能把发布作为根因候选；配置了变更源时两者一起参与收敛。
- 没有对象的告警只会归到它之前的变更，不会把没有变更的时段里的告警拉到一起；角色不是 change、也没有命名空间与逻辑归属关联的告警不受影响。
