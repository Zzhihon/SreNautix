import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ModelRoute } from '@srenautix/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, ResearchLedger } from '../../src/llm/budget.js';
import { declaredProfile } from '../../src/llm/dialect.js';
import { Egress } from '../../src/llm/egress.js';
import { probeRoute } from '../../src/llm/probe.js';
import { buildRuntimes } from '../../src/llm/routes.js';
import { DOMAIN_PROBE, ModelLayer, type LlmCallRecord } from '../../src/llm/session.js';
import { MessagesAccumulator } from '../../src/llm/stream.js';
import type { LlmRequest } from '../../src/llm/types.js';
import {
  buildParams,
  fromMessage,
  schemaInstruction,
  toMessagesParams,
  type MessagesResponse,
} from '../../src/llm/wire.js';
import { workerConfigSchema } from '../../src/research/config.js';
import { WorkerMetrics } from '../../src/research/metrics.js';
import { fixture, ReplayServer } from '../support/llm-fixtures.js';

// Anthropic Messages API（api: messages，ADR 0200）：请求与响应的映射、流事件的归并、经路由的 OpenAI 客户端发出的研判调用与能力探测。
// 夹具是 2026-11-12 经模型网关取得的 claude-fable-5-2 响应与流事件

const P = 'gateway-claude-fable-5-2';
const profile = declaredProfile('anthropic-messages');
const wire = { model: 'claude-fable-5-2', profile, language: 'en' as const };
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['component', 'verdict', 'refs'],
  properties: {
    component: { type: 'string', enum: ['Deployment:shop/api', 'StatefulSet:shop/postgres'] },
    verdict: { type: 'string', enum: ['abnormal', 'normal'] },
    refs: { type: 'array', items: { type: 'string', enum: ['card:1', 'card:2'] } },
  },
};
const seg = (text: string) => ({ text, categories: [], egress: 'allow' as const });

const events = (name: string): Array<{ type: string }> =>
  (
    JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/llm', P, `${name}.json`), 'utf8')) as {
      events: Array<{ type: string }>;
    }
  ).events;

function accumulate(name: string): { acc: MessagesAccumulator; tokens: number } {
  const acc = new MessagesAccumulator('primary');
  let tokens = 0;
  for (const ev of events(name)) {
    tokens += acc.push(ev) ? 1 : 0;
  }
  return { acc, tokens };
}

describe('请求映射', () => {
  const request: LlmRequest = {
    items: [
      { type: 'system', segments: [seg('固定指令')] },
      { type: 'user', segments: [seg('证据')] },
      { type: 'assistant', text: '先查一下' },
      { type: 'tool_call', callId: 'toolu_1', name: 'query_metrics', arguments: '{"query":"up","minutes":30}' },
      { type: 'tool_call', callId: 'toolu_2', name: 'get_pod_restarts', arguments: 'not json' },
      { type: 'tool_result', callId: 'toolu_1', output: seg('{"result":[]}') },
      { type: 'tool_result', callId: 'toolu_2', output: seg('3') },
      { type: 'user', segments: [seg('继续')] },
    ],
    tools: [{ name: 'query_metrics', description: 'q', parameters: { type: 'object', properties: {} } }],
    toolChoice: 'required',
    output: { name: 'out', schema },
    maxOutputTokens: 1000,
    temperature: 0,
  };

  it('system 合成顶层 system 并附上 schema 说明；相邻的同角色内容合成一条消息，user 与 assistant 交替', () => {
    const p = toMessagesParams(request, wire);
    expect(p.system).toBe(`固定指令\n\n${schemaInstruction(schema, 'en')}`);
    expect(p.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '证据' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先查一下' },
          { type: 'tool_use', id: 'toolu_1', name: 'query_metrics', input: { query: 'up', minutes: 30 } },
          // 参数不是 JSON 对象时原文放进 _raw
          { type: 'tool_use', id: 'toolu_2', name: 'get_pod_restarts', input: { _raw: 'not json' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"result":[]}' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: '3' },
          { type: 'text', text: '继续' },
        ],
      },
    ]);
    expect(p).toMatchObject({ model: 'claude-fable-5-2', max_tokens: 1000, stream: false });
    expect(p.tools).toEqual([
      { name: 'query_metrics', description: 'q', input_schema: request.tools?.[0]?.parameters },
    ]);
    expect(p.tool_choice).toEqual({ type: 'any' });
    // 不带采样参数，也不带 Chat 的 thinking 字段；声明档案不支持严格 schema，不带 output_config
    expect(p).not.toHaveProperty('temperature');
    expect(p).not.toHaveProperty('thinking');
    expect(p).not.toHaveProperty('output_config');
    expect(buildParams('messages', request, wire)).toEqual(p);
  });

  it('toolChoice 的三个取值；none 时仍然带工具定义', () => {
    expect(toMessagesParams({ ...request, toolChoice: 'auto' }, wire).tool_choice).toEqual({ type: 'auto' });
    const none = toMessagesParams({ ...request, toolChoice: 'none' }, wire);
    expect(none.tool_choice).toEqual({ type: 'none' });
    expect(none.tools).toHaveLength(1);
  });

  it('探测到严格 schema 的路由用 output_config.format，系统提示不再附 schema 说明', () => {
    const p = toMessagesParams(request, { ...wire, profile: { ...profile, strict_json_schema: true } });
    expect(p.output_config).toEqual({ format: { type: 'json_schema', schema } });
    expect(p.system).toBe('固定指令');
  });

  it('重新请求的历史：空的助手文本不成块，前后的用户输入合成一条 user 消息', () => {
    const p = toMessagesParams(
      {
        items: [
          { type: 'user', segments: [seg('问题')] },
          { type: 'assistant', text: '' },
          { type: 'user', segments: [seg('上一次输出无效，请重新输出')] },
        ],
        maxOutputTokens: 100,
      },
      wire,
    );
    expect(p.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '问题' },
          { type: 'text', text: '上一次输出无效，请重新输出' },
        ],
      },
    ]);
  });
});

