# 0178 领域包的确定性结论规则：模型不可用时的根因候选与机制，研判可用时作为假设进入账本

## 背景

模型路由按故障域提前熔断时（ADR 0080、0152），事件涉及模型调用链路上的组件，研判只出阶段 A。兜底路由可以缓解，但它本身也可能不可用或超出当日额度。一次真实部署的并行对照里，业务影响最大的两类事件都只有阶段 A：

- 数据库主库被 OOM 终止引发故障转移：一条路由弃权，另一条把根因判成网关的新版本回归，与事实方向相反；
- 网关的查询占满数据库连接池：三条路由都只说到连接池占满，结论都是 undetermined。

对照系统几分钟内就给出了根因与机制，依据是两三个确定的事实组合（容器 OOMKilled 加主库切换；连接数饱和加语句变慢）。阶段 A 已经算出这些事实所在的证据卡，缺少的是把它们组合成结论的确定性规则。阶段 A 只给证据卡、处置与处置依据，不给根因候选的机制。

## 决定

### 1. 领域包的结论规则（契约 2.43.0，`pack.schema.json` 的 `ConclusionsFile`）

领域包增加可选文件 `conclusions.yaml`：

```yaml
conclusions:
  - id: oom-failover
    title: { zh-CN: 实例 OOM 引发主库切换, en: ... }
    component_types: [postgres.cnpg-cluster, postgres.instance]   # 可选；不写时在全部组件上求值
    when:
      cards:
        - card: availability/oom-kills                # <chain>/<card>，或 <包>/<chain>/<card>（包在 depends_on 中）
        - card: availability/primary-changes
          verdict: abnormal                           # 默认 abnormal，可写 normal
          observations: [{ name: changes, op: gt, value: 0 }]
          on: self                                    # 默认 self；incident 表示事件里任何位置
      alerts:
        - { alertnames: [...], labels: {...}, roles: [cause], on: self }
      changes:
        - { kinds: [rollout], min_grade: high, on: self }
    mechanism: { zh-CN: ..., en: ... }
```

- **求值对象**：事件涉及的每个组件，依次为根因候选（按排名）、根因、事件组件、成员告警归属的组件与证据卡所为的组件，去重。`component_types` 给出时只在这些组件类型的组件上求值。
- **条件**：三类条件全部成立时规则在这个组件上命中，合计 1–8 个。
  - 卡片条件：阶段 A 的证据卡在实体上的结论；证据基线判为常态的异常卡按正常对待（ADR 0153），无法判定的卡两种结论都不满足；`observations` 比较卡片判定时 let 绑定的取值（`EvidenceResult.observations`），取值缺失时不成立，大小比较只用于数值；
  - 告警条件：事件的成员告警（已恢复的也算，与 ADR 0122 相同），按名字、标签与角色匹配；
  - 变更条件：事件的变更，按类型与关联分级（ADR 0169）匹配，事件没有分级时 `min_grade` 不成立。
  - `on: self` 只看落在求值对象上的证据：卡片按“执行这张卡所为的组件”判断（根因候选上执行的卡属于候选；告警实体上执行的卡属于告警归属的组件，例如 CNPG 实例 Pod 上的卡属于它的集群），告警按归属组件，变更按目标与管理应用。
- **编译检查**：卡片条件只能引用证据链中的卡，跨包时包必须在 `depends_on` 中；`observations` 的名字必须是卡片前 16 个 let 绑定之一（只有它们记进结果）；`component_types` 必须存在；规则 id 在包内唯一；机制每种语言最多 300 字。用户层可以 `extend.conclusions` 追加、`disable: conclusions/<id>` 禁用。
- **包测试**：测试文件增加 `conclusions`（`PackTestFile.conclusions`）：在夹具上执行列出的卡（两个后端各一遍），加上列出的成员告警与变更，按阶段 A 的方式求值规则，期望命中或不命中。`tests` 与 `conclusions` 至少写一种。stable 的包要求每条结论规则都有命中与不命中的测试，缺少时报告列在 `uncovered`。
- **领域包只含数据**：规则是声明式的条件，没有 CEL。条件只比较已经算好的卡片结论与取值，阶段 A 不会因为规则多发查询。

