// 收敛（DESIGN §5）：告警映射到实体后，满足以下条件就合并为一个事件
//   - 沿置信度 ≥ τ 的边可达（枢纽不作为中间节点）；
//   - 符合作用范围规则（对象级可达：节点故障只连到运行在该节点上的 Pod）；
//   - 时间相邻（默认 30 分钟）。
// forecast 告警最多加入一个分组，不能把两个分组连起来；变更在 30 分钟窗口内连到它触及的组件上的告警；
// 没有告警的集群枢纽只有在至少 3 个独立依赖方同时出现告警时才吸收这些告警。
// 告警归属的组件按拓扑的 owned_by 链取到顶层（Pod → ReplicaSet → Deployment），Pod 级告警归到它的工作负载；
// 拓扑中没有锚点的告警（逻辑组件、命名空间伪组件、没有实体）在变更之后与该变更的分组时间相邻时归到这次变更（ADR 0104）。
import type { Alert, ChangeEvent, ComponentKey } from '@srenautix/contract';
import { entityKey, isNamespacePseudo, parseKey } from './keys.js';
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
    // 告警归属的组件：拓扑中的对象沿 owned_by 取到顶层（Pod 的告警归到它的 Deployment/StatefulSet）
    const component = anchor !== null ? graph.componentOf(anchor) : a.component;
    return {
      alert: component === a.component ? a : { ...a, component },
      start: parseTime(a.starts_at),
      end: a.ends_at === null ? now : parseTime(a.ends_at),
      anchor,
      component,
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

/** 依赖合并要求两条告警的开始时间相差不超过时间相邻的这么多倍（默认 4 × 30 分钟） */
export const DEPENDENCY_ONSET_FACTOR = 4;

/** 变更输入最多回看这么久（长期触发的告警不会让引擎读取无限久远的变更） */
export const MAX_CHANGE_LOOKBACK_MS = 24 * 3600_000;

/**
 * 计算事件时需要的变更从什么时候开始（ADR 0104）。变更与告警的关联按告警的开始时间计算
 * （告警在变更之后的变更窗口加时间相邻范围内触发），所以只要告警仍在触发或仍在回看窗口内，它之前这段范围内的变更都要在输入里；
 * 只取"现在之前一个窗口"会让发布在一小时后离开输入，已经归到这次发布的无对象告警被拆成新的事件。
 * 结果不早于 now − MAX_CHANGE_LOOKBACK_MS。
 */
export function changeInputFrom(
  alerts: ReadonlyArray<Pick<Alert, 'starts_at'>>,
  now: number,
  params: Pick<ResolvedRcaParams, 'changeWindowMs' | 'adjacencyMs'>,
): number {
  const reach = params.changeWindowMs + params.adjacencyMs;
  let earliest = now;
  for (const a of alerts) {
    const t = parseTime(a.starts_at);
    if (Number.isFinite(t) && t < earliest) {
      earliest = t;
    }
  }
  return Math.max(Math.min(now, earliest) - reach, now - MAX_CHANGE_LOOKBACK_MS);
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
  const comps = changeComponents(c, graph);
  const managers = managersOfTargets(comps, graph);
  for (const comp of comps) {
    if (x.component === comp) {
      return 1;
    }
    // 管理应用同时管理变更没有触及的兄弟工作负载：它作为目标时只解释落在应用本身上的告警（ADR 0104 §14）
    if (managers.has(comp)) {
      continue;
    }
    best = Math.max(best, reach?.components.get(comp) ?? 0);
  }
  // 发布的前置 Job（迁移）与一次性 Job 的变更作用在它写入的组件上：落在这些组件上的告警也由这次变更解释
  // （ADR 0104 §13、ADR 0140）
  if (x.component !== null) {
    best = Math.max(best, actsOn(c, graph).get(x.component) ?? 0);
  }
  return best;
}

/** 按强依据（managed_by、版本标签、镜像）挂上的前置 Job 才算发布的一部分；namespace_window 是弱推导，不扩展作用对象 */
const STRONG_ATTACHMENTS: ReadonlySet<string> = new Set(['managed_by', 'revision_label', 'image']);

/**
 * 变更的作用对象：变更目标中的 Job（挂上的前置 Job、一次性 Job 自成的变更）经 egress_to 访问的组件（迁移 Job 访问的数据库）
 * → 边的置信度。只看 egress_to：Job 依赖它们，迁移改的正是它们，所以它们上的告警可以由这次变更解释，它们也是变更失败时的
 * 根因候选（ADR 0140）；Job 的其他依赖（存储）与枢纽（DNS）不算。按第 4 档（namespace_window）弱推导挂上的 Job 不算（ADR 0104 §13）。
 * 变更自己的目标所属的组件不在结果里
 */
export function actsOn(c: ChangeEvent, graph: TopologyGraph): Map<ComponentKey, number> {
  const out = new Map<ComponentKey, number>();
  const own = changeComponents(c, graph);
  const basis = new Map((c.attachments ?? []).map((a) => [a.target, a.basis]));
  for (const t of c.targets) {
    const b = basis.get(t);
    if (graph.node(t)?.kind !== 'Job' || (b !== undefined && !STRONG_ATTACHMENTS.has(b))) {
      continue;
    }
    for (const e of graph.dependencies(t)) {
      if (e.relation !== 'egress_to' || e.provenance === 'naming') {
        continue;
      }
      const comp = graph.componentOf(e.to);
      // 枢纽（CoreDNS 之类，网络策略总会放行 DNS）是所有工作负载共用的基础设施，不是 Job 写入的对象
      if (!own.has(comp) && !graph.isHub(comp)) {
        out.set(comp, Math.max(out.get(comp) ?? 0, e.confidence));
      }
    }
  }
  return out;
}

/**
 * 变更目标中作为其他目标的管理应用出现的组件（另一个目标有到它的 managed_by 边），例如发布的目标里 checkout 与管理它的
 * Argo 应用。变更已经点名了具体的工作负载，同一应用下的其他工作负载不因为经 managed_by 可达应用而被这次变更解释。
 * 只有应用一个目标的变更（例如 Argo 同步）不受影响：没有别的目标指向它
 */
function managersOfTargets(comps: ReadonlySet<ComponentKey>, graph: TopologyGraph): Set<ComponentKey> {
  const out = new Set<ComponentKey>();
  for (const t of comps) {
    for (const e of graph.dependencies(t)) {
      if (e.relation === 'managed_by' && e.to !== t && comps.has(graph.componentOf(e.to))) {
        out.add(graph.componentOf(e.to));
      }
    }
  }
  return out;
}

/** 告警所在的命名空间：实体、命名空间伪组件或 namespace 标签 */
function namespaceOf(x: PreparedAlert): string | null {
  if (x.alert.entity?.namespace) {
    return x.alert.entity.namespace;
  }
  if (x.component !== null && isNamespacePseudo(x.component)) {
    return parseKey(x.component).name;
  }
  return x.alert.labels.namespace ?? null;
}

/** 变更目标所在的命名空间 */
function changeNamespaces(c: ChangeEvent, graph: TopologyGraph): Set<string> {
  const out = new Set<string>();
  for (const t of c.targets) {
    const n = graph.node(t);
    let ns = n?.namespace ?? null;
    if (!n) {
      try {
        ns = parseKey(t).namespace;
      } catch {
        ns = null;
      }
    }
    if (ns) {
      out.add(ns);
    }
  }
  return out;
}

/** 告警在拓扑里没有对象锚点，或者只落在命名空间伪组件上 */
function unanchored(x: PreparedAlert): boolean {
  return x.anchor === null || (x.component !== null && isNamespacePseudo(x.component));
}

/** 告警的逻辑归属：组件键，没有时取 component 标签（领域包按它归类的逻辑组件，例如 release） */
function logicalOf(x: PreparedAlert): string | null {
  return x.component ?? (x.alert.labels.component ? `label:${x.alert.labels.component}` : null);
}

/**
 * 没有锚点的告警该归到哪一次变更（ADR 0104），返回变更的下标，不归时为 null。条件：
 * - 告警在变更之后、变更窗口加时间相邻的范围内触发（默认 60 分钟）；
 * - 告警的命名空间就是变更目标所在的命名空间；或者角色是 change（发布流水线、部署后检查之类没有对象的告警）
 *   并且这次变更有影响：输入中至少一条有锚点的告警由它解释（触发在变更窗口内、组件就是或依赖变更目标）。
 *   没有影响的变更（例如另一个命名空间里同时发生、没有任何告警的发布）不吸收没有对象的发布告警；
 *   不满足这两条的告警，与已经归到某次变更的告警逻辑归属相同时（同一个组件键或 component 标签）也归到那次变更；
 * - 有多次变更可选时取告警之前最近的一次。
 */
function changeTargets(
  xs: readonly PreparedAlert[],
  changes: readonly ChangeEvent[],
  graph: TopologyGraph,
  params: ResolvedRcaParams,
): Array<number | null> {
  const out: Array<number | null> = xs.map(() => null);
  if (!changes.length) {
    return out;
  }
  const namespaces = changes.map((c) => changeNamespaces(c, graph));
  const times = changes.map((c) => parseTime(c.time));
  const own = changes.map((c) => changeComponents(c, graph));
  // 告警的组件就是变更自己的目标（不是命名空间伪组件）：对象已经删除（失败的迁移 Job 被流水线删掉）、告警因此没有锚点时，
  // 它仍然只属于这次变更（ADR 0140）
  const onTarget = (x: PreparedAlert, k: number) =>
    x.component !== null && !isNamespacePseudo(x.component) && own[k]!.has(x.component);
  // 有影响的变更：至少解释一条有锚点的告警，或落在它自己目标上的告警
  const impact = changes.map((c, k) =>
    xs.some(
      (x) =>
        (!unanchored(x) || onTarget(x, k)) &&
        x.alert.classification.role !== 'forecast' &&
        changeExplains(c, x, graph, params, 'rank') > 0,
    ),
  );
  const reach = params.changeWindowMs + params.adjacencyMs;
  const latestBefore = (x: PreparedAlert, ok: (k: number) => boolean): number | null => {
    let best: number | null = null;
    for (let k = 0; k < changes.length; k++) {
      const t = times[k]!;
      if (t <= x.start && x.start - t <= reach && ok(k) && (best === null || t > times[best]!)) {
        best = k;
      }
    }
    return best;
  };
  xs.forEach((x, i) => {
    if (x.alert.classification.role === 'forecast' || !unanchored(x)) {
      return;
    }
    const ns = namespaceOf(x);
    out[i] =
      latestBefore(x, (k) => onTarget(x, k)) ??
      latestBefore(
        x,
        (k) => (ns !== null && namespaces[k]!.has(ns)) || (x.alert.classification.role === 'change' && impact[k]!),
      );
  });
  // 逻辑归属相同的告警跟随已经归到变更的告警
  const byLogical = new Map<string, Set<number>>();
  xs.forEach((x, i) => {
    const l = logicalOf(x);
    if (l !== null && out[i] !== null) {
      byLogical.set(l, (byLogical.get(l) ?? new Set()).add(out[i]!));
    }
  });
  xs.forEach((x, i) => {
    const l = logicalOf(x);
    if (out[i] !== null || l === null || x.alert.classification.role === 'forecast' || !unanchored(x)) {
      return;
    }
    const ks = byLogical.get(l);
    if (ks) {
      out[i] = latestBefore(x, (k) => ks.has(k));
    }
  });
  return out;
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
  const targets = changeTargets(xs, changes, graph, params);
  // 没有对象锚点（或只落在命名空间伪组件上）、也没有归到变更的告警：它与别的告警"同一对象"只是因为都落在同一个命名空间
  // （或都没有组件、同名），不说明两者有关。这样的告警最多并入一个已有分组，不把两个分组连起来（ADR 0104 §14）
  const floating = xs.map((x, i) => unanchored(x) && targets[i] === null);
  const pending: Array<[number, number]> = [];

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
      // 归到不同变更的同名告警（例如两次发布各自的部署后检查）不因同名而合并
      const splitByChange = targets[i] !== null && targets[j] !== null && targets[i] !== targets[j];
      if (sameObject && floating[i] !== floating[j]) {
        pending.push(floating[i] ? [i, j] : [j, i]);
        continue;
      }
      if (sameObject && !splitByChange) {
        uf.union(i, j);
        continue;
      }
      if (sameObject) {
        continue;
      }
      if (isForecast(x) || isForecast(y)) {
        continue;
      }
      // 依赖关系只在两条告警开始时间相近时合并（ADR 0104）：已经持续触发数小时的告警（资源请求接近上限、全天的扩容
      // 顶格）不是几小时后才开始的新故障的起因，不吸收它
      if (Math.abs(x.start - y.start) > DEPENDENCY_ONSET_FACTOR * gap) {
        continue;
      }
      // 同一组件的不同对象（CNPG 集群的主库与备库 Pod、同一 Deployment 的两个 Pod）与依赖关系同样处理（ADR 0104 §12）；
      // 枢纽（每个节点上都有的 CNI 之类）与命名空间伪组件除外，它们的不同对象常常各自独立出故障
      const sameComponent =
        x.component !== null &&
        x.component === y.component &&
        !splitByChange &&
        !isNamespacePseudo(x.component) &&
        !graph.isHub(x.component);
      if (sameComponent || dependsOn(x, y, graph, 'merge') > 0 || dependsOn(y, x, graph, 'merge') > 0) {
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

  // 没有锚点的告警归到变更（ADR 0104）
  targets.forEach((k, i) => {
    if (k !== null) {
      uf.union(i, n + k);
    }
  });

  // 不归属的告警（以及彼此同一对象的这类告警组成的小组）只并入一个分组：开始时间最接近的那条同一对象告警所在的分组
  const floatingGroups = new Map<number, number[]>();
  xs.forEach((_, i) => {
    if (floating[i]) {
      const r = uf.find(i);
      floatingGroups.set(r, [...(floatingGroups.get(r) ?? []), i]);
    }
  });
  for (const members of [...floatingGroups.values()].sort((a, b) => a[0]! - b[0]!)) {
    const own = new Set(members);
    let best: { j: number; dt: number } | undefined;
    for (const [f, j] of pending) {
      if (!own.has(f)) {
        continue;
      }
      const dt = Math.abs(xs[f]!.start - xs[j]!.start);
      if (!best || dt < best.dt || (dt === best.dt && j < best.j)) {
        best = { j, dt };
      }
    }
    if (best) {
      uf.union(members[0]!, best.j);
    }
  }

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
