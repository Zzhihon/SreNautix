import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ServerMetrics } from '../../src/kernel/metrics.js';
import { migrateExpand } from '../../src/kernel/store/migrate.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { Scheduler } from '../../src/scheduler/admission.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { seedFiringIncident } from '../support/incidents.js';

// 模型恢复后补研判（触发原因 model_recovered）：CCHP 11-09..11-11 模型账户余额不足，研判失败的事件停在阶段 A 的
// "无法判定"，模型恢复后也不再研判。补研判只挑当前版本最近一次研判因模型失败的未恢复事件，每个版本只补一次

const CLUSTER = 'recover';
let db: TestDb;
let scheduler: Scheduler;
let n = 0;

const settings = {
  slots: 4,
  criticalReserved: 1,
  maxRunsPerIncident: 3,
  runWindowMs: 6 * 3600_000,
  stageTimeoutMs: 120_000,
  stormActiveAlerts: 200,
  stormNewIncidents: 20,
  stormWindowMs: 5 * 60_000,
  stormTopRoots: 3,
  maxRecoveries: 2,
};
const routes = (enabled: boolean) =>
  scheduler.reportRoutes({
    workerId: 'w1',
    at: Date.now(),
    routes: [{ id: 'primary', enabled, reason: null, message: null }],
  });

/** 一个未恢复事件，版本 1 上有一次研判，状态与错误码按参数 */
async function incidentWithRun(state: 'failed' | 'completed', code: string | null): Promise<string> {
  const id = await seedFiringIncident(db.server, CLUSTER, ++n);
  await db.server.query(
    `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, error, started_at, finished_at)
     VALUES ($1, $2, 1, 'new_incident', $3, $4, now() - interval '1 hour', now() - interval '1 hour')`,
    [randomUUID(), id, state, code ? JSON.stringify({ code, message: code }) : null],
  );
  return id;
}

const queued = async (id: string) =>
  (
    await db.admin.query<{ reason: string; state: string }>(
      'SELECT reason, state FROM server.research_queue WHERE incident_id = $1 ORDER BY enqueued_at',
      [id],
    )
  ).rows;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
});

beforeEach(async () => {
  scheduler = new Scheduler(db.server, settings, new ServerMetrics('server', false));
  await db.admin.query('DELETE FROM server.research_queue');
});

afterAll(async () => {
  await db?.close();
});

describe('模型恢复后补研判', () => {
  it('研判因模型不可用或输出无效而失败的未恢复事件入队一次；成功研判过的与其他失败原因不补', async () => {
    routes(true);
    const unavailable = await incidentWithRun('failed', 'model_unavailable');
    const invalid = await incidentWithRun('failed', 'invalid_output');
    const done = await incidentWithRun('completed', null);
    const other = await incidentWithRun('failed', 'internal');

    const r = await scheduler.recoverModelFailures(10);
    expect(r.map((x) => [x.incidentId, x.outcome]).sort()).toEqual(
      [
        [invalid, 'queued'],
        [unavailable, 'queued'],
      ].sort(),
    );
    expect(await queued(unavailable)).toEqual([{ reason: 'model_recovered', state: 'queued' }]);
    expect(await queued(done)).toEqual([]);
    expect(await queued(other)).toEqual([]);

    // 已有排队中的研判、或这个版本已经补过：不再入队
    expect(await scheduler.recoverModelFailures(10)).toEqual([]);
    await db.admin.query("UPDATE server.research_queue SET state = 'done'");
    expect(await scheduler.recoverModelFailures(10)).toEqual([]);
  });

  it('准入时因没有可用路由而跳过的事件同样补研判', async () => {
    const id = await seedFiringIncident(db.server, CLUSTER, ++n);
    await db.server.query(
      `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, is_new, state, skip_reason, finished_at)
       VALUES ($1, $2, 1, 'new_incident', 'warning', true, 'skipped', 'no_model_route', now())`,
      [randomUUID(), id],
    );
    routes(true);
    const r = await scheduler.recoverModelFailures(10);
    expect(r).toContainEqual({ incidentId: id, outcome: 'queued' });
  });

  it('没有可用路由时不做任何事', async () => {
    await incidentWithRun('failed', 'model_unavailable');
    routes(false);
    expect(await scheduler.recoverModelFailures(10)).toEqual([]);
    expect((await db.admin.query('SELECT 1 FROM server.research_queue')).rowCount).toBe(0);
  });
});
