// 实体解析（DESIGN §3.3）：告警标签 → 实体候选 → 按顺序查找 informer 缓存、24 小时墓碑、kube-state-metrics 历史。
import type { AlertCatalogEntry, ClusterId, ComponentKey, EntityRef, Labels, MetricSeries } from '@srenautix/contract';
import { NAMESPACE_KIND, tryNodeKey } from './keys.js';
import type { TopologyStore } from './topology/store.js';

/** 告警自带的 entity_kind 标签值 → Kubernetes Kind */
const LABEL_KIND: Record<string, string> = {
  pod: 'Pod',
  node: 'Node',
  pvc: 'PersistentVolumeClaim',
  persistentvolumeclaim: 'PersistentVolumeClaim',
  deployment: 'Deployment',
  statefulset: 'StatefulSet',
  daemonset: 'DaemonSet',
  job: 'Job',
  cronjob: 'CronJob',
  service: 'Service',
  namespace: 'Namespace',
};

// 没有目录条目时按标签推断，越具体的越靠前
const HEURISTICS: ReadonlyArray<{ label: string; kind: string; namespaced: boolean }> = [
  { label: 'pod', kind: 'Pod', namespaced: true },
  { label: 'persistentvolumeclaim', kind: 'PersistentVolumeClaim', namespaced: true },
  { label: 'deployment', kind: 'Deployment', namespaced: true },
  { label: 'statefulset', kind: 'StatefulSet', namespaced: true },
  { label: 'daemonset', kind: 'DaemonSet', namespaced: true },
  { label: 'replicaset', kind: 'ReplicaSet', namespaced: true },
  { label: 'job_name', kind: 'Job', namespaced: true },
  { label: 'cronjob', kind: 'CronJob', namespaced: true },
  { label: 'horizontalpodautoscaler', kind: 'HorizontalPodAutoscaler', namespaced: true },
  { label: 'node', kind: 'Node', namespaced: false },
  { label: 'service', kind: 'Service', namespaced: true },
];

export interface EntityCandidate {
  entity: EntityRef | null;
  /** 解析不到实体时用于命名空间伪组件 */
  namespace: string | null;
  fromLabels: boolean;
}

function stripPort(v: string): string {
  return v.replace(/:[0-9]+$/, '');
}

/** 从告警标签取实体候选：标签契约 → 目录条目的映射 → 按标签推断 */
export function alertEntityCandidate(
  labels: Labels,
  entry: AlertCatalogEntry | undefined,
  clusterId: ClusterId,
): EntityCandidate {
  const namespace = labels.namespace || null;
  const make = (kind: string, ns: string | null, name: string): EntityRef => ({
    cluster_id: clusterId,
    kind,
    namespace: kind === 'Node' || kind === 'PersistentVolume' ? null : ns,
    name,
    uid: null,
  });
  if (labels.entity && labels.entity_kind) {
    const kind = LABEL_KIND[labels.entity_kind.toLowerCase()] ?? labels.entity_kind;
    return { entity: make(kind, namespace, labels.entity), namespace, fromLabels: true };
  }
  if (entry) {
    const m = entry.entity;
    if (m.kind === 'cluster') {
      return { entity: null, namespace, fromLabels: false };
    }
    const ns = labels[m.namespace_label ?? 'namespace'] || null;
    for (const l of m.name_labels) {
      const v = labels[l];
      if (v) {
        return { entity: make(m.kind, ns, m.kind === 'Node' ? stripPort(v) : v), namespace: ns, fromLabels: false };
      }
    }
    return { entity: null, namespace: ns, fromLabels: false };
  }
  for (const h of HEURISTICS) {
    const v = labels[h.label];
    if (v && (!h.namespaced || namespace)) {
      return { entity: make(h.kind, namespace, v), namespace, fromLabels: false };
    }
  }
  return { entity: null, namespace, fromLabels: false };
}

export type ResolutionLayer = 'labels' | 'informer' | 'tombstone' | 'ksm_history' | 'unresolved';

export interface Resolution {
  entity: EntityRef | null;
  layer: ResolutionLayer;
  /** 告警归属的拓扑组件；解析失败时为命名空间伪组件，连命名空间也没有时为 null */
  component: ComponentKey | null;
}

/** kube-state-metrics 历史查询：在时刻 at 求值的 instant 查询 */
export type InstantQuery = (expr: string, at: number) => Promise<MetricSeries[]>;

