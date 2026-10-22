# 0139 修复模板按根因自己的卡适用

## 背景

ADR 0138 让代码推导处置，适用的修复模板可以支撑 act，重建评测也按模板匹配统计 PR 触发。用 aq-full3 的 102 份 trace 离线重算之后，模板匹配暴露出过宽的问题（Zzhihon/SreNautix#10）。CCHP 影子环境已经打开自愈 PR，带着这些问题上线会对 CCHP 开出错误的 PR。

- **`release-to-serving-version` 只看全局的卡**：上下文的 `cards` 是阶段 A 全部卡按卡片 id 取最严重的结论（ADR 0126 §3），模板的 `when` 只问"有没有任何一张 init 或 ReplicaSet 卡异常"。事件里只要有一个工作负载卡住，任何根因都适用：onboarding 的处置依据里，Node、PVC、HPA、PodDisruptionBudget、Service、Workflow 与几十个 Argo 应用都列着这个模板。
- **init 卡把正常启动算成"反复失败"**：`workload/release/init-waiting` 的第二条规则数 `kube_pod_init_container_status_waiting_reason` 在窗口内出现过的 init 容器，没有区分原因。新 Pod 的 init 容器在创建之后、开始运行之前处于 `PodInitializing`（或 `ContainerCreating`），滚动发布时 kube-state-metrics 常常正好采到这一刻，窗口内的最大值就把正常启动判成"1 个 init 容器在反复失败"。10-14 metrics-scrape 的 gateway 就是这样：Kubernetes 事件里 gateway-1、gateway-0 的 init 容器 05:09:44、05:10:29 启动，4 到 5 秒后主容器启动，整个窗口没有 BackOff 或 Failed 事件，卡片却判为异常。onboarding 的 worker 上这张卡也是同样的"反复失败"、运行时长 0，研判根因是 worker 时发布回退模板因此适用，处置从 escalate（正确）变成 act。
- **外部上游被判为 ignore 时 `noisy-alert-relax` 也适用**：它对"研判为 ignore、有 critical 告警"的事件提议把告警降为 warning。ADR 0138 之后 provider 用例的 ignore 依据是"根因是集群外部组件"，于是 CCHPProvider* 的 critical 告警被提议降级，离线重算里 alert_rule 误触发 primary 10、fallback 11 次。外部上游真的出故障时告警本身是对的，"集群内没有可处置的对象"不说明告警误报。
- **`memory-limit-raise` 读的也是全局的卡**：根因是工作负载、全局的内存卡异常就适用，被 OOMKilled 的可以是事件里任何一个 Pod。
- **HPA 良性用例没有"没有到瓶颈"的依据**（ADR 0138 遗留）：`hpa-utilization` 只看 CPU 相对 HPA 目标值，业务高峰把 gateway 的 CPU 推到目标的 167% 就判为饱和，`hpa-max-replicas-raise` 随之适用；限流（0.2%）正常，延迟卡因为 CCHP gateway 没有 `http_request_duration_seconds` 而无法判定。没有任何卡是影响卡，影响卡依据从不成立。
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
4. **`memory-limit-raise` 只看根因工作负载的内存卡**：`root_cards` 中的 `workload/pod-restarts/memory` 异常才适用。别的工作负载（例如 pg-lock 中被 OOMKilled 的 postgres Pod）的内存卡异常时，不提高研判根因（seaweedfs-master）的 limit。
5. **`noisy-alert-relax` 不对外部上游降级**：模板根因的组件类型声明为 `external`（上下文的 `root.external`）时不适用。研判以外部组件为根因判为 ignore（ADR 0138 的 external 依据）时，模板根因就是这个外部组件，所以"处置依据是外部上游"也被这一条挡住。根因不是外部组件时有两种依据：
   - 研判结论为 ignore（ADR 0138 起只按确定性依据给出：阶段 A 的 ignore、没有异常卡、影响卡全部正常），并且有 critical 告警。Kind 的 alert-too-sensitive（一次正常的容器重启触发 critical 告警）走这一条；
   - 告警在 7 天内反复触发（chronic）、以 critical 触发，并且事件的影响卡全部正常：至少有一张影响卡，没有一张异常或无法判定。原来的"事件中没有症状告警"由影响卡取代：症状告警说明有告警在响，影响卡说明用户是否真的受影响。没有任何影响卡的事件不适用。

   上下文的卡带上卡片定义的 `impact` 标记。
