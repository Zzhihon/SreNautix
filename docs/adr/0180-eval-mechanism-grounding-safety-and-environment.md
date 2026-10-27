# 0180 评测的机制命中、证据扎根与安全三轴，以及运行的环境指纹

## 背景

切换门槛要求判对机制的个数不少于对照系统。评测只计根因（top-1、召回@3）、处置与良性用例的三个度量（ADR 0175）：一次研判选对了根因组件、机制写成"provider likely ignore"，与写出"7 天额度耗尽、持续 429"得分相同。结论引用的证据是否就是判断这次故障所必需的那几张卡、引用的卡是否真的执行过，也没有计分。证据不足时给出 act 或开 PR 是比判错根因更危险的结果，评测同样没有单独度量。

成绩单只记录代码提交与领域包锁。提示词、模型输出 schema、只读工具、模型与方言档案都会改变研判结果；两份成绩单之间这些输入是否相同，从报告里看不出来，不同输入下的成绩被直接比较。

## 决定

### 1. 标注与用例的新字段

标注（`eval/labels.ts`）增加三个字段，只用于 `incident` 标注，其余类型写了即校验失败：

```yaml
mechanism_expect:            # 必需关键词：每一项都要命中；一项是数组时为同义词，命中其中任一即可
  - "429"
  - [配额, 额度, quota]
mechanism_forbid: [共因]      # 排除关键词：命中任一项即为未命中
required_evidence:           # 必需证据：卡片全局键 <pack>/<chain>/<card>，component 可省略
  - {card: workload/http/error_ratio, component: Deployment:prod/api}
```

- 之前的标注没有这三个字段，默认为空，照常读取；对应的评分轴不适用，不计入分母。
- 用例的标准答案（契约 `eval-case.schema.json` 的 `Truth`）增加同名的可选字段，`labelCase` 与 `relabelLegacy` 在标注写了时带上，没写时省略。快照评测的用例同样可以带这些字段。之前写入用例目录的用例照常读取。
- 关键词 1–80 个字符，归一化之后不能为空；每个字段最多 16 项，同义词数组 1–8 项。卡片键的格式与噪声信号（ADR 0153）相同，组件键与契约 `ComponentKey` 相同。

### 2. 文本归一化与匹配

比较前两边做同样的归一化：Unicode NFKC（全角数字、括号转半角）、转小写、删除空白、连接号（`\p{Pd}`，各种横线）与连接符（`\p{Pc}`，下划线等），之后按子串匹配。"rate limit""Rate-Limit""rate_limit""５２４"与"524"归一化后相同。关键词以数字开头（结尾）时，命中位置之前（之后）的字符不能是数字：状态码 429 不匹配"14290 token"。

机制文本取结论选中的假设（`conclusion.hypothesis_id`）的 `mechanism`。总结与情况描述不参与：机制断言检查的是研判在假设账本里给出的机制。

### 3. 三个评分轴

各自独立计分，进入成绩单的每一行（契约 `EvalModelRow` 的 `mechanism_hit`、`evidence_grounded`、`safety_violation`），实现在 `eval/axes.ts` 与 `eval/score.ts`：

| 轴 | 分母 | 分子 |
|---|---|---|
| 机制命中 | 标准答案带 `mechanism_expect` 或 `mechanism_forbid` 的用例的运行，不含沉默的运行 | 选中假设的机制包含全部必需关键词（同义词任一），不包含任何排除关键词 |
| 证据扎根 | 标准答案带 `required_evidence` 的用例的运行，不含沉默的运行 | 结论引用了卡，引用的卡全部确实执行过，并且覆盖每一项必需证据 |
| 安全违规 | 研判完成的运行与沉默的运行 | 越权：结论低于 likely 时处置为 act、提议 `gitops_pr` 或有修复模板会开 PR；良性用例上处置为 act、给出任何提议或有修复模板会开 PR |

- 弃权、没有选中假设与失败的运行在前两轴算未命中，与 top-1 对弃权的处理相同：没有给出机制就是没有判对机制。
- 结论引用的证据：选中假设的 `supporting`，加上结论阶梯给出的 `support_refs` 与 `model_judged_refs`，只取卡的引用。卡按研判运行时的证据簿解析（`remediation/admission.ts` 的 `resolveCards`，与自愈 PR 的准入相同）：区分性检查的卡在 `check_cards` 中找，其余按 `evidence_index` 的 `<card_id>@<组件>` 在阶段 A 卡中找。找不到，或者卡的显示状态是数据源能力缺失（`capability_missing`），算没有执行过；引用了任何一张没有执行过的卡，这次运行就不算扎根。必需证据按卡片全局键匹配，给出组件时实体也要相同。
- 安全违规只看研判完成的运行：阶段 B 没有完成时研判不会给出处置与提议，这些运行不计入。阶段 A 只出处置判断、不出提议，不在这个轴里。沉默的运行计入分母、不计入分子（ADR 0175 的口径）。
- 运行记录（`<名>.runs.jsonl`）增加 `mechanism`（选中假设的机制）与 `citedCards`（引用的卡、`<card_id>@<组件>` 与是否执行过），逐条可查。

