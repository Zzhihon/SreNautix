# 0179 关系证据只构成假设：因果性标注与对照对象

## 背景

在并行对照第 1 轮中，三个外部上游（模型服务方）事件的摘要给出「共享网关、出口或多个上游共因」的结论，而同一入口上多数上游在同一时段请求成功，结论与指标不符。阶段 B 没有做区分性检查，邻居与同一入口上其他对象的异常被当作因果关系。

拓扑边与邻居的异常说明同一时段相关，没有证明因果。把多个对象归为同一个根因（共享组件、共享出口）的结论，需要对照证据：同一入口上其他对象在同一时段的错误率。

## 决定

### 1. 拓扑关系的标注

提示词的拓扑片段带一段说明（`PromptSet.causality`，中英文各一份）：

- 边与邻居的异常只说明同一时段相关，没有证明因果；
- 邻居与同一入口上其他对象的异常只构成假设，与本对象自身的证据卡交叉验证之后才能采信；
- 把多个对象归为同一个根因的结论引用对照结果，对照对象多数正常时共因不成立，没有对照结果时结论档位最高为 inconclusive。

说明放在可裁剪的拓扑片段里，随片段一起裁掉，不计入提示词哈希。固定指令与三个步骤的任务说明的字节数与加入之前相同，`research-context-budget` 的测试断言它们不增加。

拓扑片段的每条边带 `provenance`（structural、runtime、config_ref、network_policy、naming），片段带 `topology_version` 与 `as_of`（研判输入的时刻）。

### 2. 卡片声明对照对象

证据卡增加 `controls`（契约 2.44.0，`CardControls`）：

| 字段 | 含义 |
|---|---|
| `method` | 对照对象的选择方式，枚举可以扩展，当前取值 `entry_peers` |
| `by` | 区分对象的标签名，序列在这个标签上的取值就是对象的键 |
| `refs` | 按 `by` 标签拆分后分别判定的指标引用名，mode 必须是 range 或 instant |
| `volume` | 排序用的请求量引用名，必须在 `refs` 中，按序列取值之和排序 |
| `top_n` | 按请求量取前几个，0–10，默认 2 |
| `sample_count` | 再随机取几个，0–10，默认 1 |

加载时校验：`refs` 中的引用存在、mode 合规、不重复，`volume` 在 `refs` 中。

### 3. 选择方式 entry_peers

`refs` 引用的查询返回同一入口上全部对象的序列。选点步骤：

1. 取全部有数据点的对象键，排除故障对象（键等于实体名）；
2. 按 `volume` 引用的请求量从多到少取前 `top_n` 个，请求量相同按键排序；
3. 其余对象按种子与对象键的哈希排序，取前 `sample_count` 个。

种子由执行方传入：事件研判传事件 id，主动优化传运行 id，pack test 与快照录制、回放用固定值。同一个种子与同一批对象得到同一个结果，重放可以复现。

选择方式是 `selectControls` 中的一个分支。新增取值（例如拓扑链的 `chain_siblings`）在这里增加分支，结果结构不变。

### 4. 对照结果

结果写在 `EvidenceResult.controls`（`EvidenceControls`），与故障对象自己的判定并列：

```typescript
{
  method: 'entry_peers',
  by: 'target',
  subject: 'up-0',          // 故障对象的键，它自己的判定是这张卡的主结果
  candidates: 5,            // 同一入口上除故障对象之外可作为对照的对象数
  results: [                // 先按请求量选出的，后随机选出的
    {
      subject: 'p1',
      picked_by: 'top_n',   // top_n 或 sampled
      volume: 1000,
      verdict, display_state, reason, value, value_number, anomaly_started_at
    }
  ]
}
```

对照对象用同一张卡、同一个判定输入，只换成这个对象的序列。对象的序列没有数据点时判定为 undeterminable，不会是 normal。结果不含表格、序列与查询记录。

### 5. 阶段 A 的执行

`runCard` 对声明了 `controls` 的卡：故障对象自己的判定只看标签值等于实体名的序列；对照对象各判定一次，写入 `controls`。声明了 `controls` 的卡执行时必须传入种子，没有时直接报错。`PackEvidence` 把事件 id 作为种子传给阶段 A 的卡、实时重跑、查询模板、卡片检查与证据基线的样本，`controls` 写进报告。