6. **HPA 饱和要求限流或变慢**：`workload/capacity/hpa-utilization` 改为判断负载是否饱和：伸缩指标超过目标的 `params.over` 倍，并且伸缩对象的 CPU 限流超过 `params.ratio`、或 p95 延迟超过一天前的 `params.factor` 倍（与 `hpa-throttling`、`hpa-latency` 的阈值相同）。限流与延迟没有数据时按"没有证据"处理，只用另一项判断；超过目标、没有限流、延迟直方图饱和时无法判定。`hpa-throttling` 与 `hpa-latency` 标为影响卡。`hpa-max-replicas-raise` 要求根因 HPA 自己的 `hpa` 与 `hpa-utilization` 都异常：副本数顶到上限、负载没有饱和时上限只是没有余量，不提高上限，影响卡全部正常时处置推导可以按 ADR 0138 的影响卡依据给出 ignore。
7. **用户包补充内置包的信号**（契约 2.26.0）：领域包的信号增加 `extends: <包>/<信号 id>`，补充的备选排在被补充信号原有的备选之前，引用它的卡按合并后的备选探测与查询。只能补充别的包里、本身不是补充的信号，类型必须相同。包的测试可以用完整的卡键测试别的包的卡。CCHP 的 gateway 没有 `http_request_duration_seconds`，cchp 包用它为 `workload/hpa_target_latency_p95` 与 `_baseline` 补充 gateway 自身的阶段耗时（`cchp_gateway_stage_duration_seconds`，auth、parse、plan），`hpa-latency` 与 `hpa-utilization` 不必复制到 cchp 包。没有采用"组件类型替换信号"这类按实体选择备选的做法：备选的探测按数据源进行，按实体选择要改运行时，补充的表达式用 `and on ()` 限定实体就够了。

## 结果

- 实现：`packages/packs-sdk/src/remediation/{plan,compile}.ts`（`root_cards`、`RemediationCard` 的 `observations` 与 `impact`）、`packages/packs-sdk/src/pack/compile.ts`（`extends`）、`testing/pack-test.ts`；`apps/srenautix/src/remediation/{facts,render,service}.ts`、`api/routes-research.ts`、`roles/server.ts`、`eval/{reconstruct,phase2}.ts`；`packs/gitops/remediations.yaml`、`packs/workload/{signals,chains}.yaml`。契约 2.26.0：`pack.schema.json` 的 `Signal.extends`。
- 测试：`RootCardScope` 的归属与缓存、`root.external`、卡的 `impact` 与 `observations`（单元）；发布回退模板在节点根因与根因上正常时不适用、StatefulSet 发布进度卡按 `missing` 适用、内存模板只看根因、告警调优模板对外部根因与影响卡不正常时不适用、HPA 模板要求饱和（packs-sdk，真实 Prometheus）；另一个工作负载 OOMKilled 时内存模板不适用（集成，真实 PostgreSQL）；init 卡在 `PodInitializing` 下正常、CrashLoopBackOff 下异常，HPA 高峰没有限流与变慢时不饱和（workload 夹具）；用户包补充 HPA 延迟信号后内置的 hpa-latency 卡能判定（packs-sdk）。
- CCHP 的 cchp 包用 `extends` 补充 gateway 的延迟信号，要在影子环境升级到契约 2.26.0 之后部署。

### Kind 的 shop 补上影响卡

kind-e2e 39719813915（48747db）的 alert-too-sensitive 发现与分析通过（1 个事件，根因 `Deployment:shop/api`，30 张卡，likely），600 秒内没有开出 PR，自愈记录为 `no_template`。服务端日志的模板匹配：根因上异常的卡是 spec 变更、重启、未就绪与容器等待，适用模板为空。原因不在模板：

- 录制的研判给出 ignore，处置推导（ADR 0138）把它改成了 escalate。阶段 A 没有判为 ignore，根因不是外部组件，有异常卡（一次重启本来就会让重启、未就绪卡异常），而 shop 没有任何影响卡：shop 是 nginx，没有 `http_requests_total` 与 `http_request_duration_seconds`，`workload/release-traffic` 没有挂上，内置包里的影响卡只有 HPA 的两张。四种依据都不成立。
- `noisy-alert-relax` 的研判一支要求 `research.disposition == "ignore"`，模板拿到的是推导后的 escalate，所以不适用。dd85e76 之前处置直接取模型的 ignore，场景因此是绿的。

修法是让 Kind 的 shop 给出影响卡，模板与处置推导不变：

- **不放宽模板或推导**。"告警太敏感"的含义是告警响了而用户没有受影响；没有影响卡时，"一次重启"与"用户正在受影响而集群里看不出来"无法区分。如果把"没有影响卡"当成没有影响（例如对非外部根因放开研判一支，或者在没有影响卡时取模型的 ignore），ignore 就重新依赖模型的判断，第 5 条与 ADR 0138 收紧的正是这一点：provider 用例的 critical 告警在集群内同样没有影响卡，模型给出 ignore 时会再次被降级。生产领域包要让这个模板适用，也必须先给出用户侧的影响卡，Kind 应当演示这条要求，而不是绕开它。
- **影响取自外部客户端**。`traffic/loadgen` 原来就持续经 web 访问 api 的 `/catalog`；它改为按结果计数 `shop_client_requests_total{target="web", result="ok|failed"}`（超时 5 秒与非 2xx 都算失败），由同一 Pod 中的 busybox httpd 以 CGI 输出、PodMonitor 抓取。给 nginx 加导出器只能看到 nginx 自己的状态码，看不到客户端超时，也会改动 shop 的镜像与资源，影响 HPA 与发布场景。
- **kind-shop 包的影响卡**：信号 `client_failure_ratio`（失败请求的比例，用 `and on ()` 限定在 shop 的 web 与 api 上，其余实体没有数据）、证据链 `traffic` 与卡 `client-errors`（`impact: true`，峰值超过 5% 为异常），挂在客户端请求路径上的 web 与 api；组件类型 `shop.app` 拆成 `shop.api` 与 `shop.checkout`，checkout 不在路径上，没有影响卡。包从 0.1.0 升到 0.2.0，卡有夹具（`tests/client-errors.yaml`），`packages/packs-sdk/test/kind-shop-pack.test.ts` 把它与内置包一起编译，在 Prometheus 与 VictoriaMetrics 上执行。
- 其余场景：api 或 web 不可用时（CrashLoopBackOff、NetworkPolicy、CoreDNS、数据库 OOM）客户端请求失败，影响卡异常，不会得出 ignore；发布与配置场景有适用的修复模板，ignore 不带修复，处置不受影响卡影响。

