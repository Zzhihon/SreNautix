import type { Alert, ChangeEvent, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '../src/index.js';
import { CLUSTER } from './fixtures.js';

// Kind kind-e2e 39576878796 的时序（ADR 0104 §14）：shop 的 api 与 checkout 由同一个 Argo 应用管理。
// api 的 CPUThrottlingHigh 从 09:37 一直触发；09:38 api 的 sidecar 重启一次（alert-too-sensitive）；
// 09:44 checkout 发布了新的 ReplicaSet，新 Pod 崩溃（bad-config-rollout）；09:51 一条 ShopRolloutIncomplete
// 解析不到对象，落在 Namespace:shop 上。checkout 的告警不应并进 api 的事件。

const T = (hhmm: string) => Date.parse(`2026-10-21T${hhmm}:00Z`);
const APP = 'Application.argoproj.io:argocd/shop';
const API = 'Deployment:shop/api';
const CHECKOUT = 'Deployment:shop/checkout';

const node = (key: string): TopologyNode => {
  const [kind, rest] = key.split(':') as [string, string];
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub: false };
};
const edge = (from: string, to: string, relation: string): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: 'structural',
  confidence: 1,
  scope: 'service',
  evidence: 't',
});
const graph = new TopologyGraph(
  [
    APP,
    API,
    CHECKOUT,
    'ReplicaSet:shop/api-1',
    'Pod:shop/api-1-a',
    'Pod:shop/api-1-b',
    'ReplicaSet:shop/checkout-2',
    'Pod:shop/checkout-2-x',
    'Namespace:shop',
  ].map(node),
  [
    edge('ReplicaSet:shop/api-1', API, 'owned_by'),
    edge('Pod:shop/api-1-a', 'ReplicaSet:shop/api-1', 'owned_by'),
    edge('Pod:shop/api-1-b', 'ReplicaSet:shop/api-1', 'owned_by'),
    edge('ReplicaSet:shop/checkout-2', CHECKOUT, 'owned_by'),
    edge('Pod:shop/checkout-2-x', 'ReplicaSet:shop/checkout-2', 'owned_by'),
    edge(API, APP, 'managed_by'),
    edge(CHECKOUT, APP, 'managed_by'),
  ],
  1,
);

