import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ModelRoute } from '@srenautix/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { loadEvalConfig } from '../../src/eval/config.js';
import { DEFAULT_BUDGET, ResearchLedger } from '../../src/llm/budget.js';
import { declaredProfile } from '../../src/llm/dialect.js';
import { Egress } from '../../src/llm/egress.js';
import { probeRoute } from '../../src/llm/probe.js';
import { buildRuntimes } from '../../src/llm/routes.js';
import { ModelLayer } from '../../src/llm/session.js';
import { resolveTimeouts } from '../../src/llm/timeouts.js';
import type { LlmRequest } from '../../src/llm/types.js';
import { toChatParams, type ChatThinking } from '../../src/llm/wire.js';
import { workerConfigSchema } from '../../src/research/config.js';
import { WorkerMetrics } from '../../src/research/metrics.js';
import { fixture, ReplayServer } from '../support/llm-fixtures.js';

// 路由的 thinking 设置（ADR 0158）：thinking: disabled 时每个 Chat 请求体都带 thinking: {type: "disabled"}，
// 包括研判调用与能力探测；不设置时请求体与之前逐字段相同

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

function route(id: string, baseUrl: string, over: Partial<ModelRoute> = {}): ModelRoute {
  return {
    id,
    base_url: baseUrl,
    api: 'chat_completions',
    model: 'qwen3-1.7b',
    dialect_profile: 'openai-compatible',
    price: { currency: 'CNY', input_per_mtok: 1, output_per_mtok: 2, cached_input_per_mtok: 0.1 },
    failure_domain: [],
    in_domain: true,
    tier: 'large',
    retention_terms: 'local',
    ...over,
  };
}

const request: Omit<LlmRequest, 'output'> = {
  items: [
    { type: 'system', segments: [{ text: 'You are an SRE assistant.', categories: [], egress: 'allow' }] },
    { type: 'user', segments: [{ text: 'api 的错误率升高', categories: ['metrics'], egress: 'redact' }] },
  ],
  maxOutputTokens: 4096,
};

const egress = () => new Egress({ allowCrossBorder: false, honeytokens: [] }, () => undefined);

function runtimes(routes: Array<{ route: ModelRoute; thinking?: ChatThinking }>) {
  return buildRuntimes(
    routes.map((r) => ({
      route: r.route,
      apiKey: 'local',
      state: { profile: null, calibration: null, fingerprint: null },
      timeouts: resolveTimeouts(r.route, {}),
      thinking: r.thinking ?? null,
    })),
    egress(),
  );
}

const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `route-thinking-${process.pid}`);

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let server: ReplayServer;

beforeEach(async () => {
  server = new ReplayServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

const bodies = () => server.received.filter((r) => r.body).map((r) => JSON.parse(r.body) as Record<string, unknown>);

describe('Chat 请求体', () => {
  it('thinking: disabled 时带 thinking 字段，不设置时不带', () => {
    const profile = declaredProfile('openai-compatible');
    const off = toChatParams(request, { model: 'm', profile, language: 'zh', thinking: 'disabled' });
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.max_tokens).toBe(4096);
    const plain = toChatParams(request, { model: 'm', profile, language: 'zh' });
    expect(plain).not.toHaveProperty('thinking');
    expect(off).toEqual({ ...plain, thinking: { type: 'disabled' } });
  });

  it('研判调用：thinking: disabled 的路由每次流式请求都带 thinking 字段', async () => {
    server.enqueue(fixture(P, 'chat-json-schema'));
    const [rt] = runtimes([{ route: route('direct', server.baseUrl), thinking: 'disabled' }]);
    const layer = new ModelLayer({
      routes: [rt as NonNullable<typeof rt>],
      egress: egress(),
      budget: DEFAULT_BUDGET,
      metrics: new WorkerMetrics('worker', false),
      language: 'en',
      onCalibration: async () => undefined,
      onDrift: async () => undefined,
    });
    const s = layer.session({
      runId: null,
      incidentComponents: [],
      deadline: Date.now() + 480_000,
      signal: new AbortController().signal,
      ledger: new ResearchLedger(DEFAULT_BUDGET),
      record: async () => undefined,
    });
    const r = await s.structured('conclude', request, OUTPUT);
    expect(r).toMatchObject({ ok: true, routeId: 'direct' });
    const [body] = bodies();
    expect(body).toMatchObject({ stream: true, max_tokens: 4096, thinking: { type: 'disabled' } });
  });

  it('能力探测的每个 Chat 请求都带同样的 thinking 设置', async () => {
    server.enqueue(
      fixture(P, 'chat-json-schema'),
      fixture(P, 'chat-tool-call'),
      fixture(P, 'chat-json-object'),
      fixture(P, 'chat-chinese'),
    );
    const [rt] = runtimes([{ route: route('direct', server.baseUrl), thinking: 'disabled' }]);
    const r = rt as NonNullable<typeof rt>;
    await probeRoute(
      r.route,
      declaredProfile('openai-compatible'),
      r.client,
      30_000,
      AbortSignal.timeout(60_000),
      'disabled',
    );
    const chat = server.received.filter((x) => x.path === '/v1/chat/completions');
    expect(chat).toHaveLength(4);
    for (const x of chat) {
      expect(JSON.parse(x.body)).toMatchObject({ thinking: { type: 'disabled' } });
    }
  });
});

describe('配置', () => {
  const worker = (over: Record<string, unknown>) => ({
    cluster_id: 'c',
    code_sha: 'a'.repeat(40),
    hub: { url: 'http://hub:8080', token_file: '/t' },
    inbound: { token_sha256_file: '/s' },
    llm: { routes: [{ ...route('direct', 'http://m/v1'), api_key_file: '/k', ...over }] },
    budget: { daily_tokens: 100000 },
  });

  it('worker 配置的 thinking 只接受 disabled', () => {
    expect(workerConfigSchema.parse(worker({ thinking: 'disabled' })).llm.routes[0]?.thinking).toBe('disabled');
    expect(workerConfigSchema.parse(worker({})).llm.routes[0]).not.toHaveProperty('thinking');
    expect(() => workerConfigSchema.parse(worker({ thinking: 'enabled' }))).toThrow();
  });

  it('评测配置：thinking 单独给出，不进入契约的路由对象', () => {
    const file = join(ROOT, 'eval.yaml');
    writeFileSync(
      file,
      stringify({
        routes: [
          { ...route('direct', 'http://m/v1'), api_key_env: 'THINKING_TEST_KEY', thinking: 'disabled' },
          { ...route('plain', 'http://m/v1'), api_key_env: 'THINKING_TEST_KEY' },
        ],
      }),
    );
    const cfg = loadEvalConfig(file, { THINKING_TEST_KEY: 'k' });
    expect(cfg.routes.map((r) => [r.route.id, r.thinking])).toEqual([
      ['direct', 'disabled'],
      ['plain', null],
    ]);
    expect(cfg.routes[0]?.route).not.toHaveProperty('thinking');
  });

  it('Responses 接口的路由配置 thinking 时拒绝构造', () => {
    expect(() =>
      runtimes([{ route: route('direct', 'http://m/v1', { api: 'responses' }), thinking: 'disabled' }]),
    ).toThrow(/路由 direct 的 thinking 只用于 api: chat_completions，当前是 responses/);
  });
});
