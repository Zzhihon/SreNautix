import type { Alert, AlertRole, ChangeEvent, EntityRef, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import {
  changeLinks,
  computeIncidents,
  converge,
  DEFAULT_RCA_PARAMS,
  gradeChange,
  isRollback,
  rankRoot,
  TopologyGraph,
  type AlertGroup,
} from '../src/index.js';
import { CLUSTER } from './fixtures.js';

// 变更与事件关联的确定性分级（ADR 0169）。夹具：shop 命名空间里 Argo 应用管理 api；web 经运行时调用依赖 api（0.8），
// worker 经低置信度的边依赖 api（0.5，低于归并阈值）；发布的迁移 Job 经 egress_to 访问数据库 db。

const T = (hhmm: string) => Date.parse(`2026-10-26T${hhmm}:00Z`);
const APP = 'Application.argoproj.io:argocd/shop';
const API = 'Deployment:shop/api';
const WEB = 'Deployment:shop/web';
const WORKER = 'Deployment:shop/worker';
const DB = 'Cluster.postgresql.cnpg.io:shop/db';
const MIGRATE = 'Job:shop/migrate-1';

const node = (key: string): TopologyNode => {
  const kind = key.slice(0, key.indexOf(':'));
  const [ns, name] = key.slice(key.indexOf(':') + 1).split('/') as [string, string];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub: false };
};
const edge = (from: string, to: string, relation: string, confidence = 1): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: relation === 'managed_by' ? 'structural' : 'runtime',
  confidence,
  scope: 'service',
  evidence: 't',
});
const graph = new TopologyGraph(
  [APP, API, WEB, WORKER, DB, MIGRATE].map(node),
  [
    edge(API, APP, 'managed_by'),
    edge(WEB, API, 'calls', 0.8),
    edge(WORKER, API, 'calls', 0.5),
    edge(MIGRATE, DB, 'egress_to', 0.6),
  ],
  1,
);
const P = DEFAULT_RCA_PARAMS;

let n = 0;
const entity = (key: string): EntityRef => {
  const x = node(key);
  return { cluster_id: CLUSTER, kind: x.kind, namespace: x.namespace, name: x.name, uid: null };
};
const alert = (
  alertname: string,
  at: string,
  o: { on?: string; role?: AlertRole; labels?: Record<string, string>; component?: string | null; end?: string },
): Alert => {
  const id = `${(++n).toString(16).padStart(16, '0')}@${T(at) / 1000}`;
  return {
    alert_id: id,
    cluster_id: CLUSTER,
    source: 'alertmanager',
    fingerprint: id,
    alertname,
    labels: { alertname, ...(o.labels ?? {}) },
    annotations: {},
    severity: 'warning',
    status: o.end ? 'resolved' : 'firing',
    suppressed: 'none',
    starts_at: new Date(T(at)).toISOString(),
    ends_at: o.end ? new Date(T(o.end)).toISOString() : null,
    generator_url: null,
    classification: {
      role: o.role ?? 'symptom',
      source: 'catalog',
      confidence: 1,
      catalog_entry: null,
      chronic: false,
    },
    entity: o.on ? entity(o.on) : null,
    entity_resolution: o.on ? 'informer' : 'labels',
    component: o.component !== undefined ? o.component : (o.on ?? null),
    received_at: new Date(T(at)).toISOString(),
  };
};
const change = (id: string, at: string, o: Partial<ChangeEvent> = {}): ChangeEvent => ({
  change_id: id,
  source: 'kubernetes',
  kind: 'rollout',
  refs: [APP],
  revision: null,
  actor: null,
  time: new Date(T(at)).toISOString(),
  link: null,
  targets: [API, APP],
  summary: 'api 的发布',
  ...o,
});
const NOW = T('07:30');
const incidents = (alerts: Alert[], changes: ChangeEvent[]) =>
  computeIncidents({ alerts, changes, graph, params: P, now: NOW });
const linkOf = (alerts: Alert[], changes: ChangeEvent[], id: string) => {
  const hit = incidents(alerts, changes).find((i) => i.links.some((l) => l.change_id === id));
  return hit!.links.find((l) => l.change_id === id)!;
};
/** 把变更放进只按告警收敛出的唯一分组：看不进分组的变更怎样分级 */
const onlyGroup = (alerts: Alert[], changes: ChangeEvent[]): AlertGroup => {
  const groups = converge({ alerts, changes: [], graph, params: P, now: NOW });
  expect(groups).toHaveLength(1);
  return { ...groups[0]!, changes };
};

