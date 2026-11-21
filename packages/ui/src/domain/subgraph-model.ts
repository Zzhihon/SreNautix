// 根因子图的边分档与语义归类（ADR 0208）：
// 与全集群地图（ADR 0205）保持一致的三档视角，并做事件节点可达性裁剪（消除断连孤岛）：
// - core（有核心边时默认）：声明依赖、运行时、路由/主从/存储链路、事件节点的宿主机 runs_on，以及从事件节点向上的 owned_by；
// - deps：核心链路加上配置引用、向下 owned_by、managed_by、selects、scales、protects、非事件宿主机 runs_on 与 operator_convention；
// - allowed：再加上全部网络策略放行边（与 ClusterMap 一致）。
import type { IncidentSubgraph } from '../contract';

export type SubgraphNode = IncidentSubgraph['nodes'][number];
export type SubgraphEdge = IncidentSubgraph['edges'][number];

export type SubgraphEdgeLevel = 'core' | 'deps' | 'allowed';
export const SUBGRAPH_EDGE_LEVELS: readonly SubgraphEdgeLevel[] = ['core', 'deps', 'allowed'];

export type SubgraphEdgeKind = 'declared' | 'route' | 'substrate' | 'runtime' | 'reference' | 'structural' | 'allowed';

const LEVEL_RANK: Record<SubgraphEdgeLevel, number> = { core: 0, deps: 1, allowed: 2 };
const CORE_RELATIONS: ReadonlySet<string> = new Set([
  'routes_to',
  'primary',
  'replica',
  'mounts',
  'bound_to',
  'provisioned_by',
  'csi_node_plugin',
]);

export function subgraphEdgeKind(e: Pick<SubgraphEdge, 'provenance' | 'relation'>): SubgraphEdgeKind {
  if (e.provenance === 'declared') {
    return 'declared';
  }
  if (e.relation === 'routes_to') {
    return 'route';
  }
  if (e.relation === 'runs_on') {
    return 'substrate';
  }
  if (e.provenance === 'network_policy') {
    return 'allowed';
  }
  if (e.provenance === 'runtime') {
    return 'runtime';
  }
  if (e.provenance === 'config_ref') {
    return 'reference';
  }
  return 'structural';
}

export function subgraphEdgeLevel(
  e: Pick<SubgraphEdge, 'from' | 'to' | 'provenance' | 'relation'>,
  incidentNodes: ReadonlySet<string>,
): SubgraphEdgeLevel {
  if (e.provenance === 'network_policy') {
    return 'allowed';
  }
  if (e.provenance === 'declared' || e.provenance === 'runtime' || CORE_RELATIONS.has(e.relation)) {
    return 'core';
  }
  if (e.relation === 'runs_on') {
    return incidentNodes.has(e.from) || incidentNodes.has(e.to) ? 'core' : 'deps';
  }
  if (e.relation === 'owned_by') {
    return incidentNodes.has(e.from) ? 'core' : 'deps';
  }
  return 'deps';
}

export interface FilteredSubgraph {
  graph: IncidentSubgraph;
  /** 当前档位下隐藏的边数（含因失去与事件节点连通而被裁剪的孤岛边） */
  hiddenEdges: number;
  /** 总边数 */
  totalEdges: number;
  /** 当前档位下实际可见的边种类 */
  kinds: ReadonlySet<SubgraphEdgeKind>;
}

/** 按边档位过滤子图，并从事件节点做无向 BFS 裁剪不可达孤岛（根因、候选、成员与带告警的节点始终保留） */
export function filterSubgraph(graph: IncidentSubgraph, level: SubgraphEdgeLevel): FilteredSubgraph {
  const incidentNodes = new Set<string>();
  for (const n of graph.nodes) {
    if (n.role !== 'neighbor' || n.alerts.length > 0 || n.component === graph.root) {
      incidentNodes.add(n.component);
    }
  }
  const maxRank = LEVEL_RANK[level];
  const levelEdges = graph.edges.filter((e) => LEVEL_RANK[subgraphEdgeLevel(e, incidentNodes)] <= maxRank);

  const adj = new Map<string, string[]>();
  for (const e of levelEdges) {
    const f = adj.get(e.from);
    if (f) {
      f.push(e.to);
    } else {
      adj.set(e.from, [e.to]);
    }
    const t = adj.get(e.to);
    if (t) {
      t.push(e.from);
    } else {
      adj.set(e.to, [e.from]);
    }
  }

  const reachable = new Set<string>(incidentNodes);
  const queue = [...incidentNodes];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    for (const next of adj.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const edges = levelEdges.filter((e) => reachable.has(e.from) && reachable.has(e.to));
  const kinds = new Set<SubgraphEdgeKind>();
  for (const e of edges) {
    kinds.add(subgraphEdgeKind(e));
  }
  const nodes = graph.nodes.filter((n) => incidentNodes.has(n.component) || reachable.has(n.component));
  return {
    graph: { ...graph, nodes, edges },
    hiddenEdges: graph.edges.length - edges.length,
    totalEdges: graph.edges.length,
    kinds,
  };
}

/** 默认边档位：核心链路有边时优先 core，否则依次回退到 deps 与 allowed */
export function defaultSubgraphLevel(graph: IncidentSubgraph): SubgraphEdgeLevel {
  if (filterSubgraph(graph, 'core').graph.edges.length > 0) {
    return 'core';
  }
  if (filterSubgraph(graph, 'deps').graph.edges.length > 0) {
    return 'deps';
  }
  return 'allowed';
}
