import type { ChatCompletion } from 'openai/resources/chat/completions/completions';
import type { Response } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';
import { declaredProfile } from '../../src/llm/dialect.js';
import type { LlmRequest } from '../../src/llm/types.js';
import {
  fromChatCompletion,
  fromResponse,
  requestCategories,
  schemaInstruction,
  stripInlineReasoning,
  toChatParams,
  toResponsesParams,
} from '../../src/llm/wire.js';
import { fixture } from '../support/llm-fixtures.js';

const strict = declaredProfile('openai-responses');
const loose = declaredProfile('deepseek');

const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } };

const request: LlmRequest = {
  items: [
    { type: 'system', segments: [{ text: '固定指令', categories: [], egress: 'allow' }] },
    { type: 'user', segments: [{ text: '证据', categories: ['metrics', 'logs'], egress: 'redact' }] },
    { type: 'assistant', text: '先查一下' },
    { type: 'tool_call', callId: 'c1', name: 'metrics_query', arguments: '{"query":"up"}' },
    { type: 'tool_result', callId: 'c1', output: { text: '{"result":[]}', categories: ['metrics'], egress: 'redact' } },
  ],
  tools: [{ name: 'metrics_query', description: 'q', parameters: { type: 'object', properties: {} } }],
  toolChoice: 'auto',
  output: { name: 'out', schema },
  maxOutputTokens: 1000,
};

describe('请求映射', () => {
  it('responses：system 合成 instructions，严格 schema 用 json_schema', () => {
    const p = toResponsesParams(request, { model: 'm', profile: strict, language: 'zh' });
    expect(p.instructions).toBe('固定指令');
    expect(p.store).toBe(false);
    expect(p.text).toEqual({ format: { type: 'json_schema', name: 'out', schema, strict: true } });
    const input = p.input as unknown as Array<Record<string, unknown>>;
    expect(input.map((i) => i.type)).toEqual(['message', 'message', 'function_call', 'function_call_output']);
  });

  it('不支持严格 schema 的方言：json_object，schema 写在系统提示末尾', () => {
    const p = toChatParams(request, { model: 'm', profile: loose, language: 'zh' });
    expect(p.response_format).toEqual({ type: 'json_object' });
    expect(p.messages[0]).toEqual({ role: 'system', content: `固定指令\n\n${schemaInstruction(schema, 'zh')}` });
    expect(p.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(p.messages[2]).toMatchObject({ content: '先查一下', tool_calls: [{ id: 'c1', type: 'function' }] });
  });

  it('chat 的严格 schema 用 response_format.json_schema；toolChoice=none 时不带工具', () => {
    const p = toChatParams(
      { ...request, toolChoice: 'none' },
      { model: 'm', profile: declaredProfile('openai-chat'), language: 'en' },
    );
    expect(p.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'out', schema, strict: true } });
    expect(p.tools).toBeUndefined();
  });

  it('数据类别取自提示词片段与工具结果', () => {
    expect([...requestCategories(request.items)].sort()).toEqual(['logs', 'metrics']);
  });
});

describe('OpenAI 文档中的响应示例', () => {
  it('responses 文本', () => {
    const t = fromResponse(fixture('openai-docs', 'responses-text').body as Response, strict);
    expect(t.text).toMatch(/^In a peaceful grove/);
    expect(t.usage.input).toBeGreaterThan(0);
    expect(t.responseModel).toBe('gpt-6-astra');
  });

  it('responses 函数调用', () => {
    const t = fromResponse(fixture('openai-docs', 'responses-function-call').body as Response, strict);
    expect(t.text).toBeNull();
    expect(t.toolCalls).toHaveLength(1);
    expect(t.toolCalls[0]?.name).toBe('get_current_weather');
  });

  it('responses 推理模型：推理 token 计入 usage.reasoning', () => {
    const body = fixture('openai-docs', 'responses-reasoning').body as Response;
    const t = fromResponse(body, strict);
    expect(t.usage.reasoning).toBe(body.usage?.output_tokens_details.reasoning_tokens);
    expect(t.text).toBe('The classic tongue twister...');
  });

  it('chat 默认与函数调用', () => {
    const d = fromChatCompletion(
      fixture('openai-docs', 'chat-default').body as ChatCompletion,
      declaredProfile('openai-chat'),
    );
    expect(d).toMatchObject({
      text: 'Hello! How can I assist you today?',
      incomplete: null,
      usage: { input: 19, output: 10 },
    });
    const f = fromChatCompletion(
      fixture('openai-docs', 'chat-function-call').body as ChatCompletion,
      declaredProfile('openai-chat'),
    );
    expect(f.toolCalls[0]).toMatchObject({ callId: 'call_abc123', name: 'get_current_weather' });
  });
});

describe('llama.cpp（Qwen3 1.7B）录制的响应', () => {
  const p = declaredProfile('llamacpp');
  const P = 'llamacpp-qwen3-1.7b';

  it('chat：reasoning_content 在独立字段，正文是最终输出；system_fingerprint 进入指纹', () => {
    const t = fromChatCompletion(fixture(P, 'chat-json-schema').body as ChatCompletion, p);
    expect(JSON.parse(t.text as string)).toMatchObject({ component: 'Deployment:shop/api' });
    expect(t.reasoningChars).toBeGreaterThan(100);
    expect(t.systemFingerprint).toMatch(/^b\d+-/);
  });

  it('chat：finish_reason=length 判为不完整；缓存命中进入 cachedInput', () => {
    const t = fromChatCompletion(fixture(P, 'chat-length').body as ChatCompletion, p);
    expect(t.incomplete).toBe('length');
    expect(t.usage.cachedInput).toBe(16);
  });

  it('chat：工具调用', () => {
    const t = fromChatCompletion(fixture(P, 'chat-tool-call').body as ChatCompletion, p);
    expect(t.toolCalls[0]?.name).toBe('metrics_query');
  });

  it('responses：推理条目的 content 计入推理字符；输出上限耗尽时没有 message，status 仍是 completed', () => {
    const t = fromResponse(fixture(P, 'responses-max-output').body as Response, p);
    expect(t.text).toBeNull();
    expect(t.incomplete).toBeNull();
    expect(t.reasoningChars).toBeGreaterThan(0);
  });

  it('responses：llama.cpp 的 /v1/responses 不执行 text.format 的 json_schema（输出字段与 schema 不符）', () => {
    const t = fromResponse(fixture(P, 'responses-json-schema').body as Response, p);
    const out = JSON.parse(t.text as string) as Record<string, unknown>;
    expect(Object.keys(out)).not.toEqual(['component', 'verdict', 'refs']);
  });
});

describe('内联推理标签', () => {
  it('去掉 <think> 部分，只保留最终输出', () => {
    expect(stripInlineReasoning('<think>先算 17-5</think>\n20')).toEqual({
      text: '20',
      reasoningChars: '先算 17-5'.length,
    });
  });
});
