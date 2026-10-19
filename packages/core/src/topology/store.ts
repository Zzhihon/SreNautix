// 事件溯源的拓扑（DESIGN §4.1）。节点与边按 [valid_from, valid_to) 保存，可以按任意时刻查询；
// 每次研判引用当时的拓扑版本（事件 seq）。
import type { ClusterId, ComponentKey, TopologyEdge, TopologyEvent, TopologyNode } from '@srenautix/contract';
import { formatTime, parseTime } from '../time.js';
import { TopologyGraph } from './graph.js';

export type TopologySource = TopologyEvent['source'];

interface Interval<T> {
  from: number;
  to: number | null;
  value: T;
  source: TopologySource;
  seq: number;
}

export function edgeKey(e: Pick<TopologyEdge, 'from' | 'to' | 'relation'>): string {
  return `${e.from}|${e.relation}|${e.to}`;
}

export interface TopologySnapshot {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface TopologyStoreOptions {
  clusterId: ClusterId;
  /** 事件 id 生成器，默认 crypto.randomUUID */
  newId?: () => string;
}

export class TopologyStore {
  readonly clusterId: ClusterId;
  private readonly newId: () => string;
  private readonly events: TopologyEvent[] = [];
  private readonly nodes = new Map<ComponentKey, Array<Interval<TopologyNode>>>();
  private readonly edges = new Map<string, Array<Interval<TopologyEdge>>>();
  private seq = 0;

