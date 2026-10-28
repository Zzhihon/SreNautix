# 0177 错误样例证据卡：按依赖与错误类别聚合错误日志

## 背景

在一次真实部署的 24 小时并行对照中，外部上游（模型服务方）类的业务影响事件上，SreNautix 判对了根因组件，却没有给出机制：对照系统给出"某上游 7 天额度耗尽、持续返回 429""某上游对某模型能力不匹配并伴随 524"这类结论，SreNautix 只给出"上游组件，likely，ignore"。对照系统的机制都来自网关日志里上游返回的错误内容。

阶段 A 的证据卡以指标为主。领域包的 `Signal` 支持 `kind: logs`（`logql`、`logs_match`），但 server 的证据数据源只接了 Prometheus，日志引用一律是能力缺失；即使接上，卡片判定只看到日志行数，没有一种证据卡按依赖与错误类别聚合错误日志并给出样例，研判也就没有机制可以引用。

## 决定

### 1. 卡片声明

证据卡增加 `samples`（契约 2.42.0，`evidence-card.schema.json` 的 `CardSamples`）：

| 字段 | 含义 |
|---|---|
| `ref` | 卡片中 mode 为 `logs` 的引用名，计数与样例取自它返回的日志行 |
| `dimensions` | 1–6 个聚合维度，按顺序组成维度组合；每个维度取日志行的标签（`label`，日志流标签或 LogQL 解析器提取的字段），或在日志行上匹配正则取第一个捕获组（`regex`），两者二选一 |
| `classes` | 至多 16 个错误类别，按声明顺序取第一个命中的；`match` 的条件全部成立才命中，写了 `dimension` 时匹配这一维的原始取值，没写时匹配整行；都没有命中的行归入 `other` |
| `per_class` | 每个类别的样例条数上限，1–10，默认 3 |
| `max_chars` | 每条样例脱敏之后保留的字符数上限，80–2000，默认 300 |
| `max_groups` | 结果里保留的维度组合数，1–50，默认 20 |

加载时校验：`ref` 是卡片中的日志引用；卡片的 `egress` 不能是 `allow`（样例含有日志原文）；维度名唯一、`label` 与 `regex` 二选一、正则至少一个捕获组；类别 id 唯一且不是 `other`；类别条件只引用声明过的维度；正则按 ECMAScript 语法编译。卡片判定照常用 CEL 写在 `judge` 里，`samples` 只决定结果里的聚合与样例。

维度由领域包声明，SreNautix 不预设"依赖方""状态码"之类的字段：不同网关的日志格式不同，聚合维度与错误类别是领域知识，属于领域包。

### 2. 结果

结果写在 `EvidenceResult.samples`（`EvidenceSamples`），只在卡片声明了 `samples` 时出现：

- `groups`：维度组合与错误类别的行数、首末时间，按行数从多到少，最多 `max_groups` 个，其余的个数记在 `groups_omitted`；
- `classes`：每个类别的行数与样例，按行数从多到少。同一类别内先轮流取不同的维度组合（行数多的组合在前），每个组合内从新到旧，取满 `per_class` 条；每条样例带时刻与维度取值；
- `lines` 与 `truncated`：参与聚合的行数，以及查询返回的行数是否达到引用的 `limit`。达到时窗口内还有更早的行，计数与首次时间是下限，消息与表格在计数前加 `≥`；
- `redactions`：样例与维度值里被脱敏规则替换的处数，同一个维度值只计一次；
- `code`：没有取得日志行的原因码，取得了日志行（包括零行）时为 null。

没有声明 `display.table` 时，维度组合同时写成卡片的表格（每个维度一列，加类别、行数与首末时间），控制台、事件 issue 与消息的证据段照常展示。

### 3. 脱敏与截断

样例与维度值先脱敏再截断：截断在脱敏之后，凭证不会因为被截成两半而躲过规则。脱敏规则与出站模块相同（ADR 0081，`llm/redact.ts`），由执行方注入 packs-sdk 的 `runCard`（`redact`）：server 在写进阶段 A 报告之前就已脱敏，报告、控制台、消息与研判看到的是同一份脱敏后的样例。声明了 `samples` 的卡执行时没有提供脱敏函数直接报错。只在本机执行、结果不出站的场合（`pack test` 的夹具、查询快照的录制与回放）显式传入不脱敏的 `NO_REDACTION`。

### 4. 日志数据源

server 增加可选的 `datasources.loki`（地址、租户、日志流上的 Kubernetes 标签名、单次查询超时，默认 15 秒；chart 的 `datasources.loki.url` 设置后写入 server 配置）。配置了它时证据数据源提供 `logs.match` 与 `logs.query`，`requires` 日志能力的包随之启用；没有配置时证据数据源只有指标能力。数据源报错时 `DatasourceError` 带 `timeout` 标记（请求或读取响应体超时），用于区分超时与其他错误。

### 5. 期限与原因码

错误样例卡在阶段 A 的证据期限（40 秒）内执行，与其他卡共用并发：

- 期限到达时还没有开始执行的错误样例卡，以及正在等待日志查询的错误样例卡，都照常出结果：无法判定，原因为数据源报错，`samples.code` 为 `samples_deadline`；其他没有完成的卡不进入报告；
- 日志查询超时为 `samples_timeout`，其他数据源错误为 `samples_source_error`，日志能力不可用为 `samples_capability_missing`。

