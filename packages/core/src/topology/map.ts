// 全集群地图（ADR 0199）：把某一时刻的对象图归并成地图。
// 地图上的组件是有 Pod 的顶层对象（Deployment、StatefulSet、CNPG Cluster……，静态 Pod 的属主是 Node，这时 Pod 自己是组件）
// 与路由入口（有 routes_to 的对象）。Service 与带 Operator 约定的对象只是连接：经过它们的边接到它们选中的组件上。
// 组件引用、挂载的其余对象（ConfigMap、Secret、PVC……）不画，按类型计数；节点与集群枢纽单独列出，不画边。
// 领域包 business.yaml 声明的依赖（ADR 0200）画成来源为 declared、置信度 1 的边，与推出的边合并。
import type { ComponentKey, ComponentType, HubComponents, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { matchesByName, type ServiceCatalog, type TypedObject } from '@srenautix/packs-sdk/business';
import { parseKey } from '../keys.js';
import { OWNED_BY, SCALES, TopologyGraph } from './graph.js';
import { matchTypeByName, PROTECTS } from './kube.js';

type MapSchema = HubComponents['schemas']['ClusterMap'];
/** 地图的结构部分：只随拓扑版本与领域包变化；时刻与事件由调用方补上 */
export type ClusterMapStructure = Omit<MapSchema, 'at' | 'incidents'>;
type MapComponent = MapSchema['components'][number];
type MapEdge = MapSchema['edges'][number];

const NODE_KIND = 'Node';
const POD_KIND = 'Pod';
const RUNS_ON = 'runs_on';
const ROUTES_TO = 'routes_to';
/** 不画成地图边的关系：成员关系、节点放置（节点条）、GitOps 管理（每个对象都有，没有依赖含义） */
const NOT_DEPENDENCY: ReadonlySet<string> = new Set([OWNED_BY, SCALES, RUNS_ON, 'managed_by']);
/** 连接对象的出边：Service 选中 Pod，Operator 约定的 Service、Secret 指向数据库集群 */
const CONNECTS: ReadonlySet<string> = new Set(['selects', 'operator_convention']);

export function clusterMap(
  snapshot: { nodes: readonly TopologyNode[]; edges: readonly TopologyEdge[]; version: number },
  catalog: ServiceCatalog | null,
  types: readonly ComponentType[],
): ClusterMapStructure {
  const g = new TopologyGraph(snapshot.nodes, snapshot.edges, snapshot.version);
  const kindOf = (k: ComponentKey) => g.node(k)?.kind ?? parseKey(k).kind;
  const top = topOf(g);

  const placed = new Map<ComponentKey, ComponentKey>();
  const outgoing = new Map<ComponentKey, TopologyEdge[]>();
  for (const e of snapshot.edges) {
    if (e.relation === RUNS_ON) {
      placed.set(e.from, e.to);
    }
    const list = outgoing.get(e.from) ?? [];
    list.push(e);
    outgoing.set(e.from, list);
  }

  const hubs = new Set<ComponentKey>();
  const components = new Set<ComponentKey>();
  for (const n of g.allNodes()) {
    if (n.kind === POD_KIND || (outgoing.get(n.key) ?? []).some((e) => e.relation === ROUTES_TO)) {
      const t = top(n.key);
      (g.isHub(t) ? hubs : components).add(t);
    }
  }
  for (const n of g.allNodes()) {
    // 没有 Pod 的枢纽（例如 CSI 驱动）也列在枢纽里；Service 只是连接，不单列
    if (n.hub && n.kind !== 'Service') {
      hubs.add(top(n.key));
    }
  }

  // 一个对象在地图上落到哪些组件或枢纽；落不到的是附属对象（attached）或地图之外的对象
  const resolved = new Map<ComponentKey, { to: ComponentKey[]; attached: boolean }>();
  const resolve = (k: ComponentKey) => {
    const t = top(k);
    const hit = resolved.get(t);
    if (hit) {
      return hit;
    }
    let r: { to: ComponentKey[]; attached: boolean };
    if (components.has(t) || hubs.has(t)) {
      r = { to: [t], attached: false };
    } else {
      const via = new Set<ComponentKey>();
      for (const m of g.membersOf(t)) {
        for (const e of outgoing.get(m) ?? []) {
          const x = top(e.to);
          if (CONNECTS.has(e.relation) && (components.has(x) || hubs.has(x))) {
            via.add(x);
          }
        }
      }
      r = via.size ? { to: [...via], attached: false } : { to: [], attached: true };
    }
    resolved.set(t, r);
    return r;
  };

  const attachments = new Map<ComponentKey, Map<string, Set<ComponentKey>>>();
  const dependents = new Map<ComponentKey, Set<ComponentKey>>();
  const edges = new Map<string, MapEdge & { rel: Set<string> }>();
  const touched = new Set<ComponentKey>();
  for (const e of snapshot.edges) {
    if (NOT_DEPENDENCY.has(e.relation)) {
      continue;
    }
    const from = top(e.from);
    if (!components.has(from)) {
      continue;
    }
    const r = resolve(e.to);
    const target = top(e.to);
    touched.add(target);
    if (r.attached) {
      const byKind = attachments.get(from) ?? new Map<string, Set<ComponentKey>>();
      const kind = kindOf(target);
      byKind.set(kind, (byKind.get(kind) ?? new Set()).add(target));
      attachments.set(from, byKind);
      continue;
    }
    for (const to of r.to) {
      if (to === from) {
        continue;
      }
      if (hubs.has(to)) {
        dependents.set(to, (dependents.get(to) ?? new Set()).add(from));
        continue;
      }
      const key = `${from}\0${to}`;
      const seen = edges.get(key);
      if (!seen) {
        edges.set(key, {
          from,
          to,
          relations: [],
          rel: new Set([e.relation]),
          count: 1,
          provenance: e.provenance,
          confidence: e.confidence,
        });
        continue;
      }
      seen.rel.add(e.relation);
      seen.count++;
      if (e.confidence > seen.confidence) {
        seen.confidence = e.confidence;
        seen.provenance = e.provenance;
      }
    }
  }

  const typed = (k: ComponentKey): TypedObject => {
    const n = g.node(k);
    const p = n ?? parseKey(k);
    return {
      kind: p.kind,
      namespace: p.namespace,
      name: p.name,
      componentType: n?.component_type ?? matchTypeByName(p.kind, p.namespace, p.name, types)?.id ?? null,
    };
  };
  const nodePods = new Map<ComponentKey, { pods: number; components: Set<ComponentKey> }>();
  const out: MapComponent[] = [];
  for (const c of [...components].sort()) {
    const self = typed(c);
    const members = g.membersOf(c).slice(1);
    let service: string | null = catalog?.ofObject(self) ?? null;
    let source: MapComponent['service_source'] = 'component';
    if (service === null && catalog) {
      source = 'member';
      for (const m of members) {
        service = catalog.ofObject(typed(m));
        if (service !== null) {
          break;
        }
      }
    }
    if (service === null) {
      service = catalog?.ofNamespace(self.namespace) ?? null;
      source = service === null ? 'default' : 'namespace';
    }
    const nodes = new Set<ComponentKey>();
    for (const m of [c, ...members]) {
      const node = placed.get(m);
      if (node) {
        nodes.add(node);
        const np = nodePods.get(node) ?? { pods: 0, components: new Set() };
        np.pods++;
        np.components.add(c);
        nodePods.set(node, np);
      }
    }
    out.push({
      key: c,
      kind: self.kind,
      namespace: self.namespace,
      name: self.name,
      component_type: self.componentType,
      service,
      service_source: source,
      members: countBy(members.map(kindOf)),
      attachments: Object.fromEntries(
        [...(attachments.get(c) ?? [])].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, s.size]),
      ),
      nodes: [...nodes].sort(),
    });
  }

  // 声明的依赖：命中 from 与 to 的组件之间一条 depends_on 边；已有推出的边时并入它，来源与置信度取声明
  for (const d of catalog?.dependencies() ?? []) {
    const hit = (ms: typeof d.from) =>
      out.filter((c) => ms.some((m) => matchesByName(m, c.kind, c.namespace, c.name))).map((c) => c.key);
    for (const from of hit(d.from)) {
      for (const to of hit(d.to)) {
        if (from === to) {
          continue;
        }
        const seen = edges.get(`${from}\0${to}`);
        if (seen) {
          seen.rel.add('depends_on');
          seen.count++;
          seen.provenance = 'declared';
          seen.confidence = 1;
        } else {
          edges.set(`${from}\0${to}`, {
            from,
            to,
            relations: [],
            rel: new Set(['depends_on']),
            count: 1,
            provenance: 'declared',
            confidence: 1,
          });
        }
      }
    }
  }

  const used = new Set(out.map((c) => c.service));
  const domains: MapSchema['domains'] = [];
  for (const s of catalog?.services() ?? []) {
    if (!used.has(s.id)) {
      continue;
    }
    let d = domains.find((x) => x.id === s.business_domain);
    if (!d) {
      d = { id: s.business_domain, title: s.business_domain_title, tier: s.tier, services: [] };
      domains.push(d);
    }
    d.services.push({ id: s.id, title: s.title });
  }

  // 地图之外的顶层对象：不是组件、枢纽、节点，也没有被组件引用或经过
  let omitted = 0;
  for (const n of g.allNodes()) {
    if (
      top(n.key) === n.key &&
      n.kind !== NODE_KIND &&
      n.kind !== POD_KIND &&
      !components.has(n.key) &&
      !hubs.has(n.key) &&
      !touched.has(n.key)
    ) {
      omitted++;
    }
  }

  return {
    topology_version: snapshot.version,
    domains,
    components: out,
    edges: [...edges.values()]
      .map(({ rel, ...e }) => ({ ...e, relations: [...rel].sort() }))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    nodes: [...g.allNodes()]
      .filter((n) => n.kind === NODE_KIND)
      .map((n) => ({
        key: n.key,
        name: n.name,
        components: nodePods.get(n.key)?.components.size ?? 0,
        pods: nodePods.get(n.key)?.pods ?? 0,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    hubs: [...hubs].sort().map((k) => {
      const p = typed(k);
      return { key: k, kind: p.kind, namespace: p.namespace, name: p.name, dependents: dependents.get(k)?.size ?? 0 };
    }),
    omitted,
  };
}

/** 对象在地图上归入的顶层对象。静态 Pod 的属主是 Node：Node 在节点条上，Pod 自己作为组件 */
function topOf(g: TopologyGraph): (k: ComponentKey) => ComponentKey {
  return (k) => {
    const c = g.componentOf(k);
    return c !== k && (g.node(c)?.kind ?? parseKey(c).kind) === NODE_KIND ? k : c;
  };
}

/** 领域包告警用的伪组件（component:gateway）的 kind */
const PSEUDO_KIND = 'component';

/** 事件怎样放到地图上（ADR 0203）；只有 root 与 named 的事件向依赖它的组件传播“受影响” */
export type MapPlacement = NonNullable<MapSchema['incidents'][number]['placement']>;

/**
 * 事件的根因放到地图的哪里（ADR 0199、0203），依次：
 * - root：根因本身是组件，或者它的顶层对象是组件；
 * - node：根因是节点，放到节点条上；
 * - protects：根因是 PodDisruptionBudget，放到它保护的组件上（有几个时取主服务里的唯一一个）；
 * - named：根因是领域包的伪组件（component:gateway），取主服务里同名的组件，没有时取全图唯一同名的组件。
 * 都不命中时为 null，事件按主服务计入服务框。
 */
export function mapPlacer(
  snapshot: { nodes: readonly TopologyNode[]; edges: readonly TopologyEdge[]; version: number },
  map: Pick<ClusterMapStructure, 'components' | 'nodes'>,
): (root: ComponentKey | null, service: string | null) => { component: ComponentKey; placement: MapPlacement } | null {
  const top = topOf(new TopologyGraph(snapshot.nodes, snapshot.edges, snapshot.version));
  const byKey = new Map(map.components.map((c) => [c.key, c]));
  const nodes = new Set(map.nodes.map((n) => n.key));
  const protects = new Map<ComponentKey, Set<ComponentKey>>();
  for (const e of snapshot.edges) {
    const t = top(e.to);
    if (e.relation === PROTECTS && byKey.has(t)) {
      protects.set(e.from, (protects.get(e.from) ?? new Set()).add(t));
    }
  }
  // 候选里取唯一一个：先看主服务里的，主服务里没有时看全部
  const only = (candidates: readonly ComponentKey[], service: string | null) => {
    const inService = candidates.filter((k) => service !== null && byKey.get(k)?.service === service);
    const pick = inService.length ? inService : candidates;
    return pick.length === 1 ? pick[0]! : null;
  };
  return (root, service) => {
    if (!root) {
      return null;
    }
    const t = top(root);
    if (byKey.has(t)) {
      return { component: t, placement: 'root' };
    }
    if (nodes.has(root)) {
      return { component: root, placement: 'node' };
    }
    const guarded = only([...(protects.get(root) ?? [])], service);
    if (guarded) {
      return { component: guarded, placement: 'protects' };
    }
    const k = parseKey(root);
    if (k.kind !== PSEUDO_KIND) {
      return null;
    }
    const named = only(
      map.components.filter((c) => c.name === k.name).map((c) => c.key),
      service,
    );
    return named ? { component: named, placement: 'named' } : null;
  };
}

function countBy(keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...keys].sort()) {
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
