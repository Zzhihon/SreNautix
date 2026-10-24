import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { incidentTrack } from '../../src/incident/migrations.js';
import { WorkerEventMirror } from '../../src/scheduler/worker-events.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { newTestDb, type TestDb } from '../support/db.js';

// server.research_runs.reason 与队列里的入队原因一致（ADR 0142）。CCHP 2026-10-23 的 gateway 事件 b18629a6：
// 队列里是 root_changed、fingerprint_changed，镜像里全部是 new_incident。原因在 server 写入镜像时：worker 的
// research.concluded / research.failed 不带原因（契约里没有这个字段），镜像以前用 `p.reason ?? 'new_incident'`。

let db: TestDb;
let worker: Server;
let url = '';
let events: unknown[] = [];

beforeAll(async () => {
  db = await newTestDb();
  // 先只建到修复之前的版本，写入一条错的镜像记录，再升级：迁移 5 按队列补正
  await migrateExpand(db.server, 'server', [
    storeTrack,
    { ...incidentTrack, migrations: incidentTrack.migrations.slice(0, 4) },
  ]);
  worker = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const body = { events, next: `worker:${events.length}` };
    events = [];
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => worker.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise((r) => worker?.close(r));
  await db?.close();
});

const incident = randomUUID();
let seq = 0;
const queue = async (reason: string, version: number) => {
  const runId = randomUUID();
  await db.admin.query(
    `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, is_new, state)
     VALUES ($1, $2, $3, $4, 'critical', false, 'done')`,
    [runId, incident, version, reason],
  );
  return runId;
};
const event = (type: string, runId: string, version: number, extra: Record<string, unknown>) => ({
  seq: ++seq,
  event_id: randomUUID().replaceAll('-', ''),
  type,
  schema_version: '2.2.0',
  cluster_id: 'cchp',
  occurred_at: new Date().toISOString(),
  payload: { incident_id: incident, incident_version: version, run_id: runId, ...extra },
});
const reasonOf = async (runId: string) =>
  (await db.admin.query<{ reason: string }>('SELECT reason FROM server.research_runs WHERE run_id = $1', [runId]))
    .rows[0]?.reason;
const output = {
  disposition: 'escalate',
  conclusion: { level: 'inconclusive', root_component: 'StatefulSet:cchp-prod/gateway' },
  summary: 's',
};

describe('研判镜像的原因（ADR 0142）', () => {
  it('迁移 5：已有的镜像记录按队列里的入队原因补正，队列里没有的保持原样', async () => {
    const wrong = await queue('root_changed', 9);
    const orphan = randomUUID();
    for (const id of [wrong, orphan]) {
      await db.admin.query(
        `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, started_at)
         VALUES ($1, $2, 9, 'new_incident', 'stage_a_only', now())`,
        [id, incident],
      );
    }
    await migrateExpand(db.server, 'server', [storeTrack, incidentTrack]);
    expect(await reasonOf(wrong)).toBe('root_changed');
    expect(await reasonOf(orphan)).toBe('new_incident');
  });

  it('worker 的事件不带原因：镜像取队列里这次任务的入队原因，结论与失败事件都一样', async () => {
    const root = await queue('root_changed', 10);
    const fp = await queue('fingerprint_changed', 11);
    const reopened = await queue('reopened', 12);
    events = [
      event('research.failed', root, 10, { kind: 'breaker_open', message: '所有路由都因事件涉及其故障域而提前熔断' }),
      event('research.concluded', fp, 11, { evidence_fingerprint: 'a'.repeat(64), output }),
      event('research.concluded', reopened, 12, { evidence_fingerprint: 'b'.repeat(64), output }),
    ];
    const mirror = new WorkerEventMirror(db.server, url, 'token', () => {});
    expect(await mirror.once(0, new AbortController().signal)).toBe(3);
    expect(await reasonOf(root)).toBe('root_changed');
    expect(await reasonOf(fp)).toBe('fingerprint_changed');
    expect(await reasonOf(reopened)).toBe('reopened');
    const state = await db.admin.query<{ state: string }>('SELECT state FROM server.research_runs WHERE run_id = $1', [
      root,
    ]);
    expect(state.rows[0]?.state).toBe('stage_a_only');
  });

  it('队列里没有这次任务（不应出现）时记为 new_incident；事件自己带原因时以事件为准', async () => {
    const unknown = randomUUID();
    const withReason = await queue('root_changed', 13);
    events = [
      event('research.failed', unknown, 13, { kind: 'internal', message: 'x' }),
      event('research.failed', withReason, 13, { kind: 'internal', message: 'x', reason: 'manual' }),
    ];
    const mirror = new WorkerEventMirror(db.server, url, 'token', () => {});
    expect(await mirror.once(0, new AbortController().signal)).toBe(2);
    expect(await reasonOf(unknown)).toBe('new_incident');
    expect(await reasonOf(withReason)).toBe('manual');
  });
});
