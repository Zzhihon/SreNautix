import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions/completions';
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import { chatMaxTokensField, type DialectProfile } from './dialect.js';
import type { Item, LlmRequest, LlmTurn, Segment } from './types.js';

// 内部消息与两种 OpenAI 协议之间的映射。方言档案决定结构化输出的方式：
// 支持严格 json_schema 的路由直接约束解码；不支持的路由用 json_object，并把 schema 写进系统提示。

export function segmentsText(segments: readonly Segment[]): string {
  return segments.map((s) => s.text).join('\n\n');
}

/** 不支持严格 json_schema 时附在系统提示末尾的 schema 说明 */
export function schemaInstruction(schema: Record<string, unknown>, language: 'zh' | 'en'): string {
  const head =
    language === 'zh'
      ? '只输出一个 JSON 对象，不要输出代码块标记或任何其他文字。该对象必须严格符合下面的 JSON schema：所有字段都要出现，不允许额外字段，可空字段用 null，取值遵守枚举。'
      : 'Output exactly one JSON object and nothing else, no code fences. It must conform to the JSON schema below: every field present, no extra fields, null for nullable fields, values within the enums.';
  return [head, '```json', JSON.stringify(schema), '```'].join('\n');
}

/**
 * 路由的思考模式设置（ADR 0158）：`disabled` 在 Chat 请求体里加 `thinking: {type: "disabled"}`，关闭服务方默认开启的思考模式。
 * 默认思考的服务方把推理 token 计入 max_tokens，阶段的输出上限会被推理用完，正文为空。
 */
export type ChatThinking = 'disabled';

export interface WireOptions {
  model: string;
  profile: DialectProfile;
  language: 'zh' | 'en';
  /** 只用于 Chat 接口；不给或为 null 时请求体不带 thinking 字段 */
  thinking?: ChatThinking | null;
}

/** OpenAI SDK 的 Chat 请求类型没有服务方扩展的 thinking 字段 */
export type ChatParams = ChatCompletionCreateParamsNonStreaming & { thinking?: { type: ChatThinking } };

function systemText(req: LlmRequest, opts: WireOptions): string {
  const parts = req.items.filter((i) => i.type === 'system').map((i) => segmentsText(i.segments));
  if (req.output && !opts.profile.strict_json_schema) {
    parts.push(schemaInstruction(req.output.schema, opts.language));
  }
  return parts.join('\n\n');
}

/** 内部消息 → `POST /v1/responses` 请求体（非流式、不在服务方存储） */
export function toResponsesParams(req: LlmRequest, opts: WireOptions): ResponseCreateParamsNonStreaming {
  const input: ResponseInputItem[] = [];
  for (const i of req.items) {
    switch (i.type) {
      case 'system':
        break;
      case 'user':
        input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: segmentsText(i.segments) }],
        });
        break;
      case 'assistant':
        input.push({ type: 'message', role: 'assistant', content: i.text });
        break;
      case 'tool_call':
        input.push({ type: 'function_call', call_id: i.callId, name: i.name, arguments: i.arguments });
        break;
      case 'tool_result':
        input.push({ type: 'function_call_output', call_id: i.callId, output: i.output.text });
        break;
    }
  }
  const params: ResponseCreateParamsNonStreaming = {
    model: opts.model,
    input,
    store: false,
    stream: false,
    max_output_tokens: req.maxOutputTokens,
  };
  const instructions = systemText(req, opts);
  if (instructions) {
    params.instructions = instructions;
  }
  if (req.temperature !== undefined) {
    params.temperature = req.temperature;
  }
  if (req.tools?.length) {
    params.tools = req.tools.map((t): FunctionTool => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
    if (req.toolChoice) {
      params.tool_choice = req.toolChoice;
    }
  }
  if (req.output) {
    params.text = opts.profile.strict_json_schema
      ? { format: { type: 'json_schema', name: req.output.name, schema: req.output.schema, strict: true } }
      : { format: { type: 'json_object' } };
  }
  return params;
}

/** 内部消息 → `POST /v1/chat/completions` 请求体（非流式）；相邻的助手文本与函数调用合成一条 assistant 消息 */
export function toChatParams(req: LlmRequest, opts: WireOptions): ChatParams {
  const messages: ChatCompletionMessageParam[] = [];
  const system = systemText(req, opts);
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  let assistant: ChatCompletionAssistantMessageParam | null = null;
  const flush = () => {
    if (assistant) {
      messages.push(assistant);
      assistant = null;
    }
  };
  for (const i of req.items) {
    switch (i.type) {
      case 'system':
        break;
      case 'user':
        flush();
        messages.push({ role: 'user', content: segmentsText(i.segments) });
        break;
      case 'assistant':
        flush();
        assistant = { role: 'assistant', content: i.text };
        break;
      case 'tool_call': {
        const cur: ChatCompletionAssistantMessageParam = assistant ?? { role: 'assistant', content: null };
        cur.tool_calls = [
          ...(cur.tool_calls ?? []),
          { id: i.callId, type: 'function', function: { name: i.name, arguments: i.arguments } },
        ];
        assistant = cur;
        break;
      }
      case 'tool_result':
        flush();
        messages.push({ role: 'tool', tool_call_id: i.callId, content: i.output.text });
        break;
    }
  }
  flush();
  const params: ChatParams = {
    model: opts.model,
    messages,
    stream: false,
    ...(chatMaxTokensField(opts.profile.id) === 'max_tokens'
      ? { max_tokens: req.maxOutputTokens }
      : { max_completion_tokens: req.maxOutputTokens }),
  };
  if (opts.thinking) {
    params.thinking = { type: opts.thinking };
  }
  if (req.temperature !== undefined) {
    params.temperature = req.temperature;
  }
  if (req.seed !== undefined) {
    params.seed = req.seed;
  }
  if (req.tools?.length && req.toolChoice !== 'none') {
    params.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters, strict: false },
    }));
    if (req.toolChoice) {
      params.tool_choice = req.toolChoice;
    }
  }
  if (req.output) {
    params.response_format = opts.profile.strict_json_schema
      ? { type: 'json_schema', json_schema: { name: req.output.name, schema: req.output.schema, strict: true } }
      : { type: 'json_object' };
  }
  return params;
}

