import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validatorFor } from '@srenautix/contract';
import { NO_LINKS } from '../../src/notify/links.js';
import { PgMessageSource, ReportSource } from '../../src/notify/source.js';
import type { FeedbackService } from '../../src/proposals/feedback.js';
import type { ProposalService } from '../../src/proposals/service.js';
import type { ServerHandle } from '../../src/roles/server.js';
import { buildWorker, type WorkerHandle } from '../../src/roles/worker.js';
import { DEFAULT_DB_ROLES } from '../../src/store/bootstrap.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { ReplayServer, type LlmFixture } from '../support/llm-fixtures.js';
import { freePort, until } from '../support/monitoring.js';
import { fileWriter, seedShopTopology, startHubForWorker, workerConfigFor } from '../support/worker-hub.js';

/**
 * 兜底路由端到端（ADR 0152）：真实 PostgreSQL、真实 HTTP，三个 OpenAI 兼容的模型服务（本地回放服务）。
 * 两条常规路由都经过模型网关，网关的组件就是事件所在的 shop 命名空间（故障域 Namespace:shop）；兜底路由直连另一个服务方，
 * 走 OpenAI 兼容的 /v1/chat/completions。网关事件进入后：两条常规路由都因故障域提前熔断、收不到任何请求，
 * 兜底路由被选中并完成研判；研判输出标明兜底路由，用量单独记账，通知消息标注“由兜底线路研判”。
 */
const FIXTURE = resolve(import.meta.dirname, '../fixtures/llm/worker/e2e.json');
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `worker-last-resort-${process.pid}`);
const TOKENS = {
  ingest: 'ingest-token-last-resort-0123456789',
  worker: 'worker-token-last-resort-0123456789',
  inbound: 'server-to-worker-last-resort-0123',
};
const DAILY = 2_000_000;

let db: TestDb;
let srv: ServerHandle;
let wrk: WorkerHandle;
let primary: ReplayServer;
let secondary: ReplayServer;
let direct: ReplayServer;
const file = fileWriter(ROOT);

const viaGateway = (id: string, baseUrl: string, api: 'responses' | 'chat_completions') => ({
  id,
  base_url: baseUrl,
  api,
  model: `${id}-model`,
  dialect_profile: api === 'responses' ? 'openai-responses' : 'deepseek',
  price: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null },
  failure_domain: ['Namespace:shop'],
  in_domain: true,
  tier: 'large',
  retention_terms: 'gateway',
  api_key_file: file(`${id}-key`, id),
});

beforeAll(async () => {
  db = await newTestDb();
  await seedShopTopology(db);
  const workerPort = await freePort();
  srv = await startHubForWorker(db, file, TOKENS, workerPort);
  primary = new ReplayServer();
  secondary = new ReplayServer();
  direct = new ReplayServer();
  await Promise.all([primary.start(), secondary.start(), direct.start()]);
  direct.enqueue(...(JSON.parse(readFileSync(FIXTURE, 'utf8')) as { responses: LlmFixture[] }).responses);
  wrk = await buildWorker({
    config: workerConfigFor(srv.apiUrl, file, TOKENS, {
      llm: {
        probe_on_start: false,
        call_timeout: '90s',
        routes: [
          viaGateway('primary', primary.baseUrl, 'responses'),
          viaGateway('secondary', secondary.baseUrl, 'chat_completions'),
          {
            id: 'direct',
            base_url: direct.baseUrl,
            api: 'chat_completions',
            model: 'domestic-model',
            dialect_profile: 'openai-compatible',
            price: { currency: 'CNY', input_per_mtok: 2, output_per_mtok: 8, cached_input_per_mtok: null },
            in_domain: true,
            tier: 'large',
            role: 'last_resort',
            retention_terms: 'provider',
            api_key_file: file('direct-key', 'direct'),
          },
        ],
      },
      budget: { last_resort: { daily_tokens: DAILY } },
    }),
    pg: { ...db.serverConfig, user: DEFAULT_DB_ROLES.worker },
    noAuxListeners: true,
    apiListen: { host: '127.0.0.1', port: workerPort },
  });
  // 回放的模型响应在 16k 上下文的本地服务上录制，提示词按同样的上下文组装
  for (const rt of wrk.layer.routes) {
    rt.profile = { ...rt.profile, context_tokens: 16_384 };
  }
}, 120_000);

