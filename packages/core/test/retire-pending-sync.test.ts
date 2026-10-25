import type { Alert, AlertRole, ChangeEvent, EntityRef, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '../src/index.js';
import { CLUSTER } from './fixtures.js';

// 退役与已合并、尚未同步的提交（ADR 0161）。夹具按 2026-10-25 两次事件的时序搭建（名称换成 shop）：
// - 退役：02:44 合并删除 store 全部定义的提交；02:50 管理应用以 orphan 方式删除，02:51 三个 StatefulSet 删除，抓取 job store
//   失去全部目标；03:02 ObservabilityScrapeJobVanished{job="store"} 触发，实体是不在拓扑里的 Job:store；
//   同一命名空间 03:05 另有一条与退役无关、没有对象锚点的告警；
// - 未同步：应用 metrics 10-24 13:32 起 OutOfSync，之后合并的提交触及它与另外两个应用；10-25 13:31 漂移告警触发，
//   同时另一个应用 rules 也在漂移，两个提交都触及它。

const T = (s: string) => Date.parse(s);
const APP = 'Application.argoproj.io:argocd/store';
const PARENT = 'Application.argoproj.io:argocd/platform-definitions';
const STS = ['master', 'volume', 'filer'].map((n) => `StatefulSet:shop-data/store-${n}`);
const METRICS = 'Application.argoproj.io:argocd/metrics';
const RULES = 'Application.argoproj.io:argocd/rules';
const GRAFANA = 'Application.argoproj.io:argocd/grafana';

const node = (key: string): TopologyNode => {
  const kind = key.slice(0, key.indexOf(':'));
  const rest = key.slice(key.indexOf(':') + 1);
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub: false };
};
const managed = (from: string, to: string): TopologyEdge => ({
  from,
  to,
  relation: 'managed_by',
  provenance: 'structural',
  confidence: 1,
  scope: 'service',
  evidence: 'Argo CD status.resources',
});

let n = 0;
const alert = (
  alertname: string,
  start: string,
  o: { role: AlertRole; entity: EntityRef | null; component: string | null; labels?: Record<string, string> },
): Alert => {
  const id = (++n).toString(16).padStart(16, '0');
  return {
    alert_id: `${id}@${T(start) / 1000}`,
    cluster_id: CLUSTER,
    source: 'reconcile',
    fingerprint: id,
    alertname,
    labels: { alertname, ...(o.labels ?? {}) },
    annotations: {},
    severity: 'warning',
    status: 'firing',
    suppressed: 'none',
    starts_at: new Date(T(start)).toISOString(),
    ends_at: null,
    generator_url: null,
    classification: { role: o.role, source: 'label', confidence: 1, catalog_entry: null, chronic: false },
    entity: o.entity,
    entity_resolution: 'labels',
    component: o.component,
    received_at: new Date(T(start)).toISOString(),
  };
};
const ref = (kind: string, namespace: string | null, name: string): EntityRef => ({
  cluster_id: CLUSTER,
  kind,
  namespace,
  name,
  uid: null,
});

