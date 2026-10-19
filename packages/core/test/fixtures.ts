// 测试共用的输入：kubectl 导出、组件类型与 Operator 约定、告警目录。
// 组件类型与目录条目按领域包的写法给出，内容与 packs/ 中对应的内置包一致
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AlertCatalogEntry, ComponentType, OperatorConvention } from '@srenautix/contract';
import { parse } from 'yaml';
import { AlertCatalog, buildKubeTopology, flattenKubeList, type KubeObject, TopologyStore } from '../src/index.js';

export const CLUSTER = 'kind-demo';

export function testdata(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./testdata/${name}`, import.meta.url)), 'utf8');
}

export function clusterObjects(): KubeObject[] {
  return flattenKubeList(parse(testdata('cluster.yaml')));
}

export const COMPONENT_TYPES: ComponentType[] = [
  { id: 'postgres.cluster', match: { kind: 'Cluster', api_group: 'postgresql.cnpg.io' } },
  { id: 'kubernetes.coredns', hub: true, match: { kind: 'Deployment', labels: { 'k8s-app': 'kube-dns' } } },
  { id: 'kubernetes.cni', hub: true, match: { kind: 'DaemonSet', labels: { 'k8s-app': 'cilium' } } },
];

export const CONVENTIONS: OperatorConvention[] = [
  {
    id: 'cnpg-app-secret',
    from: { kind: 'Secret', name_pattern: '^(.+)-app$' },
    to: { kind: 'Cluster', name: '$1' },
    relation: 'operator_convention',
    scope: 'service',
  },
];

export const CATALOG_ENTRIES: AlertCatalogEntry[] = [
  {
    id: 'pod-crash-looping',
    alertname: 'KubePodCrashLooping',
    expr: 'max_over_time(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff", job="kube-state-metrics"}[5m]) >= 1',
    role: 'cause',
    entity: { kind: 'Pod', name_labels: ['pod'] },
  },
  {
    id: 'container-oom-killed',
    alertname: 'KubeContainerOOMKilled',
    expr: 'increase(kube_pod_container_status_restarts_total[10m]) > 0 and on (namespace, pod, container) kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1',
    role: 'cause',
    entity: { kind: 'Pod', name_labels: ['pod'] },
  },
  {
    id: 'pv-filling-up-warning',
    alertname: 'KubePersistentVolumeFillingUp',
    match_labels: { severity: 'warning' },
    expr: 'kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes < 0.15 and predict_linear(kubelet_volume_stats_available_bytes[6h], 4 * 24 * 3600) < 0',
    role: 'forecast',
    entity: { kind: 'PersistentVolumeClaim', name_labels: ['persistentvolumeclaim'] },
  },
  {
    id: 'node-not-ready',
    alertname: 'KubeNodeNotReady',
    expr: 'kube_node_status_condition{job="kube-state-metrics",condition="Ready",status="true"} == 0',
    role: 'cause',
    entity: { kind: 'Node', name_labels: ['node'] },
  },
  {
    id: 'deployment-replicas-mismatch',
    alertname: 'KubeDeploymentReplicasMismatch',
    expr: 'kube_deployment_spec_replicas != kube_deployment_status_replicas_available',
    role: 'symptom',
    entity: { kind: 'Deployment', name_labels: ['deployment'] },
  },
];

export function catalog(): AlertCatalog {
  return new AlertCatalog([{ pack: 'test', entries: CATALOG_ENTRIES }]);
}

/** 应用的规则表达式：目录之外的告警按 rules API 的表达式分类 */
export const RULE_EXPRS = new Map<string, string>([
  [
    'ApiErrorRatioHigh',
    'sum(rate(http_requests_total{job="api",code=~"5.."}[5m])) / sum(rate(http_requests_total{job="api"}[5m])) > 0.05',
  ],
  ['WorkerJobFailuresHigh', 'sum(rate(worker_jobs_failed_total[5m])) > 1'],
  [
    'FrontendErrorRatioHigh',
    'sum(rate(nginx_http_requests_total{status=~"5.."}[5m])) / sum(rate(nginx_http_requests_total[5m])) > 0.05',
  ],
]);

export const T0 = Date.parse('2026-10-15T10:00:00Z');
export const MIN = 60_000;

/** 在 T0 - 1 小时写入 kubectl 导出的拓扑 */
export function clusterStore(): TopologyStore {
  let n = 0;
  const store = new TopologyStore({
    clusterId: CLUSTER,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  store.reconcile(
    buildKubeTopology(clusterObjects(), { componentTypes: COMPONENT_TYPES, conventions: CONVENTIONS }),
    T0 - 60 * MIN,
    'informer',
  );
  return store;
}
