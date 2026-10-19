import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referenceCases } from '../../src/api/research-materials.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';

/** 阶段 B 的参考案例：同集群已结束、经人工确认根因的历史事件（真实 PostgreSQL）。 */
let db: TestDb;
const NOW = new Date('2026-10-20T12:00:00Z');

async function incident(o: {
  cluster?: string;
  state?: 'firing' | 'resolved';
  endedAt?: string;
  root: string;
  label: string;
}): Promise<string> {
  const id = randomUUID();
  await db.server.query(
    `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, ended_at, root_component, body)
     VALUES ($1, $2, $3, 1, $4, 'warning', '2026-10-19T00:00:00Z', $5, $6, '{}')`,
    [id, o.cluster ?? 'east', o.label, o.state ?? 'resolved', o.endedAt ?? '2026-10-19T08:00:00Z', o.root],
  );
  await db.server.query(
    `INSERT INTO server.incident_versions (incident_id, version, body, reason) VALUES ($1, 1, $2, 'created')`,
    [id, JSON.stringify({ root: { component: o.root } })],
  );
  return id;
}

async function feedback(
  incidentId: string,
  f: { verdict: 'confirmed' | 'rejected'; root?: string | null; mechanism?: string; linked?: boolean; at: string },
): Promise<void> {
  await db.server.query(
    `INSERT INTO server.feedback (feedback_id, incident_id, incident_version, verdict, root_component, mechanism, principal_id, channel, linked, created_at)
     VALUES ($1, $2, 1, $3, $4, $5, 'oidc:alice', 'console', $6, $7)`,
    [randomUUID(), incidentId, f.verdict, f.root ?? null, f.mechanism ?? null, f.linked ?? true, f.at],
  );
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  // 确认：根因取反馈所评价版本的根因
  ids.confirmed = await incident({ root: 'StatefulSet:shop/pg', label: 'a', endedAt: '2026-10-19T09:00:00Z' });
  await feedback(ids.confirmed, { verdict: 'confirmed', mechanism: 'WAL 盘满', at: '2026-10-19T10:00:00Z' });
  // 否定并给出真实根因：根因取反馈给出的组件（同命名空间的 PVC）
  ids.corrected = await incident({ root: 'Deployment:shop/api', label: 'b', endedAt: '2026-10-19T07:00:00Z' });
  await feedback(ids.corrected, {
    verdict: 'rejected',
    root: 'PersistentVolumeClaim:shop/data-pg-0',
    at: '2026-10-19T08:00:00Z',
  });
  // 最新一条是否定且真实根因未知：不作为参考案例（较早的确认被覆盖）
  ids.unknown = await incident({ root: 'Deployment:shop/web', label: 'c' });
  await feedback(ids.unknown, { verdict: 'confirmed', at: '2026-10-19T09:00:00Z' });
  await feedback(ids.unknown, { verdict: 'rejected', root: null, at: '2026-10-19T09:30:00Z' });
  // 未绑定账号的反馈不算人工确认
  ids.unlinked = await incident({ root: 'Deployment:shop/cart', label: 'd' });
  await feedback(ids.unlinked, { verdict: 'confirmed', linked: false, at: '2026-10-19T09:00:00Z' });
  // 其他命名空间、其他集群、仍在触发、研判开始之后才结束的都不取
  ids.otherNs = await incident({ root: 'Deployment:pay/api', label: 'e' });
  await feedback(ids.otherNs, { verdict: 'confirmed', at: '2026-10-19T09:00:00Z' });
  ids.otherCluster = await incident({ cluster: 'west', root: 'StatefulSet:shop/pg', label: 'f' });
  await feedback(ids.otherCluster, { verdict: 'confirmed', at: '2026-10-19T09:00:00Z' });
  ids.firing = await incident({ root: 'StatefulSet:shop/pg', label: 'g', state: 'firing' });
  await feedback(ids.firing, { verdict: 'confirmed', at: '2026-10-19T09:00:00Z' });
  ids.later = await incident({ root: 'StatefulSet:shop/pg', label: 'h', endedAt: '2026-10-20T13:00:00Z' });
  await feedback(ids.later, { verdict: 'confirmed', at: '2026-10-20T13:10:00Z' });
});

afterAll(async () => {
  await db?.close();
});

describe('参考案例', () => {
  it('按人工确认的根因、同集群、子图组件或同命名空间、研判开始前结束选择，按结束时间从新到旧', async () => {
    const current = randomUUID();
    const cases = await referenceCases(db.server, {
      clusterId: 'east',
      incidentId: current,
      keys: new Set(['StatefulSet:shop/pg', 'Pod:shop/pg-0']),
      namespaces: new Set(['shop']),
      before: NOW,
    });
    expect(cases).toEqual([
      {
        incident_id: ids.confirmed,
        label: 'a',
        root_component: 'StatefulSet:shop/pg',
        mechanism: 'WAL 盘满',
        resolved_at: '2026-10-19T09:00:00.000Z',
        source: 'human',
      },
      {
        incident_id: ids.corrected,
        label: 'b',
        root_component: 'PersistentVolumeClaim:shop/data-pg-0',
        mechanism: null,
        resolved_at: '2026-10-19T07:00:00.000Z',
        source: 'human',
      },
    ]);
  });

  it('不包括当前事件自己', async () => {
    const cases = await referenceCases(db.server, {
      clusterId: 'east',
      incidentId: ids.confirmed as string,
      keys: new Set(['StatefulSet:shop/pg']),
      namespaces: new Set(['shop']),
      before: NOW,
    });
    expect(cases.map((c) => c.label)).toEqual(['b']);
  });
});
