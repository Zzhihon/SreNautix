import { describe, expect, it } from 'vitest';
import type {
  Alert,
  AlertmanagerAlert,
  AlertmanagerWebhook,
  ChangeEvent,
  TopologyEdge,
  TopologyNode,
} from '@srenautix/contract';
import {
  computeIncidents,
  DEFAULT_RCA_PARAMS,
  EntityResolver,
  normalizeAlert,
  normalizeWebhook,
  silentRootTargets,
  TopologyGraph,
  type TopologyStore,
  type ComputedIncident,
} from '../src/index.js';
import { catalog, CLUSTER, clusterStore, MIN, RULE_EXPRS, T0, testdata } from './fixtures.js';

// frontend 在 09:58 发布了新 ReplicaSet；这次发布与数据库故障无关
const FRONTEND_ROLLOUT: ChangeEvent = {
  change_id: 'k8s-rollout:web/frontend-9a8b7c6d5',
  source: 'k8s-rollout',
  kind: 'rollout',
  refs: ['ReplicaSet/frontend-9a8b7c6d5'],
  revision: '14',
  actor: null,
  time: '2026-10-15T09:58:00Z',
  link: null,
  targets: ['Deployment:web/frontend', 'ReplicaSet:web/frontend-9a8b7c6d5'],
  summary: 'new ReplicaSet frontend-9a8b7c6d5',
};

async function cascadeAlerts(store: TopologyStore, now: number): Promise<Alert[]> {
  const body = JSON.parse(testdata('am-webhook-cascade.json')) as AlertmanagerWebhook;
  return normalizeWebhook(body, {
    clusterId: CLUSTER,
    source: 'alertmanager',
    receivedAt: now,
    catalog: catalog(),
    resolver: new EntityResolver({ store }),
    ruleExprs: RULE_EXPRS,
    now,
  });
}

const view = (c: ComputedIncident) => ({
  members: c.group.alerts.map((x) => x.alert.alertname).sort(),
  changes: c.group.changes.map((x) => x.change_id),
  ranking: c.ranking.candidates.map((x) => ({
    component: x.component,
    source: x.source,
    score: x.score,
    layer: x.layer,
  })),
  root: c.ranking.root,
});

describe('级联：CNPG 主库 OOM，同时有一次无关的发布（黄金）', () => {
  it('数据库排第一，发布排第二；forecast 单独成事件', async () => {
    const store = clusterStore();
    const now = T0 + 20 * MIN;
    const alerts = await cascadeAlerts(store, now);
    const incidents = computeIncidents({
      alerts,
      changes: [FRONTEND_ROLLOUT],
      graph: store.asOf(now),
      params: DEFAULT_RCA_PARAMS,
      now,
    });
    expect(incidents.map(view)).toEqual([
      {
        members: [
          'ApiErrorRatioHigh',
          'FrontendErrorRatioHigh',
          'KubeContainerOOMKilled',
          'KubePodCrashLooping',
          'WorkerJobFailuresHigh',
        ],
        changes: ['k8s-rollout:web/frontend-9a8b7c6d5'],
        ranking: [
          // 覆盖率 (0.7 + 0.7 + 0.49) / 3 = 0.63；三个症状都晚于 10:01 的 OOM；cause 先验 0.8
          { component: 'Cluster:shop/pg', source: 'alert', score: 0.562, layer: 0 },
          // 只解释 frontend 一个症状：覆盖率 1/3；变更先验 1.0；30 分钟内的变更 1
          { component: 'Deployment:web/frontend', source: 'change', score: 0.633333, layer: 1 },
        ],
        root: {
          component: 'Cluster:shop/pg',
          entity: {
            cluster_id: CLUSTER,
            kind: 'Pod',
            namespace: 'shop',
            name: 'pg-1',
            uid: '7b2d0000-0000-4000-8000-000000000p01',
          },
          ambiguous: false,
          margin: -0.071333,
          silent_root: false,
        },
      },
      {
        members: ['KubePersistentVolumeFillingUp'],
        changes: [],
        ranking: [{ component: 'PersistentVolumeClaim:shop/data-search-0', source: 'symptom', score: 0, layer: 1 }],
        root: {
          component: 'PersistentVolumeClaim:shop/data-search-0',
          entity: expect.objectContaining({ kind: 'PersistentVolumeClaim', name: 'data-search-0' }),
          ambiguous: false,
          margin: null,
          silent_root: false,
        },
      },
    ]);
    const db = incidents[0]!.ranking.candidates[0]!;
    expect(db.terms).toEqual({ coverage: 0.63, precedence: 1, role_prior: 0.8, recent_change: 0, chronic_penalty: 0 });
    expect(db.explains).toHaveLength(3);
  });

  it('结果与告警、变更的到达顺序无关', async () => {
    const store = clusterStore();
    const now = T0 + 20 * MIN;
    const alerts = await cascadeAlerts(store, now);
    const run = (xs: Alert[]) =>
      computeIncidents({
        alerts: xs,
        changes: [FRONTEND_ROLLOUT],
        graph: store.asOf(now),
        params: DEFAULT_RCA_PARAMS,
        now,
      }).map(view);
    expect(run([...alerts].reverse())).toEqual(run(alerts));
  });

  it('同样的分数下，长期告警受惩罚', async () => {
    const store = clusterStore();
    const now = T0 + 20 * MIN;
    const alerts = (await cascadeAlerts(store, now)).map((a) =>
      a.component === 'Cluster:shop/pg' ? { ...a, classification: { ...a.classification, chronic: true } } : a,
    );
    const [inc] = computeIncidents({ alerts, changes: [], graph: store.asOf(now), params: DEFAULT_RCA_PARAMS, now });
    expect(inc!.ranking.candidates[0]!.terms.chronic_penalty).toBe(1);
    expect(inc!.ranking.candidates[0]!.score).toBeCloseTo(0.462);
  });
});

