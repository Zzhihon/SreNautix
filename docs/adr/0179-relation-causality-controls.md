# 0179 关系证据只构成假设：因果性标注与对照选点

## 背景

在并行对照第 1 轮中，三个外部上游（模型服务方）事件的摘要给出"共享网关、出口或多个上游共因"的结论，而同一入口上多数上游在同一时段请求成功，结论与指标不符。原因是阶段 B 没有做区分性检查，邻居与同入口的异常被当作因果关系。

拓扑证据卡与邻居检查的异常结果构成假设，但不直接证明因果。确认共因（多个对象归为同一根因，例如共享组件、共享出口）需要对照证据：同一入口上其他对象在同一时段的成功率或错误率。没有对照证据时，共因结论只能是推测，档位上限为 `inconclusive`。

## 决定

### 1. 拓扑边标注

拓扑边（契约 2.44.0，`TopologyEdge`）写入提示词时带 `provenance`（结构性、运行时、配置引用、NetworkPolicy、命名推断）与 `observed_at`（结构性边取事件版本的拓扑时刻，运行时边取最近一次服务图样本）。固定指令在"拓扑链"片段说明中加一句："相邻两跳的异常同时出现，只构成关联，不证明因果；确认因果需要证据卡或区分性检查的结果。"

### 2. 对照对象选择

证据卡增加 `controls`（`CardControls`），声明对照对象选择方式与参数：

```yaml
controls:
  method: entry_peers
  request_metric: # 按请求量选前 N 个
    signal_ref: requests
    aggregation: sum
    top_n: 2
  sample_count: 1  # 随机取若干个，种子为事件 id
```

`method` 取值（可扩展枚举）：

- `entry_peers`（本项实现）：同一入口的其他上游，按请求量取前 N 个，再随机取若干个；随机以事件 id 为种子，保证重放可以复现。
- `chain_siblings`（拓扑链 T1/T5 添加）：链路上与故障跳共享上一跳的兄弟跳。

卡片声明了 `controls` 时，卡的判定同时在故障对象与对照对象上执行，结果写在 `EvidenceResult.controls`（`EvidenceControlResults`）：

```typescript
{
  method: 'entry_peers',
  selection: {
    top_n: ['provider:xx', 'provider:yy'],  // 按请求量选出的前 N 个
    sampled: ['provider:zz']  // 随机选出的
  },
  results: [
    { component: 'provider:xx', verdict, value, value_number, ... },
    // ...
  ]
}
```

每个对照对象的结果包含组件键、结论、主值、主值数值与阈值，不含表格、序列、查询记录与样例。对照对象不存在、无法取到信号、或判定失败时，结果的 `verdict` 为 `undeterminable`，`reason` 写明原因。

### 3. 选择方式实现

`entry_peers`：

- 输入：拓扑（事件版本）、故障对象组件键、入口组件键、请求量信号、事件 id。
- 选点：从入口沿依赖边（`relation` 为 `calls`、置信度 ≥ 0.5）找到全部下游组件，排除故障对象；按请求量信号在事件窗口的总量排序，取前 `top_n` 个；剩余的组件按组件键的哈希（以事件 id 为种子）取 `sample_count` 个。
- 请求量从卡的 `request_metric.signal_ref` 引用取：引用必须是 `kind: metrics`、`mode: range`，按 `aggregation`（`sum`/`avg`/`max`）聚合。
- 对照对象最多 `controls.max_results`（默认 6）个；超过时截断并记 `truncated: true`。

### 4. 共因约束

阶段 B 的账本增加共因约束（`research/ledger.ts`）：假设的根因放在共享跳上（例如 gateway）、而故障跳是它的下游（例如 provider）时，结论要求对照证据：

- 对照卡正常（`verdict: 'normal'`）时假设被推翻，记 `refuted_by_control`。
- 对照卡无法判定或不存在时，档位上限为 `inconclusive`，记 `control_unavailable`。
- 对照卡异常时共因假设可以继续。

