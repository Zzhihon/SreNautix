import type { TopologyEdge, TopologyNode } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kubernetesRollouts } from '../../src/changes/kubernetes.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { topologyTrack } from '../../src/topology/migrations.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 从状态库的拓扑事件推导发布（ADR 0104）：版本标签变化与新的 ReplicaSet，按时间、版本与管理应用合成一次发布

let db: TestDb;
let store: TopologyStore;
const C = 'east';
const T0 = Date.parse('2026-10-20T15:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);

const node = (kind: string, name: string, labels: Record<string, string> = {}): TopologyNode => ({
  key: `${kind}:shop/${name}`,
  kind,
  namespace: 'shop',
  name,
  uid: `uid-${kind}-${name}`,
  labels,
  component_type: null,
  hub: false,
});
const edge = (from: string, to: string, relation: TopologyEdge['relation']): TopologyEdge =>
  ({ from, to, relation, confidence: 1, provenance: 'structural' }) as TopologyEdge;
const APP = 'Application.argoproj.io:argocd/shop';

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, topologyTrack]);
  store = new TopologyStore(db.server);
  const up = (min: number, n: TopologyNode) => ({
    op: 'node_upsert' as const,
    at: at(min),
    source: 'informer' as const,
    node: n,
  });
  const ue = (min: number, e: TopologyEdge) => ({
    op: 'edge_upsert' as const,
    at: at(min),
    source: 'informer' as const,
    edge: e,
  });
  await store.apply(C, [
    up(0, node('Deployment', 'api', { 'release-id': 'r1' })),
    up(0, node('StatefulSet', 'db', { 'release-id': 'r1' })),
    up(0, node('Deployment', 'web', { 'release-id': 'r1' })),
    up(0, node('ReplicaSet', 'api-aaa', { 'pod-template-hash': 'aaa' })),
    ue(0, edge('ReplicaSet:shop/api-aaa', 'Deployment:shop/api', 'owned_by')),
    ue(0, edge('Deployment:shop/api', APP, 'managed_by')),
    ue(0, edge('StatefulSet:shop/db', APP, 'managed_by')),
  ]);
  // 10 分钟：api 与 db 一起发布 r2（api 有新的 ReplicaSet）；web 只改了一个无关标签
  await store.apply(C, [
    up(10, node('Deployment', 'api', { 'release-id': 'r2' })),
    up(10, node('ReplicaSet', 'api-bbb', { 'pod-template-hash': 'bbb' })),
    ue(10, edge('ReplicaSet:shop/api-bbb', 'Deployment:shop/api', 'owned_by')),
    up(11, node('StatefulSet', 'db', { 'release-id': 'r2' })),
    up(11, node('Deployment', 'web', { 'release-id': 'r1', team: 'b' })),
  ]);
  // 40 分钟：回滚到 r1，没有新的 ReplicaSet
  await store.apply(C, [up(40, node('Deployment', 'api', { 'release-id': 'r1' }))]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('从拓扑事件推导 Kubernetes 发布', () => {
  it('同一版本、同一管理应用在 2 分钟内的变化合成一次发布；无关标签不算；回滚也是一次发布', async () => {
    const r = await kubernetesRollouts(db.server, at(5), at(60), {
      clusterId: C,
      revisionLabels: ['release-id'],
      groupWithinMs: 2 * 60_000,
    });
    expect(r.map((c) => [c.time, c.kind, c.source, c.targets, c.revision])).toEqual([
      [at(10).toISOString(), 'rollout', 'kubernetes', ['Deployment:shop/api', 'StatefulSet:shop/db', APP], 'r2'],
      [at(40).toISOString(), 'rollout', 'kubernetes', ['Deployment:shop/api', APP], 'r1'],
    ]);
    expect(r[0]!.summary).toContain('release-id r1 → r2');
    expect(r[0]!.summary).toContain('新的 ReplicaSet api-bbb');
    expect(r[1]!.summary).toContain('release-id r2 → r1');
    expect(r[0]!.change_id).toMatch(/^kubernetes:east:\d+$/);
    // 再算一次结果相同（change_id 稳定）
    const again = await kubernetesRollouts(db.server, at(5), at(60), {
      clusterId: C,
      revisionLabels: ['release-id'],
      groupWithinMs: 2 * 60_000,
    });
    expect(again.map((c) => c.change_id)).toEqual(r.map((c) => c.change_id));
  });

  it('发布之前的 Job：Pod 镜像与新 ReplicaSet 的相同时挂上；managed_by 指向别的应用时不挂（ADR 0104 §13）', async () => {
    const K = 'east-jobs';
    const up = (min: number, n: TopologyNode) => ({
      op: 'node_upsert' as const,
      at: at(min),
      source: 'informer' as const,
      node: n,
    });
    const ue = (min: number, e: TopologyEdge) => ({
      op: 'edge_upsert' as const,
      at: at(min),
      source: 'informer' as const,
      edge: e,
    });
    const pod = (name: string, images: string[]): TopologyNode => ({ ...node('Pod', name), images });
    await store.apply(K, [
      up(0, node('Deployment', 'api')),
      ue(0, edge('Deployment:shop/api', APP, 'managed_by')),
      // 12 分钟：迁移 Job（没有 managed_by，镜像与新版本相同）与另一个应用管理的 Job（镜像也相同）
      up(12, node('Job', 'migrate')),
      up(12, pod('migrate-x1', ['ghcr.io/acme/api:sha-2', 'sha256:222'])),
      ue(12, edge('Pod:shop/migrate-x1', 'Job:shop/migrate', 'owned_by')),
      up(13, node('Job', 'billing-sync')),
      ue(13, edge('Job:shop/billing-sync', 'Application.argoproj.io:argocd/billing', 'managed_by')),
      up(13, pod('billing-sync-y1', ['sha256:222'])),
      ue(13, edge('Pod:shop/billing-sync-y1', 'Job:shop/billing-sync', 'owned_by')),
      // 20 分钟：api 的新 ReplicaSet
      up(20, node('ReplicaSet', 'api-ccc', { 'pod-template-hash': 'ccc' })),
      ue(20, edge('ReplicaSet:shop/api-ccc', 'Deployment:shop/api', 'owned_by')),
      up(20, pod('api-ccc-z1', ['ghcr.io/acme/api:sha-2', 'sha256:222'])),
      ue(20, edge('Pod:shop/api-ccc-z1', 'ReplicaSet:shop/api-ccc', 'owned_by')),
    ]);
    const r = await kubernetesRollouts(db.server, at(5), at(30), {
      clusterId: K,
      revisionLabels: ['release-id'],
      groupWithinMs: 2 * 60_000,
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.time).toBe(at(12).toISOString());
    expect(r[0]!.attachments).toEqual([{ target: 'Job:shop/migrate', basis: 'image' }]);
    expect(r[0]!.targets).toEqual(['Deployment:shop/api', 'Job:shop/migrate', APP]);
  });

  it('窗口外的变化与第一次出现的工作负载不算发布', async () => {
    expect(
      await kubernetesRollouts(db.server, at(-10), at(5), {
        clusterId: C,
        revisionLabels: ['release-id'],
        groupWithinMs: 2 * 60_000,
      }),
    ).toEqual([]);
  });
});