async function alert(
  store: TopologyStore,
  labels: Record<string, string>,
  startsAt: string,
  now: number,
): Promise<Alert> {
  const raw: AlertmanagerAlert = {
    labels,
    annotations: {},
    startsAt,
    endsAt: '0001-01-01T00:00:00Z',
    status: 'firing',
  };
  const a = await normalizeAlert(raw, {
    clusterId: CLUSTER,
    source: 'alertmanager',
    receivedAt: now,
    catalog: catalog(),
    resolver: new EntityResolver({ store }),
    ruleExprs: RULE_EXPRS,
    now,
  });
  return a!;
}

describe('作用范围、时间相邻与沉默根因', () => {
  it('节点故障只吸收运行在该节点上的实例的告警', async () => {
    const store = clusterStore();
    const now = T0 + 20 * MIN;
    const xs = [
      await alert(
        store,
        { alertname: 'KubeNodeNotReady', node: 'node-2', severity: 'critical' },
        '2026-10-15T10:00:00Z',
        now,
      ),
      // pg-2 跑在 node-2 上
      await alert(
        store,
        { alertname: 'KubePodCrashLooping', namespace: 'shop', pod: 'pg-2', severity: 'warning' },
        '2026-10-15T10:05:00Z',
        now,
      ),
      // search-0 跑在 node-1 上
      await alert(
        store,
        { alertname: 'KubePodCrashLooping', namespace: 'shop', pod: 'search-0', severity: 'warning' },
        '2026-10-15T10:05:00Z',
        now,
      ),
    ];
    const incidents = computeIncidents({
      alerts: xs,
      changes: [],
      graph: store.asOf(now),
      params: DEFAULT_RCA_PARAMS,
      now,
    });
    expect(incidents.map((i) => i.group.alerts.map((x) => x.alert.entity?.name).sort())).toEqual([
      ['node-2', 'pg-2'],
      ['search-0'],
    ]);
    expect(incidents[0]!.ranking.root.component).toBe('Node:node-2');
  });

  it('间隔超过 30 分钟的告警不合并', async () => {
    const store = clusterStore();
    const now = T0 + 120 * MIN;
    const cause = await alert(
      store,
      { alertname: 'KubeContainerOOMKilled', namespace: 'shop', pod: 'pg-1', severity: 'critical' },
      '2026-10-15T10:00:00Z',
      now,
    );
    const resolved = { ...cause, status: 'resolved' as const, ends_at: '2026-10-15T10:10:00Z' };
    const late = await alert(
      store,
      { alertname: 'ApiErrorRatioHigh', namespace: 'shop', deployment: 'api', severity: 'critical' },
      '2026-10-15T10:41:00Z',
      now,
    );
    const near = await alert(
      store,
      { alertname: 'WorkerJobFailuresHigh', namespace: 'shop', deployment: 'worker', severity: 'warning' },
      '2026-10-15T10:39:00Z',
      now,
    );
    const incidents = computeIncidents({
      alerts: [resolved, late, near],
      changes: [],
      graph: store.asOf(now),
      params: DEFAULT_RCA_PARAMS,
      now,
    });
    expect(incidents.map((i) => i.group.alerts.map((x) => x.alert.alertname).sort())).toEqual([
      ['KubeContainerOOMKilled', 'WorkerJobFailuresHigh'],
      ['ApiErrorRatioHigh'],
    ]);
  });

  it('只有症状时对上游执行探测卡，异常的上游成为沉默根因', async () => {
    const store = clusterStore();
    const now = T0 + 20 * MIN;
    const graph = store.asOf(now);
    const xs = [
      await alert(
        store,
        { alertname: 'ApiErrorRatioHigh', namespace: 'shop', deployment: 'api', severity: 'critical' },
        '2026-10-15T10:02:00Z',
        now,
      ),
      await alert(
        store,
        { alertname: 'WorkerJobFailuresHigh', namespace: 'shop', deployment: 'worker', severity: 'warning' },
        '2026-10-15T10:03:00Z',
        now,
      ),
    ];
    const [plain] = computeIncidents({ alerts: xs, changes: [], graph, params: DEFAULT_RCA_PARAMS, now });
    expect(plain!.ranking.candidates.every((c) => c.source === 'symptom')).toBe(true);
    const targets = silentRootTargets(plain!.group, graph);
    expect(targets.filter((t) => t.reason === 'upstream').map((t) => t.component)).toEqual(
      expect.arrayContaining(['Cluster:shop/pg', 'Node:node-1', 'Node:node-2']),
    );
    expect(targets.filter((t) => t.reason !== 'upstream')).toEqual([
      {
        reason: 'namespace_pvc',
        component: 'StatefulSet:shop/search',
        object: 'PersistentVolumeClaim:shop/data-search-0',
        namespace: 'shop',
        confidence: 1,
      },
      { reason: 'namespace_logs', component: 'Namespace:shop', object: null, namespace: 'shop', confidence: 1 },
    ]);
    const [probed] = computeIncidents({
      alerts: xs,
      changes: [],
      graph,
      params: DEFAULT_RCA_PARAMS,
      now,
      probes: [
        {
          component: 'Cluster:shop/pg',
          abnormal: true,
          card_id: 'postgres/availability/connections',
          anomaly_started_at: T0 + MIN,
        },
        { component: 'Node:node-1', abnormal: false, card_id: 'node/pressure/memory', anomaly_started_at: null },
        // 不在本事件探测目标里的组件不参与
        {
          component: 'Deployment:web/frontend',
          abnormal: true,
          card_id: 'workload/rollout/stuck',
          anomaly_started_at: T0,
        },
      ],
    });
    expect(probed!.ranking.root).toMatchObject({ component: 'Cluster:shop/pg', silent_root: true });
    expect(probed!.ranking.candidates.map((c) => c.component)).toEqual(['Cluster:shop/pg']);
  });
});

