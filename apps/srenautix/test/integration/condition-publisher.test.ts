import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConditionPublisher, type Observed } from '../../src/console-bff/conditions.js';
import { ServerMetrics } from '../../src/kernel/metrics.js';
import { migrateExpand } from '../../src/kernel/store/migrate.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 状态条件的发布（DESIGN §12.4）：重启或换主实例之后，上一个进程留下、本轮不再观察到的条件要恢复。
// CCHP 11-09 的两条 PackLoadFailed 在包已经能加载之后仍留在状态条上，就是因为新进程不知道它们

let db: TestDb;
const metrics = new ServerMetrics('server', false);
const packFailed = (subject: string): Observed => ({
  type: 'PackLoadFailed',
  subject,
  active: true,
  reason: 'LintFailed',
  message: `${subject} 校验不通过`,
});
const status = async (subject: string) =>
  (
    await db.admin.query<{ status: string; reason: string }>(
      "SELECT status, reason FROM server.conditions WHERE role = 'server' AND type = 'PackLoadFailed' AND subject = $1",
      [subject],
    )
  ).rows[0];
const openSpans = async (subject: string) =>
  (
    await db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM server.condition_spans WHERE type = 'PackLoadFailed' AND subject = $1 AND ended_at IS NULL",
      [subject],
    )
  ).rows[0]!.n;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
});

afterAll(async () => {
  await db?.close();
});

describe('状态条件跨进程恢复', () => {
  it('上一个进程留下的条件，本轮没有观察到时恢复；仍观察到的保持成立', async () => {
    const before = new ConditionPublisher(db.server, 'server', 'c1', metrics);
    await before.publish([packFailed('cchp-alerts'), packFailed('still-broken')]);
    expect(await status('cchp-alerts')).toEqual({ status: 'true', reason: 'LintFailed' });
    expect(await openSpans('cchp-alerts')).toBe(1);

    // 重启：新进程的发布器没有内存状态，包 cchp-alerts 已经能加载
    const after = new ConditionPublisher(db.server, 'server', 'c1', metrics);
    await after.publish([packFailed('still-broken')]);
    expect(await status('cchp-alerts')).toEqual({ status: 'false', reason: 'Resolved' });
    expect(await openSpans('cchp-alerts')).toBe(0);
    expect(await status('still-broken')).toEqual({ status: 'true', reason: 'LintFailed' });
    expect(await openSpans('still-broken')).toBe(1);
  });

  it('只恢复本角色、本集群的条件', async () => {
    await new ConditionPublisher(db.server, 'server', 'other', metrics).publish([packFailed('elsewhere')]);
    await new ConditionPublisher(db.server, 'server', 'c1', metrics).publish([]);
    const r = await db.admin.query<{ status: string }>(
      "SELECT status FROM server.conditions WHERE cluster_id = 'other' AND subject = 'elsewhere'",
    );
    expect(r.rows[0]?.status).toBe('true');
  });
});
