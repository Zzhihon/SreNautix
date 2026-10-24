# worker 角色

worker 运行阶段 B 的模型研判，是唯一持有模型密钥的角色。设计见 DESIGN §7.2–§7.5、§8；取舍见 ADR 0080–0083、0086。

## 启动

```
node apps/srenautix/dist/main.js --role=worker --config=/etc/srenautix/config.yaml
```

数据库连接取 libpq 环境变量（`PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGSSLMODE`、`PGSSLROOTCERT`），`PGUSER` 是 worker 的库角色（默认 `srenautix_worker`），口令从 `database.password_file` 读取。启动时执行 `worker` schema 的扩展迁移。

## 配置

```yaml
cluster_id: prod
worker_id: worker-0                  # 默认取主机名（Pod 名）
code_sha: 0123456789abcdef0123456789abcdef01234567   # 镜像构建时注入，写进研判清单
log_level: info
listen: { api: ":8080", metrics: ":9090", probes: ":8081" }
database: { password_file: /etc/srenautix/secrets/db/password, pool_size: 4 }
hub:
  url: http://srenautix-server:8080
  token_file: /etc/srenautix/secrets/worker/token          # server 调用方文件中 kind: worker 的 token 原文
inbound:
  token_sha256_file: /etc/srenautix/secrets/worker/inbound-sha256   # server 调用 worker 的 token 的 sha256，每行一个
language: zh                         # 提示词模板与修复说明的语言：zh | en
llm:
  allow_cross_border: false          # 国内配置默认禁止 in_domain: false 的路由
  honeytokens_file: /etc/srenautix/secrets/honeytokens   # 每行一个蜜标，至少 16 个字符
  # 允许出境的数据类别（ADR 0146 §3.6）；不在其中的提示词片段出站前删除，计入
  # srenautix_egress_dropped_segments_total{category} 与调用记录的说明。省略时为
  # metrics、logs、traces、events、topology、changes、alerts、knowledge（不含主动优化的 sql 与 code）
  # egress: { categories: [metrics, logs, traces, events, topology, changes, alerts, knowledge, sql, code] }
  probe_on_start: true               # 启动时逐条路由探测能力
  # call_timeout: 90s                # 旧配置，可省略：只作为没有声明 timeouts.total 的路由的总上限
  routes:
    - id: primary
      base_url: https://llm.example.com/v1
      api: responses                 # responses | chat_completions
      model: example-large
      dialect_profile: openai-responses   # openai-responses | openai-chat | deepseek | qwen-vllm | llamacpp
      price: { currency: USD, input_per_mtok: 1.25, output_per_mtok: 10, cached_input_per_mtok: 0.125 }
      failure_domain: []             # 这条路由依赖的被管组件，例如 Namespace:llm-gateway
      in_domain: true
      tier: large                    # large：hypothesize、conclude；small：工具结果判定
      retention_terms: "服务方的数据保留条款"
      api_key_file: /etc/srenautix/secrets/llm/primary
      model_class: hosted_large      # 可省略：本地方言档案（qwen-vllm、llamacpp）为 local，否则按 tier
      timeouts: { first_token: 120s, idle: 30s }   # 可省略：按模型类别的默认值；total 默认不设（ADR 0098）
budget:
  daily_tokens: 5000000              # 必填，没有默认值
  daily_warn_ratio: 0.8
  on_exhausted: critical_only        # critical_only | stage_a_only
  per_research_input_tokens: 150000
  purposes:
    optimization: { daily_tokens: 3000000 }   # 主动优化每天的用量上限；省略或为 0 时不运行目标任务（ADR 0146 §5.3）
research:
  deadline: 8m
  max_steps: 3
  checks_per_step: 3
  tool_calls: 12
  claim_wait: 25s
mcp:                                 # 只读 MCP 服务器与工具白名单（区分性检查 type: tool）
  - id: metrics
    url: http://mcp-victoriametrics:8080/mcp
    bearer_token_file: /etc/srenautix/secrets/mcp/metrics
    tools:
      - { name: query_range, range: { from: start, to: end, format: unix }, step: step, live: false, result: prometheus }
      - { name: query, instant: { at: time, format: unix }, live: false, result: prometheus }
```