describe('集群枢纽', () => {
  // 四个应用都经 config_ref 依赖 CoreDNS；CoreDNS 是枢纽
  const node = (key: string, hub = false): TopologyNode => {
    const [kind, rest] = key.split(':') as [string, string];
    const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
    return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub };
  };
  const edge = (from: string, to: string): TopologyEdge => ({
    from,
    to,
    relation: 'references',
    provenance: 'config_ref',
    confidence: 0.7,
    scope: 'service',
    evidence: 'test',
  });
  const apps = ['a', 'b', 'c', 'd'].map((x) => `Deployment:apps/${x}`);
  const graph = new TopologyGraph(
    [...apps.map((k) => node(k)), node('Deployment:kube-system/coredns', true), node('Deployment:apps/backend')],
    [
      ...apps.map((k) => edge(k, 'Deployment:kube-system/coredns')),
      edge('Deployment:kube-system/coredns', 'Deployment:apps/backend'),
    ],
    1,
  );
  const symptom = (app: string, at: number): Alert => ({
    alert_id: `00000000000000${app.slice(-1).charCodeAt(0).toString(16)}@${at / 1000}`,
    cluster_id: CLUSTER,
    source: 'alertmanager',
    fingerprint: `00000000000000${app.slice(-1).charCodeAt(0).toString(16)}`,
    alertname: 'HighErrorRatio',
    labels: { alertname: 'HighErrorRatio', namespace: 'apps', deployment: app.split('/')[1]! },
    annotations: {},
    severity: 'warning',
    status: 'firing',
    suppressed: 'none',
    starts_at: new Date(at).toISOString(),
    ends_at: null,
    generator_url: null,
    classification: { role: 'symptom', source: 'expression', confidence: 0.7, catalog_entry: null, chronic: false },
    entity: { cluster_id: CLUSTER, kind: 'Deployment', namespace: 'apps', name: app.split('/')[1]!, uid: null },
    entity_resolution: 'informer',
    component: app,
    received_at: new Date(at).toISOString(),
  });
  const now = T0 + 30 * MIN;

  it('两个依赖方同时出错时枢纽不吸收', () => {
    const incidents = computeIncidents({
      alerts: [symptom(apps[0]!, T0), symptom(apps[1]!, T0 + MIN)],
      changes: [],
      graph,
      params: DEFAULT_RCA_PARAMS,
      now,
    });
    expect(incidents).toHaveLength(2);
  });

  it('三个独立依赖方同时出错时枢纽吸收，成为沉默根因', () => {
    const incidents = computeIncidents({
      alerts: [symptom(apps[0]!, T0), symptom(apps[1]!, T0 + MIN), symptom(apps[2]!, T0 + 2 * MIN)],
      changes: [],
      graph,
      params: DEFAULT_RCA_PARAMS,
      now,
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.ranking.root).toMatchObject({
      component: 'Deployment:kube-system/coredns',
      silent_root: true,
    });
  });

  it('枢纽不作为中间节点：backend 的告警不经 CoreDNS 把应用拉进来', () => {
    const backend: Alert = {
      ...symptom('Deployment:apps/backend', T0),
      alert_id: '00000000000000ff@1',
      fingerprint: '00000000000000ff',
      classification: { role: 'cause', source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
    };
    const incidents = computeIncidents({
      alerts: [backend, symptom(apps[0]!, T0 + MIN)],
      changes: [],
      graph,
      params: DEFAULT_RCA_PARAMS,
      now,
    });
    expect(incidents).toHaveLength(2);
  });
});

describe('没有对象的发布告警归到哪一次变更（ADR 0104）', () => {
  const node = (key: string): TopologyNode => {
    const [kind, rest] = key.split(':') as [string, string];
    const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
    return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub: false };
  };
  const API = 'Deployment:shop/api';
  const GRAFANA = 'Deployment:observability/grafana';
  const graph = new TopologyGraph([node(API), node(GRAFANA)], [], 1);
  const rollout = (id: string, target: string, at: number): ChangeEvent => ({
    change_id: id,
    source: 'kubernetes',
    kind: 'rollout',
    refs: [],
    revision: null,
    actor: null,
    time: new Date(at).toISOString(),
    link: null,
    targets: [target],
    summary: `rollout ${target}`,
  });
  const alert = (
    n: number,
    alertname: string,
    at: number,
    over: Partial<Pick<Alert, 'component' | 'entity' | 'labels'>> & { role: Alert['classification']['role'] },
  ): Alert => ({
    alert_id: `${n.toString(16).padStart(16, '0')}@${at / 1000}`,
    cluster_id: CLUSTER,
    source: 'alertmanager',
    fingerprint: n.toString(16).padStart(16, '0'),
    alertname,
    labels: { alertname, ...over.labels },
    annotations: {},
    severity: 'warning',
    status: 'firing',
    suppressed: 'none',
    starts_at: new Date(at).toISOString(),
    ends_at: null,
    generator_url: null,
    classification: { role: over.role, source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
    entity: over.entity ?? null,
    entity_resolution: over.entity ? 'informer' : 'unresolved',
    component: over.component ?? null,
    received_at: new Date(at).toISOString(),
  });
  const release = alert(1, 'ReleaseFailed', T0 + 10 * MIN, {
    role: 'change',
    component: 'component:release',
    labels: { component: 'release' },
  });
  const apiDown = alert(2, 'ApiReplicasUnavailable', T0 + 5 * MIN, {
    role: 'cause',
    component: API,
    entity: { cluster_id: CLUSTER, kind: 'Deployment', namespace: 'shop', name: 'api', uid: null },
  });
  const now = T0 + 20 * MIN;
  const groupOf = (incs: ComputedIncident[], name: string) =>
    incs.find((i) => i.group.alerts.some((a) => a.alert.alertname === name));

  it('另一个命名空间里没有任何告警的发布不吸收发布告警', () => {
    const incs = computeIncidents({
      alerts: [release],
      changes: [rollout('grafana', GRAFANA, T0)],
      graph,
      params: DEFAULT_RCA_PARAMS,
      now,
    });
    expect(groupOf(incs, 'ReleaseFailed')?.group.changes.map((c) => c.change_id)).toEqual([]);
  });

  it('有更近但没有影响的发布时，发布告警归到解释了工作负载告警的那次发布，与工作负载告警在同一个事件', () => {
    const incs = computeIncidents({
      alerts: [apiDown, release],
      changes: [rollout('shop', API, T0), rollout('grafana', GRAFANA, T0 + 8 * MIN)],
      graph,
      params: DEFAULT_RCA_PARAMS,
      now,
    });
    const g = groupOf(incs, 'ReleaseFailed')!;
    expect(g.group.alerts.map((a) => a.alert.alertname).sort()).toEqual(['ApiReplicasUnavailable', 'ReleaseFailed']);
    expect(g.group.changes.map((c) => c.change_id)).toContain('shop');
    expect(g.group.changes.map((c) => c.change_id)).not.toContain('grafana');
  });
});