  constructor(opts: TopologyStoreOptions) {
    this.clusterId = opts.clusterId;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  get version(): number {
    return this.seq;
  }

  /** 全部事件（按 seq），用于持久化与推送 */
  log(): readonly TopologyEvent[] {
    return this.events;
  }

  /** 重放已持久化的事件；seq 必须连续递增 */
  load(events: readonly TopologyEvent[]): void {
    for (const ev of events) {
      if (ev.seq !== this.seq + 1) {
        throw new Error(`拓扑事件 seq 不连续：期望 ${this.seq + 1}，收到 ${ev.seq}`);
      }
      if (ev.cluster_id !== this.clusterId) {
        throw new Error(`拓扑事件属于集群 ${ev.cluster_id}，本存储属于 ${this.clusterId}`);
      }
      this.applyEvent(ev);
    }
  }

  private append(
    op: TopologyEvent['op'],
    source: TopologySource,
    from: number,
    to: number | null,
    node: TopologyNode | null,
    edge: TopologyEdge | null,
  ): TopologyEvent {
    const ev: TopologyEvent = {
      event_id: this.newId(),
      cluster_id: this.clusterId,
      seq: this.seq + 1,
      op,
      valid_from: formatTime(from),
      valid_to: to === null ? null : formatTime(to),
      source,
      node,
      edge,
    };
    this.applyEvent(ev);
    return ev;
  }

  private applyEvent(ev: TopologyEvent): void {
    this.seq = ev.seq;
    this.events.push(ev);
    const from = parseTime(ev.valid_from);
    const to = ev.valid_to === null ? null : parseTime(ev.valid_to);
    if (ev.op === 'node_upsert' || ev.op === 'node_delete') {
      if (ev.node === null) {
        throw new Error(`${ev.op} 缺少 node`);
      }
      upsertInterval(this.nodes, ev.node.key, ev, from, to, ev.op === 'node_upsert' ? ev.node : null);
    } else {
      if (ev.edge === null) {
        throw new Error(`${ev.op} 缺少 edge`);
      }
      upsertInterval(this.edges, edgeKey(ev.edge), ev, from, to, ev.op === 'edge_upsert' ? ev.edge : null);
    }
  }

  /**
   * 用一份完整快照对账某个来源在时刻 at 的状态：新增或变化的写 upsert，消失的写 delete。
   * 只比较同一来源的条目，其他来源（例如用户声明的覆盖）不受影响。返回新产生的事件
   */
  reconcile(snapshot: TopologySnapshot, at: number, source: TopologySource): TopologyEvent[] {
    const out: TopologyEvent[] = [];
    const seenNodes = new Set<ComponentKey>();
    for (const n of snapshot.nodes) {
      seenNodes.add(n.key);
      const open = openInterval(this.nodes.get(n.key));
      if (!open || open.source !== source || JSON.stringify(open.value) !== JSON.stringify(n)) {
        out.push(this.append('node_upsert', source, at, null, n, null));
      }
    }
    for (const [key, list] of this.nodes) {
      const open = openInterval(list);
      if (open && open.source === source && !seenNodes.has(key)) {
        out.push(this.append('node_delete', source, at, null, open.value, null));
      }
    }
    const seenEdges = new Set<string>();
    for (const e of snapshot.edges) {
      const key = edgeKey(e);
      seenEdges.add(key);
      const open = openInterval(this.edges.get(key));
      if (!open || open.source !== source || JSON.stringify(open.value) !== JSON.stringify(e)) {
        out.push(this.append('edge_upsert', source, at, null, null, e));
      }
    }
    for (const [key, list] of this.edges) {
      const open = openInterval(list);
      if (open && open.source === source && !seenEdges.has(key)) {
        out.push(this.append('edge_delete', source, at, null, null, open.value));
      }
    }
    return out;
  }

  /** 写入一段已知起止的历史区间（从 kube-state-metrics 历史重建时使用） */
  addInterval(
    item: { node: TopologyNode } | { edge: TopologyEdge },
    from: number,
    to: number | null,
    source: TopologySource,
  ): TopologyEvent {
    return 'node' in item
      ? this.append('node_upsert', source, from, to, item.node, null)
      : this.append('edge_upsert', source, from, to, null, item.edge);
  }

  /** 时刻 t 的拓扑：valid_from <= t 且 (valid_to 为空或 t < valid_to) */
  asOf(t: number): TopologyGraph {
    const nodes: TopologyNode[] = [];
    let version = 0;
    for (const list of this.nodes.values()) {
      const hit = at(list, t);
      if (hit) {
        nodes.push(hit.value);
        version = Math.max(version, hit.seq);
      }
    }
    const edges: TopologyEdge[] = [];
    for (const list of this.edges.values()) {
      const hit = at(list, t);
      if (hit) {
        edges.push(hit.value);
        version = Math.max(version, hit.seq);
      }
    }
    // 边的端点必须存在；端点已删除的边不进入图
    const keys = new Set(nodes.map((n) => n.key));
    return new TopologyGraph(
      nodes,
      edges.filter((e) => keys.has(e.from) && keys.has(e.to)),
      version,
    );
  }

  /** 节点最近一次有效区间，用于墓碑查找：删除后仍能拿到删除前的样子 */
  lastSeen(key: ComponentKey): { node: TopologyNode; from: number; to: number | null } | undefined {
    const list = this.nodes.get(key);
    const last = list?.[list.length - 1];
    return last ? { node: last.value, from: last.from, to: last.to } : undefined;
  }
}

function openInterval<T>(list: Array<Interval<T>> | undefined): Interval<T> | undefined {
  const last = list?.[list.length - 1];
  return last && last.to === null ? last : undefined;
}

function at<T>(list: Array<Interval<T>>, t: number): Interval<T> | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const iv = list[i]!;
    if (iv.from <= t && (iv.to === null || t < iv.to)) {
      return iv;
    }
  }
  return undefined;
}

function upsertInterval<T>(
  map: Map<string, Array<Interval<T>>>,
  key: string,
  ev: TopologyEvent,
  from: number,
  to: number | null,
  value: T | null,
): void {
  const list = map.get(key) ?? [];
  // 关闭起点早于新事件的开放区间
  for (const iv of list) {
    if (iv.to === null && iv.from <= from) {
      iv.to = from;
    }
  }
  if (value !== null) {
    list.push({ from, to, value, source: ev.source, seq: ev.seq });
    list.sort((a, b) => a.from - b.from || a.seq - b.seq);
  }
  map.set(key, list);
}
