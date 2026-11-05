import type { LabelProfile, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { assertValid } from '@srenautix/contract';
import {
  LokiAdapter,
  PrometheusApiAdapter,
  startLoki,
  startPrometheus,
  type FixtureLogStream,
  type FixtureMetricSeries,
  type RunningProcess,
  type TsdbInstance,
} from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kubeEventsSource } from '../../src/export/kube-events.js';
import {
  collectKubeWarnings,
  DEFAULT_GROUPING,
  type KubeWarningIncident,
  type KubeWarningsDeps,
} from '../../src/export/kube-warnings.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { topologyTrack } from '../../src/topology/migrations.js';
import { TopologyStore, type TopologyChange } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 导出用的 Warning 摘要与疑似同一根因分组（ADR 0185），对真实的 Loki（Alloy loki.source.kubernetes_events 的 json 日志行）、
// Prometheus（kube-state-metrics 序列）与 PostgreSQL（拓扑历史）执行：两个节点内存不足驱逐 api 与 control 的 Pod，
// 之后 HPA 到顶、调度失败、5xx 与错误预算燃烧归为一组；node-c 上 worker 的 OOMKilled 与重启退避不进组。

const T0 = Date.parse('2026-11-03T08:00:00Z');
const min = (m: number) => T0 + m * 60_000;
const at = (m: number) => new Date(min(m));
const iso = (m: number) => at(m).toISOString();
const NOW = min(120);
const CLUSTER = 'c1';

const API = 'Deployment:shop/api';
const CONTROL = 'StatefulSet:shop/control';
const WORKER = 'Deployment:jobs/worker';

const ids = {
  controlHpa: '00000000-0000-4000-8000-000000000001',
  apiHpa: '00000000-0000-4000-8000-000000000002',
  schedule: '00000000-0000-4000-8000-000000000003',
  api5xx: '00000000-0000-4000-8000-000000000004',
  budget: '00000000-0000-4000-8000-000000000005',
  worker: '00000000-0000-4000-8000-000000000006',
};

const incident = (id: string, from: number, to: number | null, component: string, alertname: string) => ({
  incident_id: id,
  window: { from: iso(from), to: to === null ? null : iso(to) },
  components: [component],
  alertnames: [alertname],
});

const incidents: KubeWarningIncident[] = [
  incident(ids.controlHpa, 14, 70, CONTROL, 'KubeHpaMaxedOut'),
  // 仍在触发
  incident(ids.apiHpa, 13, null, API, 'ApiHpaMaxedOut'),
  incident(ids.schedule, 25, 45, CONTROL, 'KubePodCreateOrScheduleFailing'),
  incident(ids.api5xx, 11, 40, API, 'ApiHigh5xxRate'),
  incident(ids.budget, 30, 90, API, 'ApiErrorBudgetBurnFast'),
  incident(ids.worker, 10, 50, WORKER, 'WorkerQueueBacklog'),
];

/** Alloy loki.source.kubernetes_events（log_format = json）在第 m 分钟写出的一行 */
function alloy(
  m: number,
  kind: string,
  name: string,
  reason: string,
  host: string | null,
  msg: string,
  type = 'Warning',
) {
  const line = JSON.stringify({
    name,
    kind,
    objectAPIversion: 'v1',
    reason,
    type,
    sourcecomponent: host ? 'kubelet' : 'default-scheduler',
    ...(host ? { sourcehost: host } : {}),
    msg,
  });
  return { t: min(m), line };
}

const EVICTED = 'The node was low on resource: memory. Threshold quantity: 100Mi, available: 80Mi.';
const RECLAIM = 'Attempting to reclaim memory';
const UNSCHEDULABLE =
  '0/3 nodes are available: 2 Insufficient memory, 1 node(s) had volume node affinity conflict. ' +
  'preemption: 0/3 nodes are available.';

function logStreams(): FixtureLogStream[] {
  const job = 'loki.source.kubernetes_events';
  return [
    {
      labels: { job, type: 'Warning' },
      lines: [
        alloy(9.5, 'Node', 'node-a', 'EvictionThresholdMet', 'node-a', RECLAIM),
        alloy(18.5, 'Node', 'node-b', 'EvictionThresholdMet', 'node-b', RECLAIM),
      ],
    },
    {
      labels: { job, type: 'Normal' },
      lines: [alloy(9.6, 'Node', 'node-a', 'NodeHasInsufficientMemory', 'node-a', 'status is now', 'Normal')],
    },
    {
      labels: { job, namespace: 'shop', type: 'Warning' },
      lines: [
        alloy(11.5, 'Pod', 'api-7d9f-a1', 'Evicted', 'node-a', EVICTED),
        alloy(11.6, 'Pod', 'control-0', 'Evicted', 'node-a', EVICTED),
        // 不计数的 reason
        alloy(12.5, 'Pod', 'api-7d9f-a3', 'Unhealthy', 'node-a', 'Readiness probe failed'),
        alloy(19.5, 'Pod', 'api-7d9f-b2', 'Evicted', 'node-b', EVICTED),
        alloy(21.5, 'Pod', 'control-1', 'Evicted', 'node-b', EVICTED),
        ...[25.5, 26.5, 29.5, 39.5].map((m) => alloy(m, 'Pod', 'control-2', 'FailedScheduling', null, UNSCHEDULABLE)),
      ],
    },
    {
      labels: { job, namespace: 'jobs', type: 'Warning' },
      lines: [15.5, 20.5, 30.5].map((m) => alloy(m, 'Pod', 'worker-5c-x1', 'BackOff', 'node-c', 'Back-off restarting')),
    },
  ];
}

