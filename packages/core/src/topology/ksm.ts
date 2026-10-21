// 从 kube-state-metrics 历史重建拓扑（DESIGN §4.1、§14.5）：用于回放与观察模式的首次成绩单。
// 每条序列有样本的时段就是对应节点或边的有效区间；相邻样本间隔超过 gapMs 时拆成两段。
import type { MetricSeries, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { ComponentKeyError, nodeKey as rawKey, scopedNamespace } from '../keys.js';

/** 集群级 kind（例如静态 Pod 的属主 Node）的键不带命名空间 */
const nodeKey = (kind: string, namespace: string | null | undefined, name: string) =>
  rawKey(kind, scopedNamespace(kind, namespace), name);
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
  /** Job 的属主（CronJob 创建的 Job 不当作发布的前置步骤，ADR 0104 §13） */
  jobOwner: 'max by (namespace, job_name, owner_kind, owner_name) (kube_job_owner{owner_is_controller="true"})',
  /** Pod 容器的镜像：发布之前的 Job 按镜像关联到发布（ADR 0104 §13） */
  podImages: 'max by (namespace, pod, image, image_id) (kube_pod_container_info)',
} as const;

/** 没有给出的查询按没有数据处理（早于这些查询导出的重建包） */
type OptionalKsmQuery = 'jobOwner' | 'podImages';
export type KsmTopologyResults = {
  [K in Exclude<keyof typeof KSM_TOPOLOGY_QUERIES, OptionalKsmQuery>]: MetricSeries[];
} & { [K in OptionalKsmQuery]?: MetricSeries[] };

/** 镜像比较用的形式：image_id 取 digest（sha256:…），image 取去掉运行时前缀的引用 */
export function normalizeImage(ref: string): string {
  const s = ref.trim().replace(/^[a-z-]+:\/\//, '');
  const at = s.indexOf('@sha256:');
  if (at >= 0) {
    return s.slice(at + 1);
  }
  return s.startsWith('sha256:') ? s : s.toLowerCase();
}

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

function node(kind: string, ns: string | null, name: string, uid: string | null = null): TopologyNode {
  const namespace = scopedNamespace(kind, ns);
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
  // Pod 的镜像在它的生命周期内不变：按 (命名空间, Pod) 汇总全部容器的 image 与 image_id
  const images = new Map<string, Set<string>>();
  for (const s of results.podImages ?? []) {
    const { namespace, pod, image, image_id } = s.labels;
    if (!namespace || !pod || !s.values.some((v) => v !== null && v !== undefined)) {
      continue;
    }
    const k = `${namespace}/${pod}`;
    const set = images.get(k) ?? new Set<string>();
    for (const ref of [image, image_id]) {
      if (ref && ref.trim()) {
        set.add(normalizeImage(ref));
      }
    }
    images.set(k, set);
  }
  for (const s of results.podInfo) {
    series(s, (add) => {
      const { namespace, pod, node: nodeName, uid } = s.labels;
      const p = node('Pod', namespace!, pod!, uid ?? null);
      const imgs = images.get(`${namespace}/${pod}`);
      if (imgs?.size) {
        p.images = [...imgs].sort();
      }
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
  for (const s of results.jobOwner ?? []) {
    series(s, (add) => {
      const { namespace, job_name, owner_kind, owner_name } = s.labels;
      add({ node: node('Job', namespace!, job_name!) });
      if (!owner_kind || owner_kind === '<none>') {
        return;
      }
      add({ node: node(owner_kind, namespace!, owner_name!) });
      add({
        edge: edge(
          nodeKey('Job', namespace, job_name!),
          nodeKey(owner_kind, namespace, owner_name!),
          OWNED_BY,
          'service',
          'kube_job_owner',
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
