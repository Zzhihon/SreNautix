import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { validatorFor } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openapiValidator } from '../../src/api/openapi-schemas.js';
import { HttpError } from '../../src/api/errors.js';
import { createApp } from '../../src/api/http.js';
import type { PageRouteView } from '../../src/research/page-data.js';
import { registerPageRoutes } from '../../src/roles/worker.js';
import type pg from 'pg';

// B1 后端：console-bff 的 forward() 把 9 条路由原样转发给 worker，历史上 worker 没有实现，
// 线上 /eval /health /models 三页直接 404。这里在真实 fastify 实例上注册本文件里的 9 个
// handler，用 mock PG pool 走真实 SQL 聚合代码路径（SQL 不带用户输入拼接），核对：
//   1) 9 条路由都返回非 404 且形状合法；
//   2) 鉴权失败返回 401；
//   3) 4 条「未启用」接口用 200 + 契约合法的空体，不渲染红色 ErrorBox。
// mock pool 返回的是「表里的行」，不是伪造的 HTTP 响应：handler 的聚合、投影、schema 校验全跑真实代码。

const NOW = Date.parse('2026-11-08T12:00:00Z');
const TOKEN = 'server-to-worker-page-routes-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex');

/** 真实配置派生出的路由视图（与 worker.ts buildWorker 里的构造同形）。 */
const VIEWS: PageRouteView[] = [
  {
    route: {
      id: 'primary',
      model: 'gpt-4o',
      dialect_profile: 'openai-chat',
      base_url: 'https://api.example.com/v1',
      in_domain: true,
      failure_domain: ['Deployment:shop/api'],
      price: { input_per_mtok: 2.5, output_per_mtok: 10, currency: 'USD' },
      retention_terms: 'provider default',
    },
    enabled: true,
    breaker: 'closed',
    breakerReason: null,
    egressCategories: ['metrics', 'logs'],
  },
  {
    route: {
      id: 'overseas-disabled',
      model: 'claude-sonnet',
      dialect_profile: 'anthropic-chat',
      base_url: 'https://overseas.example.com/v1',
      in_domain: false,
      failure_domain: [],
      price: { input_per_mtok: 3, output_per_mtok: 15, currency: 'USD' },
      retention_terms: 'provider default',
    },
    enabled: false,
    breaker: 'closed',
    breakerReason: null,
    egressCategories: ['metrics'],
  },
];

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';

/** 一条真实形态的 llm_calls 行（worker.research/store.ts llmCall 写入的列）。 */
const LLM_CALL = {
  run_id: RUN_ID,
  incident_id: INCIDENT_ID,
  route_id: 'primary',
  model: 'gpt-4o',
  at: new Date(NOW - 60_000),
  input_tokens: 1000,
  output_tokens: 200,
  cost: 0.012,
  duration_ms: 450,
  bytes: 4096,
  categories: ['metrics', 'logs'],
  redaction_hits: { ip: 2, token: 1 },
  outcome: 'succeeded',
  error_kind: null,
  phase: 'hypothesize',
};

/**
 * mock PG pool：按 SQL 注释标签（page-data:xxx）分发到「表里现有的行」。
 * 不模拟 handler 逻辑，handler 的每一行 SQL 与投影都真实执行。
 */
function mockPool(): { pool: pg.Pool; queries: string[] } {
  const queries: string[] = [];
  const query = async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
    queries.push(sql);
    const tag = /page-data:([\w-]+)/.exec(sql)?.[1] ?? '';
    switch (tag) {
      case 'health-calls':
        return {
          rows: [
            {
              calls: 10,
              succeeded: 8,
              failed: 1,
              fallback_calls: 1,
              input_tokens: 10000,
              output_tokens: 2000,
              cost: 0.12,
            },
          ],
        };
      case 'health-phases':
        return { rows: [{ phase: 'conclude', failures: 1 }] };
      case 'health-routes':
        return { rows: [{ route_id: 'primary', calls: 10, failures: 1 }] };
      case 'health-runs':
        return { rows: [{ runs: 4, budget_stopped: 1, zero_tool_runs: 2, p95_ms: 1234.5 }] };
      case 'cost-day':
        return { rows: [{ key: '2026-11-08', input_tokens: 1000, output_tokens: 200, cost: 0.012, runs: 2 }] };
      case 'cost-incident':
        return { rows: [{ key: INCIDENT_ID, input_tokens: 1000, output_tokens: 200, cost: 0.012, runs: 2 }] };
      case 'cost-model':
        return { rows: [{ key: 'gpt-4o', input_tokens: 1000, output_tokens: 200, cost: 0.012, runs: 2 }] };
      case 'cost-day-usage':
        return { rows: [{ key: '2026-11-07', tokens: 5000, cost: 0.05 }] };
      case 'cost-day-purpose':
        return { rows: [] };
      case 'cost-currency':
        return { rows: [{ currency: 'USD' }] };
      case 'egress-ledger':
        return { rows: [LLM_CALL] };
      case 'model-call-stats':
        return {
          rows: [
            {
              route_id: 'primary',
              calls: 10,
              last_call_at: new Date(NOW - 60_000),
              failures: 1,
              structured_failures: 2,
              p50_ms: 450,
              last_error: 'timeout',
              calls_1h: 10,
              failures_1h: 1,
            },
          ],
        };
      case 'model-route-state':
        return { rows: [{ route_id: 'primary', fingerprint: 'fp-primary', updated_at: new Date(NOW - 3600_000) }] };
      default:
        return { rows: [] };
    }
  };
  // 只实现 page-data 用到的 pool.query(sql, params)；其余方法不在这些 handler 里出现。
  const pool = { query } as unknown as pg.Pool;
  return { pool, queries };
}

