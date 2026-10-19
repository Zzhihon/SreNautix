import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxListener } from '../../src/events/listener.js';
import { DEFAULT_DB_ROLES, schemaIsolationViolations } from '../../src/store/bootstrap.js';
import { idempotent } from '../../src/store/idempotency.js';
import {
  migrateContract,
  migrateExpand,
  MigrationError,
  migrationsReady,
  type Track,
} from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { appendEvents, lastSeq, outboxDdl, readEvents } from '../../src/store/outbox.js';
import { tx } from '../../src/store/pool.js';
import { newTestDb, type TestDb } from '../support/db.js';

let db: TestDb;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack]);
});

afterAll(async () => {
  await db.close();
});

describe('schema 隔离', () => {
  it('每个库角色对其他角色的 schema 没有 USAGE', async () => {
    expect(await schemaIsolationViolations(db.admin, DEFAULT_DB_ROLES)).toEqual([]);
  });

  it('worker 角色读不到 server schema 的表', async () => {
    await expect(db.worker.query('SELECT * FROM server.outbox')).rejects.toThrow(/permission denied for schema server/);
  });

  it('worker 角色可以在自己的 schema 里建表', async () => {
    await migrateExpand(db.worker, 'worker', [
      { track: 'store', migrations: [{ version: 1, name: 'outbox', phase: 'expand', sql: outboxDdl('worker') }] },
    ]);
    expect((await db.worker.query('SELECT count(*)::int AS n FROM worker.outbox')).rows[0].n).toBe(0);
  });
});

describe('先扩展后收缩的迁移', () => {
  const v1: Track = {
    track: 'demo',
    migrations: [{ version: 1, name: 'create', phase: 'expand', sql: 'CREATE TABLE server.demo (a int, old text)' }],
  };
  const v2: Track = {
    track: 'demo',
    migrations: [
      ...v1.migrations,
      { version: 2, name: 'add b', phase: 'expand', sql: 'ALTER TABLE server.demo ADD COLUMN b int' },
      { version: 3, name: 'drop old', phase: 'contract', sql: 'ALTER TABLE server.demo DROP COLUMN old' },
    ],
  };
  const v3: Track = {
    track: 'demo',
    migrations: [
      ...v2.migrations,
      { version: 4, name: 'add c', phase: 'expand', sql: 'ALTER TABLE server.demo ADD COLUMN c int' },
    ],
  };

  it('扩展迁移幂等，N-1 的二进制可以在 N 扩展后的 schema 上运行', async () => {
    expect(await migrateExpand(db.server, 'server', [storeTrack, v1])).toEqual(['demo/1']);
    expect(await migrateExpand(db.server, 'server', [storeTrack, v1])).toEqual([]);
    expect(await migrateExpand(db.server, 'server', [storeTrack, v2])).toEqual(['demo/2']);
    expect(await migrationsReady(db.server, 'server', [storeTrack, v1])).toBe(true);
    expect(await migrationsReady(db.server, 'server', [storeTrack, v2])).toBe(true);
  });

  it('收缩迁移只由显式命令执行，之后 N-1 的二进制拒绝启动', async () => {
    expect((await db.server.query('SELECT old FROM server.demo')).rowCount).toBe(0);
    expect(await migrateContract(db.server, 'server', [storeTrack, v2])).toEqual(['demo/3']);
    await expect(db.server.query('SELECT old FROM server.demo')).rejects.toThrow(/column "old" does not exist/);
    await expect(migrationsReady(db.server, 'server', [storeTrack, v1])).rejects.toThrow(MigrationError);
  });

  it('未执行的收缩迁移挡住之后的扩展迁移', async () => {
    const t: Track = {
      track: 'gate',
      migrations: [
        { version: 1, name: 'a', phase: 'expand', sql: 'CREATE TABLE server.gate (x int)' },
        { version: 2, name: 'b', phase: 'contract', sql: 'ALTER TABLE server.gate DROP COLUMN x' },
        { version: 3, name: 'c', phase: 'expand', sql: 'ALTER TABLE server.gate ADD COLUMN y int' },
      ],
    };
    await expect(migrateExpand(db.server, 'server', [storeTrack, v3, t])).rejects.toThrow(/收缩迁移 gate\/2/);
  });
});

