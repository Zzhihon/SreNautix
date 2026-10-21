import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_LINKS } from '../../src/notify/links.js';
import { PgMessageSource, ReportSource } from '../../src/notify/source.js';
import { TopologyStore } from '../../src/topology/store.js';
import type { FeedbackService } from '../../src/proposals/feedback.js';
import type { ProposalService } from '../../src/proposals/service.js';
import type { ServerHandle } from '../../src/roles/server.js';
import { buildWorker, type WorkerHandle } from '../../src/roles/worker.js';
import { DEFAULT_DB_ROLES } from '../../src/store/bootstrap.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { ReplayServer } from '../support/llm-fixtures.js';
import { freePort, until } from '../support/monitoring.js';
import { fileWriter, seedShopTopology, startHubForWorker, workerConfigFor } from '../support/worker-hub.js';

/**
 * 出站策略禁用路由（ADR 0093）：国内配置（allow_cross_border=false）下只有一条境外路由。
 * worker 照常启动并就绪，路由被禁用并暴露指标；server 发布条件，阶段 B 不入队，通知横幅说明原因；
 * 上报之前已入队的任务由 worker 兜底，记为只出阶段 A。全程境外路由的服务端收不到任何请求（包括启动探测）。
 */
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `worker-route-disabled-${process.pid}`);
const TOKENS = {
  ingest: 'ingest-token-route-disabled-0123456789',
  worker: 'worker-token-route-disabled-0123456789',
  inbound: 'server-to-worker-token-disabled-0123',
};
const file = fileWriter(ROOT);

let db: TestDb;
let srv: ServerHandle;
let wrk: WorkerHandle;
let model: ReplayServer;
let metricsPort: number;
let probesPort: number;

beforeAll(async () => {
  db = await newTestDb();
  await seedShopTopology(db);
  const workerPort = await freePort();
  srv = await startHubForWorker(db, file, TOKENS, workerPort);
  model = new ReplayServer();
  await model.start();
  metricsPort = await freePort();
  probesPort = await freePort();
  wrk = await buildWorker({
    config: workerConfigFor(srv.apiUrl, file, TOKENS, {
      listen: {
        api: `127.0.0.1:${workerPort}`,
        metrics: `127.0.0.1:${metricsPort}`,
        probes: `127.0.0.1:${probesPort}`,
      },
      llm: {
        // 启动探测打开：被禁用的路由也不能被探测
        probe_on_start: true,
        call_timeout: '10s',
        routes: [
          {
            id: 'overseas',
            base_url: model.baseUrl,
            api: 'chat_completions',
            model: 'qwen3-1.7b',
            dialect_profile: 'llamacpp',
            price: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null },
            in_domain: false,
            tier: 'large',
            retention_terms: 'provider default',
            api_key_file: file('llm-key', 'local'),
          },
        ],
      },
    }),
    pg: { ...db.serverConfig, user: DEFAULT_DB_ROLES.worker },
    apiListen: { host: '127.0.0.1', port: workerPort },
  });
}, 120_000);

afterAll(async () => {
  await wrk?.stop();
  await srv?.stop();
  await model?.stop();
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

const banner = async (incidentId: string): Promise<string | null> => {
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
  const m = (await source.desired('zh')).find((x) => x.incidentId === incidentId);
  return m?.message.banner ?? null;
};

describe('出站策略禁用模型路由', () => {
  it('worker 照常就绪；路由被禁用并暴露指标', async () => {
    expect(wrk.layer.routes).toHaveLength(0);
    expect(wrk.layer.disabled.map((d) => [d.id, d.reason])).toEqual([['overseas', 'cross_border']]);
    const ready = await fetch(`http://127.0.0.1:${probesPort}/readyz`);
    expect(ready.status).toBe(200);
    const metrics = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
    expect(metrics).toContain('srenautix_llm_route_disabled{route="overseas",reason="cross_border"} 1');
    expect(metrics).toContain('srenautix_llm_routes_available 0');
    expect(metrics).toContain('srenautix_condition{role="worker",type="no_model_route"} 1');
    expect(model.received).toHaveLength(0);
  });

  it('server 发布条件，阶段 B 不入队，通知横幅说明原因；已入队的任务由 worker 兜底为只出阶段 A', async () => {
    const cond = await until(
      'server 发布 worker 的路由条件',
      async () => {
        const r = await db.admin.query<{ status: string; reason: string; message: string }>(
          "SELECT status, reason, message FROM server.conditions WHERE role = 'worker' AND type = 'ModelRouteBreakerOpen' AND subject = 'overseas'",
        );
        return r.rows[0] ?? null;
      },
      40_000,
    );
    expect(cond).toMatchObject({ status: 'true', reason: 'EgressPolicyNoRoute' });
    expect(cond.message).toMatch(/路由 overseas 在境外.*不会被调用.*阶段 B 不运行，只出阶段 A/);
    const changed = await db.admin.query<{ payload: { role: string; subject: string } }>(
      "SELECT payload FROM server.outbox WHERE type = 'condition.changed' AND payload->>'type' = 'ModelRouteBreakerOpen'",
    );
    expect(changed.rows.map((r) => [r.payload.role, r.payload.subject])).toEqual([['worker', 'overseas']]);

    // 新事件：阶段 A 照常，阶段 B 因没有可用路由被跳过
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
    const skipped = await until(
      '阶段 B 因没有可用路由被跳过',
      async () => {
        const q = await db.admin.query<{ incident_id: string; incident_version: number; skip_reason: string }>(
          "SELECT incident_id, incident_version, skip_reason FROM server.research_queue WHERE state = 'skipped'",
        );
        return q.rows[0] ?? null;
      },
      30_000,
    );
    expect(skipped.skip_reason).toBe('no_model_route');
    expect(await banner(skipped.incident_id)).toBe('只出确定性报告：没有可用的模型路由（全部被出站策略禁用）');

    // 上报到达之前已入队的任务：worker 认领后不调用模型，记为只出阶段 A，原因写进研判记录与通知横幅
    const runId = randomUUID();
    await db.admin.query(
      `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, absorbed, is_new, state)
       VALUES ($1, $2, $3, 'manual', 'warning', 0, false, 'queued')`,
      [runId, skipped.incident_id, skipped.incident_version],
    );
    const run = await until(
      'worker 兜底并被 server 镜像',
      async () => {
        const q = await db.admin.query<{ state: string; error: { kind: string; message: string } }>(
          'SELECT state, error FROM server.research_runs WHERE run_id = $1',
          [runId],
        );
        return q.rows[0]?.state === 'stage_a_only' ? q.rows[0] : null;
      },
      30_000,
    );
    expect(run.error.kind).toBe('breaker_open');
    expect(run.error.message).toMatch(/没有可用的模型路由：路由 overseas 在境外/);
    const queue = await db.admin.query<{ state: string; skip_reason: string }>(
      'SELECT state, skip_reason FROM server.research_queue WHERE run_id = $1',
      [runId],
    );
    expect(queue.rows[0]).toEqual({ state: 'done', skip_reason: 'stage_a_only' });
    expect(await banner(skipped.incident_id)).toMatch(/^只出确定性报告：没有可用的模型路由：路由 overseas 在境外/);
    const calls = await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM worker.llm_calls');
    expect(calls.rows[0]?.n).toBe(0);
    expect(model.received).toHaveLength(0);
  }, 120_000);
});