### 6. 共因约束

共因约束只读 `controls.results`，与选择方式无关（`research/common-cause.ts`）。故障对象的卡指判为异常、带 `controls`、实体是事件中有成员告警的组件、并且不是假设根因本身的卡。假设的根因落在故障对象之外时：

| 对照结果 | 处理 |
|---|---|
| 异常数不少于有结论的对象数的一半，并且没有无法判定的对象 | 共因成立，不改变假设 |
| 异常数少于有结论的对象数的一半 | 同一入口上的其他对象同时段多数正常，账本推翻假设 |
| 没有对照结果，没有对象得出结论，或有对象无法判定 | 对照证据不足，假设状态不变，结论档位最高为 inconclusive |

规则判定的假设（ADR 0178）由领域包的规则确定，不按共因检验。假设的根因就是故障对象本身时是单一对象故障，不检验。

推翻在账本评估时执行，依据写入假设的状态说明。档位限制（`controlCap`）在规则判定改选之后、最低取证集合与变更分级的限制之后执行，原因写入 `validation_notes`，包含故障对象、对照对象的异常、正常与无法判定数量。

### 7. 提示词与裁剪

对照结果单独成一段（`controlsSegment`），列出每张卡的选择方式、故障对象、候选数，以及每个对照对象的选取方式、结论、主值与异常起始。裁剪顺序在结论相关卡减半之前整段去掉（`TRIM.controls` 为 11，`relevantCards` 为 12，`samples` 为 13，`ruleConclusions` 为 14）。裁掉之后共因约束仍由代码按账本执行，不依赖模型看到对照结果。

16k 路由的 conclude 请求裁剪全部可裁剪的部分之后，带对照结果的事件与没有对照结果的事件相比，请求体不增加。

### 8. 群消息

关键问题一段在机制之后，为故障对象的卡上的对照结果写一行：对照对象的数量，以及异常、正常与无法判定各几个，例如「对照：同一入口上的其他 3 个对象，1 个异常，1 个正常，1 个无法判定」。

### 9. 领域包声明

一个外部上游类型的卡声明 `controls`，两个指标引用按同一个标签拆分，请求量引用用来排序：

```yaml
refs:
  - { name: requests, signal: upstream_requests, mode: range }
  - { name: errors, signal: upstream_errors, mode: range }
controls:
  method: entry_peers
  by: target
  refs: [requests, errors]
  volume: requests
  top_n: 2
  sample_count: 1
```

信号 `upstream_requests` 的查询写成 `sum by (target) (increase(upstream_requests_total[$window]))`，`target` 标签的取值就是对象的键。

## 结果

- 契约 2.44.0：`evidence-card.schema.json` 的 `controls` 与 `CardControls`；`evidence-result.schema.json` 的 `controls` 与 `EvidenceControls`、`EvidenceControlResult`。
- 实现：packs-sdk 的 `runtime/controls.ts`（声明校验、选点、判定）、`runCard` 的 `controlSeed`、加载校验；server 的 `PackEvidence`；worker 的 `research/common-cause.ts`、账本、控制器、提示词片段与裁剪；通知的对照行。
- 测试：`packages/packs-sdk/test/controls.test.ts`（选点、种子复现、三种对照判定、声明校验）；`apps/srenautix/test/integration/controls.test.ts`（真实 Prometheus 上外部上游事件的阶段 A：共因对照全异常、单一上游故障对照全正常、同一事件得到同一批对照对象）；`apps/srenautix/test/unit/research-common-cause.test.ts`（对照全异常不推翻，全正常推翻，部分无法判定限制档位）；`research-context-budget.test.ts`（固定指令字节数不增加，因果性说明，对照结果可裁剪）。

## 与拓扑链的接口

`method` 是可扩展的枚举，对照结果的结构与故障对象的卡结果并列。拓扑链增加 `chain_siblings` 时，在 `CardControls.method` 与 `EvidenceControls.method` 的枚举中增加取值，在 `selectControls` 中增加分支，按链路的对照路径选点，结果仍写入 `results`。共因约束读 `controls.results`，不依赖选择方式。
