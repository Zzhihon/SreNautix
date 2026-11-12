// 子图的同类合并（ADR 0197）：类型、命名空间、跳数都相同，并且连到同一批组件、关系也相同的邻居，合并成一个节点。
// 一个节点上的 30 个 Pod、一个工作负载挂载的 20 个 ConfigMap 各自只占一个位置；根因、候选、成员与带告警的组件从不合并。

import type { IncidentSubgraph } from '../contract';

type SubNode = IncidentSubgraph['nodes'][number];
type SubEdge = IncidentSubgraph['edges'][number];

/** 同类组件达到这个数量才合并 */
export const FOLD_MIN = 4;

export interface FoldGroup {
  /** 画布上的节点 id：`fold:` 加第一个成员的组件键，展开与折叠前后不变 */
  id: string;
  kind: string;
  namespace: string | null;
  hops: number;
  members: SubNode[];
}

export interface FoldedSubgraph {
  /** 没有被合并的组件，保持原来的顺序 */
  nodes: SubNode[];
  /** 合并后的组 */
  groups: FoldGroup[];
  /** 成员的边改接到组上，同一对端点、同一关系只留一条，置信度取成员中最低的 */
  edges: SubEdge[];
  /** 可以合并的组数（含已经展开的），为 0 时不需要合并开关 */
  foldable: number;
}

/** expanded：用户展开的组 id，这些组的成员照常单独画出。 */
export function foldSubgraph(g: IncidentSubgraph, expanded: ReadonlySet<string>): FoldedSubgraph {
  const links = new Map<string, string[]>();
  for (const n of g.nodes) {
    if (n.role === 'neighbor' && n.alerts.length === 0 && n.component !== g.root) {
      links.set(n.component, []);
    }
  }
  for (const e of g.edges) {
    links.get(e.from)?.push(`>${e.relation}\0${e.to}`);
    links.get(e.to)?.push(`<${e.relation}\0${e.from}`);
  }
  const alike = new Map<string, SubNode[]>();
  for (const n of g.nodes) {
    const l = links.get(n.component);
    if (l) {
      const key = [n.kind, n.namespace ?? '', n.hops, ...l.sort()].join('\0');
      alike.set(key, [...(alike.get(key) ?? []), n]);
    }
  }
  const groups: FoldGroup[] = [];
  const groupOf = new Map<string, string>();
  let foldable = 0;
  for (const members of alike.values()) {
    if (members.length < FOLD_MIN) {
      continue;
    }
    foldable++;
    const first = members[0] as SubNode;
    const id = `fold:${first.component}`;
    if (expanded.has(id)) {
      continue;
    }
    groups.push({ id, kind: first.kind, namespace: first.namespace, hops: first.hops, members });
    for (const m of members) {
      groupOf.set(m.component, id);
    }
  }
  const edges = new Map<string, SubEdge>();
  for (const e of g.edges) {
    const from = groupOf.get(e.from) ?? e.from;
    const to = groupOf.get(e.to) ?? e.to;
    const key = `${from}\0${e.relation}\0${to}`;
    const seen = edges.get(key);
    if (!seen || e.confidence < seen.confidence) {
      edges.set(key, { ...e, from, to });
    }
  }
  return { nodes: g.nodes.filter((n) => !groupOf.has(n.component)), groups, edges: [...edges.values()], foldable };
}
