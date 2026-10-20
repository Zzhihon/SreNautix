import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DB_ROLES } from '../../src/store/bootstrap.js';
import { waitForSchema } from '../../src/store/wait-schema.js';
import { newTestDb, type TestDb } from '../support/db.js';

/**
 * `db wait`（chart 中 server、worker 的 initContainer）：真实 PostgreSQL 上，schema 不存在或不属于该库角色时一直等待，
 * db bootstrap 建好之后返回；中止时抛出。
 */
let db: TestDb;

beforeAll(async () => {
  db = await newTestDb();
  // 模拟 bootstrap 之前：worker 的 schema 还不存在
  await db.admin.query('DROP SCHEMA worker CASCADE');
});

afterAll(async () => {
  await db?.close();
});

const workerCfg = () => ({ ...db.serverConfig, user: DEFAULT_DB_ROLES.worker });

describe('db wait', () => {
  it('schema 不存在时等待，建好并属于该库角色之后返回', async () => {
    let done = false;
    const waiting = waitForSchema(workerCfg(), 'worker', { intervalMs: 100, logEveryMs: 60_000 }).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(done).toBe(false);
    // 先由别的角色建好：仍然等待（bootstrap 会把属主改为该库角色）
    await db.admin.query('CREATE SCHEMA worker AUTHORIZATION postgres');
    await new Promise((r) => setTimeout(r, 500));
    expect(done).toBe(false);
    await db.admin.query(`ALTER SCHEMA worker OWNER TO ${DEFAULT_DB_ROLES.worker}`);
    await waiting;
    expect(done).toBe(true);
  });

  it('已经就绪时立即返回', async () => {
    const t0 = Date.now();
    await waitForSchema({ ...db.serverConfig }, 'server', { intervalMs: 5_000, logEveryMs: 60_000 });
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  it('连不上 PostgreSQL 时继续等待，中止时抛出', async () => {
    const ac = new AbortController();
    const waiting = waitForSchema({ ...db.serverConfig, port: 1 }, 'server', {
      intervalMs: 100,
      logEveryMs: 60_000,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 500));
    ac.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
  });
});