### 模型调用的超时与提示词裁剪

模型调用一律流式（ADR 0098）。每条路由三项超时：`first_token`（发出请求到第一个输出增量）、`idle`（之后相邻两个流事件的最长间隔）、`total`（可选的总上限，默认不设，只受阶段 B 期限约束）。默认值按模型类别：

| model_class | first_token | idle |
|---|---|---|
| hosted_large | 120s | 30s |
| hosted_small | 60s | 30s |
| local | 300s | 60s |

延迟型熔断只看成功调用的首 token 延迟（p50 超过 `first_token` 的一半时打开），输出长但一直在流的调用不会让路由熔断；超时与网络错误只计入失败型熔断。

提示词估算超过路由上下文或本次可用的输入预算时按顺序裁剪（ADR 0099）：无关证据卡改为只列判定、参考案例、知识、其余卡的判定列表、旧的变更、拓扑子图、卡片表格、最后才裁结论相关的证据卡；裁掉的内容写进调用记录与研判的校验说明。研判剩余预算不够再提一轮假设时直接结论，不因超限整次失败。

白名单中每个工具声明时间参数的位置与结果形状。没有时间参数、只能读取当前状态的工具写 `live: true`，回放时不可用。任何参数取值为 Secret 或 ConfigMap 的调用都被拒绝；Kubernetes 对象的环境变量字面值在进入提示词前剔除。

## 主动优化的目标任务

server 的研判队列里也有目标运行（ADR 0146，认领结果的 `subject_type: goal`），worker 用同一套账本、区分性检查、证据簿、
预算与出境控制分析它们（server 部分见 [docs/server/optimization.md](../server/optimization.md)）：

1. 读取运行的输入（`GET /v1/research/tasks/{run_id}/goal-context`）：目标、基线与差距、进入分析的候选发现（最多 3 个）、
   诊断卡与份额卡、领域的查询模板。
2. 预算：全部用途的当日用量按 info 级别判断，另有主动优化自己的当日上限（`budget.purposes.optimization.daily_tokens`）；
   每次运行的输入不超过目标的 `budget.tokens`。用尽时运行以 `budget_exhausted` 结束。
3. hypothesize：模型为每个发现提出相互竞争的机制假设，写出机制预示的症状类型；假设的根因是发现的实体，同一发现上的假设互为
   竞争假设。
4. discriminate：区分性检查只能用这次运行的领域模板（没有只读工具），模型漏写的模板参数从发现实体的标签补上；server 在发现
   挂到的组件上执行（`goal-query`）。不在模板目录里的模板、原始查询与不合模板 schema 的参数在本地被拒绝，不发出请求。
5. conclude：每个发现一条结论，档位由代码按优化结论阶梯计算（差距成立、份额达到门槛、没有相反的正常卡、检验过竞争假设）；
   模型弃权时按账本选中这个发现上唯一处于支持状态的假设，档位最高 `likely`。模型文字经数值审计。
6. 交回输出（`POST .../optimization`）或报告失败（`POST .../optimization-failed`），释放任务。目标运行不发 `research.*` 事件。

提示词里的规范化语句（`sql` 类别）单独成段：`llm.egress.categories` 不含 `sql` 时只删掉这一段，判定与数值照常出境。

用量按用途分别记账：`worker.daily_usage` 是全部用途的合计，`worker.daily_usage_purpose` 按用途（`research`、`optimization`）。
ADR 0146 §5.3 写的是给 `daily_usage` 加 `purpose` 列，加列要改主键（收缩迁移），所以改为只扩展的新表。worker 每次结束任务后
向 server 上报两个比例，server 据此准入目标运行。目标运行与事件研判共用 `worker.research_runs`（`subject_type` 区分，
`incident_id` 存目标 id）。

## 接口

| 路径 | 调用方 | 内容 |
|---|---|---|
| `GET /v1/events?after=worker:<seq>` | server | worker 的 outbox：`research.concluded`、`research.failed`；支持长轮询与 SSE |
| `GET /v1/runs/{run_id}` | server | 运行明细：步骤、区分性检查的卡、模型调用（脱敏）、工具调用、预算 |
| `GET /v1/runs/{run_id}/manifest` | server | 研判清单与出境清单 |
| `GET /v1/runs/{run_id}/prompt/raw` | server | 总是 404：worker 不保存原始提示词 |