describe('退役（ADR 0161）', () => {
  // 03:03 的拓扑：管理应用已经删除；StatefulSet 被 informer 的重新列举补回了两个（与线上的状态库相同）
  const graph = new TopologyGraph([node(STS[0]!), node(STS[1]!), node(PARENT)], [], 1);
  const retire = (o: Partial<ChangeEvent> = {}): ChangeEvent => ({
    change_id: `kubernetes:${CLUSTER}:retire-1`,
    source: 'kubernetes',
    kind: 'retire',
    refs: [APP],
    revision: null,
    actor: null,
    time: '2026-10-25T02:51:30.000Z',
    link: null,
    targets: [APP, ...STS],
    summary: 'shop-data/store-filer 已删除；抓取 job store 失去全部 8 个目标',
    scrape_jobs: ['store'],
    planned_by: [
      {
        change_id: 'ops:6a701ff',
        revision: '6a701ffc28b19d4b9c85c0716223b40769aa334f',
        time: '2026-10-25T02:44:55.000Z',
        link: 'https://example.com/ops/commit/6a701ff',
        summary: 'retire store',
      },
    ],
    ...o,
  });
  const vanished = () =>
    alert('ObservabilityScrapeJobVanished', '2026-10-25T03:02:00Z', {
      role: 'meta',
      entity: ref('Job', null, 'store'),
      component: 'Job:store',
      labels: { job: 'store', entity: 'store', entity_kind: 'job' },
    });
  const unrelated = () =>
    alert('NamespaceQuotaNearlyFull', '2026-10-25T03:05:00Z', {
      role: 'cause',
      entity: null,
      component: 'Namespace:shop-data',
      labels: { namespace: 'shop-data' },
    });
  const NOW = T('2026-10-25T03:10:00Z');
  const run = (alerts: Alert[], changes: ChangeEvent[]) =>
    computeIncidents({ alerts, changes, graph, params: DEFAULT_RCA_PARAMS, now: NOW });

  it('抓取 job 消失的告警归到退役变更，头号候选是管理应用，变更带着计划依据', () => {
    const inc = run([vanished()], [retire()]);
    expect(inc).toHaveLength(1);
    expect(inc[0]!.group.changes.map((c) => c.change_id)).toEqual([`kubernetes:${CLUSTER}:retire-1`]);
    expect(inc[0]!.ranking.root.component).toBe(APP);
    expect(inc[0]!.ranking.candidates.map((c) => [c.component, c.source])).toEqual([[APP, 'change']]);
    expect(inc[0]!.group.changes[0]!.planned_by?.[0]?.change_id).toBe('ops:6a701ff');
  });

  it('同一命名空间里没有对象锚点的其他告警不归到退役变更', () => {
    const inc = run([vanished(), unrelated()], [retire()]);
    const other = inc.find((x) => x.group.alerts.some((a) => a.alert.alertname === 'NamespaceQuotaNearlyFull'))!;
    expect(other.group.changes).toEqual([]);
    expect(other.group.alerts).toHaveLength(1);
  });

  it('job 不在 scrape_jobs 里、或告警早于退役时不关联；没有管理应用时候选是工作负载', () => {
    expect(run([vanished()], [retire({ scrape_jobs: ['other'] })])[0]!.group.changes).toEqual([]);
    expect(run([vanished()], [retire({ time: '2026-10-25T03:05:00.000Z' })])[0]!.group.changes).toEqual([]);
    const bare = run([vanished()], [retire({ refs: [], targets: STS })])[0]!;
    expect(bare.ranking.candidates.map((c) => c.component).sort()).toEqual([...STS].sort());
  });

  it('没有退役变更时与之前相同：事件只有告警自己的组件', () => {
    const inc = run([vanished()], []);
    expect(inc[0]!.ranking.root.component).toBe('Job:store');
    expect(inc[0]!.group.changes).toEqual([]);
  });
});

