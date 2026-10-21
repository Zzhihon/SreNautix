import { randomUUID } from 'node:crypto';
import type { TopologyEdge, TopologyNode } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { researchRoots } from '../../src/incident/research-root.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 研判根因与发现根因不一致的标记（ADR 0104 §14）：取事件最近一次完成的研判，按状态库里的 owned_by 取顶层属主比较

const C = 'east';
let db: TestDb;
let topology: TopologyStore;

const node = (key: string): TopologyNode => {
  const [kind, rest] = key.split(':') as [string, string];
  const [ns, name] = rest.split('/') as [string, string];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub: false };
};
const owned = (from: string, to: string): TopologyEdge =>
  ({
    from,
    to,
    relation: 'owned_by',
    provenance: 'structural',
    confidence: 1,
    scope: 'service',
    evidence: 't',
  }) as TopologyEdge;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  topology = new TopologyStore(db.server);
  const at = new Date(Date.now() - 3600_000);
  await topology.apply(C, [
    ...['Deployment:shop/api', 'ReplicaSet:shop/api-1', 'Pod:shop/api-1-a', 'Deployment:shop/checkout'].map((k) => ({
      op: 'node_upsert' as const,
      at,
      source: 'informer' as const,
      node: node(k),
    })),
    {
      op: 'edge_upsert' as const,
      at,
      source: 'informer' as const,
      edge: owned('ReplicaSet:shop/api-1', 'Deployment:shop/api'),
    },
    {
      op: 'edge_upsert' as const,
      at,
      source: 'informer' as const,
      edge: owned('Pod:shop/api-1-a', 'ReplicaSet:shop/api-1'),
    },
  ]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

async function run(incidentId: string, root: string | null, state = 'completed', minutesAgo = 5) {
  const runId = randomUUID();
  await db.server.query(
    `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, root_component, started_at, finished_at)
     VALUES ($1, $2, 1, 'new_incident', $3, $4, now() - make_interval(mins => $5), now() - make_interval(mins => $5))`,
    [runId, incidentId, state, root, minutesAgo],
  );
  return runId;
}

describe('研判根因与发现根因', () => {
  it('一致不标、不一致标、Pod 与它所属的 Deployment 不算不一致；只看最近一次完成的研判', async () => {
    const same = randomUUID();
    const differ = randomUUID();
    const pod = randomUUID();
    const none = randomUUID();
    await run(same, 'Deployment:shop/api');
    const differRun = await run(differ, 'Deployment:shop/checkout');
    // 更早的一次研判与事件根因一致，最近的不一致：按最近的算
    await run(differ, 'Deployment:shop/api', 'completed', 30);
    await run(pod, 'Pod:shop/api-1-a');
    // 失败的研判没有根因，不参与比较
    await run(none, null, 'failed');
    const roots = await researchRoots(
      db.server,
      (c, k, at) => topology.ownerOf(c, k, at),
      [same, differ, pod, none].map((id) => ({
        incident_id: id,
        cluster_id: C,
        root_component: 'Deployment:shop/api',
      })),
    );
    expect(roots.get(same)).toMatchObject({ component: 'Deployment:shop/api', mismatch: false });
    expect(roots.get(differ)).toEqual({ run_id: differRun, component: 'Deployment:shop/checkout', mismatch: true });
    expect(roots.get(pod)).toMatchObject({ component: 'Pod:shop/api-1-a', mismatch: false });
    expect(roots.has(none)).toBe(false);
  });
});