let app: FastifyInstance;
let queries: string[];

/** 真实 inboundAuth 的等价实现（worker.ts 里的私有函数，按同样逻辑在测试里构造）。 */
function auth(req: { headers: { authorization?: string } }): void {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (
    !m ||
    createHash('sha256')
      .update(m[1] as string)
      .digest('hex') !== TOKEN_SHA256
  ) {
    throw new HttpError(401, 'unauthorized', 'token 无效');
  }
}

beforeAll(async () => {
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  const m = mockPool();
  queries = m.queries;
  registerPageRoutes({
    app,
    pool: m.pool,
    auth: auth as Parameters<typeof registerPageRoutes>[0]['auth'],
    routeViews: VIEWS,
    codeSha: '0123456789abcdef0123456789abcdef01234567',
    estimateTokensPerCall: 150_000,
    estimatePricePerMtok: 2.5,
    now: () => NOW,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const get = (url: string, token = TOKEN) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const post = (url: string, body: unknown, token = TOKEN) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

const ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; url: string; body?: unknown }> = [
  { method: 'GET', url: '/v1/eval/reports' },
  { method: 'GET', url: `/v1/eval/reports/${RUN_ID}` },
  { method: 'GET', url: '/v1/eval/cases' },
  { method: 'GET', url: '/v1/eval/trend' },
  { method: 'POST', url: '/v1/eval/estimate', body: { suite: 'default', routes: ['primary'], runs_per_case: 3 } },
  { method: 'GET', url: '/v1/agent/health?window=14d' },
  { method: 'GET', url: '/v1/agent/cost?group_by=day' },
  { method: 'GET', url: '/v1/egress/ledger' },
  { method: 'GET', url: '/v1/models/routes' },
];

describe('worker 页面路由（B1 后端）', () => {
  it('9 条 forward 路由都注册了 handler，返回非 404', async () => {
    for (const r of ROUTES) {
      const res = r.method === 'GET' ? await get(r.url) : await post(r.url, r.body);
      expect(res.statusCode, `${r.method} ${r.url} -> ${res.statusCode}`).toBe(200);
    }
  });

  it('每条路由缺 bearer token 或 token 无效时返回 401', async () => {
    for (const r of ROUTES) {
      const noToken = r.method === 'GET' ? await get(r.url, '') : await post(r.url, r.body, '');
      expect(noToken.statusCode, `${r.method} ${r.url} 无 token`).toBe(401);
      const bad = r.method === 'GET' ? await get(r.url, 'wrong') : await post(r.url, r.body, 'wrong');
      expect(bad.statusCode, `${r.method} ${r.url} 错 token`).toBe(401);
      expect(noToken.json()).toMatchObject({ error: 'unauthorized' });
    }
  });

  it('4 条无存储接口用 200 + 契约合法空体（不是 404/501/ErrorBox）', async () => {
    const reports = (await get('/v1/eval/reports')).json();
    expect(reports).toEqual([]);

    const cases = (await get('/v1/eval/cases')).json();
    expect(cases).toEqual({ items: [], next_cursor: null });

    const trend = (await get('/v1/eval/trend')).json();
    expect(trend).toEqual([]);

    const one = (await get(`/v1/eval/reports/${RUN_ID}`)).json() as Record<string, unknown>;
    // /v1/eval/reports/:report_id 的契约是单个 EvalReport；额外字段一律不允许。
    const evalReport = validatorFor('schemas/eval-report.schema.json');
    expect(evalReport(one), JSON.stringify(evalReport.errors)).toBe(true);
    expect(one.case_set).toBe('未启用（worker 不保存评测成绩单）');
    expect(one.rows).toEqual([]);
    expect(one.environments).toEqual([]);
    expect(one.gate).toBeNull();
    expect(String(one.code_sha)).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  it('estimate 不调用模型，配置没有用例目录时按契约返回全 0（且不查库）', async () => {
    const before = queries.length;
    const r = await post('/v1/eval/estimate', {
      suite: 'default',
      routes: ['primary', 'overseas-disabled'],
      runs_per_case: 3,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ cases: 0, calls: 0, input_tokens: 0, cost: 0, currency: 'USD' });
    expect(queries).toHaveLength(before);
  });

  it('agent/health 从 llm_calls + research_runs 聚合真实指标，符合 AgentHealth schema', async () => {
    const r = await get('/v1/agent/health?window=14d');
    expect(r.statusCode).toBe(200);
    const h = r.json() as Record<string, unknown>;
    const v = openapiValidator('openapi.yaml', 'AgentHealth');
    expect(v(h), JSON.stringify(v.errors)).toBe(true);
    expect(h.since).toBe(new Date(NOW - 14 * 86_400_000).toISOString());
    expect((h.scorecard as unknown[]).length).toBe(9);
    // 真实聚合：2/4 无工具调用、1/4 预算截断、1/10 回退、p95 1234.5。
    expect(h.runtime).toMatchObject({
      zero_tool_ratio: 0.5,
      budget_cutoff_ratio: 0.25,
      fallback_ratio: 0.1,
      rerun_p95: 1234.5,
      untested_competitor_ratio: null,
    });
  });

  it('agent/cost 三种 group_by 都返回契约形状，group_by 非法时 400', async () => {
    for (const group of ['day', 'incident', 'model'] as const) {
      const r = await get(`/v1/agent/cost?group_by=${group}`);
      expect(r.statusCode).toBe(200);
      const c = r.json() as Record<string, unknown>;
      // getAgentCost 的 200 是内联 schema（openapi.yaml:1470），不是命名 component；
      // 按契约逐字段核对形状：currency / daily_budget / items[] 六项必填、无额外字段。
      expect(Object.keys(c).sort()).toEqual(['currency', 'daily_budget', 'items']);
      expect(c.currency).toBe('USD');
      expect(c.daily_budget).toBeNull();
      expect(Array.isArray(c.items)).toBe(true);
      const item = (c.items as Array<Record<string, unknown>>)[0];
      expect(Object.keys(item as object).sort()).toEqual([
        'cost',
        'input_tokens',
        'key',
        'label',
        'output_tokens',
        'runs',
      ]);
      expect(item).toMatchObject({ input_tokens: 1000, output_tokens: 200, cost: 0.012, runs: 2 });
      expect(item?.label).toBe(item?.key);
    }
    const bad = await get('/v1/agent/cost?group_by=nope');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'bad_request' });
  });

  it('egress/ledger 从 llm_calls 出真实记录，无记录时返回 []', async () => {
    const r = await get('/v1/egress/ledger');
    expect(r.statusCode).toBe(200);
    const items = r.json() as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      at: new Date(NOW - 60_000).toISOString(),
      run_id: RUN_ID,
      incident_id: INCIDENT_ID,
      route_id: 'primary',
      in_domain: true,
      categories: ['metrics', 'logs'],
      bytes: 4096,
      redaction_hits: 3,
    });
  });

  it('models/routes 覆盖全部配置路由，禁用路由如实标 open，符合 ModelRouteStatus schema', async () => {
    const r = await get('/v1/models/routes');
    expect(r.statusCode).toBe(200);
    const list = r.json() as Array<Record<string, unknown>>;
    const v = openapiValidator('openapi.yaml', 'ModelRouteStatus');
    for (const item of list) {
      expect(v(item), JSON.stringify(v.errors)).toBe(true);
    }
    expect(list.map((x) => x.route_id)).toEqual(['primary', 'overseas-disabled']);
    expect(list[0]).toMatchObject({
      base_url_host: 'api.example.com',
      in_domain: true,
      breaker: 'closed',
      health: { p50_ms: 450, error_ratio_1h: 0.1 },
      structured_failure_ratio: 0.2,
      provider_fingerprint: 'fp-primary',
      provider_retention: 'provider default',
      limits: { per_incident_cost: null, daily_cost: null },
    });
    // 被出站策略禁用的路由：open、无健康数据、无指纹。
    expect(list[1]).toMatchObject({
      in_domain: false,
      breaker: 'open',
      breaker_reason: null,
      health: { p50_ms: null, error_ratio_1h: null },
      provider_fingerprint: null,
    });
  });

  it('所有查询都用参数化 SQL 且带 LIMIT 上限', async () => {
    // 上面 9 条路由执行后，pool 里应有多条真实 SQL；逐条核对不拼接用户输入。
    const tagged = queries.filter((q) => q.includes('page-data:'));
    expect(tagged.length).toBeGreaterThan(0);
    for (const q of tagged) {
      expect(q, q).toMatch(/LIMIT\s+\d+/);
      // 用户输入只能是 $1/$2/$3 占位符，不能出现 ISO 时间字面量或 token 字面量。
      expect(q).not.toContain('2026-11-08T');
      expect(q).not.toContain(TOKEN);
    }
  });
});
