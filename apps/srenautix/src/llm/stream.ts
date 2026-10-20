import type OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions/completions';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { DialectProfile } from './dialect.js';
import type { RouteTimeouts } from './timeouts.js';
import { LlmError, type LlmApi, type LlmTurn } from './types.js';
import { fromChatCompletion, fromResponse } from './wire.js';

// 流式调用（ADR 0098）：两种协议都以流式发出，按首 token 超时与空闲超时判断"卡住"，不再用一个总时长。
// 流结束后拼回与非流式相同的响应对象，交给 wire.ts 的同一套映射。

export type StreamParams = ResponseCreateParamsStreaming | ChatCompletionCreateParamsStreaming;

/** 非流式请求体 → 流式请求体；chat 要求服务方在最后一个块里给出 usage */
export function streamingParams(
  api: LlmApi,
  params: ResponseCreateParamsNonStreaming | ChatCompletionCreateParamsNonStreaming,
): StreamParams {
  if (api === 'responses') {
    return { ...(params as ResponseCreateParamsNonStreaming), stream: true };
  }
  return {
    ...(params as ChatCompletionCreateParamsNonStreaming),
    stream: true,
    stream_options: { include_usage: true },
  };
}

/** 流式调用因超时被中止；which 说明是哪一项 */
export class StreamTimeout extends Error {
  override name = 'StreamTimeout';
  constructor(
    readonly which: 'first_token' | 'idle' | 'total',
    readonly ms: number,
  ) {
    const what = which === 'first_token' ? '首 token' : which === 'idle' ? '流空闲' : '总时长';
    super(`${what}超过 ${Math.round(ms / 1000)} 秒`);
  }
}

export interface StreamedTurn {
  turn: LlmTurn;
  /** 从发出请求到第一个输出增量的毫秒数；没有任何增量（例如空响应）时为 null */
  firstTokenMs: number | null;
}

/** 一个 Responses 流事件是否是模型输出的增量（正文、推理、拒绝或函数调用参数） */
function responsesToken(ev: ResponseStreamEvent): boolean {
  switch (ev.type) {
    case 'response.output_text.delta':
    case 'response.refusal.delta':
    case 'response.function_call_arguments.delta':
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta':
      return true;
    default:
      return false;
  }
}

function chatToken(c: ChatCompletionChunk): boolean {
  const d = c.choices[0]?.delta as (ChatCompletionChunk.Choice.Delta & Record<string, unknown>) | undefined;
  if (!d) {
    return false;
  }
  return Boolean(d.content || d.refusal || d.tool_calls?.length || d['reasoning_content'] || d['reasoning']);
}

/** 把 chat 流块拼回 ChatCompletion（只取第一个 choice） */
export class ChatAccumulator {
  private id = '';
  private model = '';
  private created = 0;
  private fingerprint: string | null = null;
  private content = '';
  private hasContent = false;
  private reasoning = '';
  private refusal: string | null = null;
  private finish: string | null = null;
  private usage: ChatCompletion['usage'] = undefined;
  private readonly tools = new Map<number, { id: string; name: string; arguments: string }>();

  push(c: ChatCompletionChunk): void {
    this.id ||= c.id;
    this.model ||= c.model;
    this.created ||= c.created;
    this.fingerprint ??= c.system_fingerprint ?? null;
    if (c.usage) {
      this.usage = c.usage;
    }
    const choice = c.choices[0];
    if (!choice) {
      return;
    }
    const d = choice.delta as ChatCompletionChunk.Choice.Delta & Record<string, unknown>;
    if (typeof d.content === 'string') {
      this.content += d.content;
      this.hasContent = true;
    }
    const r = d['reasoning_content'] ?? d['reasoning'];
    if (typeof r === 'string') {
      this.reasoning += r;
    }
    if (typeof d.refusal === 'string') {
      this.refusal = (this.refusal ?? '') + d.refusal;
    }
    for (const t of d.tool_calls ?? []) {
      const cur = this.tools.get(t.index) ?? { id: '', name: '', arguments: '' };
      cur.id ||= t.id ?? '';
      cur.name += t.function?.name ?? '';
      cur.arguments += t.function?.arguments ?? '';
      this.tools.set(t.index, cur);
    }
    if (choice.finish_reason) {
      this.finish = choice.finish_reason;
    }
  }