describe('响应映射', () => {
  it('thinking 块计入推理字符，text 块是正文，usage 取 input_tokens 与 output_tokens', () => {
    const t = fromMessage(fixture(P, 'messages-json').body as MessagesResponse, profile);
    expect(JSON.parse(t.text as string)).toEqual({
      component: 'Deployment:shop/api',
      verdict: 'abnormal',
      refs: ['card:1'],
    });
    expect(t.reasoningChars).toBeGreaterThan(100);
    expect(t).toMatchObject({
      refusal: null,
      incomplete: null,
      toolCalls: [],
      usage: { input: 254, cachedInput: 0, output: 103, reasoning: 0 },
      responseModel: 'claude-fable-5-2',
    });
  });

  it('输入 token 是未缓存、缓存读取与缓存写入之和；max_tokens 记为 length，refusal 记为拒绝', () => {
    const body = (over: Partial<MessagesResponse>): MessagesResponse => ({
      content: [{ type: 'text', text: 'x' }],
      stop_reason: 'end_turn',
      ...over,
    });
    const cached = fromMessage(
      body({
        usage: { input_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 50, output_tokens: 7 },
      }),
      profile,
    );
    expect(cached.usage).toEqual({ input: 360, cachedInput: 300, output: 7, reasoning: 0 });
    expect(fromMessage(body({ stop_reason: 'max_tokens' }), profile).incomplete).toBe('length');
    const refused = fromMessage(
      body({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: null } }),
      profile,
    );
    expect(refused).toMatchObject({ text: null, refusal: 'cyber' });
  });
});

describe('流事件归并', () => {
  it('正文流：thinking 与 text 的增量拼回内容块，usage 以 message_delta 的累计值为准', () => {
    const { acc, tokens } = accumulate('messages-stream-text');
    expect(acc.complete).toBe(true);
    // message_start 的 input_tokens 是 0，真实值在 message_delta 里
    expect(events('messages-stream-text')[0]).toMatchObject({ message: { usage: { input_tokens: 0 } } });
    const t = fromMessage(acc.result(), profile);
    expect(t.text).toBe('{"component":"Deployment:shop/api","verdict":"abnormal","refs":["card:1"]}');
    expect(t.reasoningChars).toBeGreaterThan(100);
    expect(t.usage).toEqual({ input: 254, cachedInput: 0, output: 104, reasoning: 0 });
    expect(t.responseModel).toBe('claude-fable-5-2');
    // thinking_delta 与 text_delta 是输出增量；ping、signature_delta、块的开始与结束不是
    const deltas = events('messages-stream-text').filter((e) => e.type === 'content_block_delta').length;
    expect(tokens).toBe(deltas - 1);
  });

  it('工具调用流：tool_use 块的开始算作输出增量，input_json_delta 拼成参数', () => {
    const { acc, tokens } = accumulate('messages-stream-tool-use');
    const t = fromMessage(acc.result(), profile);
    expect(t.toolCalls).toHaveLength(1);
    expect(t.toolCalls[0]).toMatchObject({ callId: 'toolu_01ye6PqT9aP56Qyw9iAMYFvm', name: 'query_metrics' });
    expect(Object.keys(JSON.parse(t.toolCalls[0]?.arguments as string) as object)).toEqual(['query', 'minutes']);
    expect(t.text).toBeNull();
    expect(t.usage).toMatchObject({ input: 318, output: 36 });
    expect(tokens).toBe(2);
  });

  it('两个工具调用按内容块的 index 分开', () => {
    const { acc } = accumulate('messages-stream-two-tools');
    const t = fromMessage(acc.result(), profile);
    expect(t.toolCalls.map((c) => [c.name, JSON.parse(c.arguments)])).toEqual([
      ['query_metrics', { query: 'sum by (pod) (…)', minutes: 30 }],
      ['get_pod_restarts', { namespace: 'cchp-prod', workload: 'gateway' }],
    ]);
    expect(t.usage).toMatchObject({ input: 680, output: 262 });
  });

  it('流在 message_stop 之前结束时不算完整；流里的 error 事件按服务方错误抛出', () => {
    const acc = new MessagesAccumulator('primary');
    for (const ev of events('messages-stream-text').slice(0, -1)) {
      acc.push(ev);
    }
    expect(acc.complete).toBe(false);
    expect(() =>
      acc.push({ type: 'error', error: { type: 'api_error', message: 'upstream unavailable' } } as never),
    ).toThrow(/模型服务在流中报错：api_error upstream unavailable/);
  });
});

