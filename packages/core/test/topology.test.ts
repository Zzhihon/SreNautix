import { describe, expect, it } from 'vitest';
import { assertValid, type TopologyEdge } from '@srenautix/contract';
import { buildKubeTopology, matchTypeByName, OWNED_BY, TopologyStore } from '../src/index.js';
import { CLUSTER, clusterObjects, clusterStore, COMPONENT_TYPES, CONVENTIONS, MIN, T0 } from './fixtures.js';

const snapshot = () =>
  buildKubeTopology(clusterObjects(), { componentTypes: COMPONENT_TYPES, conventions: CONVENTIONS });
const fmt = (e: TopologyEdge) => `${e.from} -${e.relation}-> ${e.to} [${e.provenance} ${e.confidence} ${e.scope}]`;

describe('kubectl 导出 → 拓扑（黄金）', () => {
  it('边集合与黄金文件一致', async () => {
    const lines = snapshot().edges.map(fmt).join('\n') + '\n';
    await expect(lines).toMatchFileSnapshot('./testdata/topology.golden.txt');
  });

  it('关键边：结构、配置引用、NetworkPolicy、Operator 约定、存储', () => {
    const edges = new Set(snapshot().edges.map(fmt));
    for (const e of [
      'Pod:shop/api-7c9d8f6b4-k2x9q -owned_by-> ReplicaSet:shop/api-7c9d8f6b4 [structural 1 service]',
      'ReplicaSet:shop/api-7c9d8f6b4 -owned_by-> Deployment:shop/api [structural 1 service]',
      'Pod:shop/api-7c9d8f6b4-k2x9q -references-> Service:shop/pg-rw [config_ref 0.7 service]',
      'Pod:shop/api-7c9d8f6b4-k2x9q -references-> Secret:shop/pg-app [config_ref 0.7 service]',
      'Secret:shop/pg-app -operator_convention-> Cluster:shop/pg [structural 1 service]',
      'Service:shop/pg-rw -selects-> Pod:shop/pg-1 [structural 1 service]',
      'Service:shop/pg-ro -selects-> Pod:shop/pg-2 [structural 1 service]',
      'Service:shop/pg-rw -owned_by-> Cluster:shop/pg [structural 1 service]',
      'Pod:shop/worker-6b5f4d8c9-q1w2e -references-> Service:shop/pg-rw [config_ref 0.7 service]',
      'Pod:shop/worker-6b5f4d8c9-q1w2e -egress_to-> Pod:shop/pg-1 [network_policy 0.6 service]',
      'Pod:shop/worker-6b5f4d8c9-q1w2e -egress_to-> Pod:shop/pg-2 [network_policy 0.6 service]',
      'Pod:web/frontend-9a8b7c6d5-p4n8z -references-> Service:shop/api [config_ref 0.7 service]',
      'Ingress:web/frontend -routes_to-> Service:web/frontend [structural 1 service]',
      'Pod:shop/pg-1 -runs_on-> Node:node-3 [structural 1 instance]',
      'Pod:shop/pg-1 -mounts-> PersistentVolumeClaim:shop/pg-1 [structural 1 instance]',
      'PersistentVolumeClaim:shop/pg-1 -bound_to-> PersistentVolume:pvc-7b2d0001 [structural 1 instance]',
      'PersistentVolume:pvc-7b2d0001 -provisioned_by-> CSIDriver:rbd.csi.ceph.com [structural 1 instance]',
      'Pod:shop/pg-1 -node_local_daemon-> Pod:kube-system/cilium-x7w4d [structural 1 instance]',
    ]) {
      expect(edges, e).toContain(e);
    }
    // 引用自己所属的服务、ConfigMap 中没有对应 Service 的地址、Pod 到别的节点上的 Cilium，都不是边
    const all = [...edges].join('\n');
    expect(all).not.toContain('Pod:shop/api-7c9d8f6b4-k2x9q -references-> Service:shop/api ');
    expect(all).not.toMatch(/references-> Service:shop\/cache/);
    expect(all).not.toContain('Pod:shop/pg-1 -node_local_daemon-> Pod:kube-system/cilium-4hq8m');
    // Cilium Pod 自己不连到别的 Cilium Pod
    expect(all).not.toMatch(/Pod:kube-system\/cilium-[a-z0-9]+ -node_local_daemon->/);
  });

  it('节点：组件类型、枢纽、Secret 只有名称', () => {
    const nodes = new Map(snapshot().nodes.map((n) => [n.key, n]));
    expect(nodes.get('Cluster:shop/pg')?.component_type).toBe('postgres.cluster');
    expect(nodes.get('Deployment:kube-system/coredns')?.hub).toBe(true);
    expect(nodes.get('DaemonSet:kube-system/cilium')?.hub).toBe(true);
    expect(nodes.get('CSIDriver:rbd.csi.ceph.com')?.hub).toBe(true);
    expect(nodes.get('Secret:shop/pg-app')).toMatchObject({ uid: null, labels: {} });
    expect([...nodes.keys()].some((k) => k.startsWith('ConfigMap:'))).toBe(false);
    for (const n of nodes.values()) {
      assertValid('schemas/topology-event.schema.json#/$defs/Node', n);
    }
  });
});

