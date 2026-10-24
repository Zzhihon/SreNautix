import type { Alert, ChangeEvent, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import {
  CHANGE_ONSET_TOLERANCE_MS,
  computeIncidents,
  converge,
  DEFAULT_RCA_PARAMS,
  rankRoot,
  TopologyGraph,
} from '../src/index.js';
import { CLUSTER } from './fixtures.js';

// 晚于症状的变更（ADR 0142）。夹具按 2026-10-23 CCHP gateway OOM 循环的时序搭建（名称换成 shop）：
// 15:48:30 起 gateway-3 OOM 重启，告警一直在触发，重启中不断有新的告警触发；17:42:07 版本标签往返一次
// （canary-x → 无 → canary-x），旧代码推导出一次 revision 与 previous_revision 相同的变更，目标是 StatefulSet 与管理它的应用。
// 旧代码里这次变更解释了 17:42 之后重新触发的 gateway 告警，管理应用作为变更候选与 gateway 都得 0.35，根因有歧义。

const T = (hhmmss: string) => Date.parse(`2026-10-23T${hhmmss}Z`);
const APP = 'Application.argoproj.io:argocd/shop';
const STS = 'StatefulSet:shop/gateway';
const pod = (i: number) => `Pod:shop/gateway-${i}`;

const node = (key: string): TopologyNode => {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const [ns, name] = rest.split('/') as [string, string];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub: false };
};
const edge = (from: string, to: string, relation: string): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: 'structural',
  confidence: 1,
  scope: relation === 'owned_by' ? 'instance' : 'service',
  evidence: 'ownerReference',
});
const graph = new TopologyGraph(
  [node(APP), node(STS), ...[0, 1, 2, 3].map((i) => node(pod(i)))],
  [edge(STS, APP, 'managed_by'), ...[0, 1, 2, 3].map((i) => edge(pod(i), STS, 'owned_by'))],
  1,
);