/** 推理内容以 <think> 标签内联在正文里的方言：去掉标签部分，只保留最终输出 */
export function stripInlineReasoning(text: string): { text: string; reasoningChars: number } {
  let reasoningChars = 0;
  const out = text.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner: string) => {
    reasoningChars += inner.length;
    return '';
  });
  return { text: out.trim(), reasoningChars };
}

function finalText(raw: string | null, profile: DialectProfile): { text: string | null; reasoningChars: number } {
  if (raw === null) {
    return { text: null, reasoningChars: 0 };
  }
  if (profile.reasoning_channel === 'inline_tags') {
    const s = stripInlineReasoning(raw);
    return { text: s.text === '' ? null : s.text, reasoningChars: s.reasoningChars };
  }
  return { text: raw, reasoningChars: 0 };
}

/** `Response` → 内部回合 */
export function fromResponse(res: Response, profile: DialectProfile): LlmTurn {
  const texts: string[] = [];
  const refusals: string[] = [];
  const toolCalls: LlmTurn['toolCalls'] = [];
  let reasoningChars = 0;
  for (const item of res.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content) {
        if (c.type === 'output_text') {
          texts.push(c.text);
        } else if (c.type === 'refusal') {
          refusals.push(c.refusal);
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
    } else if (item.type === 'reasoning') {
      for (const s of item.summary ?? []) {
        reasoningChars += s.text.length;
      }
      for (const c of item.content ?? []) {
        reasoningChars += c.text.length;
      }
    }
  }
  const final = finalText(texts.length ? texts.join('') : null, profile);
  const u = res.usage;
  return {
    text: final.text,
    reasoningChars: reasoningChars + final.reasoningChars,
    refusal: refusals.length ? refusals.join('\n') : null,
    toolCalls,
    incomplete: res.status === 'incomplete' ? (res.incomplete_details?.reason ?? 'incomplete') : null,
    usage: {
      input: u?.input_tokens ?? 0,
      cachedInput: u?.input_tokens_details?.cached_tokens ?? 0,
      output: u?.output_tokens ?? 0,
      reasoning: u?.output_tokens_details?.reasoning_tokens ?? 0,
    },
    responseModel: typeof res.model === 'string' ? res.model : null,
    systemFingerprint: null,
  };
}

/** 各服务方在 chat 消息上放推理内容的字段：DeepSeek、vLLM、llama.cpp 用 reasoning_content，部分服务用 reasoning */
function chatReasoning(msg: object | undefined): string {
  if (!msg) {
    return '';
  }
  const m = msg as { reasoning_content?: unknown; reasoning?: unknown };
  if (typeof m.reasoning_content === 'string') {
    return m.reasoning_content;
  }
  return typeof m.reasoning === 'string' ? m.reasoning : '';
}

/** `ChatCompletion` → 内部回合，只读第一个 choice */
export function fromChatCompletion(res: ChatCompletion, profile: DialectProfile): LlmTurn {
  const choice = res.choices[0];
  const msg = choice?.message;
  const toolCalls: LlmTurn['toolCalls'] = [];
  for (const c of msg?.tool_calls ?? []) {
    if (c.type === 'function') {
      toolCalls.push({ callId: c.id, name: c.function.name, arguments: c.function.arguments });
    }
  }
  const final = finalText(msg?.content ?? null, profile);
  const u = res.usage;
  const finish = choice?.finish_reason as string | undefined;
  return {
    text: final.text,
    reasoningChars: chatReasoning(msg).length + final.reasoningChars,
    refusal: msg?.refusal ?? null,
    toolCalls,
    incomplete:
      finish === 'length' || finish === 'content_filter' || finish === 'insufficient_system_resource' ? finish : null,
    usage: {
      input: u?.prompt_tokens ?? 0,
      cachedInput: u?.prompt_tokens_details?.cached_tokens ?? 0,
      output: u?.completion_tokens ?? 0,
      reasoning: u?.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    responseModel: typeof res.model === 'string' ? res.model : null,
    systemFingerprint: res.system_fingerprint ?? null,
  };
}

/** 一个请求里所有提示词片段（不含模型自己的输出）携带的数据类别 */
export function requestCategories(items: readonly Item[]): Set<string> {
  const out = new Set<string>();
  for (const i of items) {
    const segs = i.type === 'system' || i.type === 'user' ? i.segments : i.type === 'tool_result' ? [i.output] : [];
    for (const s of segs) {
      for (const c of s.categories) {
        out.add(c);
      }
    }
  }
  return out;
}
