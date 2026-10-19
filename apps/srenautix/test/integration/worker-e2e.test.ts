import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { validatorFor } from '@srenautix/contract';
import { parseServerConfig } from '../../src/config/server.js';
import { hashPassword } from '../../src/identity/password.js';
import { resolveWorkerConfig, workerConfigSchema } from '../../src/research/config.js';
import { workerTracks } from '../../src/research/migrations.js';
import { buildServer, type ServerHandle } from '../../src/roles/server.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { buildWorker, type WorkerHandle } from '../../src/roles/worker.js';
import { schemaIsolationViolations, DEFAULT_DB_ROLES } from '../../src/store/bootstrap.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { ReplayServer, type LlmFixture } from '../support/llm-fixtures.js';
import { freePort, until } from '../support/monitoring.js';

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
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let db: TestDb;
let srv: ServerHandle;
let wrk: WorkerHandle;
let model: ReplayServer;

const file = (name: string, content: string) => {
  const p = join(ROOT, name);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topo = new TopologyStore(db.server);
  const at = new Date(Date.now() - 3600_000);
  const node = (kind: string, ns: string | null, name: string, uid: string) => ({
    key: ns ? `${kind}:${ns}/${name}` : `${kind}:${name}`,
    kind,
    namespace: ns,
    name,
    uid,
    labels: {},
    component_type: null,
    hub: false,
  });
  await topo.apply('c1', [
    { op: 'node_upsert', at, source: 'informer', node: node('Deployment', 'shop', 'api', 'uid-deploy-api') },
    { op: 'node_upsert', at, source: 'informer', node: node('Pod', 'shop', 'api-7d9f8-x2k4p', 'uid-pod-api') },
    {
      op: 'edge_upsert',
      at,
      source: 'informer',
      edge: {
        from: 'Pod:shop/api-7d9f8-x2k4p',
        to: 'Deployment:shop/api',
        relation: 'owned_by',
        provenance: 'structural',
        confidence: 1,
        scope: 'instance',
        evidence: 'ownerReference',
      },
    },
  ]);
  const workerPort = await freePort();
  const signing = generateKeyPairSync('ed25519');
  const checkpoint = generateKeyPairSync('ed25519');
  srv = await buildServer({
    config: parseServerConfig({
      cluster_id: 'c1',
      profile: 'standard',
      log_level: 'warn',
      public_url: 'https://srenautix.example.test',
      worker: { url: `http://127.0.0.1:${workerPort}`, token_file: file('worker-inbound', TOKENS.inbound) },
      policies_dir: resolve(
        file(
          'policies/c1.yaml',
          stringify({
            version: 1,
            cluster: 'c1',
            actions: [{ id: 'workload_scale', namespaces: ['shop'] }],
            approvers: [],
          }),
        ),
        '..',
      ),
      ingest: {
        sources: [{ id: 'am', kind: 'alertmanager', token_file: file('ingest-token', TOKENS.ingest) }],
        reconcile: { enabled: false },
      },
      packs: { dirs: [resolve(file('packs/.keep', ''), '..')] },
      datasources: { prometheus: { url: 'http://127.0.0.1:9' } },
      topology: { source: 'off' },
      approvals: {
        signing_key_file: file('signing.pem', signing.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string),
        key_id: 'e2e',
      },
      callers: {
        tokens_file: file(
          'callers.yaml',
          stringify({ callers: [{ id: 'worker', kind: 'worker', token_sha256: sha(TOKENS.worker) }] }),
        ),
      },
      identity: {
        local_admin: {
          username: 'admin',
          password_hash_file: file('admin.hash', await hashPassword('correct horse battery')),
          totp_secret_file: file('admin.totp', 'JBSWY3DPEHPK3PXP'),
        },
        bindings_dir: resolve(file('bindings/admin.yaml', stringify({ bindings: [] })), '..'),
      },
      audit: {
        checkpoint_key_file: file(
          'checkpoint.pem',
          checkpoint.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
        ),
      },
    }),
    pg: db.serverConfig,
    noAuxListeners: true,
    apiListen: { host: '127.0.0.1', port: 0 },
  });
  model = new ReplayServer(LIVE);
  await model.start();
  if (!LIVE) {
    model.enqueue(...(JSON.parse(readFileSync(FIXTURE, 'utf8')) as { responses: LlmFixture[] }).responses);
  }
  const wcfg = resolveWorkerConfig(
    workerConfigSchema.parse({
      cluster_id: 'c1',
      worker_id: 'w1',
      code_sha: 'a'.repeat(40),
      log_level: 'warn',
      hub: { url: srv.apiUrl, token_file: file('worker-token', TOKENS.worker) },
      inbound: { token_sha256_file: file('inbound-sha', `${sha(TOKENS.inbound)}\n`) },
      language: 'zh',
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
      budget: { daily_tokens: 15_000_000 },
      research: { deadline: '20m', claim_wait: '1s' },
    }),
  );
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
    expect(run.state).toBe('completed');
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
    // 每日用量
    const u = await db.admin.query<{ tokens: number }>('SELECT tokens FROM worker.daily_usage');
    expect(u.rows[0]?.tokens).toBeGreaterThan(0);
  }, 1_300_000);

  it('server 与 worker 的库角色互相没有对方 schema 的权限', async () => {
    await migrateExpand(db.worker, 'worker', workerTracks);
    expect(await schemaIsolationViolations(db.admin, DEFAULT_DB_ROLES)).toEqual([]);
  });
});