export const TOMBSTONE_MS = 24 * 3_600_000;

function quote(v: string): string {
  return JSON.stringify(v);
}

export interface KsmFacts {
  uid: string | null;
  /** 从实体沿 owner 向上的链，最后一项是组件 */
  owners: Array<{ kind: string; name: string }>;
}

/**
 * 用 kube-state-metrics 历史查 Pod 的 uid 与 owner 链（kube_pod_info、kube_pod_owner、kube_replicaset_owner）。
 * 只处理 Pod；其余实体在 informer 与墓碑中都找不到时，组件就是实体本身
 */
export async function ksmPodFacts(
  query: InstantQuery,
  namespace: string,
  pod: string,
  at: number,
): Promise<KsmFacts | null> {
  const sel = `namespace=${quote(namespace)},pod=${quote(pod)}`;
  const [info, owner] = await Promise.all([
    query(`max by (uid) (last_over_time(kube_pod_info{${sel}}[1h]))`, at),
    query(
      `max by (owner_kind, owner_name) (last_over_time(kube_pod_owner{${sel},owner_is_controller="true"}[1h]))`,
      at,
    ),
  ]);
  if (info.length === 0 && owner.length === 0) {
    return null;
  }
  const owners: KsmFacts['owners'] = [];
  const o = owner[0]?.labels;
  if (o?.owner_kind && o.owner_kind !== '<none>' && o.owner_name) {
    owners.push({ kind: o.owner_kind, name: o.owner_name });
    if (o.owner_kind === 'ReplicaSet') {
      const rs = await query(
        `max by (owner_kind, owner_name) (last_over_time(kube_replicaset_owner{namespace=${quote(namespace)},replicaset=${quote(o.owner_name)}}[1h]))`,
        at,
      );
      const r = rs[0]?.labels;
      if (r?.owner_kind && r.owner_kind !== '<none>' && r.owner_name) {
        owners.push({ kind: r.owner_kind, name: r.owner_name });
      }
    }
  }
  return { uid: info[0]?.labels.uid ?? null, owners };
}

export interface EntityResolverOptions {
  store: TopologyStore;
  /** 不提供时跳过 kube-state-metrics 历史这一层 */
  ksmQuery?: InstantQuery;
}

export class EntityResolver {
  constructor(private readonly opts: EntityResolverOptions) {}

  async resolve(candidate: EntityCandidate, at: number, now: number): Promise<Resolution> {
    // 标签里的命名空间或对象名不能构成合法的键（ADR 0034）时，按解析不到处理
    const pseudo = candidate.namespace ? tryNodeKey(NAMESPACE_KIND, null, candidate.namespace) : null;
    const e = candidate.entity;
    const key = e ? tryNodeKey(e.kind, e.namespace, e.name) : null;
    if (e === null || key === null) {
      return { entity: null, layer: 'unresolved', component: pseudo };
    }
    // informer 缓存：告警时刻的拓扑
    const graph = this.opts.store.asOf(at);
    const live = graph.node(key);
    if (live) {
      return {
        entity: { ...e, uid: live.uid },
        layer: candidate.fromLabels ? 'labels' : 'informer',
        component: graph.componentOf(key),
      };
    }
    // 24 小时墓碑：告警时刻之后才出现的对象，或已删除不超过 24 小时的对象
    const seen = this.opts.store.lastSeen(key);
    if (seen && (seen.to === null || now - seen.to <= TOMBSTONE_MS)) {
      const g = this.opts.store.asOf(seen.to === null ? Math.max(seen.from, at) : seen.to - 1);
      return { entity: { ...e, uid: seen.node.uid }, layer: 'tombstone', component: g.componentOf(key) };
    }
    if (this.opts.ksmQuery && e.kind === 'Pod' && e.namespace) {
      const facts = await ksmPodFacts(this.opts.ksmQuery, e.namespace, e.name, at);
      if (facts) {
        const top = facts.owners[facts.owners.length - 1];
        return {
          entity: { ...e, uid: facts.uid },
          layer: 'ksm_history',
          component: (top ? tryNodeKey(top.kind, e.namespace, top.name) : null) ?? key,
        };
      }
    }
    // 告警自带实体标签时信任它，组件是实体本身
    if (candidate.fromLabels) {
      return { entity: e, layer: 'labels', component: key };
    }
    return { entity: null, layer: 'unresolved', component: pseudo };
  }
}
