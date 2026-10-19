# 回放评测

在自己的事件上、按自己的模型量出研判的准确率（DESIGN §14）。取舍见 ADR 0084、0085。

## 用例与快照

用例目录：

```
<目录>/cases/<case_id>@<version>.json          契约 schemas/eval-case.schema.json
<目录>/snapshots/<snapshot_id>.json.zst        契约 schemas/eval-snapshot.schema.json（zstd 压缩的 JSON）
```

| 用例类型 | 标准答案 |
|---|---|
| `incident` | 根因集合、粒度、可选的机制与处置判断 |
| `feedback` | 已绑定账号且给出根因的最新反馈 |
| `benign` | 处置为 `ignore`，不出现 `evidence_consistent` |
| `abstain` | 去掉根因组件上的异常卡后，结论应弃权（`inconclusive` 或 `undetermined`），不出现 `evidence_consistent`；处置判断不计分（`--abstain` 自动派生） |
| `scenario` | 注入的根因；维护者编写的场景单独报告 |

快照的 `context` 是阶段 B 的全部输入（事件、阶段 A 报告、拓扑子图、动作、runbook、知识、参考案例、查询模板），`queries` 是查询快照（`srenautix.io/query-snapshot/v1`，与 `pack test --replay` 相同）。

## 命令

```
srenautix eval --cases <目录> --config <配置> [--suite <名>] [--runs 3] [--mode snapshot|reconstructed]
               [--abstain] [--max-tokens 2000000] [--out eval/reports] [--name <报告名>]
srenautix eval --compare <当前配置> <候选配置> --cases <目录> [同上] [--waive <case_id>]...
srenautix eval import-seed --dir <种子目录> --cases <目录> --suite <名> --cluster-id <id>
```

评测配置：

```yaml
language: zh
allow_cross_border: false
routes:
  - id: candidate
    base_url: http://vllm.example:8000/v1
    api: chat_completions
    model: qwen-example
    dialect_profile: qwen-vllm
    price: { currency: CNY, input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null }
    in_domain: true
    tier: large
    retention_terms: "本地部署"
    api_key_env: LLM_API_KEY          # 或 api_key_file
    context_tokens: 32768             # 可选：覆盖方言档案的上下文长度
mcp: []                               # reconstructed 模式的只读 MCP 服务器（格式同 worker）
budget: { call_timeout_seconds: 90 }
```

每条路由单独评测，成绩单每条路由一行，另按"领域包早于事件 / 晚于事件"各一行。输出：

| 文件 | 内容 |
|---|---|
| `<名>.md` | 成绩单：每个比例的值、分子、分母与 90% 置信区间；可靠性表；按粒度的 top-1；门禁 |
| `<名>.json` | 契约 `eval-report` |
| `<名>.runs.jsonl` | 每次运行的记录（用例、路由、状态、档位、处置、前 3 个根因、token、成本、快照未命中率、服务方指纹） |

`--compare` 另写出 `<名>.baseline.*`（当前配置的成绩），候选成绩单带门禁；门禁不通过时命令以非零状态退出。

## 指标

| 指标 | 定义 |
|---|---|
| top-1 | 有根因标准答案的运行中，第一候选落在根因集合内的比例（弃权算未命中） |
| 召回@3 | 前 3 个候选覆盖根因集合的比例 |
| pass@1 / pass^k | 每个用例第一次运行正确 / k 次全部正确的用例比例 |
| 运行一致 | k 次运行给出相同第一候选与相同处置的用例比例 |
| 覆盖率 / 选择性准确率 | 不弃权的运行比例 / 不弃权的运行中 top-1 命中的比例 |
| 处置准确率 | 有处置标准答案的运行中处置正确的比例 |
| 良性误报 | benign 用例中出现 `evidence_consistent` 的比例 |
| 结构化输出失败 | 修复阶梯走到"只出确定性报告"的运行比例 |
| 可靠性表 | 每个结论档位中正确的比例；`evidence_consistent` 的下界低于 85% 时标记降级 |

置信区间：聚类自助法，用例为聚类，2000 次，固定种子。门禁：配对比较，基线 pass^k 通过、候选不通过的用例必须为零或逐条豁免；按用例正确率差的单侧 90% 下界不低于 −10 个百分点（n < 100）或 −5 个百分点（n ≥ 100）。

## 防泄漏

回放时：该事件的反馈不进入上下文；`learned_from` 与用例的 `learned_from_keys` 有交集的知识条目排除；参考案例只取用例开始之前已解决的，排除本事件、别名与同根因的模型生成结论；只读当前状态的工具不可用；工具只能查询快照窗口。被排除的材料逐条记录。

## 旧版种子

`import-seed` 读取旧版 Ops-Agent 导出的 `cchp-srenautix-seed` v1 目录（`units`、`calls`、`logs`、`raw`、`snapshots` 五类 zstd JSON Lines 与 `catalog.json`）。旧版组件映射为 `legacy.component:<id>`；有复盘根因的单元进入 `<suite>`，没有标准答案的进入 `<suite>-unlabeled`（稍后标注）。种子含部署方集群的事实，只保存在部署方本地。
