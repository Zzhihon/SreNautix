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
               [--abstain] [--max-tokens 2000000] [--out eval/reports] [--name <报告名>] [--trace <目录>]
               [--route <路由 id>]...
srenautix eval --compare <当前配置> <候选配置> --cases <目录> [同上] [--waive <case_id>]...
srenautix eval import-seed --dir <种子目录> --cases <目录> --suite <名> --cluster-id <id>
srenautix eval label --labels <标注> --cases <目录>
srenautix eval export --labels <标注> --cases <目录> --config <配置> [--state <状态库连接文件>] [--only <标注 id>]...
srenautix eval reconstruct --labels <标注> --cases <目录> --config <配置> [--runs 3] [--max-tokens N]
                           [--repo <GitOps 仓库的本地克隆>] [--discovery-only] [--only <标注 id>]... [--out] [--name]
                           [--trace <目录>] [--route <路由 id>]...
srenautix eval live --state <状态库连接文件> --config <配置> --since <时刻> [--until <时刻>] [--out] [--name]
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

每条路由单独评测，成绩单每条路由一行，另按"领域包早于事件 / 晚于事件"各一行。`--route <id>`（可重复）只评测列出的路由，只读取这些路由的密钥，
其他路由可以没有密钥；配置里没有的 id 直接报错。worker 配置中的兜底路由（`role: last_resort`，ADR 0152）在评测中当作常规路由单独评测，
例如在常规路由的同一份配置里加上兜底路由，用 `--route <兜底路由 id>` 只评测它，再与常规路由已有的成绩单比较 top-1 与处置。输出：

| 文件 | 内容 |
|---|---|
| `<名>.md` | 成绩单：每个比例的值、分子、分母与 90% 置信区间；可靠性表；按粒度的 top-1；门禁 |
| `<名>.json` | 契约 `eval-report` |
| `<名>.runs.jsonl` | 每次运行的记录（用例、路由、状态、档位、处置、前 3 个根因、token、成本、快照未命中率、服务方指纹、提议） |
| `--trace <目录>` 下的 `<case_id>/<路由>-<次序>.json` | 每次运行的研判记录：标准答案、研判输出、执行的检查与得到的卡、账本，以及各步骤、模型调用（完整的请求与响应）与工具调用；`--compare` 时两份配置分别在 `config-0/`、`config-1/` 下 |

基础设施检查（这类失败量出的是评测机器到模型服务与数据源的网络，不是研判质量）：

- 开跑前每条路由做一次能力探测（几次很短的调用与 `/models`），`reconstruct` 的分析另外探测指标数据源的即时与区间查询；任何一项失败都不开跑。
- 运行中模型路由不可达（连接失败、熔断）的运行超过本轮计划运行数的 10% 时中止。

两种情况都只写 `<名>.invalid.md`（原因）与 `<名>.invalid.runs.jsonl`（中止前完成的运行），不写成绩单，命令以非零状态退出。网络或服务恢复后重跑。

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

## 重建评测与三个环节的度量

取舍见 ADR 0110。

标注文件（YAML，格式见 `apps/srenautix/src/eval/labels.ts` 文件头）每条是一次故障：故障窗口与分析时刻、属于这次故障的告警、可接受的根因组件键、处置判断、发现环节要求的成员与变更时刻、标准修复与依据。标注、重建包与成绩单含部署方集群的事实，只保存在部署方本地。

标注的 `type` 为 `incident`、`benign` 或 `abstain`。`abstain` 用于真实原因不在可观测数据里的故障（例如运行时配置变更源还没有接入）：`roots` 为空，不写处置与修复，结论为 `inconclusive` 或 `undetermined` 才算正确，不能出现 `evidence_consistent`。`noise` 列出噪声信号（卡片全局键，ADR 0153）：重建的阶段 A 中这张卡在每个实体上都应判为常态，并且不出现在任何假设的支持证据中，成绩单的"噪声信号"一节逐条列出。

评测配置增加 `reconstruct` 部分：

```yaml
reconstruct:
  cluster_id: prod
  metrics: { url: http://127.0.0.1:8428, dialect: metricsql }   # 只读；证据卡与查询模板也读这里
  packs: { dirs: [/app/packs, /etc/srenautix/packs/user] }      # 与 server 加载的领域包相同
  revision_labels: [example.io/release-id]                      # 与 server 的 changes.kubernetes 相同
  group_within_seconds: 120
  step_seconds: 30
  novelty: { timeout: 120s }                                    # 证据基线，键与 server 的 stage_a.novelty 相同
```

