import {
  AppsV1Api,
  AutoscalingV2Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  makeInformer,
  NetworkingV1Api,
  PolicyV1Api,
  type Informer,
  type KubernetesListObject,
  type KubernetesObject,
  type ObjectCache,
} from '@kubernetes/client-node';
import type { ComponentType, OperatorConvention, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { buildKubeTopology, type KubeObject } from '@srenautix/core';
import { logger } from '../log.js';
import { edgeKey, sameContent, type TopologyChange, type TopologyStore } from './store.js';

/** 一种被 watch 的资源：apiVersion 与 kind 写回对象（list 返回的条目不带它们）。 */
interface Resource {
  apiVersion: string;
  kind: string;
  path: string;
  list: () => Promise<KubernetesListObject<KubernetesObject>>;
  /** 只用于集群状态检测器（ADR 0105），不进入拓扑 */
  healthOnly?: boolean;
}

/**
 * 单集群安装的拓扑来源（DESIGN §4.1）：server 用只读凭证 list + watch 下面这些资源。
 * Secret 不在其中（只按名称引用）；ConfigMap 的值只用于找出 Service DNS 名，不保存。
 */
function resources(kc: KubeConfig): Resource[] {
  const core = kc.makeApiClient(CoreV1Api);
  const apps = kc.makeApiClient(AppsV1Api);
  const batch = kc.makeApiClient(BatchV1Api);
  const net = kc.makeApiClient(NetworkingV1Api);
  const hpa = kc.makeApiClient(AutoscalingV2Api);
  const policy = kc.makeApiClient(PolicyV1Api);
  const r = (apiVersion: string, kind: string, path: string, list: () => Promise<unknown>): Resource => ({
    apiVersion,
    kind,
    path,
    list: list as () => Promise<KubernetesListObject<KubernetesObject>>,
  });
  return [
    r('v1', 'Namespace', '/api/v1/namespaces', () => core.listNamespace()),
    r('v1', 'Node', '/api/v1/nodes', () => core.listNode()),
    r('v1', 'Pod', '/api/v1/pods', () => core.listPodForAllNamespaces()),
    r('v1', 'PersistentVolumeClaim', '/api/v1/persistentvolumeclaims', () =>
      core.listPersistentVolumeClaimForAllNamespaces(),
    ),
    r('v1', 'PersistentVolume', '/api/v1/persistentvolumes', () => core.listPersistentVolume()),
    r('v1', 'Service', '/api/v1/services', () => core.listServiceForAllNamespaces()),
    r('v1', 'Endpoints', '/api/v1/endpoints', () => core.listEndpointsForAllNamespaces()),
    r('v1', 'ConfigMap', '/api/v1/configmaps', () => core.listConfigMapForAllNamespaces()),
    r('apps/v1', 'Deployment', '/apis/apps/v1/deployments', () => apps.listDeploymentForAllNamespaces()),
    r('apps/v1', 'ReplicaSet', '/apis/apps/v1/replicasets', () => apps.listReplicaSetForAllNamespaces()),
    r('apps/v1', 'StatefulSet', '/apis/apps/v1/statefulsets', () => apps.listStatefulSetForAllNamespaces()),
    r('apps/v1', 'DaemonSet', '/apis/apps/v1/daemonsets', () => apps.listDaemonSetForAllNamespaces()),
    r('batch/v1', 'Job', '/apis/batch/v1/jobs', () => batch.listJobForAllNamespaces()),
    r('batch/v1', 'CronJob', '/apis/batch/v1/cronjobs', () => batch.listCronJobForAllNamespaces()),
    r('networking.k8s.io/v1', 'Ingress', '/apis/networking.k8s.io/v1/ingresses', () =>
      net.listIngressForAllNamespaces(),
    ),
    r('networking.k8s.io/v1', 'NetworkPolicy', '/apis/networking.k8s.io/v1/networkpolicies', () =>
      net.listNetworkPolicyForAllNamespaces(),
    ),
    r('autoscaling/v2', 'HorizontalPodAutoscaler', '/apis/autoscaling/v2/horizontalpodautoscalers', () =>
      hpa.listHorizontalPodAutoscalerForAllNamespaces(),
    ),
    {
      ...r('policy/v1', 'PodDisruptionBudget', '/apis/policy/v1/poddisruptionbudgets', () =>
        policy.listPodDisruptionBudgetForAllNamespaces(),
      ),
      healthOnly: true,
    },
  ];
}

/** 期望拓扑与 PG 中当前打开的 informer 行之间的差异：删除在前，新增与变化在后。 */
export function diffTopology(
  desired: { nodes: readonly TopologyNode[]; edges: readonly TopologyEdge[] },
  openNodes: ReadonlyMap<string, TopologyNode | TopologyEdge>,
  openEdges: ReadonlyMap<string, TopologyNode | TopologyEdge>,
  at: Date,
): TopologyChange[] {
  const wantNodes = new Map(desired.nodes.map((n) => [n.key, n]));
  const wantEdges = new Map(desired.edges.map((e) => [edgeKey(e), e]));
  const out: TopologyChange[] = [];
  for (const [k, e] of openEdges) {
    if (!wantEdges.has(k)) {
      out.push({ op: 'edge_delete', at, source: 'informer', edge: e as TopologyEdge });
    }
  }
  for (const [k, n] of openNodes) {
    if (!wantNodes.has(k)) {
      out.push({ op: 'node_delete', at, source: 'informer', node: n as TopologyNode });
    }
  }
  for (const [k, n] of wantNodes) {
    const cur = openNodes.get(k);
    if (!cur || !sameContent(cur, n)) {
      out.push({ op: 'node_upsert', at, source: 'informer', node: n });
    }
  }
  for (const [k, e] of wantEdges) {
    const cur = openEdges.get(k);
    if (!cur || !sameContent(cur, e)) {
      out.push({ op: 'edge_upsert', at, source: 'informer', edge: e });
    }
  }
  return out;
}

export interface InformerTopologyOptions {
  store: TopologyStore;
  clusterId: string;
  /** 不填时用集群内的 ServiceAccount（loadFromCluster）。 */
  kubeconfigPath?: string;
  signal: AbortSignal;
  /** 领域包 components.yaml 的组件类型与 Operator 约定边。 */
  componentTypes?: readonly ComponentType[];
  conventions?: readonly OperatorConvention[];
  /** 有变化时最多每隔这么久写一次（默认 2 秒）。 */
  flushMs?: number;
}

export interface InformerTopology {
  /** 全部资源完成首次 list 并写入一次拓扑后 resolve。 */
  ready: Promise<void>;
  /** 最近一次成功写入拓扑的时间（informer 新鲜度，控制台集群页显示）。 */
  lastFlushAt(): Date | null;
  /** 集群状态检测器用的对象（完整对象，带 status）；首次 list 完成之前为 null */
  healthObjects(): KubernetesObject[] | null;
  stop(): Promise<void>;
}

/**
 * 单集群模式的拓扑：对每种资源 list + watch，任何变化都标记为脏；每隔 flushMs 用缓存中的全部对象重建拓扑
 * （packages/core 的 buildKubeTopology），与 PG 中 source=informer 的打开行比较后只写差异。
 * 每次重建都是全量对账，因此重新 list（断线、410 Gone）之后删除的对象也会被关闭。
 */
export function startInformerTopology(o: InformerTopologyOptions): InformerTopology {
  const kc = new KubeConfig();
  if (o.kubeconfigPath) {
    kc.loadFromFile(o.kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  const flushMs = o.flushMs ?? 2_000;
  const informers: Array<{ res: Resource; inf: Informer<KubernetesObject> & ObjectCache<KubernetesObject> }> = [];
  let dirty = true;
  let stopped = false;
  let flushing: Promise<void> | null = null;
  let last: Date | null = null;
  const markDirty = () => {
    dirty = true;
  };

  for (const res of resources(kc)) {
    const inf = makeInformer(kc, res.path, res.list);
    inf.on('add', markDirty);
    inf.on('update', markDirty);
    inf.on('delete', markDirty);
    inf.on('connect', markDirty);
    inf.on('error', (err) => {
      if (stopped) {
        return;
      }
      logger.warn('拓扑 informer 中断，5 秒后重新 list', { resource: res.kind, error: err });
      markDirty();
      setTimeout(() => {
        if (!stopped) {
          inf.start().catch((e: unknown) => logger.warn('拓扑 informer 重启失败', { resource: res.kind, error: e }));
        }
      }, 5_000).unref();
    });
    informers.push({ res, inf });
  }

  const collect = (): KubeObject[] => {
    const out: KubeObject[] = [];
    for (const { res, inf } of informers) {
      if (res.healthOnly) {
        continue;
      }
      for (const obj of inf.list()) {
        out.push({ ...(obj as unknown as KubeObject), apiVersion: res.apiVersion, kind: res.kind });
      }
    }
    return out;
  };

  const flush = async (): Promise<void> => {
    dirty = false;
    const at = new Date();
    const snap = buildKubeTopology(collect(), {
      componentTypes: o.componentTypes ?? [],
      conventions: o.conventions ?? [],
    });
    const openNodes = await o.store.openKeys(o.clusterId, 'node', 'informer');
    const openEdges = await o.store.openKeys(o.clusterId, 'edge', 'informer');
    const changes = diffTopology(snap, openNodes, openEdges, at);
    if (changes.length) {
      const n = await o.store.apply(o.clusterId, changes);
      logger.debug('拓扑已更新', { cluster_id: o.clusterId, changes: n });
    }
    last = at;
  };

  const tick = () => {
    if (stopped || flushing || !dirty) {
      return;
    }
    flushing = flush()
      .catch((e: unknown) => {
        // 状态库不可用等：保持脏标记，下一轮重试
        dirty = true;
        logger.warn('拓扑写入失败，下一轮重试', { error: e });
      })
      .finally(() => {
        flushing = null;
      });
  };

  const ready = (async () => {
    await Promise.all(informers.map(({ inf }) => inf.start()));
    await flush();
  })();
  const timer = setInterval(tick, flushMs);
  timer.unref();

  const stop = async () => {
    stopped = true;
    clearInterval(timer);
    await Promise.all(informers.map(({ inf }) => inf.stop()));
    await flushing;
  };
  o.signal.addEventListener('abort', () => void stop(), { once: true });

  const HEALTH_KINDS = new Set([
    'Pod',
    'ReplicaSet',
    'Deployment',
    'StatefulSet',
    'DaemonSet',
    'Job',
    'PodDisruptionBudget',
  ]);
  const healthObjects = (): KubernetesObject[] | null => {
    if (last === null) {
      return null;
    }
    const out: KubernetesObject[] = [];
    for (const { res, inf } of informers) {
      if (HEALTH_KINDS.has(res.kind)) {
        for (const obj of inf.list()) {
          out.push({ ...obj, kind: res.kind, apiVersion: res.apiVersion });
        }
      }
    }
    return out;
  };

  return { ready, lastFlushAt: () => last, healthObjects, stop };
}