describe('拓扑图：组件、可达、深度', () => {
  const graph = clusterStore().asOf(T0);

  it('沿 owned_by 向上得到组件', () => {
    expect(graph.componentOf('Pod:shop/api-7c9d8f6b4-k2x9q')).toBe('Deployment:shop/api');
    expect(graph.componentOf('Pod:shop/pg-1')).toBe('Cluster:shop/pg');
    expect(graph.componentOf('Service:shop/pg-rw')).toBe('Cluster:shop/pg');
    expect(graph.componentOf('PersistentVolumeClaim:shop/pg-1')).toBe('Cluster:shop/pg');
    expect(graph.componentOf('Node:node-1')).toBe('Node:node-1');
  });

  it('可达置信度是路径上各边之积，取最大的路径', () => {
    const r = graph.reach('Deployment:web/frontend', { minConfidence: 0.6 });
    expect(r.objects.get('Pod:shop/api-7c9d8f6b4-k2x9q')).toBeCloseTo(0.7);
    expect(r.objects.get('Pod:shop/pg-1')).toBeCloseTo(0.49);
    expect(r.components.get('Cluster:shop/pg')).toBeCloseTo(0.49);
    // 作用范围：frontend 只跑在 node-3 上，经 api 的 Pod 才到 node-1、node-2
    expect(r.objects.get('Node:node-3')).toBe(1);
    expect(r.objects.get('Node:node-1')).toBeCloseTo(0.7);
  });

  it('worker 经 ConfigMap 与 NetworkPolicy 两条路径到 pg，取较大的 0.7', () => {
    const r = graph.reach('Deployment:shop/worker', { minConfidence: 0.6 });
    expect(r.objects.get('Pod:shop/pg-1')).toBeCloseTo(0.7);
    expect(r.objects.get('Pod:shop/pg-2')).toBeCloseTo(0.6);
  });

  it('枢纽可以被到达，但不作为中间节点继续展开', () => {
    const r = graph.reach('Pod:shop/search-0', { minConfidence: 0 });
    expect(r.objects.get('Pod:kube-system/cilium-4hq8m')).toBe(1);
    expect(r.objects.get('CSIDriver:rbd.csi.ceph.com')).toBe(1);
    // Cilium Pod 跑在 node-1 上，但不能经它把 search 连到别的对象
    expect(r.components.has('DaemonSet:kube-system/cilium')).toBe(true);
  });

  it('深度：依赖链越靠下越深，节点与存储在最底部', () => {
    const d = (k: string) => graph.depth(k);
    expect(d('Ingress:web/frontend')).toBe(0);
    expect(d('Deployment:web/frontend')).toBeGreaterThan(d('Service:web/frontend'));
    expect(d('Deployment:shop/api')).toBeGreaterThan(d('Deployment:web/frontend'));
    expect(d('Cluster:shop/pg')).toBeGreaterThan(d('Deployment:shop/api'));
    expect(d('Node:node-3')).toBeGreaterThan(d('Cluster:shop/pg'));
    expect(d('Unknown:x')).toBe(-1);
  });

  it('子图：根因加不超过 2 跳的邻居', () => {
    const sg = graph.subgraph('Cluster:shop/pg', 1);
    expect([...sg.nodes.keys()].sort()).toEqual(
      expect.arrayContaining([
        'Cluster:shop/pg',
        'Deployment:shop/api',
        'Deployment:shop/worker',
        'Node:node-3',
        'Secret:shop/pg-app',
      ]),
    );
    expect(sg.nodes.has('Deployment:web/frontend')).toBe(false);
    expect(graph.subgraph('Cluster:shop/pg', 2).nodes.get('Deployment:web/frontend')).toBe(2);
  });
});

describe('事件溯源与按时刻查询', () => {
  it('删除与重建：按时刻得到当时的拓扑，事件 seq 连续', () => {
    const store = clusterStore();
    const v1 = store.version;
    const objects = clusterObjects().filter((o) => o.metadata.name !== 'api-7c9d8f6b4-m7v3t');
    const moved = clusterObjects().find((o) => o.metadata.name === 'search-0')!;
    (moved.spec as { nodeName: string }).nodeName = 'node-2';
    const next = buildKubeTopology(
      objects.map((o) => (o.metadata.name === 'search-0' && o.kind === 'Pod' ? moved : o)),
      { componentTypes: COMPONENT_TYPES, conventions: CONVENTIONS },
    );
    const events = store.reconcile(next, T0 + 10 * MIN, 'informer');
    expect(events.map((e) => e.op).sort()).toEqual(
      expect.arrayContaining(['node_delete', 'edge_delete', 'edge_upsert']),
    );
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => v1 + i + 1));
    for (const e of events) {
      assertValid('schemas/topology-event.schema.json', e);
      expect(e.cluster_id).toBe(CLUSTER);
    }
    const before = store.asOf(T0);
    const after = store.asOf(T0 + 11 * MIN);
    expect(before.has('Pod:shop/api-7c9d8f6b4-m7v3t')).toBe(true);
    expect(after.has('Pod:shop/api-7c9d8f6b4-m7v3t')).toBe(false);
    expect(before.dependencies('Pod:shop/search-0').find((e) => e.relation === 'runs_on')?.to).toBe('Node:node-1');
    expect(after.dependencies('Pod:shop/search-0').find((e) => e.relation === 'runs_on')?.to).toBe('Node:node-2');
    expect(after.version).toBeGreaterThan(before.version);
    // 拓扑写入之前没有任何对象
    expect(store.asOf(T0 - 61 * MIN).has('Node:node-1')).toBe(false);
    // 墓碑：删除后仍能拿到删除前的节点
    expect(store.lastSeen('Pod:shop/api-7c9d8f6b4-m7v3t')?.to).toBe(T0 + 10 * MIN);
  });

  it('同一份快照再次对账不产生事件；从事件日志重放得到同样的拓扑', () => {
    const store = clusterStore();
    expect(store.reconcile(snapshot(), T0, 'informer')).toEqual([]);
    const replay = new TopologyStore({ clusterId: CLUSTER });
    replay.load(store.log());
    const a = store.asOf(T0);
    const b = replay.asOf(T0);
    expect([...b.allNodes()].length).toBe([...a.allNodes()].length);
    expect(b.edges.length).toBe(a.edges.length);
    expect(b.edges.filter((e) => e.relation === OWNED_BY).length).toBeGreaterThan(10);
  });
});

