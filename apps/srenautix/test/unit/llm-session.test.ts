import type { ModelRoute } from '@srenautix/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, ResearchLedger, type BudgetConfig } from '../../src/llm/budget.js';
import { declaredProfile } from '../../src/llm/dialect.js';
import { Egress, EgressBlocked } from '../../src/llm/egress.js';
import { buildRuntimes, partitionRoutes } from '../../src/llm/routes.js';
import { ModelLayer, type LlmCallRecord } from '../../src/llm/session.js';
import { resolveTimeouts, type RouteTimeouts } from '../../src/llm/timeouts.js';
import type { LlmRequest, Segment } from '../../src/llm/types.js';
import { WorkerMetrics } from '../../src/research/metrics.js';
import { fixture, ReplayServer } from '../support/llm-fixtures.js';

const P = 'llamacpp-qwen3-1.7b';
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['component', 'verdict', 'refs'],
  properties: {
    component: { type: 'string', enum: ['Deployment:shop/api', 'StatefulSet:shop/postgres'] },
    verdict: { type: 'string', enum: ['abnormal', 'normal'] },
    refs: { type: 'array', items: { type: 'string', enum: ['card:1', 'card:2'] } },
  },
};
const OUTPUT = { name: 'verdict', schema: SCHEMA, full: SCHEMA };
const HONEYTOKEN = 'srx-honey-7f3a9c1e5b2d4f60';

function route(id: string, baseUrl: string, over: Partial<ModelRoute> = {}): ModelRoute {
  return {
    id,
    base_url: baseUrl,
    api: 'chat_completions',
    model: 'qwen3-1.7b',
    dialect_profile: 'llamacpp',
    price: { currency: 'CNY', input_per_mtok: 1, output_per_mtok: 2, cached_input_per_mtok: 0.1 },
    failure_domain: [],
    in_domain: true,
    tier: 'large',
    retention_terms: 'local',
    ...over,
  };
}

const base = (text: string, egress: 'allow' | 'redact' = 'redact'): Omit<LlmRequest, 'output'> => ({
  items: [
    { type: 'system', segments: [{ text: 'You are an SRE assistant.', categories: [], egress: 'allow' }] },
    { type: 'user', segments: [{ text, categories: ['metrics'], egress }] },
  ],
  maxOutputTokens: 4096,
});

let a: ReplayServer;
let b: ReplayServer;
let halted: string[];
let records: LlmCallRecord[];

beforeEach(async () => {
  a = new ReplayServer();
  b = new ReplayServer();
  await a.start();
  await b.start();
  halted = [];
  records = [];
});

afterEach(async () => {
  await a.stop();
  await b.stop();
});

function layer(
  routes: ModelRoute[],
  opts: { budget?: BudgetConfig; timeouts?: Partial<RouteTimeouts>; allowCrossBorder?: boolean } = {},
) {
  const egress = new Egress({ allowCrossBorder: opts.allowCrossBorder ?? false, honeytokens: [HONEYTOKEN] }, (r) =>
    halted.push(r),
  );
  const runtimes = buildRuntimes(
    routes.map((r) => {
      const t = resolveTimeouts(r, {});
      return {
        route: r,
        apiKey: 'local',
        state: { profile: null, calibration: null, fingerprint: null },
        timeouts: { ...t, timeouts: { ...t.timeouts, ...opts.timeouts } },
      };
    }),
    egress,
  );
  return new ModelLayer({
    routes: runtimes,
    egress,
    budget: opts.budget ?? DEFAULT_BUDGET,
    metrics: new WorkerMetrics('worker', false),
    language: 'en',
    onCalibration: async () => undefined,
    onDrift: async () => undefined,
  });
}

function session(l: ModelLayer, components: string[] = [], deadlineMs = 480_000) {
  return l.session({
    runId: null,
    incidentComponents: components,
    deadline: Date.now() + deadlineMs,
    signal: new AbortController().signal,
    ledger: new ResearchLedger(l.opts.budget),
    record: async (r) => {
      records.push(r);
    },
  });
}