  result(): ChatCompletion {
    const tool_calls = [...this.tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, t]) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } }));
    const message = {
      role: 'assistant' as const,
      content: this.hasContent ? this.content : null,
      refusal: this.refusal,
      ...(tool_calls.length ? { tool_calls } : {}),
      ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
    };
    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      system_fingerprint: this.fingerprint ?? undefined,
      choices: [
        {
          index: 0,
          message,
          finish_reason: (this.finish ?? 'stop') as ChatCompletion.Choice['finish_reason'],
          logprobs: null,
        },
      ],
      usage: this.usage,
    } as ChatCompletion;
  }
}

/**
 * 发出一次流式调用。首 token 计时从发出请求开始，收到第一个输出增量后改为空闲计时（任何流事件都会重置）；
 * capMs 是总时长上限（路由的 total 与阶段 B 剩余时间中的较小者）。超时以 StreamTimeout 抛出，其他错误原样抛出。
 */
export async function streamTurn(
  client: OpenAI,
  api: LlmApi,
  params: StreamParams,
  profile: DialectProfile,
  timeouts: RouteTimeouts,
  capMs: number,
  signal: AbortSignal,
  routeId: string,
): Promise<StreamedTurn> {
  const started = Date.now();
  const ac = new AbortController();
  // 在回调里改写的状态放进对象，避免控制流收窄
  const st: { fired: StreamTimeout | null; firstTokenAt: number | null } = { fired: null, firstTokenAt: null };
  const fire = (t: StreamTimeout) => {
    st.fired = t;
    ac.abort(t);
  };
  let timer = setTimeout(() => fire(new StreamTimeout('first_token', timeouts.firstTokenMs)), timeouts.firstTokenMs);
  const cap = setTimeout(() => fire(new StreamTimeout('total', capMs)), capMs);
  const progress = (token: boolean) => {
    if (st.firstTokenAt === null) {
      if (!token) {
        return;
      }
      st.firstTokenAt = Date.now();
    }
    clearTimeout(timer);
    timer = setTimeout(() => fire(new StreamTimeout('idle', timeouts.idleMs)), timeouts.idleMs);
  };
  const opts = { signal: AbortSignal.any([signal, ac.signal]) };
  // SDK 的流在中止时安静地结束迭代而不抛错：每个流读完后检查是否是被中止的
  const throwIfAborted = () => {
    if (st.fired) {
      throw st.fired;
    }
    if (signal.aborted) {
      throw signal.reason;
    }
  };
  try {
    let turn: LlmTurn;
    if (api === 'responses') {
      const stream = await client.responses.create(params as ResponseCreateParamsStreaming, opts);
      let final: Response | null = null;
      for await (const ev of stream) {
        progress(responsesToken(ev));
        if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
          final = ev.response;
        } else if (ev.type === 'response.failed') {
          const err = ev.response.error;
          throw new LlmError(
            'llm_http',
            null,
            `模型服务报告失败：${err?.code ?? ''} ${err?.message ?? ''}`.trim(),
            routeId,
          );
        } else if (ev.type === 'error') {
          throw new LlmError('llm_http', null, `模型服务在流中报错：${ev.code ?? ''} ${ev.message}`.trim(), routeId);
        }
      }
      throwIfAborted();
      if (!final) {
        throw new LlmError('llm_network', null, '流在 response.completed 之前结束', routeId);
      }
      turn = fromResponse(final, profile);
    } else {
      const stream = await client.chat.completions.create(params as ChatCompletionCreateParamsStreaming, opts);
      const acc = new ChatAccumulator();
      for await (const chunk of stream) {
        progress(chatToken(chunk));
        acc.push(chunk);
      }
      throwIfAborted();
      turn = fromChatCompletion(acc.result(), profile);
    }
    return { turn, firstTokenMs: st.firstTokenAt === null ? null : st.firstTokenAt - started };
  } catch (e) {
    if (st.fired && !signal.aborted) {
      throw st.fired;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    clearTimeout(cap);
  }
}
