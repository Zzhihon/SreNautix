import type OpenAI from 'openai';
import type { DialectProfile, ModelRoute } from '@srenautix/contract';
import { classifyError } from './session.js';
import { LlmError, type LlmRequest, type LlmTurn } from './types.js';
import { fromChatCompletion, fromResponse, toChatParams, toResponsesParams, type ChatThinking } from './wire.js';

// 能力探测（DESIGN §8.2）：启动时和评测时逐条路由测量方言档案的各项能力。
// 探测请求只含固定文本，不含任何事件数据。每一项给出测得的值与来源：
// measured 为实测；declared 为测不出来时沿用声明值（例如服务方不公开上下文长度）。

export type ProbeSource = 'measured' | 'declared';

export interface ProbeItem<T> {
  value: T;
  source: ProbeSource;
  detail: string;
}

export interface ProbeReport {
  routeId: string;
  strictJsonSchema: ProbeItem<boolean>;
  nativeTools: ProbeItem<boolean>;
  reasoningChannel: ProbeItem<DialectProfile['reasoning_channel']>;
  contextTokens: ProbeItem<number>;
  chinese: ProbeItem<DialectProfile['chinese']>;
  fingerprint: string | null;
  measuredAt: string;
}

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['color', 'count'],
  properties: {
    color: { type: 'string', enum: ['red', 'green', 'blue'] },
    count: { type: 'integer' },
  },
};

const PROBE_TOOL = {
  name: 'lookup_order',
  description: 'Look up an order by its numeric id.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['order_id'],
    properties: { order_id: { type: 'integer' } },
  },
};

// 中文探测：给出一段带干扰的中文说明，要求只回答其中的数字；能正确读懂得 native，答错得 poor
const CHINESE_PROMPT =
  '仓库里原有十七箱苹果，上午运走了五箱，下午又运进来八箱。请只回答现在仓库里有几箱苹果，用阿拉伯数字，不要写其他内容。';
const CHINESE_ANSWER = '20';

type Send = (req: LlmRequest, strict: boolean) => Promise<LlmTurn>;

function sender(
  route: ModelRoute,
  profile: DialectProfile,
  client: OpenAI,
  timeoutMs: number,
  signal: AbortSignal,
  thinking: ChatThinking | null,
): Send {
  return async (req, strict) => {
    const p = { ...profile, strict_json_schema: strict };
    // 探测请求与研判请求带同样的 thinking 设置，测到的是研判时的行为
    const wire = { model: route.model, profile: p, language: 'en' as const, thinking };
    try {
      return route.api === 'responses'
        ? fromResponse(await client.responses.create(toResponsesParams(req, wire), { signal, timeout: timeoutMs }), p)
        : fromChatCompletion(
            await client.chat.completions.create(toChatParams(req, wire), { signal, timeout: timeoutMs }),
            p,
          );
    } catch (e) {
      throw classifyError(e, route.id, signal);
    }
  };
}

const user = (text: string): LlmRequest['items'][number] => ({
  type: 'user',
  segments: [{ text, categories: [], egress: 'allow' }],
});

/** 服务方在请求格式上拒绝（4xx）说明不支持该能力；其余错误说明探测本身失败，应当原样报告 */
function unsupported(e: unknown): e is LlmError {
  return (
    e instanceof LlmError &&
    e.kind === 'llm_http' &&
    e.httpStatus !== null &&
    e.httpStatus >= 400 &&
    e.httpStatus < 500 &&
    e.httpStatus !== 408 &&
    e.httpStatus !== 429
  );
}

export async function probeStrictJsonSchema(send: Send): Promise<ProbeItem<boolean>> {
  const req: LlmRequest = {
    items: [user('Reply with JSON describing the sky on a clear day and the number of legs a spider has.')],
    output: { name: 'probe', schema: PROBE_SCHEMA },
    maxOutputTokens: 512,
    temperature: 0,
  };
  let turn: LlmTurn;
  try {
    turn = await send(req, true);
  } catch (e) {
    if (unsupported(e)) {
      return { value: false, source: 'measured', detail: `服务方拒绝 json_schema 请求：${e.message.slice(0, 200)}` };
    }
    throw e;
  }
  const text = turn.text?.trim() ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: false, source: 'measured', detail: `接受了 json_schema 但输出不是 JSON：${text.slice(0, 120)}` };
  }
  const o = parsed as Record<string, unknown>;
  const keys = Object.keys(o ?? {})
    .sort()
    .join(',');
  const ok =
    keys === 'color,count' && ['red', 'green', 'blue'].includes(o.color as string) && Number.isInteger(o.count);
  return {
    value: ok,
    source: 'measured',
    detail: ok ? '输出严格符合 schema' : `输出不符合 schema：${text.slice(0, 120)}`,
  };
}

