# 0138 处置由代码按确定性依据推导

## 背景

CCHP 重建评测 aq-full3（17 个用例 × 2 条路由 × 3 次，e551886 / e0f58b2）的分析环节里，top-1、召回@3 与 pass^k 达标，处置相关的三项不达标：

- **良性用例 0/6**：两个良性用例（provider-ttft-p99-benign、business-peak-hpa-benign）每次都给出 likely 的根因，处置是 escalate 或 act，没有一次 ignore。根因在外部上游服务方、标注为 ignore 的三个 provider 用例（lcodex、zzone、zhiyuan）也全部是 escalate。
- **处置准确率**：primary 3/48，fallback 9/48。
- **PR 触发 0/29**。

逐条看 trace 的结论：

1. **ignore 完全依赖模型自己判断**。ADR 0123 把 ignore 的四个条件写进了 conclude 的提示词，代码对 ignore 不做任何推导，只在观测失明时改为 escalate。模型对 critical 事件几乎从不给 ignore：provider 用例 27 次有结论的运行中，模型 25 次给 escalate、2 次给 act。集群里也没有任何确定性的"外部上游"依据：领域包的组件类型不能声明组件在集群之外，provider 的 fleet 卡（同时故障的 provider 数）在 4 个 provider 用例里都是异常，它的语义是"更像网关或出口侧"，反而与外部上游相反。
2. **"资源没有到瓶颈"没有确定性依据**。HPA 良性用例的阶段 A 卡：HPA 上限异常（副本数到顶）、`hpa-utilization` 异常（CPU 达到目标值的 167%，卡片按"超过目标 1.1 倍即饱和"判定）、`hpa-throttling` 正常（0.2%）、`hpa-latency` 无法判定（CCHP gateway 没有 `http_request_duration_seconds`）。按卡片自己的定义负载已经饱和，标注说"没有到瓶颈"的两条依据里，延迟这一条在重建里拿不到。TTFT 良性用例的 `slow-ratio` 卡无法判定（10-16 时 `cchp:upstream_ttft_slow_*` 记录规则还不存在），故障率卡异常（20%）。证据卡没有给出"没有到瓶颈"的依据，提示词也就无从让模型据此给 ignore。
3. **act 的校验不认修复模板**。自愈 PR（ADR 0108、0126）由 server 按修复模板生成，模型的动作目录里没有 `gitops_pr`。校验规则"act 没有有效提议或规则提议时按严重度改写"把需要改仓库配置、并且有适用模板的 act 一律改成 escalate 或 undetermined：fallback 有 12 次 act 因此被改写。
4. **PR 触发 0/29 是度量口径**。重建评测只数研判输出里 `action_id = gitops_pr` 的提议，而 `gitops_pr` 从不在模型的动作目录里（提议只能取目录里的动作），所以这个比例在重建模式下恒为 0，不反映修复模板是否适用。

## 决定

1. **处置由代码推导**（`research/disposition.ts`，在结论阶梯之后执行）：模型给出的处置是输入之一，与档位、选中的根因、有效提议数、全部证据卡与处置依据一起决定最终处置。`validateConclusion` 不再判断处置。
2. **观测失明**时一律 escalate（不变）。
3. **ignore 只按确定性依据给出**，不论模型给出什么。依据有四种，按顺序取第一种成立的：
   - 阶段 A 已判为 ignore（`suppressed`、`pack_exclude`、`forecast_or_chronic_only`）；
   - 选中的根因、结论 likely 及以上，并且它的组件类型由领域包声明为集群外部（`external: true`，见第 6 条）；
   - 领域包规则判定的卡中至少一张得出结论，并且没有任何异常卡（只读工具结果由小模型判定的卡不算确定性证据）；
   - 有影响卡（卡片定义 `impact: true`），并且影响卡全部正常。

   四种依据都要求：没有有效提议、没有规则提议、修复模板使用的根因上没有适用的修复模板。也就是 **ignore 不带修复**：有任何一项时不给 ignore。模型给出 ignore 而依据不成立时，按严重度改写（critical 为 escalate，其余为 undetermined），`validation_notes` 写明缺的是哪一项。
