// 从 kube-state-metrics 历史重建拓扑（DESIGN §4.1、§14.5）：用于回放与观察模式的首次成绩单。
// 每条序列有样本的时段就是对应节点或边的有效区间；相邻样本间隔超过 gapMs 时拆成两段。
import type { MetricSeries, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { ComponentKeyError, nodeKey } from '../keys.js';
import { OWNED_BY } from './graph.js';
import { PROVENANCE_CONFIDENCE } from './kube.js';
import type { TopologyStore } from './store.js';

/** 重建需要的 range 查询；结果按同名键传给 ksmTopologyIntervals */
export const KSM_TOPOLOGY_QUERIES = {
  podInfo: 'max by (namespace, pod, node, uid) (kube_pod_info)',
  podOwner: 'max by (namespace, pod, owner_kind, owner_name) (kube_pod_owner{owner_is_controller="true"})',
  replicasetOwner: 'max by (namespace, replicaset, owner_kind, owner_name) (kube_replicaset_owner)',
  podPvc: 'max by (namespace, pod, persistentvolumeclaim) (kube_pod_spec_volumes_persistentvolumeclaims_info)',
  nodeInfo: 'max by (node) (kube_node_info)',
} as const;

export type KsmTopologyResults = { [K in keyof typeof KSM_TOPOLOGY_QUERIES]: MetricSeries[] };

export interface KsmInterval {
  item: { node: TopologyNode } | { edge: TopologyEdge };
  from: number;
  to: number;
}

function spans(s: MetricSeries, stepMs: number, gapMs: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  s.times.forEach((t, i) => {
    if (s.values[i] === null || s.values[i] === undefined) {
      return;
    }
    const last = out[out.length - 1];
    if (last && t - last[1] <= gapMs) {
      last[1] = t + stepMs;
    } else {
      out.push([t, t + stepMs]);
    }
  });
  return out;
}

function node(kind: string, namespace: string | null, name: string, uid: string | null = null): TopologyNode {
  return {
    key: nodeKey(kind, namespace, name),
    kind,
    namespace,
    name,
    uid,
    labels: {},
    component_type: null,
    hub: false,
  };
}

function edge(
  from: string,
  to: string,
  relation: string,
  scope: TopologyEdge['scope'],
  evidence: string,
): TopologyEdge {
  return {
    from,
    to,
    relation,
    provenance: 'structural',
    confidence: PROVENANCE_CONFIDENCE.structural,
    scope,
    evidence,
  };
}

export function ksmTopologyIntervals(results: KsmTopologyResults, stepMs: number, gapMs = 5 * 60_000): KsmInterval[] {
  const out: KsmInterval[] = [];
  /**
   * 一条序列产生的节点与边；标签里的对象不能构成合法的键时（ADR 0034）整条序列跳过，与 reader 相同
   */
  const series = (s: MetricSeries, build: (add: (item: KsmInterval['item']) => void) => void) => {
    const items: Array<KsmInterval['item']> = [];
    try {
      build((item) => items.push(item));
    } catch (e) {
      if (e instanceof ComponentKeyError) {
        return;
      }
      throw e;
    }
    for (const item of items) {
      for (const [from, to] of spans(s, stepMs, gapMs)) {
        out.push({ item, from, to });
      }
    }
  };
  for (const s of results.nodeInfo) {
    series(s, (add) => add({ node: node('Node', null, s.labels.node!) }));
  }
  for (const s of results.podInfo) {
    series(s, (add) => {
      const { namespace, pod, node: nodeName, uid } = s.labels;
      const p = node('Pod', namespace!, pod!, uid ?? null);
      add({ node: p });
      if (nodeName) {
        add({ edge: edge(p.key, nodeKey('Node', null, nodeName), 'runs_on', 'instance', 'kube_pod_info') });
      }
    });
  }
  for (const s of results.podOwner) {
    series(s, (add) => {
      const { namespace, pod, owner_kind, owner_name } = s.labels;
      if (!owner_kind || owner_kind === '<none>') {
        return;
      }
      add({ node: node(owner_kind, namespace!, owner_name!) });
      add({
        edge: edge(
          nodeKey('Pod', namespace, pod!),
          nodeKey(owner_kind, namespace, owner_name!),
          OWNED_BY,
          'service',
          'kube_pod_owner',
        ),
      });
    });
  }
  for (const s of results.replicasetOwner) {
    series(s, (add) => {
      const { namespace, replicaset, owner_kind, owner_name } = s.labels;
      add({ node: node('ReplicaSet', namespace!, replicaset!) });
      if (!owner_kind || owner_kind === '<none>') {
        return;
      }
      add({ node: node(owner_kind, namespace!, owner_name!) });
      add({
        edge: edge(
          nodeKey('ReplicaSet', namespace, replicaset!),
          nodeKey(owner_kind, namespace, owner_name!),
          OWNED_BY,
          'service',
          'kube_replicaset_owner',
        ),
      });
    });
  }
  for (const s of results.podPvc) {
    series(s, (add) => {
      const { namespace, pod, persistentvolumeclaim } = s.labels;
      add({ node: node('PersistentVolumeClaim', namespace!, persistentvolumeclaim!) });
      add({
        edge: edge(
          nodeKey('Pod', namespace, pod!),
          nodeKey('PersistentVolumeClaim', namespace, persistentvolumeclaim!),
          'mounts',
          'instance',
          'kube_pod_spec_volumes_persistentvolumeclaims_info',
        ),
      });
    });
  }
  return out;
}

/** 把重建结果写入拓扑存储（来源 ksm_history），按起点排序写入 */
export function loadKsmHistory(store: TopologyStore, intervals: readonly KsmInterval[]): void {
  for (const iv of [...intervals].sort((a, b) => a.from - b.from)) {
    store.addInterval(iv.item, iv.from, iv.to, 'ksm_history');
  }
}