### 2. 阶段 A 报告的 `rule_conclusions`

阶段 A 在执行证据卡之后求值全部结论规则，命中的按求值对象的顺序排列，最多 3 条，写进 `StageAReport.rule_conclusions`：规则 `<pack>/<id>`、标题、根因组件、机制、档位 `likely`、依据（满足条件的 `card:<n>`、`alert:<n>`、`change:<n>`，按条件顺序）与卡片条件。状态库降级时的阶段 A 同样求值（规则不依赖状态库）。指标 `srenautix_stage_a_rule_conclusions_total{rule}` 计数命中。

结论档位上限为 `likely`，与 ADR 0122 只有成员告警支持时相同：规则只组合了确定的事实，没有检验竞争解释。

### 3. 研判可用时：规则判定是账本中的假设

- worker 把报告中的规则结论作为假设 `h7`–`h9` 加入账本（模型的假设是 `h1`–`h6`，模型的输出 schema 不变），根因与机制取自规则，支持证据是规则的依据。研判输出的假设带 `rule_id`（`Hypothesis.rule_id`），`hypotheses` 的上限改为 9。
- **推翻方式只有一种**：区分性检查（针对任何假设）测的卡片定义是规则某个卡片条件的卡，实体在规则根因的范围内（条件为 `on: incident` 时不限实体），得出确定的结论，并且不满足这个条件。其余时候规则判定处于支持状态。控制器不为规则判定补选检查，它们不占每轮的检查名额。
- **结论**：模型选中的根因与某个未被推翻的规则判定相同时保持模型的选择，档位照常按四个条件判定。模型弃权，或选了别的根因，而规则判定没有被推翻时，代码改选排名最靠前的规则判定，`consistency_detail.chosen_by` 为 `rule`，档位 `likely`（相反证据照样按 ADR 0134 退回 inconclusive），`validation_notes` 写明模型的选择与没有推翻的规则判定。也就是说，模型否定规则判定时必须拿出能反驳规则条件的检查结果。
- **提示词**：规则判定放在可裁剪的片段里（裁剪等级 `ruleConclusions`，最后裁剪），片段带一段说明（推翻方式与改选规则），不进入固定指令；账本片段只列模型的假设，处置依据片段只看模型假设的根因。这样 conclude 请求的不可裁剪部分与没有规则判定时逐字相同，16k 路由的上下文余量不受影响；片段被裁掉时代码照样执行检验与改选。
- 增量研判不沿用上一次的规则判定，按本次阶段 A 的规则结论重新加入。人工反馈照样可以固定或推翻规则判定。

### 4. 研判不可用时：群消息、事件详情与时间线

- 事件版本没有阶段 B 结论（研判失败、只出阶段 A、入队跳过、不进入阶段 B、租约过期）时，群消息的“关键问题”先写规则判定：`规则判定：可能（likely） · <根因>（<规则标题>）`，下一行写机制，全文再列依据与规则 id；之后照常写阶段 A 的根因候选。消息的标题与头条用规则判定的根因。研判还在进行时同样显示，研判给出结论后改为研判结论。
- 控制台事件详情的结论头在没有完成的研判时显示规则判定：档位 `likely`、标签“规则判定”（悬停显示规则 id）、一句“根因 X（规则标题）：机制”。
- **原因码 `research/rule_only`**（info，分组 `research_rule_only`）：“没有模型结论，只有规则判定”。研判失败或只出阶段 A 的结果进入研判镜像时、入队跳过与不进入阶段 B 时、租约过期判为失败时，这个版本的阶段 A 报告有规则结论就写一条终态记录（同一版本一次），说明列出规则与根因，进入时间线（`research_ended`）与 `srenautix_terminal_states_total`。

### 5. 评测

没有模型结论的运行（只出阶段 A 或失败）按阶段 A 的规则判定评分：top-1 为第一条规则结论的根因，排名取规则结论的根因，档位 `likely`，`RunRecord.rule` 记规则 id，`RunRecord.mechanism` 取规则在评测语言下的机制，机制命中（ADR 0180）按它计算。群消息在这种时候显示的就是规则判定，评分与用户看到的一致。重建评测的阶段 A 同样求值结论规则。

