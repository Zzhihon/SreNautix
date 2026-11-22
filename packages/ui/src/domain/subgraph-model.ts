// 根因子图的边分档、五层因果泳道归类、关键因果路径计算与确定性泳道排布（ADR 0208）：
// 与全集群地图（ADR 0205）保持一致的三档视角，并做事件节点可达性裁剪（消除断连孤岛）：
// - core（有核心边时默认）：声明依赖、运行时、路由/主从/存储链路、事件节点的宿主机 runs_on，以及从事件节点向上的 owned_by；
// - deps：核心链路加上配置引用、向下 owned_by、managed_by、selects、scales、protects、非事件宿主机 runs_on 与 operator_convention；
// - allowed：再加上全部网络策略放行边（与 ClusterMap 一致）。
import type { IncidentSubgraph, OntologyGlossary } from '../contract';
import { lookupNodeOntology } from './ontology';

export type SubgraphNode = IncidentSubgraph['nodes'][number];
export type SubgraphEdge = IncidentSubgraph['edges'][number];

export type SubgraphEdgeLevel = 'core' | 'deps' | 'allowed';
export const SUBGRAPH_EDGE_LEVELS: readonly SubgraphEdgeLevel[] = ['core', 'deps', 'allowed'];

export type SubgraphEdgeKind = 'declared' | 'route' | 'substrate' | 'runtime' | 'reference' | 'structural' | 'allowed';

export type SwimlaneId = 'L0' | 'L1' | 'L2' | 'L3' | 'external';
export const SWIMLANE_ORDER: readonly SwimlaneId[] = ['L0', 'L1', 'L2', 'L3', 'external'];

export type SubgraphLayoutMode = 'swimlane' | 'elk';

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

const L0_KINDS = new Set(['route', 'HTTPRoute', 'GRPCRoute', 'TLSRoute', 'Gateway', 'Ingress', 'IngressRoute']);
const L1_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Pod',
  'ReplicaSet',
  'Job',
  'CronJob',
  'Service',
  'HorizontalPodAutoscaler',
  'component',
  'Application',
  'Workflow',
  'CronWorkflow',
  'ConfigMap',
  'Secret',
]);
const L2_KINDS = new Set([
  'Cluster',
  'Dragonfly',
  'Redis',
  'PostgresCluster',
  'PersistentVolumeClaim',
  'PersistentVolume',
  'StorageClass',
  'Volume',
  'VolumeSnapshot',
  'queryid',
  'postgres',
]);
const L3_KINDS = new Set([
  'Node',
  'Namespace',
  'Certificate',
  'ClusterIssuer',
  'Issuer',
  'PodDisruptionBudget',
  'NetworkPolicy',
  'CiliumNetworkPolicy',
  'CiliumClusterwideNetworkPolicy',
  'instance',
  'CSIDriver',
  'CSINode',
]);
const EXTERNAL_KINDS = new Set(['provider', 'model']);

const L0_NAME_RE = /^(edge-|envoy|caddy|ingress|cloudflared|tunnel|nginx-ingress)/i;
const L2_NAME_RE =
  /(postgres|(^|[-_.])pg([-_.]|$)|dragonfly|redis|nats|minio|mysql|mariadb|kafka|rocketmq|mongodb|etcd|vmsingle|loki|tempo|object-?store|backup-?store|s3\.|pvc|wal$)/i;
const L3_NAME_RE = /^(node|k8s|network|platform|cilium|coredns|kube-apiserver|kube-)/i;

/**
 * 将子图节点归入五层垂直语义泳道：
 * L0 入口/边缘 → L1 业务负载 → L2 数据与存储 → L3 节点与底座 → external 外部依赖（及未映射兜底）。
 */
