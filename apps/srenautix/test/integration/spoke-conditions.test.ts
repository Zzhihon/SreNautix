import { CONDITION_DIRECTIONS } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alerts,
  expireSpokeConditions,
  isHealthy,
  replaceSpokeConditions,
  stripType,
} from '../../src/console-bff/spoke-conditions.js';
import { proposalsTrack } from '../../src/proposals/migrations.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { tx } from '../../src/store/pool.js';
import { topologyTrack } from '../../src/topology/migrations.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 分支条件的方向来自契约（contract/conditions.json）；换 Pod 后旧实例的条件行被删除；心跳过期后清除。

let db: TestDb;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, topologyTrack, proposalsTrack]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const since = '2026-10-20T08:00:00Z';
const rows = async (role: string, cluster: string) =>
  (
    await db.admin.query<{ type: string; subject: string; status: string; reason: string }>(
      'SELECT type, subject, status, reason FROM server.conditions WHERE role = $1 AND cluster_id = $2 ORDER BY type, subject',
      [role, cluster],
    )
  ).rows.map((r) => [r.type, r.subject, r.status, r.reason]);

describe('条件方向（契约）', () => {
  it('gateway：ClockSkew=True（within_limit）是正常的；Freeze=True 与 ApiserverThrottled=True 才是异常', () => {
    expect(isHealthy('gateway', 'ClockSkew', 'True')).toBe(true);
    expect(isHealthy('gateway', 'ClockSkew', 'False')).toBe(false);
    expect(isHealthy('gateway', 'AdmissionSelfCheck', 'True')).toBe(true);
    expect(isHealthy('gateway', 'AuditSink', 'False')).toBe(false);
    expect(isHealthy('gateway', 'Freeze', 'True')).toBe(false);
    expect(alerts('gateway', 'Freeze')).toBe(false);
    expect(isHealthy('gateway', 'ApiserverThrottled', 'True')).toBe(false);
    expect(isHealthy('gateway', 'Leader', 'Unknown')).toBe(false);
  });

  it('reader：True 是正常；server、worker：true 表示问题', () => {
    for (const t of [
      'InformersFresh',
      'TunnelConnected',
      'ClockSkew',
      'QueryManifest',
      'Datasource',
      'AlertReconcile',
    ]) {
      expect(isHealthy('reader', t, 'True')).toBe(true);
      expect(isHealthy('reader', t, 'False')).toBe(false);
    }
    expect(isHealthy('server', 'IngestSilent', 'false')).toBe(true);
    expect(isHealthy('worker', 'ModelRouteBreakerOpen', 'true')).toBe(false);
    expect(alerts('server', 'Frozen')).toBe(false);
  });

  it('方向表覆盖 gateway 与 reader 协议里的每个条件类型', async () => {
    const yaml = await import('yaml');
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const root = resolve(import.meta.dirname, '../../../../contract/gateway/v1');
    const gw = yaml.parse(readFileSync(resolve(root, 'openapi.yaml'), 'utf8')) as {
      components: { schemas: { Condition: { properties: { type: { enum: string[] } } } } };
    };
    const rd = yaml.parse(readFileSync(resolve(root, 'reader.openapi.yaml'), 'utf8')) as {
      components: { schemas: { ReaderCondition: { properties: { type: { enum: string[] } } } } };
    };
    expect(Object.keys(CONDITION_DIRECTIONS.roles.gateway?.types ?? {}).sort()).toEqual(
      [...gw.components.schemas.Condition.properties.type.enum].sort(),
    );
    expect(Object.keys(CONDITION_DIRECTIONS.roles.reader?.types ?? {}).sort()).toEqual(
      [...rd.components.schemas.ReaderCondition.properties.type.enum].sort(),
    );
    expect(stripType('gateway', 'ClockSkew')).toBe('ClockSkew');
    expect(stripType('gateway', 'Leader')).toBeNull();
  });
});