4. **act 需要修复**：选中了根因，并且有一条有效提议、一条规则提议，或者修复模板使用的根因上有适用的修复模板，三者至少一项；都没有时按严重度改写。修复模板使用的根因与 ADR 0126 相同（结论 likely 及以上取研判根因，否则取事件根因）。只有 `release_rollback`、`config_resource` 两类算修复；`alert_rule`、`topology_coverage` 是告警与领域包的维护，不能支撑 act。
5. **escalate 与 undetermined** 保持模型的取值。代码只在依据成立时把处置改为 ignore，不把 escalate 提升为 act。
6. **处置依据由 server 计算**，写进研判输入的 `disposition_facts`（重建评测写进快照的 `context.disposition_facts`，契约 2.25.0）：
   - `external`：候选根因中组件类型声明为集群外部的组件。领域包的组件类型新增 `external`（默认 false）：组件在集群之外（例如外部 API 服务方），集群内没有可处置的对象；
   - `remediations`：每个候选根因上适用的修复模板，上下文与自愈 PR 相同（根因展开到具体对象、阶段 A 的卡、成员告警），按"研判以它为根因、结论 likely、处置 act"求值适用条件，只保留启用的类别中的修复两类。没有启用自愈 PR（或没有配置 GitHub App）时为空。
   - 候选根因依次是事件根因、候选根因、事件组件、逻辑组件映射出的对象、邻域里不由控制器拥有的对象，最多 40 个。
   - conclude 的提示词只列出账本中未被推翻的假设的根因里的外部组件与适用模板，处置的说明改为"代码按确定性依据推导"。旧版 server 没有这个字段时，处置只按提议与阶段 A 推导。
7. **评测的 PR 触发按模板匹配计算**：重建评测对每次运行按它的研判结论（根因、档位、处置）求值修复模板的适用条件，只匹配，不读仓库、不计划、不推送。标注有仓库修复、结论 likely 及以上的运行中，标注修复类别的模板适用即为触发；标注没有仓库修复的运行中适用的模板按类别记为误触发。原来按 `gitops_pr` 提议计算的三项保留。

## 结果

- 实现：`apps/srenautix/src/research/disposition.ts`（推导）、`remediation/facts.ts`（依据的计算与模板匹配，`RemediationService` 的根因展开也改用它）、`api/routes-research.ts`、`research/{controller,validate,prompt,service,hub,types}.ts`、`prompts/{zh,en}.ts`、`eval/{reconstruct,phase2,remediation,leakage,runner,score}.ts`；契约 2.25.0：`pack.schema.json` 的 `ComponentType.external`，`eval-snapshot.schema.json` 的 `context.disposition_facts`。
- 单元测试覆盖四种 ignore 依据、ignore 不带修复、act 的三种依据、档位低于 likely 时按事件根因匹配模板、告警规则类模板不算修复、依据的计算与提示词段的筛选；重建评测的集成测试检查快照带依据、模板匹配的触发与误触发。
- 用 aq-full3 的 102 份 trace 离线重算（复用模型输出，不调用模型；阶段 A 与依据按本提交重建，cchp 包为 1683a98 加上 `cchp.provider`、`cchp.model` 的 `external: true`）：top-1、召回@3、选择性准确率、良性误报与 pass^3 不变；处置准确率 primary 3/48 → 18/48，fallback 9/48 → 19/48；良性 ignore 两条路由各 0/6 → 2/6（TTFT 良性有结论的 2 次都为 ignore，各有 1 次 model_unavailable）；模板匹配的 PR 触发 primary 8/21、fallback 5/19。

## 遗留

- **HPA 良性用例仍不会是 ignore**：按现有卡片它就是饱和的（`hpa-utilization` 167% 异常，延迟卡无法判定），`hpa-max-replicas-raise` 也适用。要让它成为 ignore，领域包需要给出"没有到瓶颈"的确定性依据：CCHP 包为 gateway 提供请求延迟信号，`hpa-utilization` 或 `hpa-max-replicas-raise` 的饱和判定要求限流或延迟异常，并把这类卡标为影响卡。
- **模板的适用条件对根因不敏感**：`release-to-serving-version` 的 `when` 只看卡片，任何根因（Node、PVC、Application……）上都适用；`memory-limit-raise` 读的是全局的卡片结论。"适用"因此偏宽，act 的依据与模板匹配的触发率都偏高，计划阶段的 `skip_if` 才会挡住不对应的根因。
- **外部上游的 ignore 会让 `noisy-alert-relax` 适用**：它对 `research.disposition == "ignore"` 且有 critical 告警的事件提议把告警降为 warning。离线重算里这一类误触发 primary 10、fallback 11 次（provider 用例）。是否要按 ignore 的依据区分，由领域包决定。
- CCHP 包需要在影子环境升级到本提交之后再声明 `external: true`：旧版 server 的领域包 schema 不认这个字段。
