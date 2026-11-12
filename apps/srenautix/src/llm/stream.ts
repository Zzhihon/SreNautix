import { APIError } from 'openai';
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
import { EgressBlocked } from './egress.js';
import type { RouteTimeouts } from './timeouts.js';
import { LlmError, type LlmApi, type LlmTurn } from './types.js';
import {
  fromChatCompletion,
  fromMessage,
  fromResponse,
  toolInput,
  type MessagesBlock,
  type MessagesParams,
  type MessagesResponse,
  type MessagesUsage,
  type WireParams,
} from './wire.js';

// 流式调用（ADR 0098）：三种协议都以流式发出，按首 token 超时与空闲超时判断"卡住"，不再用一个总时长。
// 流结束后拼回与非流式相同的响应对象，交给 wire.ts 的同一套映射。

export type MessagesStreamParams = Omit<MessagesParams, 'stream'> & { stream: true };
export type StreamParams = ResponseCreateParamsStreaming | ChatCompletionCreateParamsStreaming | MessagesStreamParams;

/** 非流式请求体 → 流式请求体；chat 要求服务方在最后一个块里给出 usage */
export function streamingParams(api: LlmApi, params: WireParams): StreamParams {
  return PROTOCOLS[api].streaming(params);
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
  private readonly tools: Array<{ index: number | null; id: string; name: string; arguments: string }> = [];

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
      const cur = this.toolCall(t);
      cur.id ||= t.id ?? '';
      cur.name += t.function?.name ?? '';
      cur.arguments += t.function?.arguments ?? '';
    }
    if (choice.finish_reason) {
      this.finish = choice.finish_reason;
    }
  }

  /**
   * 增量所属的函数调用。带 index 的增量按 index 归并。有的服务方（经网关的 Gemini）不给 index，每个块是一个完整的调用、
   * 各有自己的 id：这时 id 与最后一个调用不同（或还没有调用）就开始新的调用，否则接在最后一个调用上
   */
  private toolCall(t: { index?: number; id?: string }): (typeof this.tools)[number] {
    const index = typeof t.index === 'number' ? t.index : null;
    const last = this.tools.at(-1);
    const cur =
      index !== null
        ? this.tools.find((x) => x.index === index)
        : last && (!t.id || t.id === last.id)
          ? last
          : undefined;
    if (cur) {
      return cur;
    }
    const created = { index, id: '', name: '', arguments: '' };
    this.tools.push(created);
    return created;
  }

  result(): ChatCompletion {
    // 带 index 的按 index 排序，不带 index 的按到达顺序
    const tool_calls = this.tools
      .map((t, order) => ({ t, key: t.index ?? order }))
      .sort((a, b) => a.key - b.key)
      .map(({ t }) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } }));
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

/** Messages API 的流事件（ADR 0200）；只声明用到的字段 */
interface MessagesStreamEvent {
  type: string;
  index?: number;
  message?: { id?: string; model?: string; usage?: MessagesUsage | null };
  content_block?: MessagesBlock | { type: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string | null;
    stop_details?: MessagesResponse['stop_details'];
  };
  usage?: MessagesUsage | null;
  error?: { type?: string; message?: string };
}

/** 把 Messages API 的流事件拼回 `POST /messages` 的响应 */
export class MessagesAccumulator {
  private id = '';
  private model = '';
  private usage: MessagesUsage = {};
  private stopReason: string | null = null;
  private stopDetails: MessagesResponse['stop_details'] = null;
  private readonly blocks = new Map<number, { block: MessagesBlock | { type: string }; json: string }>();
  private stopped = false;

  constructor(private readonly routeId: string) {}

  /** 流是否以 message_stop 正常结束 */
  get complete(): boolean {
    return this.stopped;
  }

