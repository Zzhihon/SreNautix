// 某一时刻的拓扑图（DESIGN §4）。
// 边的方向：from 依赖 to，to 的故障沿边反向传播到 from。
// owned_by 是成员关系：沿 owned_by 向上找到的顶层对象就是组件（Pod → ReplicaSet → Deployment，CNPG 的 Pod → Cluster），
// 收敛与根因排序都在组件上进行；其余的边是依赖边。
import type { ComponentKey, TopologyEdge, TopologyNode } from '@srenautix/contract';

export const OWNED_BY = 'owned_by';

export interface ReachOptions {
  /** 只沿置信度不低于它的边走：归并用 τ，候选排序用 0 */
  minConfidence: number;
  /** 排除的来源；命名推断只用于展示 */
  excludeProvenance?: ReadonlyArray<TopologyEdge['provenance']>;
}

export interface ReachResult {
  /** 可达的对象及最大路径置信度（路径上各边置信度之积） */
  objects: Map<ComponentKey, number>;
  /** 可达对象所属的组件及最大路径置信度 */
  components: Map<ComponentKey, number>;
}

export class TopologyGraph {
  private readonly nodes = new Map<ComponentKey, TopologyNode>();
  private readonly owner = new Map<ComponentKey, ComponentKey>();
  private readonly ownedMembers = new Map<ComponentKey, ComponentKey[]>();
  private readonly outEdges = new Map<ComponentKey, TopologyEdge[]>();
  private readonly componentCache = new Map<ComponentKey, ComponentKey>();
  private depthCache: Map<ComponentKey, number> | undefined;

  constructor(
    nodes: Iterable<TopologyNode>,
    readonly edges: readonly TopologyEdge[],
    readonly version: number,
  ) {
    for (const n of nodes) {
      this.nodes.set(n.key, n);
    }
    for (const e of edges) {
      if (e.relation === OWNED_BY) {
        // 一个对象只有一个控制者；构建时只为控制者生成 owned_by
        if (this.owner.has(e.from) && this.owner.get(e.from) !== e.to) {
          throw new Error(`${e.from} 有两个 owned_by：${this.owner.get(e.from)} 与 ${e.to}`);
        }
        this.owner.set(e.from, e.to);
        const list = this.ownedMembers.get(e.to) ?? [];
        list.push(e.from);
        this.ownedMembers.set(e.to, list);
      } else {
        const list = this.outEdges.get(e.from) ?? [];
        list.push(e);
        this.outEdges.set(e.from, list);
      }
    }
  }

  node(key: ComponentKey): TopologyNode | undefined {
    return this.nodes.get(key);
  }

  has(key: ComponentKey): boolean {
    return this.nodes.has(key);
  }

  allNodes(): IterableIterator<TopologyNode> {
    return this.nodes.values();
  }

  /** 沿 owned_by 向上的顶层对象；不在图中的键就是它自己 */
  componentOf(key: ComponentKey): ComponentKey {
    const cached = this.componentCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let cur = key;
    const seen = new Set<ComponentKey>([cur]);
    for (let next = this.owner.get(cur); next !== undefined; next = this.owner.get(cur)) {
      if (seen.has(next)) {
        throw new Error(`owned_by 成环：${[...seen].join(' → ')} → ${next}`);
      }
      seen.add(next);
      cur = next;
    }
    this.componentCache.set(key, cur);
    return cur;
  }

  /** 对象自身加上沿 owned_by 向下的全部成员 */
  membersOf(key: ComponentKey): ComponentKey[] {
    const out: ComponentKey[] = [key];
    for (let i = 0; i < out.length; i++) {
      out.push(...(this.ownedMembers.get(out[i]!) ?? []));
    }
    return out;
  }

  dependencies(key: ComponentKey): readonly TopologyEdge[] {
    return this.outEdges.get(key) ?? [];
  }

  /** 对象或它所属的组件是集群枢纽 */
  isHub(key: ComponentKey): boolean {
    return Boolean(this.nodes.get(key)?.hub || this.nodes.get(this.componentOf(key))?.hub);
  }

  /**
   * 从实体出发沿依赖边可达的对象与组件（最大路径置信度）。
   * 起点是实体及其全部成员（例如 Deployment 的全部 Pod）；作用范围由对象级的边自然体现：
   * 节点故障只连到运行在该节点上的 Pod。枢纽可以被到达，但不再向下展开（DESIGN §4.3）。
   */
  reach(entity: ComponentKey, opts: ReachOptions): ReachResult {
    const best = new Map<ComponentKey, number>();
    const queue: Array<[ComponentKey, number]> = [];
    for (const m of this.membersOf(entity)) {
      best.set(m, 1);
      queue.push([m, 1]);
    }
    const excluded = new Set(opts.excludeProvenance ?? []);
    const startComponent = this.componentOf(entity);
    // 最大乘积路径：置信度都在 (0,1]，按当前最优值从大到小展开
    while (queue.length > 0) {
      queue.sort((a, b) => b[1] - a[1]);
      const [cur, conf] = queue.shift()!;
      if (conf < (best.get(cur) ?? 0)) {
        continue;
      }
      const isStart = conf === 1 && this.componentOf(cur) === startComponent;
      if (!isStart && this.isHub(cur)) {
        continue;
      }
      for (const e of this.dependencies(cur)) {
        if (e.confidence < opts.minConfidence || excluded.has(e.provenance)) {
          continue;
        }
        const c = conf * e.confidence;
        if (c > (best.get(e.to) ?? 0)) {
          best.set(e.to, c);
          queue.push([e.to, c]);
        }
      }
    }
    const components = new Map<ComponentKey, number>();
    for (const [k, c] of best) {
      const comp = this.componentOf(k);
      components.set(comp, Math.max(components.get(comp) ?? 0, c));
    }
    return { objects: best, components };
  }