describe('outbox', () => {
  it('seq 的顺序等于提交顺序：先开始、后提交的事务不会被游标跳过', async () => {
    const start = await lastSeq(db.server, 'server');
    // 事务 A 先追加但不提交；事务 B 等待 A 的 advisory lock，A 提交后 B 才拿到更大的 seq
    const a = await db.server.connect();
    await a.query('BEGIN');
    await appendEvents(a, 'server', 'server', '2.0.0', [
      { type: 'incident.created', clusterId: 'c1', payload: { n: 'a' } },
    ]);
    const b = tx(db.server, (c) =>
      appendEvents(c, 'server', 'server', '2.0.0', [
        { type: 'incident.updated', clusterId: 'c1', payload: { n: 'b' } },
      ]),
    );
    await new Promise((r) => setTimeout(r, 200));
    const before = await readEvents(db.server, 'server', 'server', { after: start, limit: 10 });
    expect(before).toEqual([]);
    await a.query('COMMIT');
    a.release();
    await b;
    const after = await readEvents(db.server, 'server', 'server', { after: start, limit: 10 });
    expect(after.map((e) => (e.payload as { n: string }).n)).toEqual(['a', 'b']);
    expect((after[1] as { seq: number }).seq).toBeGreaterThan((after[0] as { seq: number }).seq);
  });

  it('同一个 event_id 只记录一次；按类型过滤', async () => {
    const start = await lastSeq(db.server, 'server');
    const id = '7d0f7f1e-1d55-4c64-8f6f-6a8d3f0c2f11';
    await tx(db.server, (c) =>
      appendEvents(c, 'server', 'server', '2.0.0', [
        { type: 'feedback.recorded', clusterId: 'c1', payload: {}, eventId: id },
      ]),
    );
    await tx(db.server, (c) =>
      appendEvents(c, 'server', 'server', '2.0.0', [
        { type: 'feedback.recorded', clusterId: 'c1', payload: {}, eventId: id },
      ]),
    );
    await tx(db.server, (c) =>
      appendEvents(c, 'server', 'server', '2.0.0', [{ type: 'condition.changed', clusterId: 'c1', payload: {} }]),
    );
    const all = await readEvents(db.server, 'server', 'server', { after: start, limit: 10 });
    expect(all.map((e) => e.type)).toEqual(['feedback.recorded', 'condition.changed']);
    const only = await readEvents(db.server, 'server', 'server', {
      after: start,
      limit: 10,
      types: ['condition.changed'],
    });
    expect(only).toHaveLength(1);
  });

  it('LISTEN 在提交时收到唤醒', async () => {
    const l = new OutboxListener(db.serverConfig, 'test');
    l.start();
    await l.waitWake('server', 5_000);
    expect(l.connected).toBe(true);
    const woke = l.waitWake('server', 5_000);
    await tx(db.server, (c) =>
      appendEvents(c, 'server', 'server', '2.0.0', [{ type: 'incident.updated', clusterId: 'c1', payload: {} }]),
    );
    expect(await woke).toBe(true);
    await l.stop();
  });
});

describe('幂等键', () => {
  it('同一个键返回第一次的结果，换请求体返回 422', async () => {
    let calls = 0;
    const run = (body: unknown) =>
      idempotent(db.server, 'caller-1', 'key-abcdef-1', body, async () => {
        calls++;
        return { status: 201, body: { n: calls } };
      });
    const first = await run({ a: 1 });
    const second = await run({ a: 1 });
    expect(first).toEqual({ status: 201, body: { n: 1 }, replayed: false });
    expect(second).toEqual({ status: 201, body: { n: 1 }, replayed: true });
    await expect(run({ a: 2 })).rejects.toMatchObject({ status: 422 });
    expect(calls).toBe(1);
  });
});