  /** 处理一个事件；返回它是否是模型输出的增量（正文、推理、工具参数，或一个 tool_use 块的开始） */
  push(ev: MessagesStreamEvent): boolean {
    switch (ev.type) {
      case 'message_start':
        this.id = ev.message?.id ?? '';
        this.model = ev.message?.model ?? '';
        this.mergeUsage(ev.message?.usage);
        return false;
      case 'content_block_start': {
        if (ev.index === undefined || !ev.content_block) {
          return false;
        }
        this.blocks.set(ev.index, { block: structuredClone(ev.content_block), json: '' });
        return ev.content_block.type === 'tool_use';
      }
      case 'content_block_delta': {
        const cur = ev.index === undefined ? undefined : this.blocks.get(ev.index);
        const d = ev.delta;
        if (!cur || !d) {
          return false;
        }
        const b = cur.block as MessagesBlock;
        if (d.type === 'text_delta' && b.type === 'text') {
          b.text += d.text ?? '';
          return true;
        }
        if (d.type === 'thinking_delta' && b.type === 'thinking') {
          b.thinking += d.thinking ?? '';
          return true;
        }
        if (d.type === 'input_json_delta' && b.type === 'tool_use') {
          cur.json += d.partial_json ?? '';
          return true;
        }
        if (d.type === 'signature_delta' && b.type === 'thinking') {
          b.signature = (b.signature ?? '') + (d.signature ?? '');
        }
        return false;
      }
      case 'content_block_stop': {
        const cur = ev.index === undefined ? undefined : this.blocks.get(ev.index);
        const b = cur?.block as MessagesBlock | undefined;
        if (cur && b?.type === 'tool_use' && cur.json !== '') {
          // 输出被截断时拼出的参数不是完整的 JSON，原文留在 `_raw`
          b.input = toolInput(cur.json);
        }
        return false;
      }
      case 'message_delta':
        this.stopReason = ev.delta?.stop_reason ?? this.stopReason;
        this.stopDetails = ev.delta?.stop_details ?? this.stopDetails;
        this.mergeUsage(ev.usage);
        return false;
      case 'message_stop':
        this.stopped = true;
        return false;
      case 'error':
        throw new LlmError(
          'llm_http',
          null,
          `模型服务在流中报错：${ev.error?.type ?? ''} ${ev.error?.message ?? ''}`.trim(),
          this.routeId,
        );
      default:
        // ping 与不认识的事件
        return false;
    }
  }

  /** message_delta 的 usage 是累计值：出现的字段覆盖 message_start 给出的值 */
  private mergeUsage(u: MessagesUsage | null | undefined): void {
    for (const k of [
      'input_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'output_tokens',
    ] as const) {
      const v = u?.[k];
      if (typeof v === 'number') {
        this.usage[k] = v;
      }
    }
  }

  result(): MessagesResponse {
    return {
      id: this.id,
      model: this.model,
      content: [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, v]) => v.block),
      stop_reason: this.stopReason,
      stop_details: this.stopDetails,
      usage: this.usage,
    };
  }
}

interface CallOptions {
  signal: AbortSignal;
  timeout?: number;
}

/** 一次流式调用的事件归并器：push 返回事件是否是模型输出的增量；turn 在流读完后给出回合，流不完整时抛出 */
interface TurnReader {
  push(ev: unknown): boolean;
  turn(): LlmTurn;
}

/** 一种协议的收发方式：流式与非流式各一种，映射都走 wire.ts */
interface Protocol {
  streaming(params: WireParams): StreamParams;
  open(client: OpenAI, params: StreamParams, opts: CallOptions): Promise<AsyncIterable<unknown>>;
  reader(profile: DialectProfile, routeId: string): TurnReader;
  complete(client: OpenAI, params: WireParams, profile: DialectProfile, opts: CallOptions): Promise<LlmTurn>;
}