四个原因码登记在 `contract/reason-codes.json` 的 `evidence_samples` 分组（阶段 `stage_a`，级别 warning），契约测试校验分组与 `Samples.code` 的枚举相同；每次出现计入 `srenautix_terminal_states_total`。它们是卡片的结果，不写入 `server.incident_reasons`：那张表的 `stage_a` 记录表示阶段 A 没有报告，事件流水线的补跑与"阶段 A 尚未生成"的消息按它判断。阶段 B 的卡片检查与查询模板由 server 的同一个执行器执行，原因码相同。

### 6. 出境

研判提示词里，错误样例单独一段，数据类别为 `logs`，出站前脱敏（片段的 `egress` 为 redact）。`egress: never` 的卡不进入提示词。部署方的 `llm.egress.categories` 不含 `logs` 时这一段在出站前删除，删除计入研判清单的出境记录（`dropped`）。证据卡片段里的错误样例卡不带表格，维度组合只在错误样例一段出现。

### 7. 研判

- hypothesize 的输出 schema 中每个假设增加 `mechanism_refs`（至多 4 项），取值是动态枚举 `sample_refs`：本次运行中进入提示词、带错误样例并且取得了日志行的卡。任务说明加一句：有错误样例时机制写出样例中的错误类别、计数与来源（依赖方返回的错误，或本侧的超时等判定），并在 `mechanism_refs` 引用这些卡；样例没有出现的错误内容不写进机制。
- 账本合并假设时，`mechanism_refs` 只保留取得了日志行的错误样例卡，其余引用删除并写一条 `validation_notes`。研判输出的假设带 `mechanism_refs`（契约 2.42.0，没有机制引用时不出现）。机制引用不改变假设的状态：状态仍按支持卡、相反卡与检查判定。
- 数值审计（ADR 0125）的语料包括错误样例：维度值、类别标题、样例原文（状态码、超时阈值）与各级计数。机制里写的"429""12 行""30s"因此不会被当作无法核实的数值删除。
- 提示词里的账本只写机制，不写 `mechanism_refs`；conclude 的任务说明与输出 schema 不涉及错误样例。conclude 请求不可裁剪的部分（固定指令、目录、事件概要、成员告警、账本、任务说明与输出 schema）因此只多出动态枚举 `evidence_refs` 里错误样例卡的编号。

### 8. 裁剪顺序

错误样例属于可裁剪的证据卡部分，分三步，按 `TRIM` 的优先级与其他片段交错：

| 顺序 | 裁剪 |
|---|---|
| 6 | 每个类别只保留一条样例（在拓扑子图之前） |
| 10 | 去掉样例原文，只保留维度组合与类别的计数（在结论相关证据卡减半之前） |
| 12 | 整段去掉（最后） |

样例原文多是同一个错误的重复，先于拓扑裁剪；计数是机制的依据、体积很小，保留到结论相关卡减半之后。阶段 A 的错误样例与账本片段里（假设相关的卡与区分性检查产生的卡）的错误样例各自一段，同一顺序。

### 9. 群消息

关键问题一段在选中假设的机制之后，为它的 `mechanism_refs` 引用的每张错误样例卡（至多 2 张）写一行：卡的引用、总行数与行数最多的 3 个类别，例如"样例：card:4（共 13 行）配额耗尽 12，其他 1"；没有取得日志行的卡写原因码的说明。日志原文不进入消息。

### 10. 领域包测试

`pack test` 的测试用例增加 `expect.samples.classes`（类别 id → 行数，0 表示这个类别不出现），在真实 Loki 上执行夹具 `input_logs` 时核对。

## 结果

- 契约 2.42.0：`evidence-card.schema.json` 的 `samples` 与 `CardSamples`、`CardSamplesDimension`、`CardSamplesClass`；`evidence-result.schema.json` 的 `samples` 与 `EvidenceSamples`、`EvidenceSamplesGroup`、`EvidenceSamplesClass`、`EvidenceSample`；`model/hypothesize.schema.json` 的 `mechanism_refs`（动态枚举 `sample_refs`）；`research-output.schema.json` 的 `Hypothesis.mechanism_refs`；`pack.schema.json` 的测试 `expect.samples`；`reason-codes.json` 的 `evidence_samples` 分组与四个原因码。
- 实现：packs-sdk 的 `runtime/samples.ts`（编译、聚合、表格）、`runCard` 的 `redact`、加载校验、`pack test` 的 `expect.samples`；integration-sdk 的 `DatasourceError.timeout` 与 Loki 的查询超时；server 的 `datasources.loki`、`EvidenceSource` 的日志适配器、`PackEvidence` 的脱敏、期限与原因码；worker 的提示词片段与裁剪、`sample_refs`、账本的机制引用、数值审计的语料；通知的样例计数；chart 的 `datasources.loki`。手写的 hypothesize 录制（kind 场景与卡片检查）补上 `mechanism_refs: []`。
- 测试：`packages/packs-sdk/test/error-samples.test.ts`（声明校验、聚合与上限、先脱敏再截断、原因码、表格；测试包 `test/fixtures/llm-gateway` 在真实 Loki 上的四类上游错误）；`apps/srenautix/test/unit/error-samples.test.ts`（提示词片段、出境删除、裁剪顺序、机制引用、数值审计、群消息）；`research-context-budget.test.ts`（三张满载的错误样例卡在 16k 路由上裁剪后放得下，不可裁剪的部分只多出动态枚举里的编号）；`apps/srenautix/test/integration/error-samples.test.ts`（真实 Loki 上的阶段 A、期限与超时的原因码，以及四类上游错误的回放：外部上游的配额耗尽、能力不匹配、单一端点 503、单一供给的模型首内容超时后由网关返回 503 且没有可以转移的候选）；契约测试（分组与枚举）；chart 单元测试 `tests/datasources_loki_test.yaml`。