/** kube-state-metrics：worker 的容器在第 20 分钟因 OOM 重启；node-a 在第 9–12 分钟处于 MemoryPressure；api 的一个 Pod 被驱逐 */
function metricSeries(): FixtureMetricSeries[] {
  const every = (from: number, to: number, v: (m: number) => number) =>
    Array.from({ length: (to - from) * 2 + 1 }, (_, i) => from + i / 2).map((m) => ({ t: min(m), v: v(m) }));
  const pod = (ns: string, name: string) => ({ namespace: ns, pod: name, cluster: CLUSTER });
  const worker = { ...pod('jobs', 'worker-5c-x1'), container: 'worker' };
  return [
    {
      labels: { __name__: 'kube_pod_container_status_restarts_total', ...worker },
      points: every(-10, 120, (m) => (m >= 20 ? 4 : 3)),
    },
    {
      labels: { __name__: 'kube_pod_container_status_last_terminated_reason', ...worker, reason: 'OOMKilled' },
      points: every(-10, 120, () => 1),
    },
    {
      labels: { __name__: 'kube_pod_info', ...pod('jobs', 'worker-5c-x1'), node: 'node-c' },
      points: every(-10, 120, () => 1),
    },
    {
      labels: { __name__: 'kube_pod_info', ...pod('shop', 'api-7d9f-a1'), node: 'node-a' },
      points: every(-10, 120, () => 1),
    },
    {
      labels: { __name__: 'kube_pod_status_reason', ...pod('shop', 'api-7d9f-a1'), reason: 'Evicted' },
      points: every(12, 120, () => 1),
    },
    {
      labels: {
        __name__: 'kube_node_status_condition',
        node: 'node-a',
        condition: 'MemoryPressure',
        status: 'true',
        cluster: CLUSTER,
      },
      points: every(-10, 120, (m) => (m >= 9 && m <= 12 ? 1 : 0)),
    },
  ];
}

const tnode = (kind: string, namespace: string | null, name: string): TopologyNode => ({
  key: namespace ? `${kind}:${namespace}/${name}` : `${kind}:${name}`,
  kind,
  namespace,
  name,
  uid: `uid-${name}`,
  labels: {},
  component_type: null,
  hub: false,
});
const tedge = (from: string, relation: string, to: string): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: 'structural',
  confidence: 1,
  scope: relation === 'runs_on' ? 'instance' : 'service',
  evidence: 'test',
});

type Change = Omit<TopologyChange, 'at' | 'source'>;

/** Pod 的创建（属主与 runs_on）；nodeName 为 null 时没有调度成功 */
const podUp = (ns: string, name: string, owner: string, nodeName: string | null): Change[] => [
  { op: 'node_upsert', node: tnode('Pod', ns, name) },
  { op: 'edge_upsert', edge: tedge(`Pod:${ns}/${name}`, 'owned_by', owner) },
  ...(nodeName
    ? [{ op: 'edge_upsert' as const, edge: tedge(`Pod:${ns}/${name}`, 'runs_on', `Node:${nodeName}`) }]
    : []),
];
/** 被驱逐的 Pod 在驱逐时删除 */
const podGone = (ns: string, name: string, owner: string, nodeName: string): Change[] => [
  { op: 'edge_delete', edge: tedge(`Pod:${ns}/${name}`, 'runs_on', `Node:${nodeName}`) },
  { op: 'edge_delete', edge: tedge(`Pod:${ns}/${name}`, 'owned_by', owner) },
  { op: 'node_delete', node: tnode('Pod', ns, name) },
];

const RS = 'ReplicaSet:shop/api-7d9f';
const HPA = 'HorizontalPodAutoscaler:shop/control';