export function classifySwimlane(
  node: Pick<SubgraphNode, 'component' | 'kind' | 'namespace' | 'name'>,
  glossary?: OntologyGlossary | null,
): SwimlaneId {
  if (glossary) {
    const info = lookupNodeOntology(node, glossary);
    if (info.external) {
      return 'external';
    }
    if (info.layer && (SWIMLANE_ORDER as readonly string[]).includes(info.layer)) {
      return info.layer;
    }
  }
  const baseKind = node.kind.includes('.') ? node.kind.slice(0, node.kind.indexOf('.')) : node.kind;
  if (EXTERNAL_KINDS.has(baseKind)) {
    return 'external';
  }
  if (L0_KINDS.has(baseKind)) {
    return 'L0';
  }
  if (baseKind === 'host') {
    return L2_NAME_RE.test(node.name) ? 'L2' : 'L0';
  }
  if (L2_KINDS.has(baseKind)) {
    return 'L2';
  }
  if (L3_KINDS.has(baseKind)) {
    return 'L3';
  }
  if (L1_KINDS.has(baseKind)) {
    if (L0_NAME_RE.test(node.name)) {
      return 'L0';
    }
    if (L2_NAME_RE.test(node.name)) {
      return 'L2';
    }
    if (baseKind === 'component' && L3_NAME_RE.test(node.name)) {
      return 'L3';
    }
    if (baseKind === 'component' && /^(provider|upstream)/i.test(node.name)) {
      return 'external';
    }
    return 'L1';
  }
  return 'external';
}

export const criticalEdgeKey = (e: Pick<SubgraphEdge, 'from' | 'to' | 'relation'>) =>
  `${e.from}\0${e.to}\0${e.relation}`;

export interface CriticalCausalPath {
  /** 最高优先怀疑根因节点 id */
  root: string | null;
  /** 位于症状 ↔ 根因最短路径上的全部节点 id */
  nodes: ReadonlySet<string>;
  /** 位于最短路径上的边键（criticalEdgeKey） */
  edges: ReadonlySet<string>;
  /** 是否存在至少一条症状到根因的路径；为 false 时不淡化上下文节点 */
  hasPath: boolean;
}

/**
 * 计算关键因果路径：找出每个告警/症状节点到最高怀疑根因的最短路径（优先沿非 network_policy 强边搜索）。
 */
export function computeCriticalCausalPath(
  graph: Pick<IncidentSubgraph, 'root' | 'nodes' | 'edges'>,
): CriticalCausalPath {
  const nodeIds = new Set(graph.nodes.map((n) => n.component));
  const root =
    (graph.root && nodeIds.has(graph.root) ? graph.root : null) ??
    graph.nodes.find((n) => n.role === 'root')?.component ??
    graph.nodes.find((n) => n.role === 'candidate')?.component ??
    null;

  if (!root) {
    return { root: null, nodes: new Set(), edges: new Set(), hasPath: false };
  }

  const symptoms = graph.nodes
    .filter((n) => n.component !== root && (n.alerts.length > 0 || n.role === 'member' || n.role === 'candidate'))
    .map((n) => n.component);

  if (symptoms.length === 0) {
    return { root, nodes: new Set([root]), edges: new Set(), hasPath: false };
  }

  const buildAdj = (includePolicy: boolean) => {
    const adj = new Map<string, Array<{ next: string; edge: SubgraphEdge }>>();
    for (const e of graph.edges) {
      if (!includePolicy && e.provenance === 'network_policy') {
        continue;
      }
      if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) {
        continue;
      }
      const f = adj.get(e.from);
      if (f) {
        f.push({ next: e.to, edge: e });
      } else {
        adj.set(e.from, [{ next: e.to, edge: e }]);
      }
      const t = adj.get(e.to);
      if (t) {
        t.push({ next: e.from, edge: e });
      } else {
        adj.set(e.to, [{ next: e.from, edge: e }]);
      }
    }
    return adj;
  };

  const strongAdj = buildAdj(false);
  const fullAdj = buildAdj(true);

  const bfsToRoot = (start: string, adj: Map<string, Array<{ next: string; edge: SubgraphEdge }>>) => {
    const visited = new Set<string>([start]);
    const parent = new Map<string, { prev: string; edge: SubgraphEdge }>();
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]!;
      if (cur === root) {
        const pathNodes: string[] = [root];
        const pathEdges: SubgraphEdge[] = [];
        let cursor = root;
        while (cursor !== start) {
          const step = parent.get(cursor)!;
          pathEdges.push(step.edge);
          cursor = step.prev;
          pathNodes.push(cursor);
        }
        return { pathNodes, pathEdges };
      }
      for (const step of adj.get(cur) ?? []) {
        if (!visited.has(step.next)) {
          visited.add(step.next);
          parent.set(step.next, { prev: cur, edge: step.edge });
          queue.push(step.next);
        }
      }
    }
    return null;
  };

  const pathNodes = new Set<string>();
  const pathEdges = new Set<string>();
  for (const s of symptoms) {
    const found = bfsToRoot(s, strongAdj) ?? bfsToRoot(s, fullAdj);
    if (!found) {
      continue;
    }
    for (const id of found.pathNodes) {
      pathNodes.add(id);
    }
    for (const e of found.pathEdges) {
      pathEdges.add(criticalEdgeKey(e));
    }
  }

  return {
    root,
    nodes: pathNodes.size > 0 ? pathNodes : new Set([root]),
    edges: pathEdges,
    hasPath: pathEdges.size > 0,
  };
}