探针：`/healthz`；`/readyz` 在迁移完成且出站没有因蜜标停止时就绪。

## 指标

| 指标 | 含义 |
|---|---|
| `srenautix_llm_calls_total{phase,route,outcome,error_kind}`、`srenautix_llm_call_duration_seconds` | 模型调用 |
| `srenautix_llm_first_token_seconds{phase,route}` | 成功调用的首 token 延迟（延迟型熔断看它的 p50） |
| `srenautix_llm_prompt_trims_total{phase,route}` | 为放进窗口与预算而裁剪提示词的步数 |
| `srenautix_llm_tokens_total{route,direction}`、`srenautix_llm_cost_total` | 按 usage 计量 |
| `srenautix_llm_repair_total{phase,route,level,outcome}` | 修复阶梯每一级的结果 |
| `srenautix_llm_breaker_open{route}`、`srenautix_llm_breaker_opened_total{route,reason}` | 熔断 |
| `srenautix_llm_failure_domain_skips_total` | 故障域提前熔断 |
| `srenautix_llm_estimate_calibration{route}` | token 估算校准系数 |
| `srenautix_llm_budget_used_ratio{scope="daily"}`、`srenautix_llm_budget_stops_total{reason}` | 预算；`scope="optimization"` 为主动优化用途的当日比例 |
| `srenautix_egress_bytes_total`、`srenautix_egress_redaction_hits_total{kind}`、`srenautix_egress_halted` | 出站 |
| `srenautix_llm_route_disabled{route,reason}`、`srenautix_llm_routes_available` | 启动时被出站策略禁用的路由与可用路由数 |
| `srenautix_llm_provider_fingerprint_changes_total` | 服务方指纹变化 |
| `srenautix_research_runs_total{outcome,stop}`、`srenautix_research_duration_seconds` | 研判 |
| `srenautix_research_conclusions_total{level,untested_competitor,zero_checks}` | 结论 |
| `srenautix_research_untested_competitor_ratio`、`srenautix_research_zero_tool_ratio` | P0 指标（最近 7 天） |
| `srenautix_research_checks_total{type,outcome}` | 区分性检查 |
| `srenautix_pg_statement_timeouts_total{pool="worker"}` | worker 库连接池里因语句超时被取消的语句（ADR 0144） |

## 运维

- **蜜标命中**：`srenautix_egress_halted` 为 1，worker 不再出站，事件只出阶段 A。查看日志中命中的路由与研判，确认泄漏途径并修正出境控制后重启 worker。
- **路由被出站策略禁用**：国内配置（`allow_cross_border: false`）下 `in_domain: false` 的路由在启动时禁用（ADR 0093）：error 日志、`srenautix_llm_route_disabled{route,reason}` 为 1、控制台状态条显示 `ModelRouteBreakerOpen`（原因 `EgressPolicy`）。禁用的路由不会被探测或调用，worker 照常就绪，其余路由照常研判。一条可用路由都没有时（原因 `EgressPolicyNoRoute`），阶段 B 不入队（队列原因 `no_model_route`），事件只出阶段 A，通知横幅写明原因。确认路由确实在境内后改 `in_domain`，或按合规要求打开 `allow_cross_border`，然后重启 worker。
- **服务方指纹变化**：该路由的评测成绩作废，用 `srenautix eval` 重新评测（见 [docs/eval](../eval/README.md)）。
- **全部路由都在被管拓扑内**：启动日志告警，状态条件 `all_routes_in_topology` 为 1；模型服务本身出事时阶段 B 全部跳过。建议保留一条拓扑之外的路由，例如本地 vLLM。
- **录制模型夹具**：`pnpm --filter @srenautix/app test:live`，需要 `SRENAUTIX_LIVE_LLM_BASE_URL` 指向本地自己启动的模型服务（例如 llama.cpp 的 `llama-server --jinja`）；`scripts/record-llm-fixtures.ts` 录制单个协议的原始响应。不要对持有生产数据的服务运行。