describe('经路由的客户端调用', () => {
  let server: ReplayServer;
  let records: LlmCallRecord[];

  const route = (over: Partial<ModelRoute> = {}): ModelRoute => ({
    id: 'primary',
    base_url: server.baseUrl,
    api: 'messages',
    model: 'claude-fable-5-2',
    dialect_profile: 'anthropic-messages',
    price: { currency: 'USD', input_per_mtok: 10, output_per_mtok: 50, cached_input_per_mtok: 1 },
    failure_domain: [],
    in_domain: true,
    tier: 'large',
    retention_terms: 'gateway',
    ...over,
  });

  const runtimes = (r: ModelRoute) =>
    buildRuntimes(
      [{ route: r, apiKey: 'sk-test-key', state: { profile: null, calibration: null, fingerprint: null } }],
      new Egress({ allowCrossBorder: false, honeytokens: [] }, () => undefined),
    );

  function layer(r: ModelRoute) {
    const egress = new Egress({ allowCrossBorder: false, honeytokens: [] }, () => undefined);
    return new ModelLayer({
      routes: buildRuntimes(
        [{ route: r, apiKey: 'sk-test-key', state: { profile: null, calibration: null, fingerprint: null } }],
        egress,
      ),
      egress,
      budget: DEFAULT_BUDGET,
      metrics: new WorkerMetrics('worker', false),
      language: 'en',
      onCalibration: async () => undefined,
      onDrift: async () => undefined,
    });
  }

  const session = (l: ModelLayer, components: string[] = []) =>
    l.session({
      runId: null,
      incidentComponents: components,
      deadline: Date.now() + 480_000,
      signal: new AbortController().signal,
      ledger: new ResearchLedger(DEFAULT_BUDGET),
      record: async (r) => {
        records.push(r);
      },
    });

  const base: Omit<LlmRequest, 'output'> = {
    items: [
      { type: 'system', segments: [seg('You are an SRE assistant.')] },
      { type: 'user', segments: [{ text: 'card:1 says api errors', categories: ['metrics'], egress: 'redact' }] },
    ],
    maxOutputTokens: 4096,
    temperature: 0,
  };
  const OUTPUT = { name: 'verdict', schema, full: schema };

  beforeEach(async () => {
    server = new ReplayServer();
    await server.start();
    records = [];
  });

  afterEach(async () => {
    await server.stop();
  });

  it('研判调用：流式 POST /v1/messages，带 anthropic-version 与两种密钥请求头，按 usage 记账', async () => {
    server.enqueue(fixture(P, 'messages-json'));
    const s = session(layer(route()));
    const r = await s.structured('conclude', base, OUTPUT);
    expect(r).toMatchObject({ ok: true, routeId: 'primary', value: { component: 'Deployment:shop/api' } });
    const [req] = server.received;
    expect(req?.path).toBe('/v1/messages');
    expect(req?.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-test-key',
      authorization: 'Bearer sk-test-key',
    });
    const body = JSON.parse(req?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'claude-fable-5-2', stream: true, max_tokens: 4096 });
    expect(body).not.toHaveProperty('temperature');
    expect(body.system).toBe(`You are an SRE assistant.\n\n${schemaInstruction(schema, 'en')}`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      api: 'messages',
      outcome: 'succeeded',
      usage: { input_tokens: 254, output_tokens: 103 },
      cost: (254 * 10 + 103 * 50) / 1e6,
    });
    // 请求体里没有采样参数，研判清单也不记 temperature；密钥不进入调用记录
    expect(s.routeUses[0]).toMatchObject({
      dialect_profile: 'anthropic-messages',
      sampling: { max_output_tokens: 4096 },
    });
    expect(s.routeUses[0]?.sampling).not.toHaveProperty('temperature');
    expect(JSON.stringify(records)).not.toContain('sk-test-key');
  });

  it('服务方返回 HTTP 503 的错误体：按服务端错误归类，计入失败', async () => {
    server.enqueue({
      provenance: { shape: 'gateway error body' },
      status: 503,
      body: { type: 'error', error: { type: 'api_error', message: 'upstream unavailable' }, request_id: 'req_1' },
    });
    const r = await session(layer(route())).structured('conclude', base, OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'model_unavailable' });
    expect(records[0]).toMatchObject({ errorKind: 'llm_http', httpStatus: 503 });
    expect(records[0]?.note).toContain('upstream unavailable');
  });

  it('故障域探测调用也走 /v1/messages：固定文本、16 个输出 token', async () => {
    server.enqueue(fixture(P, 'messages-json'), fixture(P, 'messages-json'));
    const s = session(layer(route({ failure_domain: ['Namespace:llm-gateway'] })), ['Deployment:llm-gateway/gateway']);
    expect(await s.structured('conclude', base, OUTPUT)).toMatchObject({ ok: true, routeId: 'primary' });
    expect(server.received.map((x) => x.path)).toEqual(['/v1/messages', '/v1/messages']);
    expect(JSON.parse(server.received[0]?.body as string)).toEqual({
      model: 'claude-fable-5-2',
      max_tokens: DOMAIN_PROBE.maxOutputTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: DOMAIN_PROBE.prompt }] }],
      stream: true,
    });
  });

  it('能力探测：非流式 POST /v1/messages；严格 schema 用 output_config，工具探测不强制工具调用', async () => {
    const json = fixture(P, 'messages-json');
    server.enqueue(json, json, json, json);
    const [rt] = runtimes(route());
    const r = rt as NonNullable<typeof rt>;
    const report = await probeRoute(r.route, profile, r.client, 30_000, AbortSignal.timeout(60_000), null);
    const sent = server.received.filter((x) => x.path === '/v1/messages').map((x) => JSON.parse(x.body));
    expect(sent).toHaveLength(4);
    expect(sent.every((b: Record<string, unknown>) => b.stream === false && !('temperature' in b))).toBe(true);
    expect(sent[0]).toMatchObject({ output_config: { format: { type: 'json_schema' } } });
    expect(sent[1]).toMatchObject({ tool_choice: { type: 'auto' }, tools: [{ name: 'lookup_order' }] });
    // 回放的四个响应都是同一份录制：有 thinking 块，所以推理通道测得 separate_field
    expect(report.reasoningChannel).toMatchObject({ value: 'separate_field', source: 'measured' });
    expect(report.nativeTools).toMatchObject({ value: false, detail: '没有返回工具调用' });
    expect(report.contextTokens).toMatchObject({ value: 200_000, source: 'declared' });
  });
});