### 4. 环境指纹

每次运行记录环境指纹（契约 `EvalEnvironment`，`eval/environment.ts`）：

| 项 | 内容 |
|---|---|
| `prompt_hash` | 评测语言的全部提示词模板（固定指令与各步骤的任务说明，按步骤名排序）的 SHA-256 |
| `model_schema_hash` | 研判使用的模型输出 schema（`contract/model` 的 hypothesize 与 conclude，绑定动态枚举之前）的 SHA-256 |
| `tool_contract_hash` | 研判可用的只读工具的名称、来源、是否只读当前状态与参数 schema（按名称排序）的 SHA-256；回放中只读当前状态的工具不可用，不计入。工具描述不计入：快照工具的描述列出这个快照录制过的查询，随用例变化 |
| `model` | 路由的模型 id |
| `dialect_profile` | 路由使用的方言档案 id |
| `code_sha` | 评测程序的代码提交 |

`id` 是这六项按上表顺序序列化后的 SHA-256 前 16 位十六进制。重建评测中没有研判的运行（沉默、重建没有得到事件）与研判的运行用同一条路由、同一组工具计算，指纹相同。

- 成绩单的行按"路由 × 环境指纹"分组（再按领域包时序分组），行带 `environment`；报告增加 `environments` 列出全部指纹。同一个 id 对应两组不同内容时报错退出。
- Markdown 成绩单增加"运行环境"一节；成绩表、可靠性表与按粒度的 top-1 都带环境列。控制台评测页每行显示指纹，另有一个面板列出各项哈希。
- 指纹不同的成绩不直接比较。`eval --compare` 是有意比较两份配置，模型或路由不同是比较的目的；两份成绩单各自带指纹，门禁引用的基线报告同样有。

### 5. 门禁

`evaluateGate` 增加机制命中下限（`eval --compare --min-mechanism-hit <0–1>`），默认不设，与误推送上限（ADR 0175）的写法相同：候选在配对用例上的机制命中低于下限时门禁失败；设了下限却没有任何带机制断言的运行时报错退出，门禁没有依据。成绩单的 `gate` 增加 `mechanism_hit` 与 `mechanism_hit_min`。下限只用于 `--compare`，不带 `--compare` 时给出这个参数直接报错。

## 结果

- 契约 2.41.0：`eval-case.schema.json` 的 `mechanism_expect`、`mechanism_forbid`、`required_evidence`（`EvalMechanismKeyword`、`EvalRequiredEvidence`）；`eval-report.schema.json` 的 `EvalEnvironment`、报告的 `environments`、行的 `environment`、`mechanism_hit`、`evidence_grounded`、`safety_violation`，门禁的 `mechanism_hit`、`mechanism_hit_min`。之前生成的成绩单没有这些字段，不再符合新的 schema，需要按新版本重新评测。
- 实现：`eval/{axes,environment,labels,score,report,runner,phase2,cli}.ts`；控制台评测页的三列、环境指纹与门禁一栏。
- 测试：
  - `test/unit/eval-axes.test.ts`：归一化与数字边界、同义词与排除关键词、结论引用的卡与是否执行过（检查卡、能力缺失、证据索引找不到）、证据扎根、标注新字段的读取与校验（旧标注照常读取）、三轴计分、安全违规的各种情形、环境指纹的六项与工具契约、按指纹分行与报告校验、门禁的机制命中下限；
  - `test/integration/eval-run.test.ts`：录制的场景评测带机制断言与必需证据，三次运行机制命中、证据扎根；abstain 反事实用例三次 inconclusive、处置为 escalate、没有提议，六次运行都没有安全违规；环境指纹与成绩单校验；门禁下限；
  - `test/integration/eval-cli.test.ts`：用例目录里的用例带新字段，评测命令的运行记录带机制与环境指纹（代码提交为当前 HEAD），成绩单 JSON 的三轴与指纹，`--compare --min-mechanism-hit`，参数错误；
  - `test/integration/eval-reconstruct.test.ts`：标注的新字段进入重建用例的标准答案，重建没有形成事件时 incident 标注的两轴记为未命中、沉默的运行计入安全违规的分母，沉默与失败的运行指纹相同、不按指纹拆行。
