import type { Alert, ChangeEvent, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { actsOn, computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '../src/index.js';
import { CLUSTER } from './fixtures.js';

// 停在前置步骤的发布（ADR 0140）：迁移 Job 在迁移前检查就失败，发布到不了工作负载，推导不出发布。没有属主的一次性 Job
// 自成一次变更；发布流水线的告警（没有对象）归到它；Job 经 egress_to 访问的数据库作为根因候选，排在 Job 之后；
// 作为枢纽的 DNS 不算。夹具按 2026-10-16 两次迁移前检查失败的时序搭建（只保留结构，名称换成 shop）。

const T = (hhmm: string) => Date.parse(`2026-10-16T${hhmm}:00Z`);
const DB = 'Cluster.postgresql.cnpg.io:shop-data/shop-postgres';
const DNS = 'Deployment:kube-system/coredns';
const MIGRATE = 'Job:shop/shop-migrate-5ec9';
const REPORT = 'Job:shop/report-export';

const node = (key: string, hub = false): TopologyNode => {
  const [kind, rest] = key.split(':') as [string, string];
  const [ns, name] = rest.split('/') as [string, string];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub };
};
const egress = (from: string, to: string): TopologyEdge => ({
  from,
  to,
  relation: 'egress_to',
  provenance: 'network_policy',
  confidence: 0.6,
  scope: 'service',
  evidence: 'NetworkPolicy shop/migration-to-postgresql',
});
const graphWith = (jobs: string[]) =>
  new TopologyGraph(
    [node(DB), node(DNS, true), ...jobs.map((j) => node(j))],
    jobs.flatMap((j) => [egress(j, DB), egress(j, DNS)]),
    1,
  );

let n = 0;
const alert = (
  alertname: string,
  at: string,
  o: { component: string | null; entity?: string; role?: 'cause' | 'change' },
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
    classification: { role: o.role ?? 'change', source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
    entity: e ? { cluster_id: CLUSTER, kind: e.kind, namespace: e.namespace, name: e.name, uid: null } : null,
    entity_resolution: e ? 'informer' : 'unresolved',
    component: o.component,
    received_at: new Date(T(at)).toISOString(),
  };
};
/** 一次性 Job 自成的变更（apps 的 deriveRollouts 生成的形状） */
const jobChange = (job: string, at: string): ChangeEvent => ({
  change_id: `kubernetes:${CLUSTER}:${job}`,
  source: 'kubernetes',
  kind: 'other',
  refs: [],
  revision: null,
  actor: null,
  time: new Date(T(at)).toISOString(),
  link: null,
  targets: [job],
  summary: '一次性 Job',
});
const jobFailed = (at = '04:05') => alert('KubeJobFailed', at, { component: MIGRATE, entity: MIGRATE });
// 发布流水线失败、熔断打开：没有对象，领域包按 component 标签归到逻辑组件 component:release
const pipelineFailed = (at = '04:05') => alert('ReleaseWorkflowFailed', at, { component: 'component:release' });
const breakerOpen = (at = '05:02') => alert('ReleaseBreakerOpen', at, { component: 'component:release' });

const run = (graph: TopologyGraph, changes: ChangeEvent[], alerts: Alert[], now = '05:10') =>
  computeIncidents({ alerts, changes, graph, params: DEFAULT_RCA_PARAMS, now: T(now) });

describe('停在前置步骤的发布（ADR 0140）', () => {
  it('Job 的失败告警与发布流水线的告警归到同一次变更；数据库作为候选排在 Job 之后，DNS 枢纽不算', () => {
    const inc = run(
      graphWith([MIGRATE]),
      [jobChange(MIGRATE, '04:04')],
      [jobFailed(), pipelineFailed(), breakerOpen()],
    );
    expect(inc).toHaveLength(1);
    const cands = inc[0]!.ranking.candidates;
    expect(cands[0]!.component).toBe(MIGRATE);
    const db = cands.find((c) => c.component === DB);
    expect(db).toMatchObject({ source: 'change', terms: { role_prior: 0.6, recent_change: 0.6 } });
    expect(db!.score).toBeLessThan(cands[0]!.score);
    expect(cands.map((c) => c.component)).not.toContain(DNS);
    expect(inc[0]!.ranking.root.component).not.toBe(DB);
  });

  it('没有变更时（Job 没有自成变更）：流水线告警不归到 Job，数据库不进候选', () => {
    const inc = run(graphWith([MIGRATE]), [], [jobFailed(), pipelineFailed()]);
    expect(inc).toHaveLength(2);
    expect(inc.flatMap((i) => i.ranking.candidates.map((c) => c.component))).not.toContain(DB);
  });

  it('失败的 Job 已被删除（不在拓扑里）：它的告警仍属于这次变更，变更仍有影响，流水线告警仍归到它', () => {
    const inc = run(graphWith([]), [jobChange(MIGRATE, '04:04')], [jobFailed(), pipelineFailed(), breakerOpen()]);
    expect(inc).toHaveLength(1);
    expect(inc[0]!.group.changes.map((c) => c.targets[0])).toEqual([MIGRATE]);
  });

  it('作用对象只取 Job 目标的 egress_to：枢纽、命名空间与时间窗（弱推导）挂上的 Job、变更自己的目标都不算', () => {
    const g = graphWith([MIGRATE, REPORT]);
    expect([...actsOn(jobChange(MIGRATE, '04:04'), g)]).toEqual([[DB, 0.6]]);
    const rollout: ChangeEvent = {
      ...jobChange(MIGRATE, '04:04'),
      kind: 'rollout',
      targets: ['Deployment:shop/api', MIGRATE, REPORT],
      attachments: [
        { target: MIGRATE, basis: 'image' },
        { target: REPORT, basis: 'namespace_window' },
      ],
    };
    expect([...actsOn(rollout, g)]).toEqual([[DB, 0.6]]);
    const weakOnly: ChangeEvent = {
      ...rollout,
      targets: ['Deployment:shop/api', REPORT],
      attachments: [rollout.attachments![1]!],
    };
    expect(actsOn(weakOnly, g).size).toBe(0);
    expect(actsOn({ ...jobChange(MIGRATE, '04:04'), targets: [MIGRATE, DB] }, g).size).toBe(0);
  });

  it('数据库自己的告警在变更窗口内开始：由这次变更解释并归到同一个事件', () => {
    const lock = alert('PostgresLockWaits', '04:10', { component: DB, entity: DB, role: 'cause' });
    const inc = run(graphWith([MIGRATE]), [jobChange(MIGRATE, '04:04')], [jobFailed(), lock]);
    expect(inc).toHaveLength(1);
  });
});