export interface SwimlaneLayoutItem {
  id: string;
  lane: SwimlaneId;
  /** 排布优先级：0 根因，1 关键路径/候选/成员，2 其他上下文 */
  priority: number;
  label: string;
}

export interface SwimlaneBand {
  id: SwimlaneId;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
}

export interface SwimlaneLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  lanes: SwimlaneBand[];
}

export const SWIMLANE_METRICS = {
  nodeW: 224,
  nodeH: 80,
  labelW: 144,
  padX: 20,
  padY: 12,
  gapX: 24,
  gapY: 14,
  laneGapY: 16,
  maxPerRow: 5,
} as const;

/**
 * 确定性五层垂直泳道排布：只渲染非空泳道，按 L0 → L1 → L2 → L3 → external 自上而下排列；
 * 每层内优先将根因与关键路径节点置中靠前，并按上层连接重心排序减少交叉线。
 */
export function layoutSwimlanes(
  items: readonly SwimlaneLayoutItem[],
  edges: readonly { from: string; to: string }[],
): SwimlaneLayoutResult {
  const M = SWIMLANE_METRICS;
  const grouped = new Map<SwimlaneId, SwimlaneLayoutItem[]>();
  for (const it of items) {
    const list = grouped.get(it.lane);
    if (list) {
      list.push(it);
    } else {
      grouped.set(it.lane, [it]);
    }
  }

  const nonEmpty = SWIMLANE_ORDER.filter((l) => (grouped.get(l)?.length ?? 0) > 0);
  const maxCols = Math.max(1, ...nonEmpty.map((l) => Math.min(M.maxPerRow, grouped.get(l)!.length)));
  const contentW = maxCols * M.nodeW + (maxCols - 1) * M.gapX;
  const totalW = M.labelW + M.padX * 2 + contentW;

  const neighbors = new Map<string, string[]>();
  for (const e of edges) {
    neighbors.set(e.from, [...(neighbors.get(e.from) ?? []), e.to]);
    neighbors.set(e.to, [...(neighbors.get(e.to) ?? []), e.from]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const lanes: SwimlaneBand[] = [];
  let y = 0;

  for (const laneId of nonEmpty) {
    const list = [...grouped.get(laneId)!];
    // 按与已排布上层节点的平均 X 重心排序，重心相同时按优先级与名称稳定排序
    const barycenter = (id: string): number => {
      const xs = (neighbors.get(id) ?? []).map((n) => positions.get(n)?.x).filter((v): v is number => v !== undefined);
      if (!xs.length) {
        return Number.POSITIVE_INFINITY;
      }
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    list.sort(
      (a, b) =>
        a.priority - b.priority ||
        barycenter(a.id) - barycenter(b.id) ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    );

    const rows = Math.ceil(list.length / M.maxPerRow);
    const bandH = M.padY * 2 + rows * M.nodeH + (rows - 1) * M.gapY;
    lanes.push({ id: laneId, x: 0, y, w: totalW, h: bandH, count: list.length });

    for (let r = 0; r < rows; r++) {
      const slice = list.slice(r * M.maxPerRow, (r + 1) * M.maxPerRow);
      const rowW = slice.length * M.nodeW + (slice.length - 1) * M.gapX;
      const startX = M.labelW + M.padX + Math.floor((contentW - rowW) / 2);
      const nodeY = y + M.padY + r * (M.nodeH + M.gapY);
      slice.forEach((it, idx) => {
        positions.set(it.id, { x: startX + idx * (M.nodeW + M.gapX), y: nodeY });
      });
    }
    y += bandH + M.laneGapY;
  }

  return { positions, lanes };
}