function topology(): Array<{ at: number; changes: Change[] }> {
  return [
    {
      at: -600,
      changes: [
        ...['node-a', 'node-b', 'node-c'].map((n): Change => ({ op: 'node_upsert', node: tnode('Node', null, n) })),
        { op: 'node_upsert', node: tnode('Deployment', 'shop', 'api') },
        { op: 'node_upsert', node: tnode('ReplicaSet', 'shop', 'api-7d9f') },
        { op: 'edge_upsert', edge: tedge(RS, 'owned_by', API) },
        { op: 'node_upsert', node: tnode('StatefulSet', 'shop', 'control') },
        { op: 'node_upsert', node: tnode('HorizontalPodAutoscaler', 'shop', 'control') },
        { op: 'edge_upsert', edge: tedge(HPA, 'scales', CONTROL) },
        { op: 'node_upsert', node: tnode('Deployment', 'jobs', 'worker') },
        ...podUp('shop', 'api-7d9f-a1', RS, 'node-a'),
        ...podUp('shop', 'api-7d9f-b2', RS, 'node-b'),
        ...podUp('shop', 'control-0', CONTROL, 'node-a'),
        ...podUp('shop', 'control-1', CONTROL, 'node-b'),
        ...podUp('jobs', 'worker-5c-x1', WORKER, 'node-c'),
      ],
    },
    {
      at: 12,
      changes: [...podGone('shop', 'api-7d9f-a1', RS, 'node-a'), ...podGone('shop', 'control-0', CONTROL, 'node-a')],
    },
    { at: 20, changes: podGone('shop', 'api-7d9f-b2', RS, 'node-b') },
    {
      at: 22,
      changes: [...podGone('shop', 'control-1', CONTROL, 'node-b'), ...podUp('shop', 'control-2', CONTROL, null)],
    },
    { at: 30, changes: podUp('shop', 'api-7d9f-a3', RS, 'node-a') },
  ];
}

const profile: LabelProfile = {
  namespace: 'namespace',
  pod: 'pod',
  container: 'container',
  node: 'node',
  cluster: 'cluster',
  scrape_interval_seconds: 30,
  tenant: null,
};

const REASONS = [
  'Evicted',
  'FailedScheduling',
  'BackOff',
  'EvictionThresholdMet',
  'NodeHasInsufficientMemory',
  'SystemOOM',
];

let db: TestDb;
let loki: RunningProcess;
let prom: TsdbInstance;
let store: TopologyStore;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, topologyTrack]);
  store = new TopologyStore(db.server);
  for (const step of topology()) {
    await store.apply(
      CLUSTER,
      step.changes.map((c) => ({ ...c, at: at(step.at), source: 'informer' as const })),
    );
  }
  loki = await startLoki(logStreams());
  prom = await startPrometheus(metricSeries());
});

afterAll(async () => {
  await loki?.stop();
  await prom?.stop();
  await db?.close();
});

function lokiAdapter(url: string) {
  return new LokiAdapter({
    id: 'loki',
    url,
    labels: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
  });
}

function deps(withLoki: boolean, lokiMaxSeries = 5000, lokiUrl = loki.url): KubeWarningsDeps {
  return {
    events: withLoki
      ? {
          adapter: lokiAdapter(lokiUrl),
          source: kubeEventsSource({ format: 'alloy_json', fields: {}, reasons: REASONS }, null),
          maxSeries: lokiMaxSeries,
          timeoutMs: 30_000,
        }
      : null,
    metrics: {
      adapter: new PrometheusApiAdapter({ id: 'prometheus', url: prom.url, dialects: ['promql'] }),
      dialect: 'promql',
      profile,
      maxSeries: 5000,
      timeoutMs: 30_000,
    },
    placements: store,
    grouping: DEFAULT_GROUPING,
    now: () => NOW,
  };
}

describe('TopologyStore.placements', () => {
  it('沿 owned_by 展开到组件的 Pod，取与时间段重叠的 runs_on 区间；没有调度成功的 Pod 节点为 null', async () => {
    const rows = await store.placements(CLUSTER, [CONTROL, API], at(0), at(60));
    const view = rows.map((r) => [r.component, r.object, r.node, r.from.getTime(), r.to?.getTime() ?? null]);
    expect(view).toContainEqual([CONTROL, 'Pod:shop/control-0', 'Node:node-a', min(-600), min(12)]);
    expect(view).toContainEqual([CONTROL, 'Pod:shop/control-2', null, min(0), min(60)]);
    expect(view).toContainEqual([API, 'Pod:shop/api-7d9f-a3', 'Node:node-a', min(30), null]);
    expect(view).toContainEqual([API, RS, null, min(0), min(60)]);
    expect(view).toContainEqual([API, API, null, min(0), min(60)]);
    expect(rows.some((r) => r.object.startsWith('Pod:jobs/'))).toBe(false);
  });

  it('组件是 HPA 时从 scales 指向的工作负载展开', async () => {
    const rows = await store.placements(CLUSTER, [HPA], at(0), at(60));
    const view = rows.map((r) => [r.component, r.object, r.node]);
    expect(view).toContainEqual([HPA, CONTROL, null]);
    expect(view).toContainEqual([HPA, 'Pod:shop/control-1', 'Node:node-b']);
  });
});

