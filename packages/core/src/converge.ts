// 收敛（DESIGN §5）：告警映射到实体后，满足以下条件就合并为一个事件
//   - 沿置信度 ≥ τ 的边可达（枢纽不作为中间节点）；
//   - 符合作用范围规则（对象级可达：节点故障只连到运行在该节点上的 Pod）；
//   - 时间相邻（默认 30 分钟）。
// forecast 告警最多加入一个分组，不能把两个分组连起来；变更在 30 分钟窗口内连到它触及的组件上的告警；
// 没有告警的集群枢纽只有在至少 3 个独立依赖方同时出现告警时才吸收这些告警。
import type { Alert, ChangeEvent, ComponentKey } from '@srenautix/contract';
import { entityKey } from './keys.js';
import type { ResolvedRcaParams } from './params.js';
import { parseTime } from './time.js';
import type { ReachResult, TopologyGraph } from './topology/graph.js';

export interface PreparedAlert {
  alert: Alert;
  start: number;
  /** 结束时间；仍在触发时为 now */
  end: number;
  /** 在拓扑中的起点对象；不在拓扑中时为 null */
  anchor: ComponentKey | null;
  component: ComponentKey | null;
  /** 沿 ≥ τ 的边可达（归并用） */
  mergeReach: ReachResult | null;
  /** 沿全部非命名推断边可达（候选排序用） */
  rankReach: ReachResult | null;
}

export interface AlertGroup {
  alerts: PreparedAlert[];
  changes: ChangeEvent[];
  /** 吸收了至少 3 个独立依赖方告警的无告警枢纽 */
  hubs: ComponentKey[];
}

export interface ConvergeInput {
  alerts: readonly Alert[];
  changes: readonly ChangeEvent[];
  graph: TopologyGraph;
  params: ResolvedRcaParams;
  now: number;
}

export function prepareAlerts(
  alerts: readonly Alert[],
  graph: TopologyGraph,
  params: ResolvedRcaParams,
  now: number,
): PreparedAlert[] {
  return alerts.map((a) => {
    const ek = a.entity ? entityKey(a.entity) : null;
    const anchor =
      ek !== null && graph.has(ek) ? ek : a.component !== null && graph.has(a.component) ? a.component : null;
    return {
      alert: a,
      start: parseTime(a.starts_at),
      end: a.ends_at === null ? now : parseTime(a.ends_at),
      anchor,
      component: a.component,
      mergeReach:
        anchor === null
          ? null
          : graph.reach(anchor, { minConfidence: params.mergeThreshold, excludeProvenance: ['naming'] }),
      rankReach: anchor === null ? null : graph.reach(anchor, { minConfidence: 0, excludeProvenance: ['naming'] }),
    };
  });
}

function adjacent(a: { start: number; end: number }, b: { start: number; end: number }, gapMs: number): boolean {
  return Math.max(a.start, b.start) - Math.min(a.end, b.end) <= gapMs;
}

/**
 * x 依赖 y：从 x 的实体出发可达 y 的实体；y 的实体就是组件本身时，可达该组件的任一对象也算。
 * 返回路径置信度，不可达为 0
 */
export function dependsOn(x: PreparedAlert, y: PreparedAlert, graph: TopologyGraph, which: 'merge' | 'rank'): number {
  const reach = which === 'merge' ? x.mergeReach : x.rankReach;
  if (reach === null || y.anchor === null) {
    return 0;
  }
  const direct = reach.objects.get(y.anchor) ?? 0;
  if (y.anchor === graph.componentOf(y.anchor)) {
    return Math.max(direct, reach.components.get(y.anchor) ?? 0);
  }
  return direct;
}

/** 变更触及的组件（变更目标所属的组件） */
export function changeComponents(c: ChangeEvent, graph: TopologyGraph): Set<ComponentKey> {
  return new Set(c.targets.map((t) => (graph.has(t) ? graph.componentOf(t) : t)));
}

/** 告警 x 与变更 c 的关联置信度：x 在变更后的窗口内触发，且 x 的组件就是或依赖变更目标 */
export function changeExplains(
  c: ChangeEvent,
  x: PreparedAlert,
  graph: TopologyGraph,
  params: ResolvedRcaParams,
  which: 'merge' | 'rank',
): number {
  const t = parseTime(c.time);
  if (x.start < t || x.start - t > params.changeWindowMs) {
    return 0;
  }
  let best = 0;
  const reach = which === 'merge' ? x.mergeReach : x.rankReach;
  for (const comp of changeComponents(c, graph)) {
    if (x.component === comp) {
      return 1;
    }
    best = Math.max(best, reach?.components.get(comp) ?? 0);
  }
  return best;
}

class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  union(a: number, b: number): void {
    const x = this.find(a);
    const y = this.find(b);
    if (x !== y) {
      this.parent[Math.max(x, y)] = Math.min(x, y);
    }
  }
}

