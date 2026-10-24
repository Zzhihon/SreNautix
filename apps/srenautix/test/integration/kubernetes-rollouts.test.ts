import type { Alert, ChangeEvent, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '@srenautix/core';
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

  it('没有 managed_by 边的 Job：Argo instance 标签匹配到 Application；配置的版本标签与发布的相同时挂上', async () => {
    const K = 'east-argo';
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
    const app: TopologyNode = {
      key: APP,
      kind: 'Application.argoproj.io',
      namespace: 'argocd',
      name: 'shop',
      uid: 'uid-app',
      labels: {},
      component_type: null,
      hub: false,
    };
    await store.apply(K, [
      up(0, app),
      up(0, node('Deployment', 'api', { 'release-id': 'r1' })),
      ue(0, edge('Deployment:shop/api', APP, 'managed_by')),
      up(10, node('Job', 'presync', { 'app.kubernetes.io/instance': 'shop' })),
      up(12, node('Job', 'migrate-r2', { 'release-id': 'r2' })),
      up(13, node('Job', 'migrate-r0', { 'release-id': 'r0' })),
      up(20, node('Deployment', 'api', { 'release-id': 'r2' })),
    ]);
    const r = await kubernetesRollouts(db.server, at(5), at(30), {
      clusterId: K,
      revisionLabels: ['release-id'],
      groupWithinMs: 2 * 60_000,
      preStepLabels: ['release-id'],
    });
    expect(r).toHaveLength(1);
    expect(r[0]!.time).toBe(at(10).toISOString());
    expect(r[0]!.attachments).toEqual([
      { target: 'Job:shop/presync', basis: 'managed_by' },
      { target: 'Job:shop/migrate-r2', basis: 'revision_label' },
    ]);
  });

  it('CCHP gateway OOM 循环（ADR 0142）：17:42 的 release-id 往返不是发布；根因是 StatefulSet gateway，没有歧义', async () => {
    const K = 'cchp-gw';
    const ts = (hhmmss: string) => new Date(`2026-10-23T${hhmmss}Z`);
    const R1 = 'canary-3cc28887b49f';
    const ARGO = 'Application.argoproj.io:argocd/cchp-prod';
    const STS = 'StatefulSet:cchp-prod/gateway';
    const n = (kind: string, ns: string, name: string, labels: Record<string, string> = {}): TopologyNode => ({
      key: `${kind}:${ns}/${name}`,
      kind,
      namespace: ns,
      name,
      uid: `uid-${kind}-${name}`,
      labels,
      component_type: null,
      hub: false,
    });
    const up = (t: string, x: TopologyNode) => ({
      op: 'node_upsert' as const,
      at: ts(t),
      source: 'informer' as const,
      node: x,
    });
    const ue = (t: string, x: TopologyEdge) => ({
      op: 'edge_upsert' as const,
      at: ts(t),
      source: 'informer' as const,
      edge: x,
    });
    const gw = (labels: Record<string, string>) =>
      n('StatefulSet', 'cchp-prod', 'gateway', { app: 'gateway', ...labels });
    await store.apply(K, [
      up('12:00:00', n('Application.argoproj.io', 'argocd', 'cchp-prod')),
      up('12:00:00', gw({ 'cchp.io/release-id': R1 })),
      ue('12:00:00', edge(STS, ARGO, 'managed_by')),
      ...[0, 1, 2, 3].flatMap((i) => [
        up('12:00:00', n('Pod', 'cchp-prod', `gateway-${i}`)),
        ue('12:00:00', edge(`Pod:cchp-prod/gateway-${i}`, STS, 'owned_by')),
      ]),
    ]);
    // 17:42:00 标签被去掉，17:42:07 加回原值
    await store.apply(K, [up('17:42:00', gw({}))]);
    await store.apply(K, [up('17:42:07', gw({ 'cchp.io/release-id': R1 }))]);
    const opts = { clusterId: K, revisionLabels: ['cchp.io/release-id'], groupWithinMs: 2 * 60_000 };
    const changes = await kubernetesRollouts(db.server, ts('15:00:00'), ts('18:10:00'), opts);
    expect(changes).toEqual([]);

    // 15:48:30 起 gateway-3 OOM 重启，告警一直在触发；重启中不断有新的告警触发，包括 17:42 之后的
    let seqNo = 0;
    const alert = (alertname: string, start: string, entity: TopologyNode, end?: string): Alert => {
      const id = (++seqNo).toString(16).padStart(16, '0');
      return {
        alert_id: `${id}@${ts(start).getTime() / 1000}`,
        cluster_id: K,
        source: 'alertmanager',
        fingerprint: id,
        alertname,
        labels: { alertname, namespace: 'cchp-prod' },
        annotations: {},
        severity: 'critical',
        status: end ? 'resolved' : 'firing',
        suppressed: 'none',
        starts_at: ts(start).toISOString(),
        ends_at: end ? ts(end).toISOString() : null,
        generator_url: null,
        classification: { role: 'cause', source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
        entity: { cluster_id: K, kind: entity.kind, namespace: entity.namespace, name: entity.name, uid: entity.uid },
        entity_resolution: 'informer',
        component: null,
        received_at: ts(start).toISOString(),
      };
    };
    const pod = (i: number) => n('Pod', 'cchp-prod', `gateway-${i}`);
    const alerts = [
      alert('GatewayContainerOOMKilled', '15:48:30', pod(3)),
      alert('KubePodCrashLooping', '15:58:00', pod(3)),
      alert('GatewayContainerOOMKilled', '16:40:00', pod(1), '16:52:00'),
      alert('GatewayContainerOOMKilled', '17:48:00', pod(1)),
      alert('KubeStatefulSetReplicasMismatch', '17:55:00', gw({})),
    ];
    const topo = await store.at(K, ts('18:10:00'));
    const graph = new TopologyGraph(topo.nodes, topo.edges, topo.version);
    // 旧代码推导出的那次变更（revision 与 previous_revision 相同）也不能让管理应用与 gateway 打平
    const legacy: ChangeEvent = {
      change_id: `kubernetes:${K}:153695`,
      source: 'kubernetes',
      kind: 'rollout',
      refs: [ARGO],
      revision: R1,
      previous_revision: R1,
      actor: null,
      time: '2026-10-23T17:42:07.000Z',
      link: null,
      targets: [STS, ARGO],
      summary: 'gateway：cchp.io/release-id 往返',
    };
    for (const input of [changes, [legacy]]) {
      const inc = computeIncidents({
        alerts,
        changes: input,
        graph,
        params: DEFAULT_RCA_PARAMS,
        now: ts('18:10:00').getTime(),
      });
      expect(inc).toHaveLength(1);
      expect(inc[0]!.ranking.root).toMatchObject({ component: STS, ambiguous: false });
      expect(inc[0]!.ranking.candidates.map((c) => c.component)).toEqual([STS]);
      expect(inc[0]!.ranking.candidates[0]!.terms.recent_change).toBe(0);
    }
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
