// 事件根因子图与邻域的富化（ADR 0208）：
// 1. 逻辑伪组件（component:gateway、component:pg 等）按全集群地图的落点规则与业务服务目录展开为真实工作负载，避免单点孤立图；
// 2. 注入领域包 business.yaml 声明的依赖（provenance: declared, confidence: 1），使根因子图与全集群地图一致；
// 3. 为工作负载补上直连宿主节点的 runs_on 边，同时在 BFS 展开时阻止非根因 Node 反向拉入无关 Pod，
//    并阻止 <0.6 的网络策略放行边在第二跳扩散成蛛网。
import type { ComponentKey, ComponentType, HubComponents, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { matchesByName, type ServiceCatalog } from '@srenautix/packs-sdk/business';
import { parseKey, type ParsedKey } from '../keys.js';
import { TopologyGraph } from './graph.js';
import { clusterMap, mapPlacer } from './map.js';

export type SubgraphResult = HubComponents['schemas']['Subgraph'];

export interface SubgraphIncidentInput {
  root: { component: ComponentKey | null };
  candidates: ReadonlyArray<{ component: ComponentKey }>;
  members: ReadonlyArray<{ component: ComponentKey | null; alert_id: string; left_version: number | null }>;
  components: readonly ComponentKey[];
  primary_service?: string | null;
}

export interface SubgraphBuildOptions {
  services?: ServiceCatalog | null;
  componentTypes?: readonly ComponentType[];
}

const PSEUDO_KIND = 'component';
const NODE_KIND = 'Node';
const POD_KIND = 'Pod';
const RUNS_ON = 'runs_on';
const POLICY_WEAK_THRESHOLD = 0.6;
/** 逻辑组件按服务兜底展开的最多工作负载数：避免把含几十个组件的系统服务全部当成根因 */
const SERVICE_FALLBACK_MAX = 4;

/** 容错解析组件键（兼容 2.8.0 之前未编码冒号的旧键） */
function safeParseKey(key: string): ParsedKey {
  try {
    return parseKey(key);
  } catch {
    const i = key.indexOf(':');
    const rest = key.slice(i + 1);
    const j = rest.indexOf('/');
    return j < 0
      ? { kind: key.slice(0, i), namespace: null, name: rest }
      : { kind: key.slice(0, i), namespace: rest.slice(0, j), name: rest.slice(j + 1) };
  }
}

export function buildIncidentSubgraph(
  snapshot: { nodes: readonly TopologyNode[]; edges: readonly TopologyEdge[]; version: number },
  inc: SubgraphIncidentInput,
  hops: number,
  opts: SubgraphBuildOptions = {},
): SubgraphResult {
  const maxHops = Math.min(2, Math.max(1, hops));
  const services = opts.services ?? null;
  const types = opts.componentTypes ?? [];
  const g = new TopologyGraph(snapshot.nodes, snapshot.edges, snapshot.version);
  const map = clusterMap(snapshot, services, types);
  const place = mapPlacer(snapshot, map);

  const byKey = new Map<string, TopologyNode>();
  for (const n of snapshot.nodes) {
    if (!byKey.has(n.key)) {
      byKey.set(n.key, n);
    }
  }
  const kindOf = (key: string) => byKey.get(key)?.kind ?? safeParseKey(key).kind;

  /** 将逻辑伪组件（component:*）映射到拓扑里的真实工作负载；已有真实节点或映射不出时原样返回 */
  const resolveKey = (key: ComponentKey, serviceHint: string | null): ComponentKey[] => {
    if (byKey.has(key)) {
      return [key];
    }
    const placed = place(key, serviceHint);
    if (placed) {
      return [placed.component];
    }
    const parsed = safeParseKey(key);
    if (parsed.kind !== PSEUDO_KIND) {
      return [key];
    }
    // 带命名空间的逻辑组件（component:cchp-prod/gateway）优先按命名空间与名称精确匹配
    if (parsed.namespace) {
      const exactNs = map.components
        .filter((c) => c.namespace === parsed.namespace && c.name === parsed.name)
        .map((c) => c.key);
      if (exactNs.length > 0) {
        return exactNs;
      }
    }
    const svc =
      serviceHint ??
      services?.ofObject({ kind: PSEUDO_KIND, namespace: parsed.namespace, name: parsed.name, componentType: null }) ??
      null;
    if (svc !== null) {
      const inService = map.components.filter((c) => c.service === svc);
      const needle = parsed.name.toLowerCase();
      const partial = inService.filter((c) => c.name.toLowerCase().includes(needle)).map((c) => c.key);
      if (partial.length > 0 && partial.length <= SERVICE_FALLBACK_MAX) {
        return partial;
      }
      if (inService.length > 0 && inService.length <= SERVICE_FALLBACK_MAX) {
        return inService.map((c) => c.key);
      }
    }
    return [key];
  };

  const primaryService = inc.primary_service ?? null;
  const resolvedRoots = inc.root.component ? resolveKey(inc.root.component, primaryService) : [];
  const effectiveRoot: ComponentKey | null = resolvedRoots[0] ?? inc.root.component;

  const extraRootCandidates = new Set<ComponentKey>(resolvedRoots.slice(1));
  const resolvedCandidates = new Set<ComponentKey>(extraRootCandidates);
  for (const c of inc.candidates) {
    for (const k of resolveKey(c.component, primaryService)) {
      resolvedCandidates.add(k);
    }
  }

  const memberComponents = new Map<ComponentKey, string[]>();
  const addAlert = (k: ComponentKey, alertId: string) => {
    const list = memberComponents.get(k);
    if (!list) {
      memberComponents.set(k, [alertId]);
    } else if (!list.includes(alertId)) {
      list.push(alertId);
    }
  };
  for (const m of inc.members) {
    if (m.left_version !== null || !m.component) {
      continue;
    }
    // 成员告警归属的逻辑组件也随根因规则展开，告警挂到对应真实工作负载上
    const hint = m.component === inc.root.component ? primaryService : null;
    for (const k of resolveKey(m.component, hint)) {
      addAlert(k, m.alert_id);
    }
  }

  const seeds: ComponentKey[] = resolvedRoots.length
    ? [...resolvedRoots]
    : resolvedCandidates.size
      ? [...resolvedCandidates]
      : [...new Set(inc.components.flatMap((c) => resolveKey(c, primaryService)))];

  // 合并原始边、business.yaml 声明的依赖与工作负载到宿主节点的直连 runs_on 边
  const edgeMap = new Map<string, TopologyEdge>();
  const putEdge = (e: TopologyEdge) => {
    const k = `${e.from}\0${e.to}\0${e.relation}`;
    const prev = edgeMap.get(k);
    if (!prev || e.provenance === 'declared' || (prev.provenance !== 'declared' && e.confidence > prev.confidence)) {
      edgeMap.set(k, e);
    }
  };
  for (const e of snapshot.edges) {
    putEdge(e);
  }

  // 注入 business.yaml 声明的依赖（ADR 0200、ADR 0208）
  for (const dep of services?.dependencies() ?? []) {
    const hit = (ms: typeof dep.from) =>
      snapshot.nodes.filter((n) => ms.some((m) => matchesByName(m, n.kind, n.namespace, n.name))).map((n) => n.key);
    const froms = hit(dep.from);
    const tos = hit(dep.to);
    for (const from of froms) {
      for (const to of tos) {
        if (from === to) {
          continue;
        }
        putEdge({
          from,
          to,
          relation: 'depends_on',
          provenance: 'declared',
          confidence: 1,
          scope: 'service',
          evidence: dep.reason,
        });
      }
    }
  }

  // 为顶层工作负载补充直连宿主节点的 runs_on 边（Deployment 经 ReplicaSet→Pod→Node 本来是 3 跳，两跳子图看不到宿主机）
  for (const comp of map.components) {
    if (comp.kind === POD_KIND) {
      continue;
    }
    for (const nodeKey of comp.nodes) {
      putEdge({
        from: comp.key,
        to: nodeKey,
        relation: RUNS_ON,
        provenance: 'structural',
        confidence: 1,
        scope: 'instance',
        evidence: 'pod_placement',
      });
    }
  }

  const allEdges = [...edgeMap.values()];
  const touching = new Map<string, TopologyEdge[]>();
  for (const e of allEdges) {
    const f = touching.get(e.from);
    if (f) {
      f.push(e);
    } else {
      touching.set(e.from, [e]);
    }
    const t = touching.get(e.to);
    if (t) {
      t.push(e);
    } else {
      touching.set(e.to, [e]);
    }
  }

  // 有界逐跳展开：
  // - 非根因 Node 不沿 runs_on 反向拉入无关 Pod（同宿主机上已有事件成员/候选时照常连上）；
  // - 低于 0.6 的网络策略放行边只在第 1 跳出现，不在第 2 跳扩散；
  // - 不穿过集群枢纽继续向外展开。
  const seedSet = new Set<string>(seeds);
  const incidentKeys = new Set<string>([...seeds, ...resolvedCandidates, ...memberComponents.keys()]);
  const dist = new Map<string, number>(seeds.map((s) => [s, 0]));
  let frontier = [...seedSet];
  for (let h = 1; h <= maxHops && frontier.length; h++) {
    const inFrontier = new Set(frontier);
    const next: string[] = [];
    for (const a of frontier) {
      if (h > 1 && g.isHub(a)) {
        continue;
      }
      const aIsNonSeedNode = kindOf(a) === NODE_KIND && !seedSet.has(a);
      for (const e of touching.get(a) ?? []) {
        if (h > 1 && e.provenance === 'network_policy' && e.confidence < POLICY_WEAK_THRESHOLD) {
          continue;
        }
        const b = e.from === a ? e.to : e.from;
        if (inFrontier.has(b) || dist.has(b)) {
          continue;
        }
        if (aIsNonSeedNode && e.relation === RUNS_ON && !incidentKeys.has(b)) {
          continue;
        }
        dist.set(b, h);
        next.push(b);
      }
    }
    frontier = next;
  }

  const nodes: SubgraphResult['nodes'] = [...dist.entries()].map(([key, h]) => {
    const n = byKey.get(key);
    const k = safeParseKey(key);
    return {
      component: key,
      kind: n?.kind ?? k.kind,
      namespace: n?.namespace ?? k.namespace,
      name: n?.name ?? k.name,
      role:
        key === effectiveRoot
          ? ('root' as const)
          : resolvedCandidates.has(key)
            ? ('candidate' as const)
            : memberComponents.has(key)
              ? ('member' as const)
              : ('neighbor' as const),
      alerts: memberComponents.get(key) ?? [],
      hops: h,
    };
  });

  const edges: SubgraphResult['edges'] = allEdges
    .filter((e) => dist.has(e.from) && dist.has(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      relation: e.relation,
      provenance: e.provenance,
      confidence: e.confidence,
      scope: e.scope,
    }));

  return { topology_version: snapshot.version, root: effectiveRoot, nodes, edges };
}