const PROTOCOLS: Record<LlmApi, Protocol> = {
  responses: {
    streaming: (params) => ({ ...(params as ResponseCreateParamsNonStreaming), stream: true }),
    open: (client, params, opts) => client.responses.create(params as ResponseCreateParamsStreaming, opts),
    reader: (profile, routeId) => {
      let final: Response | null = null;
      return {
        push: (e) => {
          const ev = e as ResponseStreamEvent;
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
          return responsesToken(ev);
        },
        turn: () => {
          if (!final) {
            throw new LlmError('llm_network', null, '流在 response.completed 之前结束', routeId);
          }
          return fromResponse(final, profile);
        },
      };
    },
    complete: async (client, params, profile, opts) =>
      fromResponse(await client.responses.create(params as ResponseCreateParamsNonStreaming, opts), profile),
  },
  chat_completions: {
    streaming: (params) => ({
      ...(params as ChatCompletionCreateParamsNonStreaming),
      stream: true,
      stream_options: { include_usage: true },
    }),
    open: (client, params, opts) => client.chat.completions.create(params as ChatCompletionCreateParamsStreaming, opts),
    reader: (profile) => {
      const acc = new ChatAccumulator();
      return {
        push: (e) => {
          const chunk = e as ChatCompletionChunk;
          acc.push(chunk);
          return chatToken(chunk);
        },
        turn: () => fromChatCompletion(acc.result(), profile),
      };
    },
    complete: async (client, params, profile, opts) =>
      fromChatCompletion(
        await client.chat.completions.create(params as ChatCompletionCreateParamsNonStreaming, opts),
        profile,
      ),
  },
  // Messages API 经同一个 OpenAI 客户端的通用 post 发出（出站检查、计量与超时都在同一条路径上）；
  // SDK 的通用 SSE 流对每个事件给出 JSON.parse(data)，Messages 的事件类型就在 data.type 里
  messages: {
    streaming: (params) => ({ ...(params as MessagesParams), stream: true }),
    open: (client, params, opts) =>
      client.post<AsyncIterable<unknown>>('/messages', { body: params, stream: true, ...opts }),
    reader: (profile, routeId) => {
      const acc = new MessagesAccumulator(routeId);
      return {
        push: (e) => acc.push(e as MessagesStreamEvent),
        turn: () => {
          if (!acc.complete) {
            throw new LlmError('llm_network', null, '流在 message_stop 之前结束', routeId);
          }
          return fromMessage(acc.result(), profile);
        },
      };
    },
    complete: async (client, params, profile, opts) =>
      fromMessage(await client.post<MessagesResponse>('/messages', { body: params, ...opts }), profile),
  },
};

/** 发出一次非流式调用（能力探测用），返回内部回合；错误原样抛出 */
export function completeTurn(
  client: OpenAI,
  api: LlmApi,
  params: WireParams,
  profile: DialectProfile,
  opts: CallOptions,
): Promise<LlmTurn> {
  return PROTOCOLS[api].complete(client, params, profile, opts);
}

/**
 * 发出一次流式调用。首 token 计时从发出请求开始，收到第一个输出增量后改为空闲计时（任何流事件都会重置）；
 * capMs 是总时长上限（路由的 total 与阶段 B 剩余时间中的较小者）。超时以 StreamTimeout 抛出；流读到一半的非预期异常
 * 以 LlmError llm_network 抛出；其他错误原样抛出。
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
  // 流读到一半的异常统一兜底：SDK 的 SSE 与 JSON 解析错误（SyntaxError: malformed server-sent event JSON）、
  // 连接中断（undici 的 TypeError: terminated）以及其他非预期异常都归为网络失败，照常重试或换路由，
  // 不让它逃出研判、使整个进程退出。超时与调用方中止仍按原样返回；服务方在流里报告的错误（LlmError、SDK 的 APIError）
  // 照原来的归类
  const midStream = (e: unknown): unknown => {
    if (st.fired) {
      return st.fired;
    }
    if (signal.aborted) {
      return signal.reason;
    }
    if (e instanceof LlmError || e instanceof APIError || e instanceof StreamTimeout || e instanceof EgressBlocked) {
      return e;
    }
    const cause = (e as { cause?: unknown } | null)?.cause;
    const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return new LlmError(
      'llm_network',
      null,
      `模型服务的流在读取中途出错：${what}${cause instanceof Error ? `（${cause.message}）` : ''}`.slice(0, 600),
      routeId,
    );
  };
  try {
    const protocol = PROTOCOLS[api];
    const stream = await protocol.open(client, params, opts);
    const reader = protocol.reader(profile, routeId);
    try {
      for await (const ev of stream) {
        progress(reader.push(ev));
      }
    } catch (e) {
      throw midStream(e);
    }
    throwIfAborted();
    const turn = reader.turn();
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