describe('high：时间、对象与新信号同时满足', () => {
  it('发布之后 api 上开始的症状：component_match，新信号是这条告警', () => {
    const down = alert('KubeDeploymentReplicasMismatch', '06:10', { on: API });
    const link = linkOf([down], [change('k:1', '06:00')], 'k:1');
    expect(link).toEqual({
      change_id: 'k:1',
      grade: 'high',
      basis: ['component_match'],
      new_signals: [down.alert_id],
      rollback: false,
    });
  });

  it('cause 角色也是新信号；落在管理应用上的告警同样算作用在变更目标上', () => {
    const synced = alert('ArgoCDAppDegraded', '06:05', { on: APP, role: 'cause' });
    expect(linkOf([synced], [change('k:1', '06:00')], 'k:1')).toMatchObject({
      grade: 'high',
      basis: ['component_match'],
      new_signals: [synced.alert_id],
    });
  });

  it('按镜像挂上的迁移 Job 经 egress_to 访问数据库：数据库在发布之后开始的告警是 acts_on 的新信号', () => {
    const c = change('k:1', '06:00', {
      targets: [API, MIGRATE, APP],
      attachments: [{ target: MIGRATE, basis: 'image' }],
    });
    const locks = alert('CNPGDeadlocks', '06:04', { on: DB, role: 'cause' });
    expect(linkOf([locks], [c], 'k:1')).toMatchObject({
      grade: 'high',
      basis: ['acts_on'],
      new_signals: [locks.alert_id],
    });
  });
});

describe('medium', () => {
  it('只经拓扑可达（0.8 ≥ 归并阈值）：web 的症状由 api 的发布解释，没有落在目标上的新信号', () => {
    const slow = alert('WebLatencyHigh', '06:08', { on: WEB });
    expect(linkOf([slow], [change('k:1', '06:00')], 'k:1')).toEqual({
      change_id: 'k:1',
      grade: 'medium',
      basis: ['topology_reach'],
      new_signals: [],
      rollback: false,
    });
  });

  it('直接作用但没有新信号：目标上只有 change 角色的告警', () => {
    const job = alert('KubeJobFailed', '06:03', { on: API, role: 'change' });
    expect(linkOf([job], [change('k:1', '06:00')], 'k:1')).toMatchObject({
      grade: 'medium',
      basis: ['component_match'],
      new_signals: [],
    });
  });

  it('目标上的 meta 告警不是新信号', () => {
    const gap = alert('TargetDown', '06:03', { on: API, role: 'meta' });
    expect(linkOf([gap], [change('k:1', '06:00')], 'k:1').grade).toBe('medium');
  });
});

describe('low', () => {
  it('拓扑可达的置信度低于归并阈值（0.5）：没有依据，low', () => {
    const g = onlyGroup([alert('WorkerErrors', '06:08', { on: WORKER })], [change('k:1', '06:00')]);
    expect(gradeChange(g.changes[0]!, g, graph, P)).toMatchObject({ grade: 'low', basis: [] });
  });

  it('按命名空间与时间窗（弱推导）挂上的 Job：数据库告警不算 acts_on', () => {
    const c = change('k:1', '06:00', {
      targets: [API, MIGRATE, APP],
      attachments: [{ target: MIGRATE, basis: 'namespace_window' }],
    });
    const g = onlyGroup([alert('CNPGDeadlocks', '06:04', { on: DB, role: 'cause' })], [c]);
    expect(gradeChange(c, g, graph, P)).toMatchObject({ grade: 'low', basis: [], new_signals: [] });
  });

  it('告警在变更窗口之外开始：不满足时间条件，目标上的告警也只是 low', () => {
    const g = onlyGroup([alert('KubeDeploymentReplicasMismatch', '06:45', { on: API })], [change('k:1', '06:00')]);
    expect(gradeChange(g.changes[0]!, g, graph, P)).toMatchObject({ grade: 'low', basis: [], new_signals: [] });
  });

  it('变更晚于它目标上已经开始的问题（late）：即使之后又有新的告警也是 low', () => {
    const before = alert('KubePodCrashLooping', '05:40', { on: API, role: 'cause' });
    const again = alert('KubeDeploymentReplicasMismatch', '06:05', { on: API });
    const g = onlyGroup([before, again], [change('k:1', '06:00')]);
    expect(gradeChange(g.changes[0]!, g, graph, P)).toMatchObject({
      grade: 'low',
      basis: ['late'],
      new_signals: [],
    });
  });

  it('没有对象的告警按命名空间归到变更：namespace', () => {
    const loose = alert('ShopQueueBacklog', '06:06', { labels: { namespace: 'shop' }, component: 'Namespace:shop' });
    expect(linkOf([loose], [change('k:1', '06:00')], 'k:1')).toMatchObject({ grade: 'low', basis: ['namespace'] });
  });

  it('没有对象的变更类告警按影响归到变更：logical_owner；与目标上的症状一起时分级取 high', () => {
    const down = alert('KubeDeploymentReplicasMismatch', '06:10', { on: API });
    const pipeline = alert('ReleaseWorkflowFailed', '06:12', { role: 'change', component: 'component:release' });
    const link = linkOf([down, pipeline], [change('k:1', '06:00', { targets: [API] })], 'k:1');
    expect(link).toMatchObject({ grade: 'high', basis: ['component_match', 'logical_owner'] });
  });

  it('只因"已合并、尚未同步"列进来的提交：pending_sync，low', () => {
    const drift = alert('ArgoCDManualAppDrift', '07:00', { on: APP, role: 'cause' });
    const commit = change('github:abc', '05:00', {
      source: 'github',
      kind: 'gitops_sync',
      refs: ['abc'],
      targets: [APP],
      pending_sync: [{ application: APP, out_of_sync_since: null }],
    });
    const [inc] = incidents([drift], [commit]);
    expect(inc!.group.pendingChanges).toEqual([commit]);
    expect(inc!.links).toEqual([
      { change_id: 'github:abc', grade: 'low', basis: ['pending_sync'], new_signals: [], rollback: false },
    ]);
  });
});

