// 模型层的内部类型：两种 OpenAI 协议共用的消息模型、请求与回合

/** 出境数据类别（研判清单 EgressEntry.categories） */
export type EgressCategory = 'metrics' | 'logs' | 'traces' | 'events' | 'topology' | 'changes' | 'alerts' | 'knowledge';

/**
 * 一段提示词文本及其携带的数据类别；固定指令没有类别。
 * egress 来自卡片级出境控制：allow 原样出站，redact 出站前脱敏；never 的内容不会成为片段。
 */
export interface Segment {
  text: string;
  categories: readonly EgressCategory[];
  egress: 'allow' | 'redact';
}

export type Item =
  | { type: 'system'; segments: Segment[] }
  | { type: 'user'; segments: Segment[] }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; output: Segment };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OutputFormat {
  name: string;
  /** 发给模型的可移植 schema（已替换动态枚举、去掉子集之外的关键字） */
  schema: Record<string, unknown>;
}

export type LlmApi = 'responses' | 'chat_completions';

export interface LlmRequest {
  items: Item[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  /** 结构化输出；路由的方言档案决定用严格 json_schema 还是 json_object 加提示词中的 schema */
  output?: OutputFormat;
  maxOutputTokens: number;
  /** 采样参数，写入研判清单 */
  temperature?: number;
  seed?: number;
}

export interface ToolCallRequest {
  callId: string;
  name: string;
  arguments: string;
}

export interface TurnUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

/** 一次模型调用的结果 */
export interface LlmTurn {
  /** 最终输出文本；推理内容不在这里 */
  text: string | null;
  /** 推理通道中的内容（只保存长度，不约束内容） */
  reasoningChars: number;
  refusal: string | null;
  toolCalls: ToolCallRequest[];
  /** 输出因长度上限、内容过滤等原因不完整 */
  incomplete: string | null;
  usage: TurnUsage;
  /** 服务方返回的模型 ID 与系统指纹，用于漂移检测 */
  responseModel: string | null;
  systemFingerprint: string | null;
}

export type LlmErrorKind =
  | 'llm_http'
  | 'llm_timeout'
  | 'llm_network'
  | 'llm_output_invalid'
  | 'llm_breaker_open'
  | 'llm_budget'
  | 'llm_egress_blocked';

export class LlmError extends Error {
  override name = 'LlmError';
  constructor(
    readonly kind: LlmErrorKind,
    readonly httpStatus: number | null,
    message: string,
    readonly routeId: string | null,
  ) {
    super(message);
  }

  /** 网络错误、超时、408 / 429 / 5xx 计入失败型熔断器；其他 4xx 是请求本身的问题 */
  get countsAsFailure(): boolean {
    if (this.kind === 'llm_timeout' || this.kind === 'llm_network') {
      return true;
    }
    if (this.kind !== 'llm_http') {
      return false;
    }
    const s = this.httpStatus;
    return s === null || s === 408 || s === 429 || s >= 500;
  }
}

/** 研判阶段（研判清单 RouteUse.phase） */
export type LlmPhase = 'hypothesize' | 'conclude' | 'compress' | 'still_consistent' | 'repair';
