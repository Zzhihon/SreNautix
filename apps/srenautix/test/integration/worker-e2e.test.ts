import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validatorFor } from '@srenautix/contract';
import { workerTracks } from '../../src/research/migrations.js';
import type { ServerHandle } from '../../src/roles/server.js';
import { buildWorker, type WorkerHandle } from '../../src/roles/worker.js';
import { schemaIsolationViolations, DEFAULT_DB_ROLES } from '../../src/store/bootstrap.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { responseErrors } from '../support/contract.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { ReplayServer, type LlmFixture } from '../support/llm-fixtures.js';
import { freePort, until } from '../support/monitoring.js';
import { fileWriter, seedShopTopology, startHubForWorker, workerConfigFor } from '../support/worker-hub.js';

/**
 * server 与 worker 端到端：真实 PostgreSQL（server 与 worker 各用自己的库角色）、真实 HTTP。
 * Alertmanager webhook → 事件与阶段 A → 研判入队 → worker 认领、读取输入、研判（模型响应来自本地 llama.cpp 的录制）、
 * 写入 worker schema 与 outbox → server 消费 worker 的事件流 → 控制台读取研判摘要、运行明细与研判清单。
 *
 * 设置 SRENAUTIX_LIVE_LLM_BASE_URL 时改为转发到该模型服务并重新录制（只指向本地自己启动的服务）。
 */
const LIVE = process.env.SRENAUTIX_LIVE_LLM_BASE_URL ?? null;
const FIXTURE = resolve(import.meta.dirname, '../fixtures/llm/worker/e2e.json');
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `worker-e2e-${process.pid}`);
const TOKENS = {
  ingest: 'ingest-token-worker-e2e-0123456789',
  worker: 'worker-token-worker-e2e-0123456789',
  inbound: 'server-to-worker-token-0123456789',
};

let db: TestDb;
let srv: ServerHandle;
let wrk: WorkerHandle;
let model: ReplayServer;

const file = fileWriter(ROOT);

beforeAll(async () => {
  db = await newTestDb();
  await seedShopTopology(db);
  const workerPort = await freePort();
  srv = await startHubForWorker(db, file, TOKENS, workerPort);
  model = new ReplayServer(LIVE);
  await model.start();
  if (!LIVE) {
    model.enqueue(...(JSON.parse(readFileSync(FIXTURE, 'utf8')) as { responses: LlmFixture[] }).responses);
  }
  const wcfg = workerConfigFor(srv.apiUrl, file, TOKENS, {
    llm: {
      probe_on_start: false,
      call_timeout: LIVE ? '300s' : '90s',
      routes: [
        {
          id: 'local',
          base_url: model.baseUrl,
          api: 'chat_completions',
          model: 'qwen3-1.7b',
          dialect_profile: 'llamacpp',
          price: { currency: 'CNY', input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: null },
          in_domain: true,
          tier: 'large',
          retention_terms: 'local',
          api_key_file: file('llm-key', 'local'),
        },
      ],
    },
  });
  wrk = await buildWorker({
    config: wcfg,
    pg: { ...db.serverConfig, user: DEFAULT_DB_ROLES.worker },
    noAuxListeners: true,
    apiListen: { host: '127.0.0.1', port: workerPort },
  });
  // 本地 llama-server 的上下文配置为 16k
  for (const rt of wrk.layer.routes) {
    rt.profile = { ...rt.profile, context_tokens: 16_384 };
  }
}, 120_000);

afterAll(async () => {
  await wrk?.stop();
  await srv?.stop();
  await model?.stop();
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
  if (LIVE && model) {
    mkdirSync(resolve(FIXTURE, '..'), { recursive: true });
    writeFileSync(
      FIXTURE,
      `${JSON.stringify({ provenance: { provider: 'llamacpp', model: 'qwen3-1.7b', recorded_at: new Date().toISOString() }, responses: model.recorded }, null, 2)}\n`,
    );
  }
});

