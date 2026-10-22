import type { Alert, ChangeEvent, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '../src/index.js';
import { CLUSTER } from './fixtures.js';

// 访问边只到被访问的组件为止（ADR 0141）。夹具按 bypassrls-2 的 what-if 回放搭建（2026-10-16，只保留结构，名称换成 shop）：
// 迁移 Job 04:05 失败，经 egress_to 访问数据库；数据库的主库与备库 Pod 分别运行在 storage-03 与 storage-01 上，
// 这两个节点从 02:34 起一直有"内存请求接近可分配量"的告警（比 Job 早 91 分钟，在 ADR 0104 §10 的 2 小时之内）。
// 修复之前，Job → egress_to → 数据库 → primary/replica → Pod → runs_on → 节点 这条路径让 Job 的失败与节点告警合并成一个事件。

const T = (hhmm: string) => Date.parse(`2026-10-16T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}Z`);
const DB = 'Cluster.postgresql.cnpg.io:shop-data/shop-postgres';
const PRIMARY = 'Pod:shop-data/shop-postgres-2';
const REPLICA = 'Pod:shop-data/shop-postgres-3';
const DNS = 'Deployment:kube-system/coredns';
const MIGRATE = 'Job:shop/shop-migrate-67a9';
const NODE_P = 'Node:storage-03';
const NODE_R = 'Node:storage-01';

const node = (key: string, hub = false): TopologyNode => {
  const [kind, rest] = key.split(':') as [string, string];
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub };
};
const edge = (
  from: string,
  relation: string,
  to: string,
  o: Partial<Pick<TopologyEdge, 'provenance' | 'confidence' | 'scope'>> = {},
): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: o.provenance ?? 'structural',
  confidence: o.confidence ?? 1,
  scope: o.scope ?? 'instance',
  evidence: `${relation} (夹具)`,
});
const egress = (from: string, to: string) =>
  edge(from, 'egress_to', to, { provenance: 'network_policy', confidence: 0.6, scope: 'service' });

const graph = new TopologyGraph(
  [node(DB), node(PRIMARY), node(REPLICA), node(NODE_P), node(NODE_R), node(DNS, true), node(MIGRATE)],
  [
    edge(PRIMARY, 'owned_by', DB),
    edge(REPLICA, 'owned_by', DB),
    edge(DB, 'primary', PRIMARY),
    edge(DB, 'replica', REPLICA),
    edge(PRIMARY, 'runs_on', NODE_P),
    edge(REPLICA, 'runs_on', NODE_R),
    egress(MIGRATE, DB),
    egress(MIGRATE, DNS),
  ],
  1,
);

let n = 0;
const alert = (
  alertname: string,
  at: string,
  o: { component: string | null; entity?: string; role: 'cause' | 'change' },
): Alert => {
  const id = (++n).toString(16).padStart(16, '0');
  const e = o.entity ? node(o.entity) : null;
  return {
    alert_id: `${id}@${T(at) / 1000}`,
    cluster_id: CLUSTER,
    source: 'alertmanager',
    fingerprint: id,
    alertname,
    labels: { alertname },
    annotations: {},
    severity: 'warning',
    status: 'firing',
    suppressed: 'none',
    starts_at: new Date(T(at)).toISOString(),
    ends_at: null,
    generator_url: null,
    classification: { role: o.role, source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
    entity: e ? { cluster_id: CLUSTER, kind: e.kind, namespace: e.namespace, name: e.name, uid: null } : null,
    entity_resolution: e ? 'informer' : 'unresolved',
    component: o.component,
    received_at: new Date(T(at)).toISOString(),
  };
};
/** 一次性 Job 自成的变更（ADR 0140） */
const jobChange: ChangeEvent = {
  change_id: `kubernetes:${CLUSTER}:${MIGRATE}`,
  source: 'kubernetes',
  kind: 'other',
  refs: [],
  revision: null,
  actor: null,
  time: new Date(T('04:05')).toISOString(),
  link: null,
  targets: [MIGRATE],
  summary: '一次性 Job',
};
const nodeRequests = (key: string) =>
  alert('NodeMemoryRequestsNearAllocatable', '02:34', { component: key, entity: key, role: 'cause' });
const jobFailed = () => alert('KubeJobFailed', '04:05', { component: MIGRATE, entity: MIGRATE, role: 'change' });
const pipelineFailed = () =>
  alert('ArgoWorkflowsReleaseFailed', '04:05:30', { component: 'component:release', role: 'change' });

const run = (alerts: Alert[]) =>
  computeIncidents({ alerts, changes: [jobChange], graph, params: DEFAULT_RCA_PARAMS, now: T('04:20') });
const names = (inc: ReturnType<typeof run>[number]) => inc.group.alerts.map((x) => x.alert.alertname).sort();

describe('访问边只到被访问的组件为止（ADR 0141）', () => {
  it('可达：经 egress_to 到达数据库与它的 Pod，不再到达 Pod 运行的节点', () => {
    const r = graph.reach(MIGRATE, { minConfidence: DEFAULT_RCA_PARAMS.mergeThreshold, excludeProvenance: ['naming'] });
    expect(r.objects.get(DB)).toBeCloseTo(0.6);
    expect(r.objects.get(PRIMARY)).toBeCloseTo(0.6);
    expect(r.objects.get(REPLICA)).toBeCloseTo(0.6);
    expect(r.objects.has(NODE_P)).toBe(false);
    expect(r.objects.has(NODE_R)).toBe(false);
    // 数据库自己出发仍经 Pod 到达节点（不经访问边的路径不受影响）
    const own = graph.reach(DB, { minConfidence: 0, excludeProvenance: ['naming'] });
    expect(own.objects.get(NODE_P)).toBe(1);
  });

  it('bypassrls what-if：失败的迁移 Job 不并入 02:34 起的节点资源请求告警，数据库仍是候选', () => {
    const inc = run([nodeRequests(NODE_P), nodeRequests(NODE_R), jobFailed(), pipelineFailed()]);
    const job = inc.find((i) => i.group.alerts.some((x) => x.alert.alertname === 'KubeJobFailed'))!;
    expect(names(job)).toEqual(['ArgoWorkflowsReleaseFailed', 'KubeJobFailed']);
    expect(job.group.changes.map((c) => c.change_id)).toEqual([jobChange.change_id]);
    expect(job.ranking.candidates.map((c) => c.component)).toContain(DB);
    expect(job.ranking.candidates.map((c) => c.component)).not.toContain(NODE_P);
    // 两个节点的告警各自成组，与 Job 的事件分开
    expect(
      inc.filter((i) => i !== job).every((i) => names(i).every((a) => a === 'NodeMemoryRequestsNearAllocatable')),
    ).toBe(true);
  });

  it('数据库自己有告警时：Job 经数据库的 Pod 与它合并，数据库的 Pod 再经运行的节点与节点告警合并', () => {
    const podDown = alert('CNPGPrimaryNotReady', '04:00', { component: DB, entity: PRIMARY, role: 'cause' });
    const inc = run([nodeRequests(NODE_P), podDown, jobFailed(), pipelineFailed()]);
    expect(inc).toHaveLength(1);
    expect(names(inc[0]!)).toEqual([
      'ArgoWorkflowsReleaseFailed',
      'CNPGPrimaryNotReady',
      'KubeJobFailed',
      'NodeMemoryRequestsNearAllocatable',
    ]);
  });
});