`apps/srenautix/test/unit/alert-too-sensitive.test.ts` 用 39719813915 的 30 张卡复现：没有影响卡时处置为 escalate、模板不适用；加上 api 与 web 上正常的 `kind-shop/traffic/client-errors` 之后处置为 ignore（依据 `impact_normal`），只有 `noisy-alert-relax` 适用；影响卡异常或根因是外部组件时不适用。

## 验证

隧道断开期间不能重建阶段 A（证据卡要查 CCHP 的 VictoriaMetrics），离线重算改为从每个用例 trace 的第一次 hypothesize 提示词取阶段 A 的卡（完整放入与只列判定的卡的并集；只写摘要的卡都是正常或无法判定、且不在候选根因上），经伪造的证据执行器交给被测提交的 `reconstructCase`，事件、告警与拓扑仍按被测提交从重建包重放。用 dd85e76 自己跑这个方法，102 行的处置、模板匹配与处置依据与 dd85e76 用 VictoriaMetrics 重建的结果逐行相同。

规则改变而没有原始序列的卡按提示词里的结论与展示值推出新结论：init 卡只因"反复失败"判为异常、运行时间不到 10 分钟的改为正常（metrics-scrape 由 10-14 的事件证实；10-16 的事件没有导出，onboarding 的 worker 按同一机制处理）；`hpa-utilization` 在同一 HPA 的限流与延迟卡都不异常时改为正常；发布进度卡的 `missing` 取展示值。

| 路由 | top-1 | 召回@3 | 选择性准确率 | 良性误报 | pass^3 | 处置准确率 | 良性 ignore | 模板 PR 触发 | 误触发（按类别） |
|---|---|---|---|---|---|---|---|---|---|
| primary dd85e76 | 34/45 | 38/45 | 34/39 | 0 | 10/17 | 18/48 | 2/6 | 8/21 | alert_rule 10、release_rollback 7、config_resource 3、topology_coverage 2 |
| primary 本 ADR | 34/45 | 38/45 | 34/39 | 0 | 10/17 | 17/48 | 2/6 | 6/21 | release_rollback 3、topology_coverage 2 |
| fallback dd85e76 | 36/45 | 38/45 | 36/39 | 0 | 10/17 | 19/48 | 2/6 | 5/19 | alert_rule 11、release_rollback 8、config_resource 3、topology_coverage 2 |
| fallback 本 ADR | 36/45 | 38/45 | 36/39 | 0 | 10/17 | 20/48 | 2/6 | 5/19 | release_rollback 2、topology_coverage 2 |

- alert_rule 误触发归零：provider 用例的研判根因是声明为 external 的 provider。
- onboarding fallback-1 回到 escalate：worker 自己的 init 卡不再异常，没有发布回退模板。只按有事件证据的用例改 init 卡（onboarding 的 worker 保持原结论）时它仍是 act，fallback 处置准确率 19/48。
- primary 处置准确率 18 → 17：metrics-scrape primary-0 的模型给出 act、没有提议，dd85e76 里它的 act 只由 gateway 上误判的 init 卡带出的发布回退模板支撑（标注没有仓库修复，事故的修复是抓取配置）。init 卡改正后 act 没有依据，按严重度改为 undetermined。两条路由合计 37/96 不变。
- primary 模板 PR 触发 8 → 6：pg-lock primary-1、primary-2 的研判根因是 seaweedfs-master，被 OOMKilled 的是 cchp-postgres-2，内存模板不再按别的工作负载的卡适用。
- 业务高峰 HPA 仍不是 ignore：重建数据里 gateway 的延迟卡无法判定（cchp 包的 `extends` 还没有部署），影响卡不是全部正常。假设延迟卡为正常时，primary 的 3 次（没有提议）给出 ignore，良性 ignore 2/6 → 5/6；fallback 的 3 次有模型提议，仍为 act。这 3 次 ignore 会让 `noisy-alert-relax` 对 KubeHpaMaxedOut 适用（根因不是外部组件），标注把它记为误触发；是否需要对业务高峰下的 critical 告警降级留给领域包与标注决定。