export function converge(input: ConvergeInput): AlertGroup[] {
  const { graph, params } = input;
  const xs = prepareAlerts(input.alerts, graph, params, input.now);
  // 稳定顺序：结果不依赖告警到达的顺序
  xs.sort((a, b) => a.start - b.start || a.alert.alert_id.localeCompare(b.alert.alert_id));
  const changes = [...input.changes].sort(
    (a, b) => a.time.localeCompare(b.time) || a.change_id.localeCompare(b.change_id),
  );
  const n = xs.length;
  const uf = new UnionFind(n + changes.length);
  const isForecast = (x: PreparedAlert) => x.alert.classification.role === 'forecast';
  const gap = params.adjacencyMs;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const x = xs[i]!;
      const y = xs[j]!;
      if (!adjacent(x, y, gap)) {
        continue;
      }
      // 同一组件上的同一实体（没有组件时按告警名）
      const sameObject =
        x.component !== null
          ? x.component === y.component &&
            (x.alert.entity === null) === (y.alert.entity === null) &&
            (x.alert.entity === null || entityKey(x.alert.entity) === entityKey(y.alert.entity!))
          : y.component === null && x.alert.alertname === y.alert.alertname;
      if (sameObject) {
        uf.union(i, j);
        continue;
      }
      if (isForecast(x) || isForecast(y)) {
        continue;
      }
      if (dependsOn(x, y, graph, 'merge') > 0 || dependsOn(y, x, graph, 'merge') > 0) {
        uf.union(i, j);
      }
    }
  }

  // forecast 只加入一个分组：路径置信度最高、时间最近的非 forecast 告警所在的分组
  for (let i = 0; i < n; i++) {
    const f = xs[i]!;
    if (!isForecast(f)) {
      continue;
    }
    let best: { j: number; conf: number; dt: number } | undefined;
    for (let j = 0; j < n; j++) {
      const y = xs[j]!;
      if (i === j || isForecast(y) || !adjacent(f, y, gap)) {
        continue;
      }
      const conf = Math.max(dependsOn(f, y, graph, 'merge'), dependsOn(y, f, graph, 'merge'));
      const dt = Math.abs(f.start - y.start);
      if (conf > 0 && (!best || conf > best.conf || (conf === best.conf && dt < best.dt))) {
        best = { j, conf, dt };
      }
    }
    if (best) {
      uf.union(i, best.j);
    }
  }

  changes.forEach((c, k) => {
    for (let i = 0; i < n; i++) {
      if (!isForecast(xs[i]!) && changeExplains(c, xs[i]!, graph, params, 'merge') >= params.mergeThreshold) {
        uf.union(i, n + k);
      }
    }
  });

  // 无告警的枢纽：只考虑没有原因与变更的分组里的告警（已有原因的症状不需要枢纽来解释）。
  // 时间相邻的这些告警中，至少 hubMinDependents 个相互独立（互不可达）的组件可达枢纽时，枢纽吸收它们
  const alertComponents = new Set(xs.map((x) => x.component).filter((c): c is ComponentKey => c !== null));
  const explained = new Set<number>();
  xs.forEach((x, i) => {
    if (x.alert.classification.role === 'cause' || x.alert.classification.role === 'change') {
      explained.add(uf.find(i));
    }
  });
  changes.forEach((_, k) => explained.add(uf.find(n + k)));
  const hubsByRoot = new Map<number, Set<ComponentKey>>();
  const hubComponents = new Set<ComponentKey>();
  for (const node of graph.allNodes()) {
    const comp = graph.componentOf(node.key);
    if (graph.isHub(node.key) && !alertComponents.has(comp)) {
      hubComponents.add(comp);
    }
  }
  const independent = (a: PreparedAlert, b: PreparedAlert) =>
    a.component !== b.component &&
    !(a.mergeReach?.components.has(b.component ?? '') ?? false) &&
    !(b.mergeReach?.components.has(a.component ?? '') ?? false);
  for (const hub of [...hubComponents].sort()) {
    const deps = xs
      .map((x, i) => ({ x, i }))
      .filter(
        ({ x, i }) => !isForecast(x) && !explained.has(uf.find(i)) && (x.mergeReach?.components.has(hub) ?? false),
      );
    for (const first of deps) {
      const win = deps.filter(({ x }) => x.start >= first.x.start && x.start - first.x.start <= gap);
      const chosen: PreparedAlert[] = [];
      for (const { x } of win) {
        if (chosen.every((c) => independent(c, x))) {
          chosen.push(x);
        }
      }
      if (chosen.length >= params.hubMinDependents) {
        for (const { i } of win) {
          uf.union(win[0]!.i, i);
        }
        const root = uf.find(win[0]!.i);
        const set = hubsByRoot.get(root) ?? new Set();
        set.add(hub);
        hubsByRoot.set(root, set);
      }
    }
  }

  const groups = new Map<number, AlertGroup>();
  xs.forEach((x, i) => {
    const r = uf.find(i);
    const g = groups.get(r) ?? { alerts: [], changes: [], hubs: [] };
    g.alerts.push(x);
    groups.set(r, g);
  });
  changes.forEach((c, k) => {
    const g = groups.get(uf.find(n + k));
    if (g) {
      g.changes.push(c);
    }
  });
  for (const [root, hubs] of hubsByRoot) {
    groups.get(uf.find(root))!.hubs.push(...[...hubs].sort());
  }
  return [...groups.values()];
}