状态库连接文件（JSON）：`{"host": …, "port": 5432, "database": …, "user": …, "password_file": …, "ssl_mode": "require"}`。会话设为只读，连接后核对。

| 命令 | 输出 |
|---|---|
| `eval export` | `<用例目录>/bundles/<标注 id>.json.zst`：告警实例、拓扑（kube-state-metrics 历史与状态库）、变更，以及退役与 Argo CD 同步状态的序列（ADR 0161，重放时与 server 一样推导退役变更与尚未同步的提交；早于它导出的重建包没有这些序列） |
| `eval reconstruct --discovery-only` | 发现重放的成绩单：每次故障的事件数、主事件根因与是否命中、缺少的成员、变更、检测延迟、窗口内的 unlabelled |
| `eval reconstruct` | 另加重建的阶段 A 与研判（每条路由 k 次，成绩单与 ADR 0084 相同）、证据卡覆盖、证据卡与告警结论一致率、自愈 PR 的触发率、补丁可应用率与正确率；`<名>.phase2.json` 为这几项的原始数据 |
| `eval live` | 影子环境一段时间内的新建事件、unlabelled 占比、检测延迟 p50/p95、有证据卡的比例、一致率、`gitops_pr` 提议、关联的 PR 与 issue |

| 指标 | 定义 |
|---|---|
| 每次故障的事件数 | 曾经包含故障告警的事件数；一次发布事故的验收为不超过 2 个 |
| 根因命中率 | 主事件（包含故障告警最多）在窗口结束时的根因落在标注的根因集合内的故障比例 |
| unlabelled 占比 | 窗口内新建的事件中没有根因的比例 |
| 检测延迟 | 首个故障告警的 pending 开始到故障告警第一次成为事件成员；重放开始前就在触发的告警不计；精度是一步（30 秒） |
| 证据卡覆盖 | 主事件的阶段 A 报告中卡、得出结论的卡、异常卡与根因上的异常卡的数量 |
| 研判根因与发现根因不一致 | 研判完成、给出根因且不弃权、事件有根因的运行中，第一候选与分析时刻主事件的根因按属主粒度（`incident/research-root.ts` 的 `rootsAgree`，Pod 与它所属的工作负载算同一个）不一致的次数；逐条列出两边是否命中标注，区分研判纠正了发现与偏离了正确的发现 |
| 证据卡与告警结论一致率 | 触发中的成员告警，主卡（目录条目的 `primary_card`）或条目证据链在告警实体上的卡判为异常的比例；正常、无法判定、没有卡分别列出 |
| PR 触发率 | 标注有仓库修复、结论为 likely 或 evidence_consistent 的运行中提议了 `gitops_pr` 的比例；没有仓库修复却提议的为误触发 |
| 补丁可应用率 / 正确率 | `gitops_pr` 补丁在分析时刻 base 分支的提交上 `git apply --check` 通过的比例 / 应用后标准修复的期望全部成立的比例 |

## 防泄漏

回放时：该事件的反馈不进入上下文；`learned_from` 与用例的 `learned_from_keys` 有交集的知识条目排除；参考案例只取用例开始之前已解决的，排除本事件、别名与同根因的模型生成结论；只读当前状态的工具不可用；工具只能查询快照窗口。被排除的材料逐条记录。

## 旧版种子

`import-seed` 读取旧版 Ops-Agent 导出的 `cchp-srenautix-seed` v1 目录（`units`、`calls`、`logs`、`raw`、`snapshots` 五类 zstd JSON Lines 与 `catalog.json`）。旧版组件映射为 `legacy.component:<id>`；有复盘根因的单元进入 `<suite>`，没有标准答案的进入 `<suite>-unlabeled`（稍后标注）。种子含部署方集群的事实，只保存在部署方本地。

- 用例 id 为 `legacy:<事件键>`，事件键中的 `~<序号>`（同一根组件、同一个 10 分钟内的不同事件）改为 `.<序号>`；用例的 `label` 是原始事件键。映射后冲突时导入报错，不覆盖已有用例。
- 导入逐行流式处理，在默认的 Node 堆上即可运行（中间结果写在用例目录下的临时目录中，结束时删除；临时文件的大小约为用例目录的数倍）。