describe('集群级属主与组件类型的优先级', () => {
  const pod = (name: string, owner: { kind: string; name: string }) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: 'kube-system',
      uid: `uid-${name}`,
      labels: { component: 'kube-apiserver' },
      ownerReferences: [{ apiVersion: 'v1', kind: owner.kind, name: owner.name, controller: true }],
    },
    spec: { nodeName: owner.name },
  });

  it('静态 Pod 的属主是 Node：属主的键不带 Pod 的命名空间，不产生虚构的 Node:kube-system/…', () => {
    const snap = buildKubeTopology([
      { apiVersion: 'v1', kind: 'Node', metadata: { name: 'control-plane-01', uid: 'uid-n1' } },
      pod('kube-apiserver-control-plane-01', { kind: 'Node', name: 'control-plane-01' }),
      pod('kube-apiserver-control-plane-02', { kind: 'Node', name: 'control-plane-02' }),
    ]);
    const keys = snap.nodes.map((n) => n.key);
    expect(keys.filter((k) => k.startsWith('Node:'))).toEqual(['Node:control-plane-01', 'Node:control-plane-02']);
    expect(snap.nodes.find((n) => n.key === 'Node:control-plane-02')).toMatchObject({ namespace: null });
    expect(snap.edges).toContainEqual(
      expect.objectContaining({
        from: 'Pod:kube-system/kube-apiserver-control-plane-01',
        to: 'Node:control-plane-01',
        relation: OWNED_BY,
      }),
    );
  });

  it('只按 kind 匹配的组件类型是兜底，更具体的类型优先，与声明顺序无关', () => {
    const snap = buildKubeTopology(
      [
        pod('kube-apiserver-a', { kind: 'Node', name: 'a' }),
        { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web-1', namespace: 'app', uid: 'u2' } },
      ],
      {
        componentTypes: [
          { id: 'kubernetes.pod', match: { kind: 'Pod' }, chains: [] },
          {
            id: 'kubernetes.apiserver',
            match: { kind: 'Pod', namespaces: ['kube-system'], labels: { component: 'kube-apiserver' } },
            chains: [],
          },
        ],
      },
    );
    expect(snap.nodes.find((n) => n.key === 'Pod:kube-system/kube-apiserver-a')?.component_type).toBe(
      'kubernetes.apiserver',
    );
    expect(snap.nodes.find((n) => n.key === 'Pod:app/web-1')?.component_type).toBe('kubernetes.pod');
  });

  it('没有拓扑节点的实体按 kind、命名空间与名称静态匹配：跳过带标签约束的类型，api_group 视为满足', () => {
    const types = [
      { id: 'kubernetes.pod', match: { kind: 'Pod' }, chains: [] },
      { id: 'web', match: { kind: 'Pod', name_pattern: '^x$' }, chains: [] },
      {
        id: 'labelled',
        match: { kind: 'Pod', labels: { a: 'b' }, name_pattern: '^x$', namespaces: ['app'] },
        chains: [],
      },
      { id: 'argocd.application', match: { kind: 'Application', api_group: 'argoproj.io' }, chains: [] },
      { id: 'dragonfly', match: { kind: 'cluster', name_pattern: '^dragonfly$' }, chains: [] },
    ];
    expect(matchTypeByName('Pod', 'app', 'x', types)?.id).toBe('web');
    expect(matchTypeByName('Pod', 'app', 'y', types)?.id).toBe('kubernetes.pod');
    expect(matchTypeByName('Application', 'argocd', 'cchp', types)?.id).toBe('argocd.application');
    expect(matchTypeByName('cluster', 'cchp-data', 'dragonfly', types)?.id).toBe('dragonfly');
    expect(matchTypeByName('cluster', null, 'seaweedfs', types)).toBeUndefined();
  });
});
