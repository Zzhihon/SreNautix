import type { EvidenceResult, Incident } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { incidentTrack } from '../../src/incident/migrations.js';
import { ServerMetrics } from '../../src/metrics.js';
import type { ProposalService } from '../../src/proposals/service.js';
import type { EvidenceRun, EvidenceRunner, RuleProposer } from '../../src/stage-a/ports.js';
import { StageAService } from '../../src/stage-a/service.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { incident, stageACards } from '../support/scenario.js';

// 阶段 A 报告第一次生成的时刻（ADR 0159）：事件创建后 1 秒内就出了阶段 A（outbox 有 stage_a.reported），
// 领域包变化后重算，stage_a_reports.rendered_at 被覆盖成重算时刻，事后按 rendered_at 统计时这些事件看起来
// 直到重算才有阶段 A。

let db: TestDb;
let lock = 'sha256:a';
let cards: EvidenceResult[] = [];
const metrics = new ServerMetrics('server', false);
const evidence: EvidenceRunner = {
  run: async (): Promise<EvidenceRun> => ({ cards, chains: [], runbooks: [], rootComponentType: null }),
  rerun: async () => [],
};
const rules: RuleProposer = { evaluate: () => [], excluded: () => null };

const insertIncident = async (inc: Incident) => {
  await db.admin.query(
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
};

const times = async (id: string) =>
  (
    await db.admin.query<{ first_rendered_at: Date; rendered_at: Date }>(
      'SELECT first_rendered_at, rendered_at FROM server.stage_a_reports WHERE incident_id = $1',
      [id],
    )
  ).rows[0] as { first_rendered_at: Date; rendered_at: Date };

const old: Incident = { ...incident(), incident_id: '7a1b2c3d-0000-4000-8000-0000000000a1', label: 'old-with-outbox' };
const bare: Incident = {
  ...incident(),
  incident_id: '7a1b2c3d-0000-4000-8000-0000000000a2',
  label: 'old-without-outbox',
};

beforeAll(async () => {
  db = await newTestDb();
  // 先建到迁移 5，写入被重算覆盖过的报告，再升级：迁移 6 从 outbox 补上第一次生成的时刻
  await migrateExpand(
    db.server,
    'server',
    serverTracks.map((t) =>
      t.track === incidentTrack.track ? { ...incidentTrack, migrations: incidentTrack.migrations.slice(0, 5) } : t,
    ),
  );
  for (const inc of [old, bare]) {
    await insertIncident(inc);
    await db.admin.query(
      `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body, first_firing_at, rendered_at)
       VALUES (gen_random_uuid(), $1, $2, 'undetermined', 'fp', false, '{}', $3, '2026-10-24T16:27:36.398Z')`,
      [inc.incident_id, inc.incident_version, inc.first_firing_at],
    );
  }
  for (const at of ['2026-10-24T15:35:37.717Z', '2026-10-24T15:44:39.447Z', '2026-10-24T16:27:36.408Z']) {
    await db.admin.query(
      `INSERT INTO server.outbox (event_id, type, schema_version, cluster_id, payload, occurred_at)
       VALUES (gen_random_uuid(), 'stage_a.reported', '2.2.0', 'test', $1, $2)`,
      [JSON.stringify({ incident_id: old.incident_id, incident_version: old.incident_version }), at],
    );
  }
  await migrateExpand(db.server, 'server', serverTracks);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('阶段 A 报告第一次生成的时刻', () => {
  it('迁移 6：已有报告取 outbox 里这个版本最早的 stage_a.reported，outbox 里没有的取 rendered_at', async () => {
    expect((await times(old.incident_id)).first_rendered_at.toISOString()).toBe('2026-10-24T15:35:37.717Z');
    expect((await times(bare.incident_id)).first_rendered_at.toISOString()).toBe('2026-10-24T16:27:36.398Z');
  });

  it('领域包变化后的重算更新 rendered_at，first_rendered_at 保持第一次生成的时刻', async () => {
    const inc = incident();
    await insertIncident(inc);
    const stageA = new StageAService(db.server, evidence, rules, {} as ProposalService, metrics, () => lock);
    await stageA.run(inc);
    const before = await times(inc.incident_id);
    expect(before.first_rendered_at.getTime()).toBe(before.rendered_at.getTime());

    lock = 'sha256:b';
    cards = stageACards();
    await new Promise((r) => setTimeout(r, 20));
    await stageA.recompute(inc.incident_id, 'pack_change');
    const after = await times(inc.incident_id);
    expect(after.first_rendered_at.getTime()).toBe(before.first_rendered_at.getTime());
    expect(after.rendered_at.getTime()).toBeGreaterThan(before.rendered_at.getTime());
  });
});
