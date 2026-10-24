import type { DialectProfile } from '@srenautix/contract';

export type { DialectProfile };

/**
 * 内置方言档案的声明值。启动时和评测时的能力探测（probe.ts）逐项测量并覆盖这里的取值；
 * 测不出来的项（例如上下文长度在服务方不公开时）保留声明值，并在探测结果里标为 declared。
 */
export const DECLARED_PROFILES: Readonly<Record<string, Omit<DialectProfile, 'measured_at' | 'provider_fingerprint'>>> =
  {
    // OpenAI 及兼容 /v1/responses 的服务
    'openai-responses': {
      id: 'openai-responses',
      strict_json_schema: true,
      native_tools: true,
      reasoning_channel: 'separate_field',
      context_tokens: 400_000,
      chinese: 'native',
      tokenizer: 'tiktoken_o200k',
    },
    'openai-chat': {
      id: 'openai-chat',
      strict_json_schema: true,
      native_tools: true,
      reasoning_channel: 'none',
      context_tokens: 128_000,
      chinese: 'native',
      tokenizer: 'tiktoken_o200k',
    },
    // DeepSeek：response_format 只有 text 与 json_object；推理内容在 reasoning_content
    deepseek: {
      id: 'deepseek',
      strict_json_schema: false,
      native_tools: true,
      reasoning_channel: 'separate_field',
      context_tokens: 128_000,
      chinese: 'native',
      tokenizer: 'byte_estimate',
    },
    // vLLM 上的 Qwen：结构化输出走 guided decoding；推理内容需要服务端开启 reasoning parser
    'qwen-vllm': {
      id: 'qwen-vllm',
      strict_json_schema: true,
      native_tools: true,
      reasoning_channel: 'separate_field',
      context_tokens: 32_768,
      chinese: 'native',
      tokenizer: 'byte_estimate',
    },
    // llama.cpp llama-server（--jinja）：json_schema 转为语法约束
    llamacpp: {
      id: 'llamacpp',
      strict_json_schema: true,
      native_tools: true,
      reasoning_channel: 'separate_field',
      context_tokens: 8_192,
      chinese: 'adequate',
      tokenizer: 'byte_estimate',
    },
    // 只提供 OpenAI 兼容 /v1/chat/completions 的托管服务（国内模型服务方的兼容接口，ADR 0152）：
    // 输出上限用 max_tokens，结构化输出声明为 json_object 加提示词中的 schema，推理内容在 reasoning_content；
    // 严格 json_schema 与上下文长度以能力探测为准
    'openai-compatible': {
      id: 'openai-compatible',
      strict_json_schema: false,
      native_tools: true,
      reasoning_channel: 'separate_field',
      context_tokens: 128_000,
      chinese: 'native',
      tokenizer: 'byte_estimate',
    },
  };

/**
 * 输出上限用 max_tokens 的方言档案。OpenAI 的 Chat 接口把它换成了 max_completion_tokens，
 * 兼容接口的服务方普遍只认 max_tokens
 */
const MAX_TOKENS_PROFILES: ReadonlySet<string> = new Set(['openai-compatible']);

/** Chat 请求体里表示输出上限的字段 */
export function chatMaxTokensField(profileId: string): 'max_tokens' | 'max_completion_tokens' {
  return MAX_TOKENS_PROFILES.has(profileId) ? 'max_tokens' : 'max_completion_tokens';
}

/** 取声明档案；未知的档案名直接报错 */
export function declaredProfile(id: string): DialectProfile {
  const p = DECLARED_PROFILES[id];
  if (!p) {
    throw new Error(`未知的方言档案 ${id}，可选：${Object.keys(DECLARED_PROFILES).join('、')}`);
  }
  return { ...p, measured_at: new Date(0).toISOString(), provider_fingerprint: null };
}