afterAll(async () => {
  await wrk?.stop();
  await srv?.stop();
  await Promise.all([primary?.stop(), secondary?.stop(), direct?.stop()]);
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

const message = async (incidentId: string) => {
  const source = new PgMessageSource(
    db.admin,
    {
      prefix: '',
      consoleUrl: 'https://srenautix.example.test',
      severities: ['critical', 'warning'],
      resolvedRetentionMs: 86_400_000,
    },
    {} as ProposalService,
    new ReportSource(
      db.admin,
      { latest: async () => new Map() } as unknown as FeedbackService,
      new TopologyStore(db.admin),
      { alertTitle: () => null, actionVerify: () => null, links: NO_LINKS },
      { prefix: '', consoleUrl: 'https://srenautix.example.test' },
    ),
  );
  return (await source.desired('zh')).find((x) => x.incidentId === incidentId)?.message ?? null;
};

describe('兜底路由', () => {
  it('网关事件：两条常规路由因故障域提前熔断，兜底路由完成研判，输出与消息标明兜底路由，用量单独记账', async () => {
    const body = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../fixtures/alertmanager/webhook-v4-alertmanager-0.34.1.json'),
        'utf8',
      ),
    ) as { alerts: Array<{ startsAt: string }> };
    (body.alerts[0] as { startsAt: string }).startsAt = new Date(Date.now() - 30_000).toISOString();
    const r = await fetch(`${srv.apiUrl}/v1/ingest/am`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKENS.ingest}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(200);
    const run = await until(
      '研判完成并被 server 镜像',
      async () => {
        const q = await db.admin.query<{
          run_id: string;
          incident_id: string;
          state: string;
          error: unknown;
          output: { last_resort_route?: unknown } | null;
        }>(
          "SELECT run_id, incident_id, state, error, output FROM server.research_runs WHERE state IN ('completed', 'failed', 'stage_a_only')",
        );
        return q.rows[0] ?? null;
      },
      60_000,
    );
    expect(run.state, JSON.stringify(run.error)).toBe('completed');

    // 常规路由的服务端全程收不到请求；兜底路由收到全部调用，走 OpenAI 兼容的 Chat 接口
    expect(primary.received).toHaveLength(0);
    expect(secondary.received).toHaveLength(0);
    expect(direct.received.length).toBeGreaterThanOrEqual(2);
    for (const req of direct.received) {
      expect(req.path).toBe('/v1/chat/completions');
      const sent = JSON.parse(req.body) as Record<string, unknown>;
      expect(sent).toMatchObject({ model: 'domestic-model', stream: true, response_format: { type: 'json_object' } });
      expect(sent).toHaveProperty('max_tokens');
      expect(sent).not.toHaveProperty('max_completion_tokens');
    }

    // 研判输出标明兜底路由，并符合契约
    expect(run.output?.last_resort_route).toEqual({ route_id: 'direct', model: 'domestic-model' });
    const ro = validatorFor('schemas/research-output.schema.json');
    expect(ro(run.output), JSON.stringify(ro.errors)).toBe(true);

    // 每次调用都记在兜底路由上；研判清单的路由使用全部是 direct
    const calls = await db.admin.query<{ route_id: string }>(
      'SELECT route_id FROM worker.llm_calls WHERE run_id = $1 ORDER BY seq',
      [run.run_id],
    );
    expect(new Set(calls.rows.map((c) => c.route_id))).toEqual(new Set(['direct']));
    const mf = await db.admin.query<{ manifest: { routes: Array<{ route_id: string }> } }>(
      'SELECT manifest FROM worker.research_manifests WHERE run_id = $1',
      [run.run_id],
    );
    expect(new Set(mf.rows[0]?.manifest.routes.map((u) => u.route_id))).toEqual(new Set(['direct']));

    // 用量：兜底路由单独记一行，等于这次研判的全部用量，同时计入当日合计；研判的成本按兜底路由的币种记
    const w = await db.admin.query<{ input_tokens: number; output_tokens: number; currency: string }>(
      'SELECT input_tokens, output_tokens, currency FROM worker.research_runs WHERE run_id = $1',
      [run.run_id],
    );
    const used = Number(w.rows[0]?.input_tokens) + Number(w.rows[0]?.output_tokens);
    expect(used).toBeGreaterThan(0);
    expect(w.rows[0]?.currency).toBe('CNY');
    const spare = await db.admin.query<{ route_id: string; tokens: string }>(
      'SELECT route_id, tokens FROM worker.daily_usage_last_resort',
    );
    expect(spare.rows.map((x) => [x.route_id, Number(x.tokens)])).toEqual([['direct', used]]);
    const total = await db.admin.query<{ tokens: string }>('SELECT tokens FROM worker.daily_usage');
    expect(Number(total.rows[0]?.tokens)).toBe(used);

    // 通知消息：结论之后标注“由兜底线路研判”
    const m = await message(run.incident_id);
    const keyIssue = JSON.stringify(m?.sections.find((s) => s.kind === 'key_issue'));
    expect(keyIssue).toContain('由兜底线路研判：');
    expect(keyIssue).toContain('"direct"');
    expect(keyIssue).toContain('（domestic-model），常规模型路由都依赖本事件涉及的组件');

    // worker 指标：兜底路由当日用量占上限的比例，常规路由的故障域跳过计数
    const metrics = await wrk.metrics.registry.metrics();
    expect(metrics).toMatch(/srenautix_llm_budget_used_ratio\{scope="last_resort"\} /);
    expect(metrics).toMatch(/srenautix_llm_failure_domain_skips_total\{route="primary"\} [1-9]/);
    expect(metrics).toMatch(/srenautix_llm_failure_domain_skips_total\{route="secondary"\} [1-9]/);
  }, 120_000);
});