describe('collectKubeWarnings', () => {
  it('Loki 事件与 kube-state-metrics 的 OOMKilled：两个节点的内存驱逐归为一组，node-c 的事件不进组', async () => {
    const r = await collectKubeWarnings(deps(true), { cluster_id: CLUSTER, incidents });
    expect(() => assertValid('schemas/kube-warnings.schema.json', r)).not.toThrow();
    expect(r.queries.map((q) => [q.name, q.status])).toEqual([
      ['events', 'ok'],
      ['oom_killed', 'ok'],
    ]);
    expect(r.complete).toBe(true);
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0]!;
    expect(g.kind).toBe('node_memory_eviction');
    expect(g.nodes.map((n) => n.node)).toEqual(['node-a', 'node-b']);
    expect(g.incidents.map((i) => i.incident_id).sort()).toEqual(
      [ids.controlHpa, ids.apiHpa, ids.schedule, ids.api5xx, ids.budget].sort(),
    );
    expect(g.alertnames).toEqual([
      'ApiErrorBudgetBurnFast',
      'ApiHigh5xxRate',
      'ApiHpaMaxedOut',
      'KubeHpaMaxedOut',
      'KubePodCreateOrScheduleFailing',
    ]);
    const a = g.nodes.find((n) => n.node === 'node-a')!;
    expect(a.counts.find((c) => c.reason === 'Evicted')).toEqual({
      reason: 'Evicted',
      source: 'events',
      unit: 'occurrences',
      count: 2,
      memory: 2,
    });
    const scheduleSummary = r.summaries.find((s) => s.incident_id === ids.schedule)!;
    expect(scheduleSummary.counts).toEqual([
      { reason: 'FailedScheduling', source: 'events', unit: 'occurrences', count: 4, memory: 4 },
    ]);
    const worker = r.summaries.find((s) => s.incident_id === ids.worker)!;
    expect(worker.nodes.map((n) => n.node)).toEqual(['node-c']);
    expect(worker.counts).toEqual([
      { reason: 'BackOff', source: 'events', unit: 'occurrences', count: 3, memory: 0 },
      { reason: 'OOMKilled', source: 'kube_state_metrics', unit: 'occurrences', count: 1, memory: null },
    ]);
    // 仍在触发的事件取计算时刻为终点
    expect(r.summaries.find((s) => s.incident_id === ids.apiHpa)!.window.to).toBe(new Date(NOW).toISOString());
  });

  it('没有 Loki 时用 kube-state-metrics 降级：MemoryPressure 与驱逐仍然成组', async () => {
    const r = await collectKubeWarnings(deps(false), { cluster_id: CLUSTER, incidents });
    expect(r.queries.map((q) => [q.name, q.status])).toEqual([
      ['oom_killed', 'ok'],
      ['evicted', 'ok'],
      ['unschedulable', 'ok'],
      ['crash_loop', 'ok'],
      ['memory_pressure', 'ok'],
    ]);
    expect(r.groups).toHaveLength(1);
    const a = r.groups[0]!.nodes.find((n) => n.node === 'node-a')!;
    expect(a.counts.map((c) => [c.reason, c.source, c.unit])).toEqual([
      ['Evicted', 'kube_state_metrics', 'pods'],
      ['NodeHasInsufficientMemory', 'kube_state_metrics', 'seconds'],
    ]);
  });

  it('序列数超过上限时标明截断，报告不完整', async () => {
    const r = await collectKubeWarnings(deps(true, 1), { cluster_id: CLUSTER, incidents });
    const events = r.queries.find((q) => q.name === 'events')!;
    expect(events.status).toBe('truncated');
    expect(events.series).toBe(1);
    expect(r.complete).toBe(false);
    expect(r.summaries.every((s) => !s.complete)).toBe(true);
  });

  it('Loki 拒绝查询时这一来源记为 failed，其余来源照常计数', async () => {
    const r = await collectKubeWarnings(deps(true, 5000, `${loki.url}/missing`), { cluster_id: CLUSTER, incidents });
    expect(r.queries.map((q) => [q.name, q.status])).toEqual([
      ['events', 'failed'],
      ['oom_killed', 'ok'],
    ]);
    expect(r.complete).toBe(false);
    expect(r.summaries.find((s) => s.incident_id === ids.worker)!.counts.map((c) => c.reason)).toEqual(['OOMKilled']);
  });
});