describe('已合并、尚未同步的提交（ADR 0161）', () => {
  const graph = new TopologyGraph(
    [node(METRICS), node(RULES), node(GRAFANA), node('VMRule:observability/business')],
    [managed('VMRule:observability/business', METRICS)],
    1,
  );
  const commit = (sha: string, time: string, pending: string[]): ChangeEvent => ({
    change_id: `ops:${sha}`,
    source: 'ops',
    kind: 'config',
    refs: [sha],
    revision: sha,
    actor: null,
    time,
    link: `https://example.com/ops/commit/${sha}`,
    targets: [GRAFANA, METRICS, RULES],
    summary: `commit ${sha}`,
    pending_sync: pending.map((application) => ({ application, out_of_sync_since: '2026-10-24T13:32:00.000Z' })),
  });
  const drift = (app: string, name: string) =>
    alert('ArgoCDManualAppDrift', '2026-10-25T13:31:30Z', {
      role: 'cause',
      entity: ref('Application.argoproj.io', 'argocd', name),
      component: app,
      labels: { name, job: 'argocd' },
    });
  const NOW = T('2026-10-25T13:40:00Z');
  const run = (alerts: Alert[], changes: ChangeEvent[], now = NOW) =>
    computeIncidents({ alerts, changes, graph, params: DEFAULT_RCA_PARAMS, now });
  /** 事件列出的变更（按时间关联的与只因未同步列进的） */
  const listed = (x: ReturnType<typeof run>[number]) =>
    [...x.group.changes, ...x.group.pendingChanges].map((c) => c.change_id);

  it('漂移告警所在的事件列出未同步的提交，候选只有这个应用', () => {
    const changes = [
      commit('83e3648', '2026-10-24T18:37:14.000Z', [METRICS]),
      commit('6a701ff', '2026-10-25T02:44:55.000Z', [METRICS]),
    ];
    const inc = run([drift(METRICS, 'metrics')], changes);
    expect(inc).toHaveLength(1);
    expect(listed(inc[0]!)).toEqual(['ops:83e3648', 'ops:6a701ff']);
    expect(inc[0]!.ranking.root.component).toBe(METRICS);
    expect(inc[0]!.ranking.candidates.map((c) => c.component)).toEqual([METRICS]);
  });

  it('两个应用都因同一批提交漂移时，各自成事件，各自列出提交', () => {
    const changes = [commit('83e3648', '2026-10-24T18:37:14.000Z', [METRICS, RULES])];
    const inc = run([drift(METRICS, 'metrics'), drift(RULES, 'rules')], changes);
    expect(inc).toHaveLength(2);
    for (const x of inc) {
      expect(listed(x)).toEqual(['ops:83e3648']);
      expect(x.ranking.candidates.map((c) => c.component)).toEqual([x.group.alerts[0]!.component]);
    }
  });

  it('告警的开始时刻紧挨着早于输入窗口的未同步提交时，也不按时间关联：不连成一个事件，不把提交的其他目标排进候选', () => {
    // 评测按 pending 开始时刻接入告警：两个应用 24 小时前、提交之后 35 秒开始 pending
    const early = (app: string, name: string) =>
      alert('ArgoCDManualAppDrift', '2026-10-24T18:37:49Z', {
        role: 'cause',
        entity: ref('Application.argoproj.io', 'argocd', name),
        component: app,
        labels: { name, job: 'argocd' },
      });
    const changes = [commit('83e3648', '2026-10-24T18:37:14.000Z', [METRICS, RULES])];
    const inc = run([early(METRICS, 'metrics'), early(RULES, 'rules')], changes, T('2026-10-25T18:40:00Z'));
    expect(inc).toHaveLength(2);
    for (const x of inc) {
      expect(x.group.changes).toEqual([]);
      expect(listed(x)).toEqual(['ops:83e3648']);
      expect(x.ranking.candidates.map((c) => c.component)).toEqual([x.group.alerts[0]!.component]);
    }
  });

  it('告警开始之后合并、仍未同步的提交也列进事件；没有标出这个应用的提交不列进事件', () => {
    const changes = [
      commit('1d4dec1', '2026-10-24T12:39:15.000Z', []),
      commit('66a2308', '2026-10-25T13:35:46.000Z', [METRICS]),
    ];
    const inc = run([drift(METRICS, 'metrics')], changes);
    expect(listed(inc[0]!)).toEqual(['ops:66a2308']);
    expect(inc[0]!.ranking.root.component).toBe(METRICS);
  });

  it('没有标 pending_sync 的变更与之前相同：早于窗口的提交不进事件', () => {
    const inc = run([drift(METRICS, 'metrics')], [commit('83e3648', '2026-10-24T18:37:14.000Z', [])]);
    expect(listed(inc[0]!)).toEqual([]);
    expect(inc[0]!.ranking.candidates.map((c) => c.component)).toEqual([METRICS]);
  });
});