describe('server 与 worker 端到端', () => {
  it('webhook → 阶段 B 研判 → server 镜像研判结果；明细与清单符合契约', async () => {
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
    const runs = await until(
      '研判完成并被 server 镜像',
      async () => {
        const q = await db.admin.query<{ run_id: string; state: string; incident_id: string }>(
          "SELECT run_id, state, incident_id FROM server.research_runs WHERE state IN ('completed', 'failed', 'stage_a_only')",
        );
        return q.rows.length ? q.rows : null;
      },
      LIVE ? 1_200_000 : 60_000,
    );
    const run = runs[0] as { run_id: string; state: string; incident_id: string };
    const why = await db.admin.query<{ error: unknown }>('SELECT error FROM server.research_runs WHERE run_id = $1', [
      run.run_id,
    ]);
    expect(run.state, JSON.stringify(why.rows[0]?.error)).toBe('completed');
    // worker schema 的研判记录与模型调用
    const w = await db.admin.query<{ state: string; input_tokens: number; output: { conclusion: { level: string } } }>(
      'SELECT state, input_tokens, output FROM worker.research_runs WHERE run_id = $1',
      [run.run_id],
    );
    expect(w.rows[0]?.state).toBe('completed');
    expect(w.rows[0]?.input_tokens).toBeGreaterThan(0);
    const calls = await db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM worker.llm_calls WHERE run_id = $1',
      [run.run_id],
    );
    expect(calls.rows[0]?.n).toBeGreaterThanOrEqual(2);
    // 事件流：research.concluded 符合契约
    const ev = await fetch(`http://127.0.0.1:${new URL(wrk.apiUrl).port}/v1/events?after=worker:0`, {
      headers: { authorization: `Bearer ${TOKENS.inbound}` },
    });
    const events = ((await ev.json()) as { events: Array<{ type: string; payload: unknown }> }).events;
    const concluded = events.find((e) => e.type === 'research.concluded');
    expect(concluded).toBeDefined();
    const ro = validatorFor('schemas/research-output.schema.json');
    const out = (concluded?.payload as { output: unknown }).output;
    expect(ro(out), JSON.stringify(ro.errors)).toBe(true);
    // 未授权的调用方
    expect((await fetch(`${wrk.apiUrl}/v1/events`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    // 研判清单
    const mf = await fetch(`${wrk.apiUrl}/v1/runs/${run.run_id}/manifest`, {
      headers: { authorization: `Bearer ${TOKENS.inbound}` },
    });
    const manifest = await mf.json();
    const mv = validatorFor('schemas/research-manifest.schema.json');
    expect(mv(manifest), JSON.stringify(mv.errors)).toBe(true);
    expect((manifest as { egress: Array<{ in_domain: boolean }> }).egress.length).toBeGreaterThan(0);
    // 运行明细
    const detail = (await (
      await fetch(`${wrk.apiUrl}/v1/runs/${run.run_id}`, { headers: { authorization: `Bearer ${TOKENS.inbound}` } })
    ).json()) as { llm_calls: unknown[]; steps: Array<{ state: string }> };
    expect(detail.llm_calls.length).toBeGreaterThanOrEqual(2);
    expect(detail.steps.map((s) => s.state)).toContain('conclude');
    // 经 server 读取的运行明细：worker 的检查卡之前合并该事件版本的阶段 A 卡，符合契约。
    // 本用例的模型响应是录制的，事件不能改变，所以没有领域包；在该版本的阶段 A 报告里加一张卡
    // （编号接在 worker 的卡之后，避免与检查卡重号），再经 server 读取
    const workerOnly = (detail as unknown as { evidence: Array<{ ref: string }> }).evidence;
    const nextRef = `card:${Math.max(0, ...workerOnly.map((c) => Number(c.ref.slice(5)))) + 1}`;
    const now = new Date().toISOString();
    const stageACard = {
      ref: nextRef,
      card_id: '_example/pod-memory/limit-ratio',
      title: { 'zh-CN': 'working set 占 limit', en: 'Working set vs limit' },
      threshold: 0.9,
      series: [],
      entity: { cluster_id: 'c1', kind: 'Pod', namespace: 'shop', name: 'api-7d9f8-x2k4p', uid: 'uid-pod-api' },
      window: { from: now, to: now },
      verdict: 'undeterminable',
      display_state: 'undeterminable',
      reason: { kind: 'source_error', text: '数据源不可达' },
      value: null,
      table: null,
      queries: [],
      egress: 'allow',
      anomaly_started_at: null,
      evaluated_at: now,
    };
    await db.admin.query(
      `UPDATE server.stage_a_reports s SET body = jsonb_set(s.body, '{cards}', (s.body->'cards') || $2::jsonb)
         FROM server.research_runs r
        WHERE r.run_id = $1 AND r.incident_id = s.incident_id AND r.incident_version = s.incident_version`,
      [run.run_id, JSON.stringify([stageACard])],
    );
    const stageA = await db.admin.query<{ body: { cards: Array<{ ref: string }> } }>(
      `SELECT s.body FROM server.stage_a_reports s JOIN server.research_runs r
         ON r.incident_id = s.incident_id AND r.incident_version = s.incident_version WHERE r.run_id = $1`,
      [run.run_id],
    );
    const stageACards = stageA.rows[0]?.body.cards ?? [];
    expect(stageACards.map((c) => c.ref)).toContain(nextRef);
    const viaServer = await fetch(`${srv.apiUrl}/v1/runs/${run.run_id}`, {
      headers: { authorization: `Bearer ${TOKENS.worker}` },
    });
    expect(viaServer.status).toBe(200);
    const merged = (await viaServer.json()) as { evidence: Array<{ ref: string }> };
    expect(merged.evidence.map((c) => c.ref)).toEqual([
      ...stageACards.map((c) => c.ref),
      ...workerOnly.map((c) => c.ref).filter((r) => !stageACards.some((c) => c.ref === r)),
    ]);
    expect(responseErrors('/v1/runs/{run_id}', 'get', 200, merged)).toBeNull();
    // 每日用量
    const u = await db.admin.query<{ tokens: number }>('SELECT tokens FROM worker.daily_usage');
    expect(u.rows[0]?.tokens).toBeGreaterThan(0);
  }, 1_300_000);

  it('server 与 worker 的库角色互相没有对方 schema 的权限', async () => {
    await migrateExpand(db.worker, 'worker', workerTracks);
    expect(await schemaIsolationViolations(db.admin, DEFAULT_DB_ROLES)).toEqual([]);
  });
});