describe('退役（ADR 0161 的处理不变，依据记 retire_scrape_job）', () => {
  const retire = (o: Partial<ChangeEvent> = {}) =>
    change('k:r', '06:00', { kind: 'retire', targets: [WORKER, APP], scrape_jobs: ['worker'], ...o });
  it('抓取 job 消失的 meta 告警：直接作用、没有新信号，medium', () => {
    const vanished = alert('ScrapeJobVanished', '06:05', {
      role: 'meta',
      labels: { job: 'worker' },
      component: 'Job:worker',
    });
    expect(linkOf([vanished], [retire()], 'k:r')).toMatchObject({
      grade: 'medium',
      basis: ['retire_scrape_job'],
      new_signals: [],
    });
  });

  it('报这个 job 的 symptom 告警：high，新信号是它', () => {
    const missing = alert('WorkerMetricsAbsent', '06:05', {
      role: 'symptom',
      labels: { job: 'worker' },
      component: 'Job:worker',
    });
    expect(linkOf([missing], [retire()], 'k:r')).toMatchObject({
      grade: 'high',
      basis: ['retire_scrape_job'],
      new_signals: [missing.alert_id],
    });
  });
});

describe('回退', () => {
  it('revision 等于更早一次变更的 previous_revision、previous_revision 等于它的 revision', () => {
    const up = change('k:1', '06:00', { revision: 'v2', previous_revision: 'v1' });
    const back = change('k:2', '06:20', { revision: 'v1', previous_revision: 'v2' });
    const other = change('k:3', '06:25', { revision: 'v3', previous_revision: 'v1' });
    expect(isRollback(back, [up, back, other])).toBe(true);
    expect(isRollback(up, [up, back, other])).toBe(false);
    expect(isRollback(other, [up, back, other])).toBe(false);
    // 更晚的那次不算更早的变更
    expect(isRollback(up, [up, { ...back, time: up.time }])).toBe(false);
    const down = alert('KubeDeploymentReplicasMismatch', '06:22', { on: API });
    const [inc] = incidents([down], [up, back]);
    expect(inc!.links.map((l) => [l.change_id, l.rollback])).toEqual([
      ['k:1', false],
      ['k:2', true],
    ]);
  });
});

describe('事件与排序读同一份分级', () => {
  it('事件的 change_links 与 changes 顺序相同', () => {
    const slow = alert('WebLatencyHigh', '06:08', { on: WEB });
    const down = alert('KubeDeploymentReplicasMismatch', '06:10', { on: API });
    const [inc] = incidents([slow, down], [change('k:2', '06:02'), change('k:1', '06:00')]);
    expect(inc!.group.changes.map((c) => c.change_id)).toEqual(['k:1', 'k:2']);
    expect(inc!.links.map((l) => l.change_id)).toEqual(['k:1', 'k:2']);
    expect(changeLinks(inc!.group, graph, P)).toEqual(inc!.links);
  });

  it('近期变更一项按分级取值：high 1、medium 0.5、low 0.2', () => {
    const terms = (alerts: Alert[], changes: ChangeEvent[]) => {
      const g = onlyGroup(alerts, changes);
      return rankRoot({ group: g, graph, params: P }).candidates.find((c) => c.component === API)?.terms.recent_change;
    };
    expect(terms([alert('KubeDeploymentReplicasMismatch', '06:10', { on: API })], [change('k:1', '06:00')])).toBe(1);
    expect(terms([alert('WebLatencyHigh', '06:08', { on: WEB })], [change('k:1', '06:00')])).toBe(0.5);
    expect(terms([alert('WorkerErrors', '06:08', { on: WORKER })], [change('k:1', '06:00')])).toBe(0.2);
  });

  it('作用对象的近期变更再乘访问边的置信度', () => {
    const c = change('k:1', '06:00', {
      targets: [API, MIGRATE, APP],
      attachments: [{ target: MIGRATE, basis: 'image' }],
    });
    const [inc] = incidents([alert('CNPGDeadlocks', '06:04', { on: DB, role: 'cause' })], [c]);
    expect(inc!.links[0]!.grade).toBe('high');
    // 数据库自己有 cause 告警，近期变更取作用对象的 1 × 0.6（看全部候选，不截取前 k 个）
    const all = rankRoot({ group: inc!.group, graph, params: { ...P, topK: 10 }, links: inc!.links }).candidates;
    expect(all.find((x) => x.component === DB)!.terms.recent_change).toBe(0.6);
  });
});