let n = 0;
const alert = (
  alertname: string,
  start: string,
  o: { entity: string; role?: 'cause' | 'symptom' | 'change'; end?: string },
): Alert => {
  const id = (++n).toString(16).padStart(16, '0');
  const e = node(o.entity);
  return {
    alert_id: `${id}@${T(start) / 1000}`,
    cluster_id: CLUSTER,
    source: 'alertmanager',
    fingerprint: id,
    alertname,
    labels: { alertname },
    annotations: {},
    severity: 'critical',
    status: o.end ? 'resolved' : 'firing',
    suppressed: 'none',
    starts_at: new Date(T(start)).toISOString(),
    ends_at: o.end ? new Date(T(o.end)).toISOString() : null,
    generator_url: null,
    classification: { role: o.role ?? 'cause', source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
    entity: { cluster_id: CLUSTER, kind: e.kind, namespace: e.namespace, name: e.name, uid: null },
    entity_resolution: 'informer',
    component: STS,
    received_at: new Date(T(start)).toISOString(),
  };
};
/** 旧代码从版本标签往返推导出的变更（kubernetes:cchp:153695 的形状） */
const roundTrip = (at = '17:42:07'): ChangeEvent => ({
  change_id: `kubernetes:${CLUSTER}:153695`,
  source: 'kubernetes',
  kind: 'rollout',
  refs: [APP],
  revision: 'canary-3cc28887b49f',
  previous_revision: 'canary-3cc28887b49f',
  actor: null,
  time: new Date(T(at)).toISOString(),
  link: null,
  targets: [STS, APP],
  summary:
    'gateway：cchp.io/release-id canary-3cc28887b49f → （无）；gateway：cchp.io/release-id （无） → canary-3cc28887b49f',
});
/** OOM 循环：15:48:30 起 gateway-3 一直在触发；重启中不断有新的告警触发，包括 17:42 之后的 */
const oomLoop = () => [
  alert('KubeContainerOOMKilled', '15:48:30', { entity: pod(3) }),
  alert('KubePodCrashLooping', '15:58:00', { entity: pod(3) }),
  alert('KubeContainerOOMKilled', '16:40:00', { entity: pod(1), end: '16:52:00' }),
  alert('KubeStatefulSetReplicasMismatch', '17:20:00', { entity: STS, end: '17:41:00' }),
  alert('KubeContainerOOMKilled', '17:48:00', { entity: pod(1) }),
  alert('KubeStatefulSetReplicasMismatch', '17:55:00', { entity: STS }),
];
const NOW = T('18:10:00');
const run = (alerts: Alert[], changes: ChangeEvent[]) =>
  computeIncidents({ alerts, changes, graph, params: DEFAULT_RCA_PARAMS, now: NOW });

describe('晚于症状的变更（ADR 0142）', () => {
  it('CCHP gateway OOM 循环：17:42 的版本标签往返不进事件，根因是 StatefulSet gateway，没有歧义', () => {
    const inc = run(oomLoop(), [roundTrip()]);
    expect(inc).toHaveLength(1);
    expect(inc[0]!.group.alerts).toHaveLength(6);
    expect(inc[0]!.group.changes).toEqual([]);
    expect(inc[0]!.ranking.root).toMatchObject({ component: STS, ambiguous: false });
    expect(inc[0]!.ranking.candidates.map((c) => c.component)).toEqual([STS]);
    expect(inc[0]!.ranking.candidates[0]!.terms.recent_change).toBe(0);
  });

  it('变更仍在分组里（经变更之后新开始的问题进入）时：不产生候选，不给变更先验与近期变更', () => {
    const xs = converge({ alerts: oomLoop(), changes: [], graph, params: DEFAULT_RCA_PARAMS, now: NOW })[0]!;
    const r = rankRoot({ group: { ...xs, changes: [roundTrip()] }, graph, params: DEFAULT_RCA_PARAMS });
    expect(r.root).toMatchObject({ component: STS, ambiguous: false });
    expect(r.candidates.map((c) => c.component)).toEqual([STS]);
    expect(r.candidates[0]!.terms).toMatchObject({ role_prior: 0.8, recent_change: 0 });
  });

  it('对照：变更早于最早症状时照常是近期变更；晚于最早症状但在容差之内（采集步长）也照常', () => {
    const xs = converge({ alerts: oomLoop(), changes: [], graph, params: DEFAULT_RCA_PARAMS, now: NOW })[0]!;
    for (const at of ['15:40:00', '15:52:00']) {
      const r = rankRoot({ group: { ...xs, changes: [roundTrip(at)] }, graph, params: DEFAULT_RCA_PARAMS });
      expect(r.candidates.map((c) => c.component).sort(), at).toEqual([APP, STS].sort());
      expect(r.candidates.find((c) => c.component === STS)!.terms, at).toMatchObject({
        role_prior: 1,
        recent_change: 1,
      });
    }
    expect(T('15:52:00') - T('15:48:30')).toBeLessThan(CHANGE_ONSET_TOLERANCE_MS);
  });

  it('变更之后重新触发的告警：所在组件的问题更早开始，变更不解释它；变更之后才开始的问题照常由变更解释', () => {
    // 问题在变更之后才开始：同样的告警由这次变更解释，归到同一个事件，变更是近期变更
    const fresh = [
      alert('KubeContainerOOMKilled', '17:48:00', { entity: pod(1) }),
      alert('KubeStatefulSetReplicasMismatch', '17:55:00', { entity: STS }),
    ];
    const inc = run(fresh, [roundTrip()]);
    expect(inc).toHaveLength(1);
    expect(inc[0]!.group.changes.map((c) => c.change_id)).toEqual([roundTrip().change_id]);
    expect(inc[0]!.ranking.candidates.find((c) => c.component === STS)!.terms.recent_change).toBe(1);
  });

  it('管理应用在变更之后自己告警（同步失败）：变更经它进入事件，但仍不给任何候选变更先验与近期变更', () => {
    const argo = { ...alert('ArgoCDProdSyncFailed', '17:43:00', { entity: APP }), component: APP };
    const inc = run([...oomLoop(), argo], [roundTrip()]);
    // 应用的告警经 gateway → managed_by 与 gateway 的告警合并（ADR 0104 §14，与本 ADR 无关），变更由应用的告警带入
    expect(inc).toHaveLength(1);
    expect(inc[0]!.group.changes.map((c) => c.change_id)).toEqual([roundTrip().change_id]);
    for (const c of inc[0]!.ranking.candidates) {
      expect(c.terms, c.component).toMatchObject({ role_prior: 0.8, recent_change: 0 });
      expect(c.source, c.component).toBe('alert');
    }
  });
});