describe('结构化调用', () => {
  it('录制的合格输出：一次成功，按 usage 记账，写出路由使用与出境清单', async () => {
    a.enqueue(fixture(P, 'chat-json-schema'));
    const s = session(layer([route('a', a.baseUrl)]));
    const r = await s.structured('conclude', base('card:1 says api errors'), OUTPUT);
    expect(r).toMatchObject({ ok: true, routeId: 'a', step: 'validate', value: { component: 'Deployment:shop/api' } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: 'succeeded',
      repairStep: 'validate',
      usage: { input_tokens: 62, output_tokens: 1249 },
    });
    expect(records[0]?.fingerprint).toMatch(/^fp:/);
    expect(s.routeUses[0]).toMatchObject({ phase: 'conclude', route_id: 'a', dialect_profile: 'llamacpp' });
    expect(s.egress[0]).toMatchObject({ route_id: 'a', in_domain: true, categories: ['metrics'] });
    expect(s.egress[0]?.bytes).toBeGreaterThan(0);
    const sent = JSON.parse(a.received[0]?.body as string) as Record<string, unknown>;
    expect(sent.response_format).toMatchObject({ type: 'json_schema' });
  });

  it('输出不完整时带上错误重新请求一次', async () => {
    a.enqueue(fixture(P, 'chat-length'), fixture(P, 'chat-json-schema'));
    const r = await session(layer([route('a', a.baseUrl)])).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: true, step: 'reask' });
    expect(records.map((x) => x.outcome)).toEqual(['retried', 'succeeded']);
    const second = JSON.parse(a.received[1]?.body as string) as { messages: Array<{ role: string; content: string }> };
    expect(second.messages.at(-1)?.content).toMatch(/could not be used/);
  });

  it('请求被服务方拒绝（录制的 400）时换下一条路由', async () => {
    a.enqueue(fixture(P, 'chat-bad-request'));
    b.enqueue(fixture(P, 'chat-json-object'));
    const r = await session(layer([route('a', a.baseUrl), route('b', b.baseUrl)])).structured(
      'conclude',
      base('x'),
      OUTPUT,
    );
    expect(r).toMatchObject({ ok: true, routeId: 'b' });
    expect(records.map((x) => [x.routeId, x.outcome, x.httpStatus])).toEqual([
      ['a', 'switched', 400],
      ['b', 'succeeded', null],
    ]);
  });

  it('两次输出都无效、没有其他路由：模型输出无效，只出确定性报告', async () => {
    a.enqueue(fixture(P, 'chat-length'), fixture(P, 'chat-length'));
    const r = await session(layer([route('a', a.baseUrl)])).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'model_output_invalid' });
    expect(records.map((x) => x.outcome)).toEqual(['retried', 'failed']);
  });

  it('首 token 超时计入失败型熔断', async () => {
    a.enqueue('hang');
    const l = layer([route('a', a.baseUrl)], { timeouts: { firstTokenMs: 300 } });
    const r = await session(l).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'model_unavailable' });
    expect(records[0]).toMatchObject({ errorKind: 'llm_timeout', outcome: 'failed' });
    expect(records[0]?.note).toMatch(/首 token超过/);
  });

  it('流开始后停住：空闲超时，记为超时失败', async () => {
    a.enqueue({ fixture: fixture(P, 'chat-json-schema'), stallAfter: 3 });
    const l = layer([route('a', a.baseUrl)], { timeouts: { firstTokenMs: 5_000, idleMs: 300 } });
    const r = await session(l).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'model_unavailable' });
    expect(records[0]).toMatchObject({ errorKind: 'llm_timeout', outcome: 'failed' });
    expect(records[0]?.note).toMatch(/流空闲超过/);
  });

  it('慢但一直在输出的调用不受总时长限制：总耗时超过首 token 与空闲超时之和照样成功，也不打开延迟型熔断', async () => {
    // 每个流事件间隔 20 毫秒，事件数上百，总耗时远超 300 + 200 毫秒
    a.enqueue({ fixture: fixture(P, 'chat-json-schema'), paceMs: 20 });
    const l = layer([route('a', a.baseUrl)], { timeouts: { firstTokenMs: 300, idleMs: 200 } });
    const started = Date.now();
    const r = await session(l).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: true, step: 'validate' });
    expect(Date.now() - started).toBeGreaterThan(500);
    expect(records[0]).toMatchObject({ outcome: 'succeeded', usage: { input_tokens: 62, output_tokens: 1249 } });
    const rt = l.route('a');
    expect(rt.breaker.openReason).toBeNull();
    expect(rt.breaker.p50(Date.now())).toBeNull();
  });

  it('路由声明的总时长仍然生效', async () => {
    a.enqueue({ fixture: fixture(P, 'chat-json-schema'), paceMs: 20 });
    const l = layer([route('a', a.baseUrl)], { timeouts: { firstTokenMs: 300, idleMs: 200, totalMs: 400 } });
    const r = await session(l).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'model_unavailable' });
    expect(records[0]?.note).toMatch(/总时长超过/);
  });

  it('请求以流式发出：Responses 与 Chat 都带 stream，Chat 要求 usage', async () => {
    a.enqueue(fixture(P, 'chat-json-schema'));
    await session(layer([route('a', a.baseUrl)])).structured('conclude', base('x'), OUTPUT);
    expect(JSON.parse(a.received[0]?.body as string)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    b.enqueue(fixture(P, 'responses-json-schema'));
    await session(layer([route('b', b.baseUrl, { api: 'responses' })])).structured('conclude', base('x'), OUTPUT);
    const sent = JSON.parse(b.received[0]?.body as string) as Record<string, unknown>;
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toBeUndefined();
    // 录制的 llama.cpp 输出本身不符合 schema（rootCause）：流被完整拼回，进入修复阶梯而不是超时或网络错误
    expect(records[1]).toMatchObject({ outcome: 'retried', errorKind: 'llm_output_invalid' });
    expect(records[1]?.response).toContain('rootCause');
    expect(records[1]?.usage.output_tokens).toBeGreaterThan(0);
  });

  it('连接被拒绝 5 次后熔断，之后的调用不再发出', async () => {
    await a.stop();
    const l = layer([route('a', a.baseUrl)]);
    for (let i = 0; i < 5; i++) {
      await session(l).structured('conclude', base('x'), OUTPUT);
    }
    expect(records.every((x) => x.errorKind === 'llm_network')).toBe(true);
    await session(l).structured('conclude', base('x'), OUTPUT);
    expect(records.at(-1)?.errorKind).toBe('llm_breaker_open');
    await a.start();
  });

  it('事件涉及路由的故障域时提前熔断这条路由', async () => {
    b.enqueue(fixture(P, 'chat-json-schema'));
    const l = layer([route('a', a.baseUrl, { failure_domain: ['Namespace:llm-gateway'] }), route('b', b.baseUrl)]);
    const s = session(l, ['Deployment:llm-gateway/gateway']);
    expect(s.preOpened()).toEqual([{ routeId: 'a', component: 'Deployment:llm-gateway/gateway' }]);
    const r = await s.structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: true, routeId: 'b' });
    expect(a.received).toHaveLength(0);
  });

  it('所有路由都落在故障域内：跳过阶段 B', async () => {
    const l = layer([route('a', a.baseUrl, { failure_domain: ['Deployment:llm-gateway/gateway'] })]);
    const r = await session(l, ['Deployment:llm-gateway/gateway']).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'failure_domain' });
  });

  it('小模型阶段优先使用小模型路由', async () => {
    b.enqueue(fixture(P, 'chat-json-schema'));
    const l = layer([route('large', a.baseUrl), route('small', b.baseUrl, { tier: 'small' })]);
    const r = await session(l).structured('still_consistent', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: true, routeId: 'small' });
  });
});