共因识别：故障对象的组件类型声明 `external: true`，选中根因的 component_type 不是外部，并且选中根因是故障对象所依赖的组件。这条约束在传播约束（`chain_deeper_first`）之后、档位计算之前执行。

没有对照证据时 `validation_notes` 记录：故障对象、共享跳、缺失的对照卡。

### 5. 研判提示词

拓扑链片段（契约 2.44.0）在边的说明中加 `provenance` 与 `observed_at`，固定指令加因果性说明（约 60 字节，在可裁剪部分的拓扑链说明里）。对照结果写在证据卡片段：对照卡的 `controls` 字段列出选择方式、选中的对照对象与每个对照对象的结论、主值与阈值，体积约 20–40 token/对照对象。

裁剪顺序（与拓扑链合并）：对照结果在 `chainSiblings`（8）一步裁剪，与对照路径、共享链路同级；最后裁剪的拓扑链骨架（16）保留，它是判断"最深一跳"的唯一输入。

### 6. 群消息

证据段不展示对照结果（避免消息过长）。关键问题一段在假设机制之后，为根因卡中有对照结果的卡（至多 1 张）写一行：对照方法、对照对象数量、异常/正常/无法判定的对象数，例如"对照：同入口其他 3 个上游，2 个正常，1 个无法判定"。

### 7. 领域包声明

一个外部上游类型的卡声明 `controls`：两个指标引用按同一个标签拆分，请求量引用用来排序。

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

请求量信号 `upstream_requests` 的查询写成 `sum by (target) (rate(upstream_requests_total[5m]))`，`target` 标签的取值就是对象的键，故障对象的键等于实体名。

### 8. 测试

- 单元测试（`packages/packs-sdk/test/controls.test.ts`）：`entry_peers` 选点逻辑、种子复现、对照判定、结果结构。
- 集成测试（`apps/srenautix/test/integration/controls.test.ts`）：单一上游故障判为单一上游；同一入口多数上游同时失败、有对照证据时判为共因；没有对照证据时共因档位上限 `inconclusive`。
- `research-context-budget` 测试：16k 路由 conclude 请求不可裁剪部分不增加字节数；带 3 个对照对象的卡在裁剪后放得下。
- 契约测试：`controls` 与 `EvidenceControlResults` 的 schema，`method` 枚举可扩展。

## 结果

- 契约 2.44.0：`evidence-card.schema.json` 的 `controls` 与 `CardControls`、`CardControlsRequestMetric`；`evidence-result.schema.json` 的 `controls` 与 `EvidenceControlResults`、`ControlSelection`、`ControlResult`；`control_method` 枚举（`entry_peers`、`chain_siblings`）；`research-output.schema.json` 的 `ConsistencyDetail` 增加 `refuted_by_control`、`control_unavailable`；`pack.schema.json` 的 `ComponentType.external`。
- 实现：packs-sdk 的 `runtime/controls.ts`（选点、判定）、`runCard` 的 `controls`、加载校验；server 的 `PackEvidence` 对照执行；worker 的共因约束、提示词片段与裁剪、群消息；cchp 包 provider 卡的 `controls` 声明。
- 测试：单元、集成、contract、context budget、回放（E17、E24、E25、单 provider 故障）。

## 与拓扑链的接口

`EvidenceControlResults` 的字段形状：

```typescript
{
  method: 'entry_peers' | 'chain_siblings',
  selection: {
    top_n?: string[],      // entry_peers: 按请求量选出的前 N 个
    sampled?: string[],    // entry_peers: 随机选出的
    siblings?: string[]    // chain_siblings: 拓扑链添加
  },
  results: ControlResult[],
  truncated?: boolean
}
```

拓扑链实现 T1/T5 时，`chain_siblings` 方法按链路计算的对照路径选点，把选中的兄弟跳写入 `selection.siblings`，结果写入 `results`。共因约束读 `controls.results`，不依赖选择方式。