  /** 组件级依赖边（去掉组件内部的边），用于深度与子图 */
  componentEdges(): Array<{ from: ComponentKey; to: ComponentKey; edge: TopologyEdge }> {
    const out: Array<{ from: ComponentKey; to: ComponentKey; edge: TopologyEdge }> = [];
    for (const list of this.outEdges.values()) {
      for (const e of list) {
        const from = this.componentOf(e.from);
        const to = this.componentOf(e.to);
        if (from !== to) {
          out.push({ from, to, edge: e });
        }
      }
    }
    return out;
  }

  /**
   * 组件深度：折叠强连通分量后，从没有依赖方的组件出发的最长路径长度（DESIGN §4.3）。
   * 越深越接近依赖链底部，只用于根因平分时排序。不在图中的组件为 -1
   */
  depth(component: ComponentKey): number {
    this.depthCache ??= this.computeDepths();
    return this.depthCache.get(component) ?? -1;
  }

  private computeDepths(): Map<ComponentKey, number> {
    const comps = new Set<ComponentKey>();
    for (const k of this.nodes.keys()) {
      comps.add(this.componentOf(k));
    }
    const adj = new Map<ComponentKey, Set<ComponentKey>>();
    for (const c of comps) {
      adj.set(c, new Set());
    }
    for (const { from, to } of this.componentEdges()) {
      if (comps.has(from) && comps.has(to)) {
        adj.get(from)!.add(to);
      }
    }
    const scc = tarjan([...comps], adj);
    // 分量图：from 分量依赖 to 分量；深度沿依赖方向递增
    const sccAdj = new Map<number, Set<number>>();
    const indeg = new Map<number, number>();
    for (let i = 0; i < scc.count; i++) {
      sccAdj.set(i, new Set());
      indeg.set(i, 0);
    }
    for (const [from, tos] of adj) {
      for (const to of tos) {
        const a = scc.of.get(from)!;
        const b = scc.of.get(to)!;
        if (a !== b && !sccAdj.get(a)!.has(b)) {
          sccAdj.get(a)!.add(b);
          indeg.set(b, indeg.get(b)! + 1);
        }
      }
    }
    const depth = new Map<number, number>();
    const ready = [...indeg].filter(([, d]) => d === 0).map(([i]) => i);
    for (const i of ready) {
      depth.set(i, 0);
    }
    while (ready.length > 0) {
      const i = ready.shift()!;
      for (const j of sccAdj.get(i)!) {
        depth.set(j, Math.max(depth.get(j) ?? 0, depth.get(i)! + 1));
        indeg.set(j, indeg.get(j)! - 1);
        if (indeg.get(j) === 0) {
          ready.push(j);
        }
      }
    }
    return new Map([...comps].map((c) => [c, depth.get(scc.of.get(c)!)!]));
  }

  /** 以组件为中心、不超过 hops 跳的子图（组件级，按无向相邻展开） */
  subgraph(
    center: ComponentKey,
    hops: number,
  ): { nodes: Map<ComponentKey, number>; edges: Array<{ from: ComponentKey; to: ComponentKey; edge: TopologyEdge }> } {
    const all = this.componentEdges();
    const dist = new Map<ComponentKey, number>([[center, 0]]);
    let frontier = [center];
    for (let h = 1; h <= hops; h++) {
      const next: ComponentKey[] = [];
      for (const { from, to } of all) {
        for (const [a, b] of [
          [from, to],
          [to, from],
        ] as const) {
          if (frontier.includes(a) && !dist.has(b)) {
            dist.set(b, h);
            next.push(b);
          }
        }
      }
      frontier = next;
    }
    const edges = all.filter(({ from, to }) => dist.has(from) && dist.has(to));
    return { nodes: dist, edges };
  }
}

function tarjan(
  vertices: ComponentKey[],
  adj: Map<ComponentKey, Set<ComponentKey>>,
): { of: Map<ComponentKey, number>; count: number } {
  let index = 0;
  let count = 0;
  const idx = new Map<ComponentKey, number>();
  const low = new Map<ComponentKey, number>();
  const onStack = new Set<ComponentKey>();
  const stack: ComponentKey[] = [];
  const of = new Map<ComponentKey, number>();
  // 迭代实现，避免深依赖链上的递归栈溢出
  for (const root of vertices) {
    if (idx.has(root)) {
      continue;
    }
    const work: Array<{ v: ComponentKey; it: Iterator<ComponentKey> }> = [];
    const visit = (v: ComponentKey) => {
      idx.set(v, index);
      low.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      work.push({ v, it: adj.get(v)![Symbol.iterator]() });
    };
    visit(root);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const step = top.it.next();
      if (!step.done) {
        const w = step.value;
        if (!idx.has(w)) {
          visit(w);
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.v;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
      }
      if (low.get(top.v) === idx.get(top.v)) {
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          of.set(w, count);
          if (w === top.v) {
            break;
          }
        }
        count++;
      }
    }
  }
  return { of, count };
}
