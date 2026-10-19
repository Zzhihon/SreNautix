// 从 Kubernetes 对象（informer 缓存或 kubectl -o yaml 的 List）构建拓扑快照（DESIGN §4.2）。
// 只读取对象的名称与结构；Secret 的内容永远不读，只记录 secretKeyRef 引用的名称。
// ConfigMap 的值只用于找出 Service DNS 名，边的依据只写键名，不写值。
import type { ComponentType, Labels, OperatorConvention, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { nodeKey, parseKey } from '../keys.js';
import { OWNED_BY } from './graph.js';
import type { TopologySnapshot } from './store.js';

/** 来源对应的默认置信度（DESIGN §4.2） */
export const PROVENANCE_CONFIDENCE: Record<TopologyEdge['provenance'], number> = {
  structural: 1,
  runtime: 0.9,
  config_ref: 0.7,
  network_policy: 0.6,
  naming: 0.3,
};

export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: Labels;
    ownerReferences?: Array<{ apiVersion?: string; kind: string; name: string; uid?: string; controller?: boolean }>;
  };
  spec?: Record<string, unknown>;
  data?: Record<string, string>;
  subsets?: unknown;
}

export interface BuildOptions {
  componentTypes?: readonly ComponentType[];
  conventions?: readonly OperatorConvention[];
}

// 这些对象不作为拓扑节点：ConfigMap/Secret 只提供引用，Endpoints 只用于补全 Service 的选择
const NOT_NODES = new Set([
  'ConfigMap',
  'Secret',
  'Endpoints',
  'EndpointSlice',
  'NetworkPolicy',
  'Event',
  'ControllerRevision',
  'Namespace',
  'Lease',
]);

/** kubectl get -o yaml 的 List 或单个对象，展开为对象数组 */
export function flattenKubeList(doc: unknown): KubeObject[] {
  if (doc === null || typeof doc !== 'object') {
    throw new Error('不是 Kubernetes 对象');
  }
  const d = doc as { kind?: string; items?: unknown[] };
  if (d.kind === 'List' || d.kind?.endsWith('List')) {
    return (d.items ?? []).flatMap(flattenKubeList);
  }
  return [doc as KubeObject];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function matches(labels: Labels | undefined, selector: Record<string, unknown> | undefined): boolean {
  if (selector === undefined) {
    return false;
  }
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([k, v]) => labels?.[k] === v);
}

/** LabelSelector：matchLabels 加 matchExpressions（In、NotIn、Exists、DoesNotExist）；空选择器匹配全部 */
function selectorMatches(labels: Labels | undefined, selector: Record<string, unknown>): boolean {
  const ml = obj(selector.matchLabels);
  if (!Object.entries(ml).every(([k, v]) => labels?.[k] === v)) {
    return false;
  }
  return arr(selector.matchExpressions).every((ex) => {
    const key = String(ex.key);
    const values = (ex.values as string[] | undefined) ?? [];
    const v = labels?.[key];
    switch (ex.operator) {
      case 'In':
        return v !== undefined && values.includes(v);
      case 'NotIn':
        return v === undefined || !values.includes(v);
      case 'Exists':
        return v !== undefined;
      case 'DoesNotExist':
        return v === undefined;
      default:
        throw new Error(`不支持的选择器运算符：${String(ex.operator)}`);
    }
  });
}

function apiGroup(apiVersion: string): string {
  const i = apiVersion.indexOf('/');
  return i < 0 ? '' : apiVersion.slice(0, i);
}

function matchType(o: KubeObject, types: readonly ComponentType[]): ComponentType | undefined {
  return types.find((t) => {
    const m = t.match;
    return (
      m.kind === o.kind &&
      (m.api_group === undefined || m.api_group === apiGroup(o.apiVersion)) &&
      Object.entries(m.labels ?? {}).every(([k, v]) => o.metadata.labels?.[k] === v) &&
      (m.name_pattern === undefined || new RegExp(m.name_pattern).test(o.metadata.name)) &&
      (m.namespaces === undefined || m.namespaces.includes(o.metadata.namespace ?? ''))
    );
  });
}