describe('心跳替换条件', () => {
  it('gateway 时钟正常时状态条不显示问题；换 Pod 后旧 Pod 的条件行被删除', async () => {
    const hb = (pod: string, skew: 'True' | 'False') =>
      tx(db.server, (c) =>
        replaceSpokeConditions(c, 'gateway', 'east', pod, [
          { type: 'ClockSkew', status: skew, reason: skew === 'True' ? 'within_limit' : 'too_large', since },
          { type: 'AdmissionSelfCheck', status: 'True', reason: 'probes_denied', since },
          { type: 'Freeze', status: 'True', reason: 'frozen', since },
          { type: 'Leader', status: 'True', reason: 'leading', since },
        ]),
      );
    await hb('gw-a', 'True');
    expect(await rows('gateway', 'east')).toEqual([
      ['AdmissionSelfTestFailed', 'gw-a', 'false', 'probes_denied'],
      ['ClockSkew', 'gw-a', 'false', 'within_limit'],
      ['Frozen', 'gw-a', 'true', 'frozen'],
    ]);
    await hb('gw-b', 'False');
    expect(await rows('gateway', 'east')).toEqual([
      ['AdmissionSelfTestFailed', 'gw-b', 'false', 'probes_denied'],
      ['ClockSkew', 'gw-b', 'true', 'too_large'],
      ['Frozen', 'gw-b', 'true', 'frozen'],
    ]);
  });

  it('reader：这次心跳没有列出的条件被删除', async () => {
    await tx(db.server, (c) =>
      replaceSpokeConditions(c, 'reader', 'east', '', [
        { type: 'InformersFresh', status: 'True', reason: 'Synced', since },
        { type: 'QueryManifest', status: 'False', reason: 'NotMounted', since },
      ]),
    );
    await tx(db.server, (c) =>
      replaceSpokeConditions(c, 'reader', 'east', '', [
        { type: 'InformersFresh', status: 'False', reason: 'Stale', since },
      ]),
    );
    expect(await rows('reader', 'east')).toEqual([['InformersFresh', '', 'true', 'Stale']]);
  });
});

describe('心跳过期', () => {
  it('gateway 心跳超过时限：清除 gateway 的条件；心跳恢复后由心跳写回', async () => {
    const status = (ageS: number) =>
      db.admin.query(
        `INSERT INTO server.spoke_status (cluster_id, gateway_id, version, leader, propose_only, conditions, queue, clock_skew, received_at)
         VALUES ('west', 'gw-0', '0.1.0', true, false, '[]', '[]', '{}', now() - make_interval(secs => $1))
         ON CONFLICT (cluster_id) DO UPDATE SET received_at = excluded.received_at`,
        [ageS],
      );
    await status(5);
    await tx(db.server, (c) =>
      replaceSpokeConditions(c, 'gateway', 'west', 'gw-0', [
        { type: 'AuditSink', status: 'False', reason: 'sink_unavailable', since },
      ]),
    );
    await expireSpokeConditions(db.server, 60_000, { clusterId: 'hub', usesReader: false });
    expect(await rows('gateway', 'west')).toEqual([['AuditExportLagging', 'gw-0', 'true', 'sink_unavailable']]);
    await status(300);
    await expireSpokeConditions(db.server, 60_000, { clusterId: 'hub', usesReader: false });
    expect(await rows('gateway', 'west')).toEqual([]);
  });

  it('没有心跳记录的集群上残留的 gateway 条件被清除', async () => {
    await tx(db.server, (c) =>
      replaceSpokeConditions(c, 'gateway', 'gone', 'gw-old', [
        { type: 'ClockSkew', status: 'False', reason: 'too_large', since },
      ]),
    );
    await expireSpokeConditions(db.server, 60_000, { clusterId: 'hub', usesReader: false });
    expect(await rows('gateway', 'gone')).toEqual([]);
  });
});
