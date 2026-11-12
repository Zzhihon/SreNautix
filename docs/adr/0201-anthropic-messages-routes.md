# 0201 Anthropic Messages API 路由

状态：已采纳

## 背景

模型层（ADR 0080、0098）的路由只有两种协议：OpenAI 的 `POST /responses` 与 OpenAI 兼容的 `POST /chat/completions`。Claude 模型经模型网关提供时，网关同时开放 Chat 兼容接口与 Anthropic 的 `POST /messages`。经 Chat 兼容接口调用 Claude 时，工具调用的参数与结构化输出都要经过网关的转换；`POST /messages` 是 Claude 的原生协议，没有这层转换。

另外两个现象来自同一个网关上的 Gemini 模型（`gemini-4-carbon`）：

- 流式 Chat 响应的 `tool_calls` 增量没有 `index` 字段，每个块是一个完整的调用，并带 `extra_content.google.thought_signature`；
- 原有的 Chat 累加器按 `index` 归并，`index` 缺失时所有调用合成一个，参数是几段 JSON 首尾相接。

## 决定

1. **路由协议 `api: messages`**（契约 2.62.0，`ModelRoute.api`）：请求发往 `<base_url>/messages`。
   - 不引入 Anthropic SDK。请求经这条路由已有的 OpenAI 客户端发出（`client.post('/messages')`），因此出站检查、蜜标、计量、超时（ADR 0098）与熔断都和其他路由相同；
   - 密钥除了 SDK 的 `Authorization: Bearer`，还放进 `x-api-key` 请求头，并带 `anthropic-version: 2023-06-01`；请求头不进入调用记录与日志；
   - 请求体：系统提示放进 `system`；Messages API 要求 user 与 assistant 交替，相邻的同角色内容合成一条消息（助手文本与 `tool_use` 合成一条 assistant，连续的 `tool_result` 与随后的用户输入合成一条 user）；空文本不成块；
   - 不带 `temperature` 等采样参数：当前的 Claude 模型对采样参数返回 HTTP 400；
   - `toolChoice` 映射为 `auto`、`any`、`none`。`none` 时照样带上工具定义：历史消息里有 `tool_use` 块时服务方要求工具存在；
   - 结构化输出：方言档案声明了严格 json_schema 时用 `output_config.format`，否则把 schema 写进系统提示（与 Chat 路由相同，但不带 `json_object`，Messages API 没有这个模式）；
   - 流式响应按内容块拼回：`text` 进正文，`thinking` 只计推理字数，`tool_use` 的 `input_json_delta` 拼成参数；`stop_reason` 为 `max_tokens` 时回合不完整，为 `refusal` 时记拒答；
   - 输入 token 为 `input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 三项之和，其中缓存读取计为缓存输入。
2. **方言档案 `anthropic-messages`**：`native_tools: true`，`reasoning_channel: separate_field`，`context_tokens: 200000`，`strict_json_schema: false`（以启动时的能力探测为准）。
3. **能力探测**：Messages 路由的原生工具探测不强制工具调用（`tool_choice: auto`，提示里点名工具）。2026-11-13 在 CCHP 网关上实测 `claude-fable-5-2`：同一个请求 `tool_choice: any` 返回 `{"order_id": 0}`，`auto` 返回正确的 `{"order_id": 4182}`。研判调用本来就不设置 `toolChoice`（服务方默认 `auto`），不受影响。
4. **一处分派**：`buildParams(api, …)` 与 `PROTOCOLS[api]`（流式参数、流式累加、非流式解析）按协议分派。会话、能力探测与回放服务器都用它，原来各处的三元表达式删除。
5. **Chat 流的 `tool_calls` 不带 `index`**：带 `index` 的增量照旧按 `index` 归并；不带 `index` 的增量，`id` 与上一个调用相同或为空时续写上一个调用，否则开始一个新调用。结果中带 `index` 的调用按 `index` 排序，不带的按到达顺序。`thought_signature` 不回传：2026-11-13 在网关上实测，第二轮不带签名时 `gemini-4-carbon` 照常返回（HTTP 200）。
6. **thinking 设置**（ADR 0158）仍只用于 `chat_completions` 路由；`messages` 路由配置 `thinking` 时 worker 拒绝启动。

## 考虑过的方案

- **经 Chat 兼容接口调用 Claude**：不需要新协议。代价是工具参数与结构化输出多一层网关转换，网关转换的缺陷直接变成研判的缺陷（同一个网关的非流式 Chat 响应会把 Gemini 的一个调用拆成两条）。
- **引入 Anthropic SDK**：类型完整。代价是第二个 HTTP 客户端要重复一遍出站检查、计量与超时，出站只有一个出口的约束（ADR 0081）要在两处维护。

## 结果

- 路由可以直接使用 Claude 的原生协议，评测与线上研判的结论不受网关协议转换影响；
- 新增协议只需在 `wire.ts`（请求与响应映射）与 `stream.ts`（`PROTOCOLS`）各加一项；
- 回放服务器（`replay.ts`）识别 `/messages`，录制与评测回放支持 Messages 路由。