function keyOf(o: KubeObject): string {
  return nodeKey(o.kind, o.metadata.namespace, o.metadata.name);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildKubeTopology(objects: readonly KubeObject[], opts: BuildOptions = {}): TopologySnapshot {
  const types = opts.componentTypes ?? [];
  const nodes = new Map<string, TopologyNode>();
  const edges = new Map<string, TopologyEdge>();
  const addEdge = (
    from: string,
    to: string,
    relation: string,
    provenance: TopologyEdge['provenance'],
    scope: TopologyEdge['scope'],
    evidence: string,
  ) => {
    if (from === to) {
      return;
    }
    const k = `${from}|${relation}|${to}`;
    if (!edges.has(k)) {
      edges.set(k, { from, to, relation, provenance, confidence: PROVENANCE_CONFIDENCE[provenance], scope, evidence });
    }
  };
  const addVirtual = (kind: string, namespace: string | null, name: string, hub: boolean) => {
    const key = nodeKey(kind, namespace, name);
    if (!nodes.has(key)) {
      nodes.set(key, { key, kind, namespace, name, uid: null, labels: {}, component_type: null, hub });
    }
    return key;
  };

  for (const o of objects) {
    if (NOT_NODES.has(o.kind)) {
      continue;
    }
    const t = matchType(o, types);
    const key = keyOf(o);
    nodes.set(key, {
      key,
      kind: o.kind,
      namespace: o.metadata.namespace ?? null,
      name: o.metadata.name,
      uid: o.metadata.uid ?? null,
      labels: o.metadata.labels ?? {},
      component_type: t?.id ?? null,
      hub: t?.hub ?? false,
    });
  }

  const byKind = (kind: string) => objects.filter((o) => o.kind === kind);
  const pods = byKind('Pod');
  const services = byKind('Service');
  const configMaps = new Map(byKind('ConfigMap').map((c) => [`${c.metadata.namespace}/${c.metadata.name}`, c]));
  const namespaces = new Map(byKind('Namespace').map((n) => [n.metadata.name, n.metadata.labels ?? {}]));

  // ownerReference：只为控制者生成 owned_by
  for (const o of objects) {
    if (NOT_NODES.has(o.kind)) {
      continue;
    }
    const refs = o.metadata.ownerReferences ?? [];
    const ctl = refs.find((r) => r.controller) ?? refs[0];
    if (ctl) {
      const ownerKey = nodeKey(ctl.kind, o.metadata.namespace, ctl.name);
      if (!nodes.has(ownerKey)) {
        addVirtual(ctl.kind, o.metadata.namespace ?? null, ctl.name, false);
      }
      addEdge(keyOf(o), ownerKey, OWNED_BY, 'structural', 'service', `ownerReference ${ctl.kind}/${ctl.name}`);
    }
  }

  for (const p of pods) {
    const ns = p.metadata.namespace!;
    const pk = keyOf(p);
    const spec = obj(p.spec);
    const nodeName = str(spec.nodeName);
    if (nodeName) {
      if (!nodes.has(nodeKey('Node', null, nodeName))) {
        addVirtual('Node', null, nodeName, false);
      }
      addEdge(pk, nodeKey('Node', null, nodeName), 'runs_on', 'structural', 'instance', `spec.nodeName ${nodeName}`);
    }
    const referencedConfigMaps = new Set<string>();
    for (const v of arr(spec.volumes)) {
      const claim = str(obj(v.persistentVolumeClaim).claimName);
      if (claim) {
        addEdge(
          pk,
          nodeKey('PersistentVolumeClaim', ns, claim),
          'mounts',
          'structural',
          'instance',
          `volume ${String(v.name)}`,
        );
      }
      const cm = str(obj(v.configMap).name);
      if (cm) {
        referencedConfigMaps.add(cm);
      }
      for (const src of arr(obj(v.projected).sources)) {
        const pcm = str(obj(src.configMap).name);
        if (pcm) {
          referencedConfigMaps.add(pcm);
        }
      }
    }
    // 环境变量与 ConfigMap 的取值：找 Service DNS 名；secretKeyRef 只取名称
    const values: Array<{ where: string; value: string }> = [];
    for (const c of [...arr(spec.containers), ...arr(spec.initContainers)]) {
      for (const e of arr(c.env)) {
        const value = str(e.value);
        if (value) {
          values.push({ where: `env ${String(e.name)}`, value });
        }
        const vf = obj(e.valueFrom);
        const sk = str(obj(vf.secretKeyRef).name);
        if (sk) {
          const sec = addVirtual('Secret', ns, sk, false);
          addEdge(pk, sec, 'references', 'config_ref', 'service', `env ${String(e.name)} secretKeyRef`);
        }
        const ck = str(obj(vf.configMapKeyRef).name);
        if (ck) {
          referencedConfigMaps.add(ck);
        }
      }
      for (const ef of arr(c.envFrom)) {
        const cm = str(obj(ef.configMapRef).name);
        if (cm) {
          referencedConfigMaps.add(cm);
        }
        const sec = str(obj(ef.secretRef).name);
        if (sec) {
          addEdge(pk, addVirtual('Secret', ns, sec, false), 'references', 'config_ref', 'service', 'envFrom secretRef');
        }
      }
    }
    for (const cmName of referencedConfigMaps) {
      const cm = configMaps.get(`${ns}/${cmName}`);
      for (const [k, v] of Object.entries(cm?.data ?? {})) {
        values.push({ where: `configmap ${cmName} key ${k}`, value: v });
      }
    }
    for (const s of services) {
      const sns = s.metadata.namespace!;
      const name = escapeRe(s.metadata.name);
      // 同命名空间可以只写服务名；跨命名空间至少写到 <name>.<namespace>
      const pattern = new RegExp(
        sns === ns
          ? `(^|[^a-z0-9.-])${name}(\\.${escapeRe(sns)}(\\.svc(\\.cluster\\.local)?)?)?([^a-z0-9-]|$)`
          : `(^|[^a-z0-9.-])${name}\\.${escapeRe(sns)}(\\.svc(\\.cluster\\.local)?)?([^a-z0-9-]|$)`,
      );
      // Pod 引用自己所属服务的名字不构成依赖
      if (sns === ns && matches(p.metadata.labels, obj(obj(s.spec).selector))) {
        continue;
      }
      const hit = values.find((x) => pattern.test(x.value));
      if (hit) {
        addEdge(pk, keyOf(s), 'references', 'config_ref', 'service', hit.where);
      }
    }
  }

  // Service → Pod：按选择器；没有选择器时按 Endpoints 的 targetRef
  for (const s of services) {
    const ns = s.metadata.namespace!;
    const selector = obj(obj(s.spec).selector);
    if (Object.keys(selector).length > 0) {
      for (const p of pods) {
        if (p.metadata.namespace === ns && matches(p.metadata.labels, selector)) {
          addEdge(keyOf(s), keyOf(p), 'selects', 'structural', 'service', 'spec.selector');
        }
      }
    } else {
      const ep = objects.find(
        (o) => o.kind === 'Endpoints' && o.metadata.namespace === ns && o.metadata.name === s.metadata.name,
      );
      for (const subset of arr(ep?.subsets)) {
        for (const a of [...arr(subset.addresses), ...arr(subset.notReadyAddresses)]) {
          const ref = obj(a.targetRef);
          if (ref.kind === 'Pod' && str(ref.name)) {
            addEdge(
              keyOf(s),
              nodeKey('Pod', ns, String(ref.name)),
              'selects',
              'structural',
              'service',
              'endpoints targetRef',
            );
          }
        }
      }
    }
  }

  // Ingress → Service
  for (const ing of byKind('Ingress')) {
    const ns = ing.metadata.namespace!;
    const spec = obj(ing.spec);
    const backends = [obj(spec.defaultBackend)];
    for (const r of arr(spec.rules)) {
      for (const p of arr(obj(r.http).paths)) {
        backends.push(obj(p.backend));
      }
    }
    for (const b of backends) {
      const svc = str(obj(b.service).name);
      if (svc) {
        addEdge(keyOf(ing), nodeKey('Service', ns, svc), 'routes_to', 'structural', 'service', 'ingress backend');
      }
    }
  }

  // PVC → PV → CSI 驱动（存储是集群枢纽）
  for (const pvc of byKind('PersistentVolumeClaim')) {
    const vol = str(obj(pvc.spec).volumeName);
    if (vol) {
      addEdge(
        keyOf(pvc),
        nodeKey('PersistentVolume', null, vol),
        'bound_to',
        'structural',
        'instance',
        'spec.volumeName',
      );
    }
  }
  for (const pv of byKind('PersistentVolume')) {
    const driver = str(obj(obj(pv.spec).csi).driver);
    if (driver) {
      addEdge(
        keyOf(pv),
        addVirtual('CSIDriver', null, driver, true),
        'provisioned_by',
        'structural',
        'instance',
        'spec.csi.driver',
      );
    }
  }

  // NetworkPolicy 出站规则：被选中的 Pod → 允许访问的 Pod
  for (const np of byKind('NetworkPolicy')) {
    const ns = np.metadata.namespace!;
    const spec = obj(np.spec);
    const types = (spec.policyTypes as string[] | undefined) ?? [];
    if (!types.includes('Egress')) {
      continue;
    }
    const sources = pods.filter(
      (p) => p.metadata.namespace === ns && selectorMatches(p.metadata.labels, obj(spec.podSelector)),
    );
    for (const rule of arr(spec.egress)) {
      for (const peer of arr(rule.to)) {
        if (peer.podSelector === undefined && peer.namespaceSelector === undefined) {
          continue;
        }
        const targets = pods.filter((p) => {
          const pns = p.metadata.namespace!;
          const nsOk =
            peer.namespaceSelector === undefined
              ? pns === ns
              : selectorMatches(
                  { 'kubernetes.io/metadata.name': pns, ...(namespaces.get(pns) ?? {}) },
                  obj(peer.namespaceSelector),
                );
          return nsOk && (peer.podSelector === undefined || selectorMatches(p.metadata.labels, obj(peer.podSelector)));
        });
        for (const s of sources) {
          for (const t of targets) {
            addEdge(keyOf(s), keyOf(t), 'egress_to', 'network_policy', 'service', `networkpolicy ${np.metadata.name}`);
          }
        }
      }
    }
  }

  // 同节点的枢纽 DaemonSet Pod（CNI、CSI 节点插件）：只影响本节点上的 Pod
  const owner = new Map<string, string>();
  for (const e of edges.values()) {
    if (e.relation === OWNED_BY) {
      owner.set(e.from, e.to);
    }
  }
  const topOf = (k: string): string => {
    let cur = k;
    for (let o = owner.get(cur); o !== undefined; o = owner.get(cur)) {
      cur = o;
    }
    return cur;
  };
  const hubDaemonPods = pods.filter((p) => {
    const top = nodes.get(topOf(keyOf(p)));
    return top?.kind === 'DaemonSet' && top.hub;
  });
  for (const p of pods) {
    const n = str(obj(p.spec).nodeName);
    if (!n || hubDaemonPods.includes(p)) {
      continue;
    }
    for (const d of hubDaemonPods) {
      if (str(obj(d.spec).nodeName) === n) {
        addEdge(keyOf(p), keyOf(d), 'node_local_daemon', 'structural', 'instance', `same node ${n}`);
      }
    }
  }

  // 领域包声明的 Operator 约定边
  for (const c of opts.conventions ?? []) {
    const fromRe = c.from.name_pattern === undefined ? undefined : new RegExp(c.from.name_pattern);
    for (const n of [...nodes.values()]) {
      if (n.kind !== c.from.kind) {
        continue;
      }
      const m = fromRe ? fromRe.exec(n.name) : [n.name];
      if (!m) {
        continue;
      }
      const toName = (c.to.name ?? '$0').replace(/\$([0-9])/g, (_, i: string) => m[Number(i)] ?? '');
      const sameNs = c.to.same_namespace ?? true;
      for (const t of nodes.values()) {
        if (t.kind !== c.to.kind || t.name !== toName || (sameNs && t.namespace !== n.namespace)) {
          continue;
        }
        if (c.to.name_pattern !== undefined && !new RegExp(c.to.name_pattern).test(t.name)) {
          continue;
        }
        addEdge(n.key, t.key, c.relation, 'structural', c.scope, `convention ${c.id}`);
      }
    }
  }

  // 边的端点都必须是节点：引用了不存在的对象时补一个虚节点
  for (const e of edges.values()) {
    for (const k of [e.from, e.to]) {
      if (!nodes.has(k)) {
        const p = parseKey(k);
        addVirtual(p.kind, p.namespace, p.name, false);
      }
    }
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.key.localeCompare(b.key)),
    edges: [...edges.values()].sort((a, b) =>
      `${a.from}|${a.relation}|${a.to}`.localeCompare(`${b.from}|${b.relation}|${b.to}`),
    ),
  };
}
