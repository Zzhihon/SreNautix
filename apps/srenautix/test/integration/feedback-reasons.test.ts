import { randomUUID } from 'node:crypto';
import type { FeedbackCreate, Incident } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerMetrics } from '../../src/metrics.js';
import { FeedbackService, type FeedbackActor } from '../../src/proposals/feedback.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { incident as baseIncident } from '../support/scenario.js';

/**
 * 反馈原因码（ADR 0174）与评测候选（ADR 0175）在真实 PostgreSQL 上：聊天渠道（Telegram、飞书）与控制台经同一个
 * FeedbackService 写入；表的约束只接受登记的原因码；候选按来源与事件去重
 */
let db: TestDb;
let svc: FeedbackService;
let metrics: ServerMetrics;

async function newIncident(): Promise<Incident> {
  const id = randomUUID();
  const inc = { ...baseIncident(), incident_id: id, label: `StatefulSet:shop/postgres:${id}` };
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, root_component, body)
     VALUES ($1, $2, $3, $4, 'firing', 'critical', $5, $6, $7)`,
    [
      id,
      inc.cluster_id,
      inc.label,
      inc.incident_version,
      new Date(inc.first_firing_at),
      inc.root.component,
      JSON.stringify(inc),
    ],
  );
  return inc;
}

const body = (over: Partial<FeedbackCreate> = {}): FeedbackCreate => ({
  research_run_id: null,
  verdict: null,
  root_component: null,
  disposition_verdict: null,
  disposition: null,
  mechanism: null,
  reason: null,
  ...over,
});
const as = (principalId: string, channel: FeedbackActor['channel']): FeedbackActor => ({
  principalId,
  channel,
  linked: true,
});

const candidates = async (incidentId: string) =>
  (
    await db.server.query(
      'SELECT source, source_ref, suggested_type, reason_code, reason FROM server.eval_candidates WHERE incident_id = $1',
      [incidentId],
    )
  ).rows;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  metrics = new ServerMetrics('server', false);
  svc = new FeedbackService(db.server, metrics);
});

afterAll(async () => {
  await db?.close();
});

describe('反馈原因码', () => {
  it('聊天渠道拒绝根因并选择原因：原因码写进反馈，事件本身不需要处理的原因生成 benign 候选，同一来源只生成一个', async () => {
    const inc = await newIncident();
    const fb = await svc.create(
      as('oidc:alice', 'telegram'),
      inc,
      body({ verdict: 'rejected', reason: '每周例行备份', reason_code: 'known_issue' }),
    );
    expect(fb).toMatchObject({ channel: 'telegram', reason_code: 'known_issue', reason: '每周例行备份' });
    await svc.create(
      as('oidc:bob', 'feishu'),
      inc,
      body({ disposition_verdict: 'rejected', disposition: 'ignore', reason_code: 'false_positive' }),
    );
    expect(await candidates(inc.incident_id)).toEqual([
      {
        source: 'feedback',
        source_ref: fb.feedback_id,
        suggested_type: 'benign',
        reason_code: 'known_issue',
        reason: '每周例行备份',
      },
    ]);
    const rows = await db.server.query(
      'SELECT channel, reason_code FROM server.feedback WHERE incident_id = $1 ORDER BY created_at',
      [inc.incident_id],
    );
    expect(rows.rows).toEqual([
      { channel: 'telegram', reason_code: 'known_issue' },
      { channel: 'feishu', reason_code: 'false_positive' },
    ]);
  });

  it('修复方向错误生成类型待定的候选；不生成候选的原因码与没有原因码的反馈不生成', async () => {
    const a = await newIncident();
    await svc.create(as('local:admin', 'console'), a, body({ verdict: 'confirmed', reason_code: 'wrong_fix' }));
    expect(await candidates(a.incident_id)).toEqual([
      expect.objectContaining({ source: 'feedback', suggested_type: null, reason_code: 'wrong_fix' }),
    ]);
    const b = await newIncident();
    await svc.create(as('local:admin', 'console'), b, body({ verdict: 'confirmed', reason_code: 'poor_wording' }));
    await svc.create(as('local:admin', 'console'), b, body({ verdict: 'confirmed' }));
    expect(await candidates(b.incident_id)).toEqual([]);
  });

  it('只有原因码的反馈合法；三项都没有时拒绝；表只接受登记的原因码', async () => {
    const inc = await newIncident();
    const only = await svc.create(as('local:admin', 'console'), inc, body({ reason_code: 'worse_than_baseline' }));
    expect(only).toMatchObject({
      verdict: null,
      disposition_verdict: null,
      implicit: null,
      reason_code: 'worse_than_baseline',
    });
    // 只有原因码的反馈也算最新一条
    expect((await svc.latest(db.server, [inc.incident_id])).get(inc.incident_id)?.feedback_id).toBe(only.feedback_id);
    await expect(svc.create(as('local:admin', 'console'), inc, body())).rejects.toThrow(/至少填一个/);
    await expect(
      db.server.query(
        `INSERT INTO server.feedback (feedback_id, incident_id, incident_version, principal_id, channel, linked, reason_code)
         VALUES ($1, $2, 1, 'x', 'console', true, 'bad_model')`,
        [randomUUID(), inc.incident_id],
      ),
    ).rejects.toThrow(/feedback_reason_code_check/);
    await expect(
      db.server.query(
        `INSERT INTO server.feedback (feedback_id, incident_id, incident_version, principal_id, channel, linked)
         VALUES ($1, $2, 1, 'x', 'console', true)`,
        [randomUUID(), inc.incident_id],
      ),
    ).rejects.toThrow(/feedback_check/);
    await expect(
      db.server.query(
        `INSERT INTO server.feedback (feedback_id, incident_id, incident_version, principal_id, channel, linked, implicit)
         VALUES ($1, $2, 1, 'x', 'console', true, 'merged')`,
        [randomUUID(), inc.incident_id],
      ),
    ).rejects.toThrow(/feedback_implicit_check/);
  });

  it('带原因码的反馈按登记表的级别计入 srenautix_terminal_states_total{stage="feedback"}', async () => {
    const count = async (code: string, level: string) =>
      (await metrics.terminalStates.get()).values.find(
        (v) => v.labels.stage === 'feedback' && v.labels.code === code && v.labels.level === level,
      )?.value ?? 0;
    const before = await count('external_upstream', 'info');
    const inc = await newIncident();
    await svc.create(
      as('local:admin', 'console'),
      inc,
      body({ verdict: 'rejected', reason_code: 'external_upstream' }),
    );
    await svc.create(as('local:admin', 'console'), inc, body({ verdict: 'confirmed' }));
    expect(await count('external_upstream', 'info')).toBe(before + 1);
  });
});