describe('出站控制', () => {
  it('redact 片段在出站前脱敏', async () => {
    a.enqueue(fixture(P, 'chat-json-schema'));
    await session(layer([route('a', a.baseUrl)])).structured(
      'conclude',
      base('owner phone 13812345678, db postgres://u:pw123456@db:5432/x'),
      OUTPUT,
    );
    const body = a.received[0]?.body as string;
    expect(body).not.toContain('13812345678');
    expect(body).not.toContain('pw123456');
    expect(records[0]?.redactionHits).toMatchObject({ phone: 1, dsn: 1 });
  });

  it('请求体命中蜜标：不发出，停止全部出站', async () => {
    const l = layer([route('a', a.baseUrl)]);
    const r = await session(l).structured('conclude', base(`log line ${HONEYTOKEN}`), OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'egress_blocked' });
    expect(a.received).toHaveLength(0);
    expect(halted).toHaveLength(1);
    expect(l.opts.egress.halted).toMatch(/蜜标/);
    const again = await session(l).structured('conclude', base('clean'), OUTPUT);
    expect(again).toMatchObject({ ok: false, reason: 'egress_blocked' });
    expect(a.received).toHaveLength(0);
  });

  it('allow 片段中漏过的 JWT 也会被出站检查拦下', async () => {
    // 测试时拼接，避免仓库扫描把夹具当成泄露的凭证
    const jwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ].join('.');
    const r = await session(layer([route('a', a.baseUrl)])).structured('conclude', base(jwt, 'allow'), OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'egress_blocked' });
    expect(a.received).toHaveLength(0);
  });

  it('国内配置禁止境外路由', () => {
    expect(() => layer([route('a', a.baseUrl, { in_domain: false })])).toThrow(EgressBlocked);
    expect(() => layer([route('a', a.baseUrl, { in_domain: false })], { allowCrossBorder: true })).not.toThrow();
  });

  const strict = () => new Egress({ allowCrossBorder: false, honeytokens: [HONEYTOKEN] }, (r) => halted.push(r));
  const inputs = (routes: ModelRoute[]) =>
    routes.map((r) => ({ route: r, apiKey: 'local', state: { profile: null, calibration: null, fingerprint: null } }));
  const partitioned = (routes: ModelRoute[]) => {
    const egress = strict();
    const { runtimes, disabled } = partitionRoutes(inputs(routes), egress);
    const l = new ModelLayer({
      routes: runtimes,
      disabled,
      egress,
      budget: DEFAULT_BUDGET,
      metrics: new WorkerMetrics('worker', false),
      language: 'en',
      onCalibration: async () => undefined,
      onDrift: async () => undefined,
    });
    return { l, disabled };
  };

  it('启动时禁用境外路由：不进入模型层，研判只走可用路由，境外路由收不到任何请求', async () => {
    const { l, disabled } = partitioned([route('a', a.baseUrl, { in_domain: false }), route('b', b.baseUrl)]);
    expect(disabled).toEqual([{ id: 'a', reason: 'cross_border', message: expect.stringMatching(/路由 a 在境外/) }]);
    expect(l.routes.map((r) => r.route.id)).toEqual(['b']);
    expect(l.ordered('conclude').map((r) => r.route.id)).toEqual(['b']);
    expect(() => l.route('a')).toThrow(/没有路由 a/);
    expect(l.unavailableReason()).toBeNull();
    // a 在配置中排在前面，并且也备好了录制的响应：如果 a 被尝试，它会先收到请求
    a.enqueue(fixture(P, 'chat-json-schema'));
    b.enqueue(fixture(P, 'chat-json-schema'));
    const r = await session(l).structured('conclude', base('card:1 says api errors'), OUTPUT);
    expect(r).toMatchObject({ ok: true, routeId: 'b' });
    expect(a.received).toHaveLength(0);
    expect(records.map((x) => x.routeId)).toEqual(['b']);
  });

  it('全部路由被禁用：模型层照常构造并给出降级原因，调用不发出任何请求', async () => {
    const { l } = partitioned([route('a', a.baseUrl, { in_domain: false })]);
    expect(l.routes).toHaveLength(0);
    expect(l.allRoutesInTopology()).toBe(false);
    expect(l.unavailableReason()).toMatch(/没有可用的模型路由：路由 a 在境外.*阶段 B 不运行，只出阶段 A/);
    a.enqueue(fixture(P, 'chat-json-schema'));
    const r = await session(l).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({
      ok: false,
      reason: 'egress_blocked',
      detail: expect.stringMatching(/没有可用的模型路由/),
    });
    expect(a.received).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it('出站检查本身不放宽：被禁用的路由构造不出客户端，严格构造仍然拒绝，每次请求都重新检查', async () => {
    const egress = strict();
    const overseas = route('a', a.baseUrl, { in_domain: false });
    expect(() => egress.client(overseas, 'local', 90_000)).toThrow(EgressBlocked);
    expect(() => buildRuntimes(inputs([overseas, route('b', b.baseUrl)]), egress)).toThrow(EgressBlocked);
    // 构造后路由变为境外（例如配置对象被改动）：请求在出站模块里被拦下，不到达服务端
    const changed = route('c', a.baseUrl);
    const client = egress.client(changed, 'local', 90_000);
    changed.in_domain = false;
    a.enqueue(fixture(P, 'chat-json-schema'));
    const err = await client.chat.completions
      .create({ model: 'qwen3-1.7b', messages: [{ role: 'user', content: 'x' }] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    const blocked = err instanceof EgressBlocked ? err : (err as { cause?: unknown } | null)?.cause;
    expect(blocked).toBeInstanceOf(EgressBlocked);
    expect((blocked as EgressBlocked).reason).toBe('cross_border');
    expect(a.received).toHaveLength(0);
  });
});

describe('预算与期限', () => {
  it('研判合计上限截停，不发出请求', async () => {
    const tiny: BudgetConfig = { ...DEFAULT_BUDGET, perResearchInputTokens: 10 };
    const r = await session(layer([route('a', a.baseUrl)], { budget: tiny })).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'budget' });
    expect(a.received).toHaveLength(0);
  });

  it('阶段单次上限是裁剪目标：没有可裁剪的内容时按研判剩余预算照常发送', async () => {
    a.enqueue(fixture(P, 'chat-json-schema'));
    const tiny: BudgetConfig = {
      ...DEFAULT_BUDGET,
      stages: { ...DEFAULT_BUDGET.stages, conclude: { inputTokens: 10, outputTokens: 4096 } },
    };
    const r = await session(layer([route('a', a.baseUrl)], { budget: tiny })).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: true });
    expect(a.received).toHaveLength(1);
  });

  it('超出窗口与预算时按裁剪顺序裁掉低优先级片段，写进调用记录与说明', async () => {
    a.enqueue(fixture(P, 'chat-json-schema'));
    const big = 'x'.repeat(40_000);
    const seg = (text: string, rank: number, label: string): Segment => ({
      text,
      categories: ['knowledge'],
      egress: 'allow',
      trim: { rank, label, next: () => null },
    });
    // 参考案例先裁，其次知识；证据卡保留
    const req: Omit<LlmRequest, 'output'> = {
      items: [
        { type: 'system', segments: [{ text: 'You are an SRE assistant.', categories: [], egress: 'allow' }] },
        {
          type: 'user',
          segments: [
            { text: 'CARDS card:1 api errors', categories: ['metrics'], egress: 'allow' },
            seg(`KNOWLEDGE ${big}`, 2, '知识条目 1 条'),
            seg(`CASES ${big}`, 1, '参考案例 1 条'),
          ],
        },
      ],
      maxOutputTokens: 4096,
    };
    const budget: BudgetConfig = {
      ...DEFAULT_BUDGET,
      stages: { ...DEFAULT_BUDGET.stages, conclude: { inputTokens: 25_000, outputTokens: 4096 } },
    };
    const r = await session(layer([route('a', a.baseUrl, { dialect_profile: 'deepseek' })], { budget })).structured(
      'conclude',
      req,
      OUTPUT,
    );
    expect(r).toMatchObject({ ok: true });
    const sent = a.received[0]?.body as string;
    expect(sent).toContain('CARDS card:1');
    expect(sent).toContain('KNOWLEDGE');
    expect(sent).not.toContain('CASES');
    expect(records[0]?.note).toMatch(/裁掉了：参考案例 1 条/);
    expect(r.ok && r.notes[0]).toMatch(/参考案例 1 条/);
  });

  it('剩余时间不足时不再调用', async () => {
    const r = await session(layer([route('a', a.baseUrl)]), [], 1000).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: false, reason: 'deadline' });
  });

  it('上下文不足时跳过该路由', async () => {
    b.enqueue(fixture(P, 'chat-json-schema'));
    const l = layer([route('a', a.baseUrl), route('b', b.baseUrl)]);
    const rt = l.route('a');
    rt.profile = { ...declaredProfile('llamacpp'), context_tokens: 1024 };
    const r = await session(l).structured('conclude', base('x'), OUTPUT);
    expect(r).toMatchObject({ ok: true, routeId: 'b' });
    expect(records[0]).toMatchObject({ routeId: 'a', errorKind: 'context' });
  });
});