describe('配置', () => {
  const worker = (over: Record<string, unknown>) => ({
    cluster_id: 'c',
    code_sha: 'a'.repeat(40),
    hub: { url: 'http://hub:8080', token_file: '/t' },
    inbound: { token_sha256_file: '/s' },
    llm: {
      routes: [
        {
          id: 'primary',
          base_url: 'http://m/v1',
          api: 'messages',
          model: 'claude-fable-5-2',
          dialect_profile: 'anthropic-messages',
          price: { currency: 'USD', input_per_mtok: 10, output_per_mtok: 50, cached_input_per_mtok: 1 },
          in_domain: true,
          tier: 'large',
          retention_terms: 'x',
          api_key_file: '/k',
          ...over,
        },
      ],
    },
    budget: { daily_tokens: 100000 },
  });

  it('worker 配置接受 api: messages；其他取值被拒绝', () => {
    expect(workerConfigSchema.parse(worker({})).llm.routes[0]?.api).toBe('messages');
    expect(() => workerConfigSchema.parse(worker({ api: 'completions' }))).toThrow();
  });

  it('api: messages 的路由配置 thinking 时拒绝构造', () => {
    const egress = new Egress({ allowCrossBorder: false, honeytokens: [] }, () => undefined);
    expect(() =>
      buildRuntimes(
        [
          {
            route: {
              id: 'primary',
              base_url: 'http://m/v1',
              api: 'messages',
              model: 'm',
              dialect_profile: 'anthropic-messages',
              price: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null },
              failure_domain: [],
              in_domain: true,
              tier: 'large',
              retention_terms: 'x',
            },
            apiKey: 'k',
            state: { profile: null, calibration: null, fingerprint: null },
            thinking: 'disabled',
          },
        ],
        egress,
      ),
    ).toThrow(/路由 primary 的 thinking 只用于 api: chat_completions，当前是 messages/);
  });
});
