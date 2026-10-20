# 0098 模型调用改为流式，超时按路由配置，延迟熔断只看成功调用的首 token

## 背景

CCHP 种子回放（5 个有标注用例 × 3 次）里 primary 路由（gpt-6.1-sol，`/v1/responses`）15 次研判有 8 次失败：首次调用卡在 90 秒的单次总超时，随后延迟型熔断打开（`latency_open`），同一轮后面的调用直接被拒。抽样的 12 个无标注用例里也有 5 次。

为了分清是模型慢还是请求大，2026-10-20 用流式请求直接测了两条路由（同一网关，构造的证据文本，输出要求与研判相近）：

| 路由 | 输入 token | 首个输出增量 | 相邻增量的最大间隔 | 输出 token | 总时长 |
|---|---|---|---|---|---|
| primary gpt-6.1-sol | 10k | 4.6 s | < 0.3 s | 310 | 11 s |
| primary | 62k | 5.9–6.8 s | 0.7–0.85 s | 2900–3100（推理 26–41） | 93–102 s |
| primary | 147k | 63 s | — | 238 | 69 s |
| fallback deepseek-v4.1-flash | 61k | 8.5–22.7 s | 0.3–3.0 s | 3200–3500 | 30–42 s |
| fallback | 150k | 45 s | 0.2 s | 3400 | 50 s |

回放中 primary 每次研判输入约 60k、输出约 3k token，成功的运行 70–130 秒。结论：

- 请求体不是主因：60k 输入的首 token 只要 6 秒左右，推理 token 只有几十个；
- primary 的输出吞吐约 32 token/秒，3000 token 的结论要 95 秒左右。90 秒的总超时砍掉的是一直在正常输出的调用；
- 这些超时又以约 90 秒的耗时进入延迟样本，p50 超过 45 秒后延迟型熔断打开，"慢但成功"与"失败"被混在一起。

## 决定

1. **流式调用**：两种协议都以流式发出（Responses 收到 `response.completed` 或 `response.incomplete` 为止；Chat 带 `stream_options.include_usage`，按块拼回 ChatCompletion），流结束后走与非流式相同的映射、修复阶梯与记账。回放夹具按非流式录制，测试的回放服务在请求为流式时把夹具转成对应的流事件。
2. **超时分三项，按路由配置**：
   - `first_token`：从发出请求到第一个输出增量（正文、推理、拒绝或函数调用参数），覆盖排队与输入预填充；
   - `idle`：收到第一个增量之后相邻两个流事件的最长间隔，模型还在输出就不会被打断；
   - `total`：可选的总上限，默认不设，只受阶段 B 剩余时间约束。
   worker 配置写在每条路由的 `timeouts: {first_token, idle, total}`（时长），评测配置写 `timeouts: {first_token_seconds, idle_seconds, total_seconds}`。旧的全局 `llm.call_timeout`（评测的 `budget.call_timeout_seconds`）仍可用，只作为没有声明 `total` 的路由的总上限。
3. **默认值按模型类别**（路由可写 `model_class`，省略时推断：方言档案为 `qwen-vllm`、`llamacpp` 时为 local，否则按档位）：

   | 类别 | first_token | idle | total | 依据 |
   |---|---|---|---|---|
   | hosted_large | 120 s | 30 s | 不设 | 每次研判的输入上限约 150k，实测 147k 输入首 token 63 s，取约 2 倍；实测相邻增量最大间隔 3 s，取 10 倍 |
   | hosted_small | 60 s | 30 s | 不设 | 小模型阶段的单次输入上限 30k，首 token 在 10 s 以内 |
   | local | 300 s | 60 s | 不设 | CPU 或单卡的本地推理预填充约 100 token/秒，30k 输入约 300 s |

   总时长不设上限是因为输出长度由各阶段的 `max_output_tokens` 约束，整体由阶段 B 的 8 分钟期限约束；路由需要硬上限时显式写 `total`。
4. **延迟熔断只看成功调用的首 token**：成功调用把首 token 延迟放进延迟样本，最近样本的 p50 超过该路由 `first_token` 的一半时打开；总耗时随输出长度增长，不进入样本。失败（网络、首 token 或空闲超时、408/429/5xx）只计入失败型熔断，不进入延迟样本。新增指标 `srenautix_llm_first_token_seconds{phase,route}`。
5. 能力探测等短的非流式调用用 `first_token + idle` 作为超时。

## 结果

- 同一份种子、同一配置回放（修复后）：primary 15 次研判全部完成（修复前 8 次超时失败），没有熔断；fallback 15 次全部完成（修复前 2 次 budget_exhausted、1 次输出无效、2 次模型不可用）。逐项数字见 cchp-k8s-ops 的状态文件 status/hub-server.md。
- 输出慢的路由不再被误判为不可用；真正卡住的调用（不出首 token、流中途停住）仍在首 token 或空闲超时后按失败处理并换路由。
- 调用记录的 `note` 写明是哪一项超时（首 token、流空闲或总时长）。
