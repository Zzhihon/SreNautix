import type { EvidenceResult } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { registerResearchRoutes, type ResearchRouteDeps } from '../../src/api/routes-research.js';
import type { Auth } from '../../src/identity/auth.js';
import { ServerMetrics } from '../../src/metrics.js';
import type { ProposalService } from '../../src/proposals/service.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import type { EvidenceRun, EvidenceRunner, RuleProposer } from '../../src/stage-a/ports.js';
import { StageAService } from '../../src/stage-a/service.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { incident, stageACards } from '../support/scenario.js';

// 阶段 A 的重算（ADR 0107）：报告记录 pack.lock；领域包变化后仍在触发的事件按限速重算；人工入口写审计；只算阶段 A

let db: TestDb;
let app: FastifyInstance;
let lock = 'sha256:a';
let cards: EvidenceResult[] = [];
const metrics = new ServerMetrics('server', false);

const evidence: EvidenceRunner = {
  run: async (): Promise<EvidenceRun> => ({ cards, chains: [], runbooks: [], rootComponentType: null }),
  rerun: async () => [],
};
const rules: RuleProposer = { evaluate: () => [], excluded: () => null };
let stageA: StageAService;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const inc = incident();
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      inc.incident_id,
      inc.cluster_id,
      inc.label,
      inc.incident_version,
      inc.state,
      inc.severity,
      inc.first_firing_at,
      inc.root.component,
      JSON.stringify(inc),
    ],
  );
  stageA = new StageAService(db.server, evidence, rules, {} as ProposalService, metrics, () => lock);
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerResearchRoutes(app, {
    pool: db.server,
    auth: {
      user: async () => ({ kind: 'user', subject: { id: 'alice' }, roles: ['responder'] }),
      required: async () => ({ kind: 'user', subject: { id: 'alice' } }),
      reader: async () => ({ scopes: 'all' }),
    } as unknown as Auth,
    stageA,
  } as unknown as ResearchRouteDeps);
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const report = async () =>
  (
    await db.server.query<{ pack_lock: string; n: number }>(
      "SELECT pack_lock, jsonb_array_length(body->'cards') AS n FROM server.stage_a_reports WHERE incident_id = $1",
      [incident().incident_id],
    )
  ).rows;

describe('阶段 A 重算', () => {
  it('报告记录 pack.lock；领域包变化后找出需要重算的事件，重算后卡片来自新的领域包', async () => {
    cards = [];
    await stageA.run(incident());
    expect(await report()).toEqual([{ pack_lock: 'sha256:a', n: 0 }]);
    expect(await stageA.stale('test', 10)).toEqual([]);
    expect(await stageA.current(incident().incident_id, incident().incident_version)).toBe(true);

    // 加载了新的领域包：同一事件现在有卡
    lock = 'sha256:b';
    cards = stageACards();
    expect(await stageA.current(incident().incident_id, incident().incident_version)).toBe(false);
    expect(await stageA.stale('test', 10)).toEqual([incident().incident_id]);
    for (const id of await stageA.stale('test', 10)) {
      await stageA.recompute(id, 'pack_change');
    }
    expect(await report()).toEqual([{ pack_lock: 'sha256:b', n: cards.length }]);
    expect(await stageA.stale('test', 10)).toEqual([]);
    // 只算阶段 A：没有研判入队
    const q = await db.server.query('SELECT 1 FROM server.research_queue');
    expect(q.rowCount).toBe(0);
    // 发布了 stage_a.reported
    const ev = await db.server.query("SELECT count(*)::int AS n FROM server.outbox WHERE type = 'stage_a.reported'");
    expect(ev.rows[0]).toEqual({ n: 2 });
  });

  it('限速：每次最多取 limit 个事件', async () => {
    lock = 'sha256:c';
    expect(await stageA.stale('test', 0)).toEqual([]);
    expect(await stageA.stale('test', 1)).toHaveLength(1);
  });

  it('人工入口：返回新报告并写入治理审计', async () => {
    lock = 'sha256:d';
    const r = await app.inject({ method: 'POST', url: `/v1/incidents/${incident().incident_id}/stage-a/recompute` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ incident_id: incident().incident_id, cards: expect.any(Array) });
    expect(await report()).toEqual([{ pack_lock: 'sha256:d', n: cards.length }]);
    const a = await db.server.query<{ kind: string; actor: string; data: { incident_id: string } }>(
      "SELECT kind, actor, data FROM server.governance_audit WHERE kind = 'stage_a.recompute'",
    );
    expect(a.rows).toEqual([
      expect.objectContaining({
        kind: 'stage_a.recompute',
        actor: 'alice',
        data: expect.objectContaining({ incident_id: incident().incident_id }),
      }),
    ]);
    const missing = await app.inject({ method: 'POST', url: '/v1/incidents/no-such-incident/stage-a/recompute' });
    expect(missing.statusCode).toBe(404);
  });
});