export async function probeNativeTools(send: Send): Promise<ProbeItem<boolean>> {
  const req: LlmRequest = {
    items: [user('Look up order 4182 using the available tool.')],
    tools: [PROBE_TOOL],
    toolChoice: 'required',
    maxOutputTokens: 512,
    temperature: 0,
  };
  let turn: LlmTurn;
  try {
    turn = await send(req, false);
  } catch (e) {
    if (unsupported(e)) {
      return { value: false, source: 'measured', detail: `服务方拒绝带工具的请求：${e.message.slice(0, 200)}` };
    }
    throw e;
  }
  const call = turn.toolCalls[0];
  if (!call) {
    return { value: false, source: 'measured', detail: '没有返回工具调用' };
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return { value: false, source: 'measured', detail: `工具参数不是 JSON：${call.arguments.slice(0, 120)}` };
  }
  const ok = call.name === PROBE_TOOL.name && (args as { order_id?: unknown }).order_id === 4182;
  return {
    value: ok,
    source: 'measured',
    detail: ok ? '返回了正确的工具调用' : `工具调用不正确：${call.name} ${call.arguments.slice(0, 120)}`,
  };
}

export async function probeReasoning(send: Send): Promise<ProbeItem<DialectProfile['reasoning_channel']>> {
  const turn = await send(
    {
      items: [user('What is 37 * 43? Think it through, then give only the number.')],
      maxOutputTokens: 2048,
      temperature: 0,
    },
    false,
  );
  if (turn.reasoningChars > 0 || turn.usage.reasoning > 0) {
    // 推理内容已从正文中分离：要么在独立字段，要么是被去掉的 <think> 标签
    const inline = /<think>/.test(turn.text ?? '');
    return {
      value: inline ? 'inline_tags' : 'separate_field',
      source: 'measured',
      detail: `推理 ${turn.reasoningChars} 字符，推理 token ${turn.usage.reasoning}`,
    };
  }
  if (/<think>/.test(turn.text ?? '')) {
    return { value: 'inline_tags', source: 'measured', detail: '推理内容以 <think> 标签出现在正文中' };
  }
  return { value: 'none', source: 'measured', detail: '没有观察到推理通道' };
}

export async function probeChinese(send: Send): Promise<ProbeItem<DialectProfile['chinese']>> {
  const turn = await send({ items: [user(CHINESE_PROMPT)], maxOutputTokens: 1024, temperature: 0 }, false);
  const text = (turn.text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const numbers = text.match(/\d+/g) ?? [];
  const right = numbers.length > 0 && numbers[numbers.length - 1] === CHINESE_ANSWER;
  return {
    value: right ? (numbers.length === 1 ? 'native' : 'adequate') : 'poor',
    source: 'measured',
    detail: `回答：${text.slice(0, 60)}`,
  };
}

/**
 * 上下文长度：服务方在 /v1/models 中公开时实测（llama.cpp 的 meta.n_ctx、vLLM 的 max_model_len、
 * 部分服务的 context_length），否则沿用声明值。
 */
export async function probeContext(
  route: ModelRoute,
  client: OpenAI,
  declared: number,
  signal: AbortSignal,
): Promise<ProbeItem<number>> {
  let page: unknown;
  try {
    page = await client.get('/models', { signal });
  } catch (e) {
    const c = classifyError(e, route.id, signal);
    if (c instanceof LlmError) {
      return {
        value: declared,
        source: 'declared',
        detail: `/models 不可用（${c.message.slice(0, 120)}），沿用声明值`,
      };
    }
    throw c;
  }
  const data = ((page as { data?: unknown[] }).data ?? []) as Array<Record<string, unknown>>;
  const m = data.find((x) => x.id === route.model);
  if (!m) {
    return { value: declared, source: 'declared', detail: `/models 中没有 ${route.model}，沿用声明值` };
  }
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  const n = [meta.n_ctx, m.max_model_len, m.context_length, m.context_window].find(
    (v) => typeof v === 'number' && v > 0,
  ) as number | undefined;
  if (n === undefined) {
    return { value: declared, source: 'declared', detail: '/models 没有公开上下文长度，沿用声明值' };
  }
  return { value: n, source: 'measured', detail: `/models 报告上下文 ${n}` };
}

export async function probeRoute(
  route: ModelRoute,
  declared: DialectProfile,
  client: OpenAI,
  timeoutMs: number,
  signal: AbortSignal,
  thinking: ChatThinking | null,
): Promise<ProbeReport> {
  const send = sender(route, declared, client, timeoutMs, signal, thinking);
  const strictJsonSchema = await probeStrictJsonSchema(send);
  const nativeTools = await probeNativeTools(send);
  const reasoningChannel = await probeReasoning(send);
  const chinese = await probeChinese(send);
  const contextTokens = await probeContext(route, client, declared.context_tokens, signal);
  return {
    routeId: route.id,
    strictJsonSchema,
    nativeTools,
    reasoningChannel,
    contextTokens,
    chinese,
    fingerprint: null,
    measuredAt: new Date().toISOString(),
  };
}

/** 探测结果覆盖声明档案 */
export function applyProbe(declared: DialectProfile, r: ProbeReport): DialectProfile {
  return {
    ...declared,
    strict_json_schema: r.strictJsonSchema.value,
    native_tools: r.nativeTools.value,
    reasoning_channel: r.reasoningChannel.value,
    context_tokens: r.contextTokens.value,
    chinese: r.chinese.value,
    measured_at: r.measuredAt,
    provider_fingerprint: r.fingerprint ?? declared.provider_fingerprint,
  };
}