let n = 0;
const alert = (
  alertname: string,
  at: string,
  o: { pod?: string; role: Alert['classification']['role']; end?: string; component?: string },
): Alert => {
  const id = (++n).toString(16).padStart(16, '0');
  const entity = o.pod
    ? { cluster_id: CLUSTER, kind: 'Pod', namespace: 'shop', name: o.pod.split('/')[1]!, uid: null }
    : null;
  return {
    alert_id: `${id}@${T(at) / 1000}`,
    cluster_id: CLUSTER,
    source: 'alertmanager',
    fingerprint: id,
    alertname,
    labels: { alertname, namespace: 'shop' },
    annotations: {},
    severity: 'warning',
    status: o.end ? 'resolved' : 'firing',
    suppressed: 'none',
    starts_at: new Date(T(at)).toISOString(),
    ends_at: o.end ? new Date(T(o.end)).toISOString() : null,
    generator_url: null,
    classification: { role: o.role, source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
    entity,
    entity_resolution: entity ? 'informer' : 'unresolved',
    component: o.component ?? (o.pod ? `Pod:${o.pod}` : 'Namespace:shop'),
    received_at: new Date(T(at)).toISOString(),
  };
};
const rollout: ChangeEvent = {
  change_id: 'kubernetes:kind:44',
  source: 'kubernetes',
  kind: 'rollout',
  refs: [APP],
  revision: null,
  actor: null,
  time: new Date(T('09:44')).toISOString(),
  link: null,
  targets: [CHECKOUT, APP],
  summary: 'checkout：新的 ReplicaSet checkout-2',
};

const throttleA = alert('CPUThrottlingHigh', '09:37', { pod: 'shop/api-1-a', role: 'symptom' });
const throttleB = alert('CPUThrottlingHigh', '09:37', { pod: 'shop/api-1-b', role: 'symptom' });
const apiRestart = alert('ShopPodRestarted', '09:38', { pod: 'shop/api-1-a', role: 'cause', end: '09:43' });
const crash = alert('KubePodCrashLooping', '09:46', { pod: 'shop/checkout-2-x', role: 'cause' });
const coRestart = alert('ShopPodRestarted', '09:46', { pod: 'shop/checkout-2-x', role: 'cause' });
const nsAlert = alert('ShopRolloutIncomplete', '09:51', { role: 'symptom' });

const groups = (alerts: Alert[], changes: ChangeEvent[] = [rollout]) =>
  computeIncidents({ alerts, changes, graph, params: DEFAULT_RCA_PARAMS, now: T('10:00') }).map((i) =>
    i.group.alerts.map((a) => `${a.alert.alertname}@${a.component}`).sort(),
  );
const together = (gs: string[][], a: string, b: string) =>
  gs.some((g) => g.some((x) => x.startsWith(a)) && g.some((x) => x.startsWith(b)));
/** 落在 Deployment 本身上的告警（例如 KubeDeploymentReplicasMismatch） */
const onDeployment = (alertname: string, at: string, comp: string): Alert => ({
  ...alert(alertname, at, { role: 'cause', component: comp }),
  entity: { cluster_id: CLUSTER, kind: 'Deployment', namespace: 'shop', name: comp.split('/')[1]!, uid: null },
  entity_resolution: 'informer',
});

describe('同一应用下的兄弟工作负载与命名空间告警不桥接事件（ADR 0104 §14）', () => {
  it('(a) checkout 的发布（目标含管理应用）不解释 api 上之后才开始的告警；api 自己的发布照常解释', () => {
    const late = onDeployment('KubeDeploymentReplicasMismatch', '09:47', API);
    expect(
      together(groups([throttleA, apiRestart, crash, late]), 'KubePodCrashLooping', 'KubeDeploymentReplicasMismatch'),
    ).toBe(false);
    const apiRollout: ChangeEvent = { ...rollout, change_id: 'kubernetes:kind:45', targets: [API, APP] };
    const own = groups([crash, late], [apiRollout]);
    expect(own.find((g) => g.some((x) => x.startsWith('KubeDeploymentReplicasMismatch')))).toHaveLength(1);
    // 只有应用一个目标的变更（例如 Argo 同步）仍然解释它管理的工作负载
    const sync: ChangeEvent = { ...rollout, change_id: 'argocd:shop:7', kind: 'gitops_sync', targets: [APP] };
    const coDeploy = onDeployment('KubeDeploymentRolloutStuck', '09:46', CHECKOUT);
    expect(
      together(groups([coDeploy, late], [sync]), 'KubeDeploymentRolloutStuck', 'KubeDeploymentReplicasMismatch'),
    ).toBe(true);
    expect(
      together(groups([coDeploy, late], [rollout]), 'KubeDeploymentRolloutStuck', 'KubeDeploymentReplicasMismatch'),
    ).toBe(false);
  });

  it('(b) 不归属变更的命名空间告警只并入一个分组，不把两次发布的分组连起来', () => {
    const apiRollout: ChangeEvent = {
      ...rollout,
      change_id: 'kubernetes:kind:30',
      time: new Date(T('09:30')).toISOString(),
      targets: [API, APP],
    };
    const apiCrash = alert('KubePodCrashLooping', '09:32', { pod: 'shop/api-1-a', role: 'cause', end: '09:40' });
    const ns0 = alert('ShopRolloutIncomplete', '09:25', { role: 'symptom' });
    const ns1 = alert('ShopRolloutIncomplete', '09:35', { role: 'symptom', end: '09:50' });
    const gs = groups([apiCrash, ns0, ns1, crash, nsAlert], [apiRollout, rollout]);
    expect(
      together(gs, 'KubePodCrashLooping@Deployment:shop/api', 'KubePodCrashLooping@Deployment:shop/checkout'),
    ).toBe(false);
    // 并入的是开始时间最近的同一对象告警所在的分组（09:35 那条，api 的发布）
    expect(
      gs
        .find((g) => g.includes('KubePodCrashLooping@Deployment:shop/api'))!
        .filter((x) => x.startsWith('ShopRolloutIncomplete')),
    ).toHaveLength(2);
  });

  it('(b) 不归属的同名告警彼此仍然合并成一组', () => {
    const a = alert('ShopX', '09:39', { role: 'cause', end: '09:48' });
    const b = alert('ShopX', '09:47', { role: 'cause' });
    expect(groups([a, b], [])).toEqual([['ShopX@Namespace:shop', 'ShopX@Namespace:shop']]);
  });

  it('Kind 39576878796 的完整时序：checkout 的告警不进 api 的事件', () => {
    const late = onDeployment('KubeDeploymentReplicasMismatch', '09:47', API);
    const gs = groups([throttleA, throttleB, apiRestart, crash, coRestart, nsAlert, late]);
    expect(together(gs, 'KubePodCrashLooping', 'CPUThrottlingHigh')).toBe(false);
    expect(together(gs, 'KubePodCrashLooping', 'ShopRolloutIncomplete')).toBe(true);
  });
});
