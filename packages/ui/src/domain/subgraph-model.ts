// 根因子图的边分档与语义归类（ADR 0208）：
// 与全集群地图（ADR 0205）保持一致的三档视角：
// - core：核心因果/依赖（声明的依赖、路由入口、配置引用、运行时、PDB 保护，以及事件相关节点的直连结构/宿主机 runs_on 边）；
// - deps（默认）：结构、运行时、配置引用、声明与 ≥0.6 的网络策略边，隐藏 <0.6 的网络策略放行噪声及仅由它们连出的邻居；
// - allowed：画出全部边（含 <0.6 的网络策略放行边）。
import type { IncidentSubgraph } from '../contract';

export type SubgraphNode = IncidentSubgraph['nodes'][number];
export type SubgraphEdge = IncidentSubgraph['edges'][number];

export type SubgraphEdgeLevel = 'core' | 'deps' | 'allowed';
export const SUBGRAPH_EDGE_LEVELS: readonly SubgraphEdgeLevel[] = ['core', 'deps', 'allowed'];

export type SubgraphEdgeKind = 'declared' | 'route' | 'substrate' | 'runtime' | 'reference' | 'structural' | 'allowed';

const LEVEL_RANK: Record<SubgraphEdgeLevel, number> = { core: 0, deps: 1, allowed: 2 };
const POLICY_MERGE_THRESHOLD = 0.6;

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
  e: Pick<SubgraphEdge, 'from' | 'to' | 'provenance' | 'relation' | 'confidence'>,
  incidentNodes: ReadonlySet<string>,
): SubgraphEdgeLevel {
  if (e.provenance === 'network_policy') {
    return e.confidence >= POLICY_MERGE_THRESHOLD ? 'deps' : 'allowed';
  }
  if (
    e.provenance === 'declared' ||
    e.relation === 'routes_to' ||
    e.relation === 'protects' ||
    e.provenance === 'runtime' ||
    e.provenance === 'config_ref'
  ) {
    return 'core';
  }
  const touchesIncident = incidentNodes.has(e.from) || incidentNodes.has(e.to);
  if (e.relation === 'runs_on') {
    return touchesIncident ? 'core' : 'deps';
  }
  if (touchesIncident && e.relation !== 'managed_by') {
    return 'core';
  }
  return 'deps';
}

export interface FilteredSubgraph {
  graph: IncidentSubgraph;
  /** 当前档位下隐藏的边数 */
  hiddenEdges: number;
  /** 总边数 */
  totalEdges: number;
  /** 当前档位下实际可见的边种类 */
  kinds: ReadonlySet<SubgraphEdgeKind>;
}

/** 按边档位过滤子图：隐藏高噪声边，同时收起失去连线的纯邻居节点（根因、候选、成员与带告警的节点始终保留） */
export function filterSubgraph(graph: IncidentSubgraph, level: SubgraphEdgeLevel): FilteredSubgraph {
  const incidentNodes = new Set<string>();
  for (const n of graph.nodes) {
    if (n.role !== 'neighbor' || n.alerts.length > 0 || n.component === graph.root) {
      incidentNodes.add(n.component);
    }
  }
  const maxRank = LEVEL_RANK[level];
  const edges = graph.edges.filter((e) => LEVEL_RANK[subgraphEdgeLevel(e, incidentNodes)] <= maxRank);
  const connected = new Set<string>();
  const kinds = new Set<SubgraphEdgeKind>();
  for (const e of edges) {
    connected.add(e.from);
    connected.add(e.to);
    kinds.add(subgraphEdgeKind(e));
  }
  const nodes = graph.nodes.filter((n) => incidentNodes.has(n.component) || connected.has(n.component));
  return {
    graph: { ...graph, nodes, edges },
    hiddenEdges: graph.edges.length - edges.length,
    totalEdges: graph.edges.length,
    kinds,
  };
}