## 考虑过的方案

- **规则用 CEL 写**（与规则提议相同）：表达力更强，但条件要引用“落在这个组件上的卡”，CEL 上下文只有根因实体；把每个组件的卡都放进上下文会让规则作者自己处理组件归属。声明式条件覆盖了需要的组合，编译时可以检查卡片与取值名。
- **规则判定直接作为结论，不进入账本**：研判可用时模型的结论与规则判定会并存，消息上要解释哪个为准；进入账本后，规则判定与模型假设走同一套检验与选择，只有检查能推翻它，规则错的时候模型也有办法纠正。
- **规则判定写进固定指令或账本片段**：conclude 不可裁剪部分只剩约 130 token 的余量，三条规则判定与说明放不下；放在可裁剪片段里，裁掉之后由代码执行改选，结论不依赖模型是否看到它们。

## 结果

- 契约 2.43.0：`pack.schema.json` 的 `ConclusionsFile`、`ConclusionRule`、三类条件与 `ConclusionScope`，`PackTestFile.conclusions`（`tests` 改为可选），`UserLayer` 的 `extend.conclusions` 与 `disable: conclusions/<id>`；`stage-a-report.schema.json` 的 `rule_conclusions` 与 `RuleConclusion`；`research-output.schema.json` 的 `Hypothesis.rule_id`、`hypotheses` 上限 9、`ConsistencyDetail.chosen_by` 增加 `rule`；原因码登记表的分组 `research_rule_only` 与原因码 `research/rule_only`。
- 实现：`packages/packs-sdk` 的 `pack/{load,layers,compile}.ts`、`runtime/conclusions.ts`、`testing/pack-test.ts`；`apps/srenautix` 的 `stage-a/{pack-evidence,ports,report,service,degraded,no-packs}.ts`、`research/{ledger,ladder,validate,controller,prompt}.ts`、`prompts/{zh,en}.ts`、`notify/compose.ts`、`incident/reasons.ts`、`scheduler/{admission,worker-events}.ts`、`eval/{score,runner,reconstruct}.ts`、`metrics.ts`；`packages/ui` 的 `VerdictHeader` 与中英文案。
- 领域包：`postgres` 增加卡片 `availability/oom-kills`（读 `workload` 的 `container_oom_events`，`depends_on` 增加 `workload`）与 `saturation/statement-latency`（语句平均耗时对比一天前），结论规则 `oom-failover` 与 `slow-statements-saturate-connections`；`_example` 增加 `oom-killed` 作为写法示例。
- 测试：
  - `packages/packs-sdk/test/conclusions.test.ts`：编译检查（卡片不存在、跨包未声明依赖、取值名不是 let 绑定、大小比较的值不是数值、条件个数、组件类型不存在、机制过长、id 重复、空测试文件）、条件语义（self 与 incident、常态卡、无法判定、组件类型、告警的角色与标签、变更的目标与分级）、用户层的追加与禁用；`builtin-packs.test.ts` 与 `example-pack.test.ts` 在 Prometheus 与 VictoriaMetrics 上执行每条规则的命中与不命中测试；
  - `apps/srenautix/test/unit/research-rule-conclusions.test.ts`：规则判定进入账本、只被卡片条件上的检查推翻；主库 OOM 用例中模型判成网关新版本回归时改选规则判定，连接池用例中模型弃权时改选；结论一致与规则被推翻时保持模型的选择；两条常规路由因故障域熔断、兜底路由当日额度用完时研判只出阶段 A，群消息写出规则判定的根因与机制，评测按规则判定 top-1 命中；16k 路由的 conclude 在裁掉全部可裁剪片段后与没有规则判定时逐字相同；
  - `test/integration/research-replay.test.ts`：同一段录制的研判，规则判定与模型结论一致时结论、档位与四项条件不变；规则判定落在别的根因上时改选规则判定；
  - `test/integration/stage-a-packs.test.ts`：真实 Prometheus 上卡片按组件归属、规则按组件类型筛选，报告符合契约；`incident-timeline.test.ts`：不进入阶段 B 的版本有规则判定时记 `rule_only` 并计数，时间线带原因码与说明；
  - `packages/ui` 的结论头显示规则判定。
