import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EntityResolver,
  KSM_TOPOLOGY_QUERIES,
  ksmTopologyIntervals,
  loadKsmHistory,
  TopologyStore,
  type KsmTopologyResults,
} from '../src/index.js';
import { CLUSTER, MIN, T0 } from './fixtures.js';
import { TestPrometheus, type Sample } from './prometheus.js';

const STEP = 30_000;
const FROM = T0 - 120 * MIN;
const s = (metric: string, labels: Record<string, string>, from = FROM, to = T0): Sample => ({
  metric,
  labels,
  from,
  to,
  stepMs: STEP,
});

// search-0 在 T0-60m 从 node-1 重建到 node-2；old-pod 在 T0-90m 被删除
const SAMPLES: Sample[] = [
  s('kube_node_info', { node: 'node-1' }),
  s('kube_node_info', { node: 'node-2' }),
  s('kube_pod_info', { namespace: 'shop', pod: 'search-0', node: 'node-1', uid: 'uid-search-a' }, FROM, T0 - 60 * MIN),
  s('kube_pod_info', { namespace: 'shop', pod: 'search-0', node: 'node-2', uid: 'uid-search-b' }, T0 - 60 * MIN, T0),
  s('kube_pod_owner', {
    namespace: 'shop',
    pod: 'search-0',
    owner_kind: 'StatefulSet',
    owner_name: 'search',
    owner_is_controller: 'true',
  }),
  s('kube_pod_spec_volumes_persistentvolumeclaims_info', {
    namespace: 'shop',
    pod: 'search-0',
    volume: 'data',
    persistentvolumeclaim: 'data-search-0',
  }),
  s('kube_pod_info', { namespace: 'shop', pod: 'api-7c9d8f6b4-k2x9q', node: 'node-1', uid: 'uid-api' }),
  s('kube_pod_owner', {
    namespace: 'shop',
    pod: 'api-7c9d8f6b4-k2x9q',
    owner_kind: 'ReplicaSet',
    owner_name: 'api-7c9d8f6b4',
    owner_is_controller: 'true',
  }),
  s('kube_replicaset_owner', {
    namespace: 'shop',
    replicaset: 'api-7c9d8f6b4',
    owner_kind: 'Deployment',
    owner_name: 'api',
  }),
  s('kube_pod_info', { namespace: 'shop', pod: 'api-old-x1', node: 'node-2', uid: 'uid-old' }, FROM, T0 - 90 * MIN),
  s(
    'kube_pod_owner',
    {
      namespace: 'shop',
      pod: 'api-old-x1',
      owner_kind: 'ReplicaSet',
      owner_name: 'api-7c9d8f6b4',
      owner_is_controller: 'true',
    },
    FROM,
    T0 - 90 * MIN,
  ),
];

describe('kube-state-metrics 历史（真实 Prometheus）', () => {
  let prom: TestPrometheus;
  beforeAll(async () => {
    prom = await TestPrometheus.start('core-ksm', SAMPLES);
  }, 60_000);
  afterAll(async () => {
    await prom.stop();
  });

  it('重建拓扑：按时刻查询得到当时的节点与 owner 链', async () => {
    const results = Object.fromEntries(
      await Promise.all(
        Object.entries(KSM_TOPOLOGY_QUERIES).map(
          async ([k, q]) => [k, await prom.queryRange(q, FROM, T0, STEP)] as const,
        ),
      ),
    ) as KsmTopologyResults;
    const store = new TopologyStore({ clusterId: CLUSTER });
    loadKsmHistory(store, ksmTopologyIntervals(results, STEP));
    expect(store.log().every((e) => e.source === 'ksm_history' && e.valid_to !== null)).toBe(true);

    const early = store.asOf(T0 - 100 * MIN);
    const late = store.asOf(T0 - 30 * MIN);
    const nodeOf = (g: typeof early, pod: string) => g.dependencies(pod).find((e) => e.relation === 'runs_on')?.to;
    expect(nodeOf(early, 'Pod:shop/search-0')).toBe('Node:node-1');
    expect(nodeOf(late, 'Pod:shop/search-0')).toBe('Node:node-2');
    expect(early.node('Pod:shop/search-0')?.uid).toBe('uid-search-a');
    expect(late.node('Pod:shop/search-0')?.uid).toBe('uid-search-b');
    expect(late.componentOf('Pod:shop/api-7c9d8f6b4-k2x9q')).toBe('Deployment:shop/api');
    expect(late.componentOf('Pod:shop/search-0')).toBe('StatefulSet:shop/search');
    expect(late.dependencies('Pod:shop/search-0').map((e) => e.to)).toContain(
      'PersistentVolumeClaim:shop/data-search-0',
    );
    expect(early.has('Pod:shop/api-old-x1')).toBe(true);
    expect(late.has('Pod:shop/api-old-x1')).toBe(false);
  });

  it('实体解析：informer 与墓碑里都没有时查 kube-state-metrics 历史', async () => {
    const resolver = new EntityResolver({
      store: new TopologyStore({ clusterId: CLUSTER }),
      ksmQuery: (expr, at) => prom.query(expr, at),
    });
    const r = await resolver.resolve(
      {
        entity: { cluster_id: CLUSTER, kind: 'Pod', namespace: 'shop', name: 'api-old-x1', uid: null },
        namespace: 'shop',
        fromLabels: false,
      },
      T0 - 95 * MIN,
      T0,
    );
    expect(r).toEqual({
      entity: { cluster_id: CLUSTER, kind: 'Pod', namespace: 'shop', name: 'api-old-x1', uid: 'uid-old' },
      layer: 'ksm_history',
      component: 'Deployment:shop/api',
    });
    const missing = await resolver.resolve(
      {
        entity: { cluster_id: CLUSTER, kind: 'Pod', namespace: 'shop', name: 'never-existed', uid: null },
        namespace: 'shop',
        fromLabels: false,
      },
      T0 - 95 * MIN,
      T0,
    );
    expect(missing).toEqual({ entity: null, layer: 'unresolved', component: 'Namespace:shop' });
  });
});
