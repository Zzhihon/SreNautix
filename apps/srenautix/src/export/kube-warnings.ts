// 导出用的 Kubernetes Warning 摘要与疑似同一根因的分组（ADR 0185，契约 2.47.0 的 KubeWarningReport）。
// 输入是一个集群与一组事件（时间窗、组件、成员告警名）；每个集群固定执行 1 次 Loki 查询与 1 次（Loki 不可用时 5 次）
// kube-state-metrics 查询，再加 1 次拓扑查询，与事件数无关。查询失败或截断时结果标明不完整，其余来源照常计数。
import type {
  ComponentKey,
  KubeWarningCount,
  KubeWarningNode,
  KubeWarningObject,
  KubeWarningQuery,
  KubeWarningReport,
  KubeWarningSummary,
  LabelProfile,
  MetricsQueryRangeRequest,
  MetricsQueryResult,
  SuspectedCommonCauseGroup,
  SuspectedCommonCauseIncident,
  SuspectedCommonCauseKind,
  SuspectedCommonCauseNode,
} from '@srenautix/contract';
import { parseKey, scopedNamespace, tryNodeKey } from '@srenautix/core';
import { DatasourceError, type LokiMetricRangeRequest } from '@srenautix/integration-sdk';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import {
  eventObservations,
  eventsLogql,
  ksmObservations,
  ksmQueries,
  type KubeEventsSource,
  type Observation,
} from './kube-events.js';

/** 一个事件：时间窗的终点为 null 时表示仍在触发，取计算时刻 */
export interface KubeWarningIncident {
  incident_id: string;
  window: { from: string; to: string | null };
  /** 事件涉及的组件，根因在前（Incident.components） */
  components: readonly ComponentKey[];
  /** 成员告警名 */
  alertnames: readonly string[];
}

export interface KubeWarningsInput {
  cluster_id: string;
  incidents: readonly KubeWarningIncident[];
}

/** 拓扑历史：组件在时间段内的对象与所在节点（TopologyStore.placements） */
export interface PlacementSource {
  placements(
    clusterId: string,
    components: readonly string[],
    from: Date,
    to: Date,
  ): Promise<Array<{ component: string; object: string; node: string | null; from: Date; to: Date | null }>>;
}

export interface GroupingOptions {
  /** 同一节点上相邻信号的间隔不超过它时并为一个时间段 */
  gapMs: number;
  /** 事件可以早于信号时间段开始的时长 */
  beforeMs: number;
  /** 事件可以晚于信号时间段结束的时长 */
  afterMs: number;
  /** 成组需要的最少事件数 */
  minIncidents: number;
}

export const DEFAULT_GROUPING: GroupingOptions = {
  gapMs: 30 * 60_000,
  beforeMs: 30 * 60_000,
  afterMs: 30 * 60_000,
  minIncidents: 2,
};

export interface KubeWarningsDeps {
  /** Loki 里的 Kubernetes 事件日志；没有配置 Loki 时为 null，用 kube-state-metrics 降级 */
  events: {
    adapter: { metricRange(req: LokiMetricRangeRequest): Promise<MetricsQueryResult> };
    source: KubeEventsSource;
    maxSeries: number;
    timeoutMs: number;
  } | null;
  metrics: {
    adapter: { queryRange(req: MetricsQueryRangeRequest): Promise<MetricsQueryResult> };
    dialect: 'promql' | 'metricsql';
    profile: LabelProfile;
    maxSeries: number;
    timeoutMs: number;
  };
  placements: PlacementSource;
  grouping: GroupingOptions;
  /** 计算时刻（unix 毫秒）；事件时间窗的终点不晚于它 */
  now: () => number;
}

/** 分桶的求值点数上限：3 天的导出用 3 分钟的 step */
const MAX_POINTS = 1440;
const MIN_STEP_SECONDS = 60;
const MAX_OBJECTS = 20;

/** 分桶宽度：不小于 60 秒、整分钟，使求值点数不超过 MAX_POINTS */
export function stepSecondsFor(spanMs: number): number {
  const perPoint = Math.ceil(spanMs / 1000 / MAX_POINTS);
  return Math.max(MIN_STEP_SECONDS, Math.ceil(perPoint / 60) * 60);
}

interface Window {
  from: number;
  to: number;
}

/** 求值时刻 end、end - step、…，第一个分桶的开始不晚于 from：分桶恰好覆盖 [from, end] */
function alignedStart(w: Window, stepMs: number): number {
  const n = Math.max(1, Math.ceil((w.to - w.from) / stepMs));
  return w.to - (n - 1) * stepMs;
}

const iso = (t: number) => new Date(t).toISOString();

function normalizeWindows(incidents: readonly KubeWarningIncident[], now: number): Window[] {
  return incidents.map((i) => {
    const from = Date.parse(i.window.from);
    const to = Math.min(i.window.to === null ? now : Date.parse(i.window.to), now);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new TypeError(`事件 ${i.incident_id} 的时间窗不是合法的时间：${JSON.stringify(i.window)}`);
    }
    if (from > to) {
      throw new TypeError(`事件 ${i.incident_id} 的时间窗开始晚于结束（或晚于计算时刻）：${JSON.stringify(i.window)}`);
    }
    return { from, to };
  });
}

/** 执行固定的几次聚合查询并算出报告 */
export async function collectKubeWarnings(
  deps: KubeWarningsDeps,
  input: KubeWarningsInput,
): Promise<KubeWarningReport> {
  const now = deps.now();
  const windows = normalizeWindows(input.incidents, now);
  if (!windows.length) {
    return {
      cluster_id: input.cluster_id,
      window: { from: iso(now), to: iso(now) },
      step_seconds: MIN_STEP_SECONDS,
      complete: true,
      queries: [],
      summaries: [],
      groups: [],
    };
  }
  const span: Window = { from: Math.min(...windows.map((w) => w.from)), to: Math.max(...windows.map((w) => w.to)) };
  const stepSeconds = stepSecondsFor(span.to - span.from);
  const stepMs = stepSeconds * 1000;
  const start = alignedStart(span, stepMs);
  // kube-state-metrics 多求值一个 step：识别范围开始时已经被驱逐的 Pod
  const metricsStart = start - stepMs;
  // 时钟窗口的起点要容下查询的回看：区间或 offset 一个 step，加上 PromQL 的 5 分钟回看
  const clock = { from: iso(metricsStart - 2 * stepMs - 10 * 60_000), to: iso(now) };
  const observations: Observation[] = [];
  const queries: KubeWarningQuery[] = [];

  if (deps.events) {
    const e = deps.events;
    const query = eventsLogql(e.source, input.cluster_id, stepSeconds);
    const r = await record(queries, 'events', 'events', query, e.maxSeries, () =>
      e.adapter.metricRange({
        query,
        window: { from: iso(start), to: iso(span.to) },
        step_seconds: stepSeconds,
        clock_window: clock,
        timeout_ms: e.timeoutMs,
        max_series: e.maxSeries,
      }),
    );
    if (r) {
      observations.push(...eventObservations(e.source, r.series));
    }
  }
  const m = deps.metrics;
  for (const q of ksmQueries(m.profile, input.cluster_id, stepSeconds, deps.events === null)) {
    const r = await record(queries, q.name, 'kube_state_metrics', q.expr, m.maxSeries, () =>
      m.adapter.queryRange({
        expr: q.expr,
        dialect: m.dialect,
        window: { from: iso(metricsStart), to: iso(span.to) },
        step_seconds: stepSeconds,
        clock_window: clock,
        timeout_ms: m.timeoutMs,
        max_series: m.maxSeries,
      }),
    );
    if (r) {
      observations.push(...ksmObservations(q, m.profile, r.series, stepSeconds, metricsStart));
    }
  }
  const components = [...new Set(input.incidents.flatMap((i) => i.components))].sort();
  const rows = await deps.placements.placements(input.cluster_id, components, new Date(span.from), new Date(span.to));
  return buildKubeWarningReport({
    clusterId: input.cluster_id,
    incidents: input.incidents,
    windows,
    span,
    stepMs,
    observations,
    placements: rows.map((x) => ({
      component: x.component,
      object: x.object,
      node: x.node === null ? null : parseKey(x.node).name,
      from: x.from.getTime(),
      to: x.to === null ? Number.POSITIVE_INFINITY : x.to.getTime(),
    })),
    queries,
    grouping: deps.grouping,
  });
}

/**
 * 执行一次查询并记下结果。只有数据源错误（HTTP 失败、超时、后端拒绝，例如 Loki 的单次查询序列数上限）记为 failed、
 * 这一来源的计数缺失，报告标明不完整；其他错误（查询构造或解析的缺陷）照常抛出
 */
async function record(
  out: KubeWarningQuery[],
  name: string,
  source: KubeWarningQuery['source'],
  query: string,
  maxSeries: number,
  run: () => Promise<MetricsQueryResult>,
): Promise<MetricsQueryResult | null> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  try {
    const r = await run();
    out.push({
      name,
      source,
      query,
      status: r.truncated ? 'truncated' : 'ok',
      series: r.series.length,
      detail: r.truncated ? `序列数超过上限 ${maxSeries}，只保留按标签排序的前 ${maxSeries} 条` : null,
      duration_ms: ms(),
    });
    return r;
  } catch (e) {
    if (!(e instanceof DatasourceError)) {
      throw e;
    }
    out.push({ name, source, query, status: 'failed', series: 0, detail: e.message, duration_ms: ms() });
    return null;
  }
}

export interface Placement {
  component: ComponentKey;
  object: ComponentKey;
  /** 节点名；对象在这段时间没有运行在节点上时为 null */
  node: string | null;
  from: number;
  /** 仍然有效时为 +Infinity */
  to: number;
}

export interface ReportParts {
  clusterId: string;
  incidents: readonly KubeWarningIncident[];
  /** 与 incidents 一一对应、已截到计算时刻的时间窗 */
  windows: readonly Window[];
  span: Window;
  stepMs: number;
  observations: readonly Observation[];
  placements: readonly Placement[];
  queries: readonly KubeWarningQuery[];
  grouping: GroupingOptions;
}

/** 观测归属的对象键与节点：数据本身给出的节点优先，没有时取拓扑里该对象在这个分桶所在的节点 */
interface Attributed extends Observation {
  key: ComponentKey | null;
  at: string | null;
}

const overlaps = (aFrom: number, aTo: number, bFrom: number, bTo: number) => aFrom < bTo && bFrom < aTo;

/** 分桶 (t - step, t] 与时间窗 [from, to] 有重叠 */
const inWindow = (o: Observation, w: Window, stepMs: number) => o.t > w.from && o.t - stepMs < w.to;

function objectKey(o: Observation): ComponentKey | null {
  if (!o.object) {
    return null;
  }
  return tryNodeKey(o.object.kind, scopedNamespace(o.object.kind, o.object.namespace), o.object.name);
}

/** 由观测与拓扑历史算出报告（纯函数） */
export function buildKubeWarningReport(p: ReportParts): KubeWarningReport {
  const byObject = new Map<ComponentKey, Placement[]>();
  for (const pl of p.placements) {
    if (pl.node !== null) {
      byObject.set(pl.object, [...(byObject.get(pl.object) ?? []), pl]);
    }
  }
  const attributed: Attributed[] = p.observations.map((o) => {
    const key = objectKey(o);
    const placed =
      o.node ??
      (key === null
        ? null
        : ((byObject.get(key) ?? []).find((pl) => overlaps(o.t - p.stepMs, o.t, pl.from, pl.to))?.node ?? null));
    return { ...o, key, at: placed };
  });
  const complete = p.queries.every((q) => q.status === 'ok');
  const members = new Map<ComponentKey, Set<ComponentKey>>();
  for (const pl of p.placements) {
    members.set(pl.component, (members.get(pl.component) ?? new Set()).add(pl.object));
  }

  const views = p.incidents.map((inc, i) => incidentView(inc, p.windows[i]!, p, attributed, members, complete));
  const groups = (Object.keys(NODE_SIGNAL_RULES) as SuspectedCommonCauseKind[]).flatMap((kind) =>
    groupsOf(kind, p, attributed, views),
  );
  groups.sort((a, b) =>
    a.window.from < b.window.from ? -1 : a.window.from > b.window.from ? 1 : a.group_id < b.group_id ? -1 : 1,
  );
  return {
    cluster_id: p.clusterId,
    window: { from: iso(p.span.from), to: iso(p.span.to) },
    step_seconds: p.stepMs / 1000,
    complete,
    queries: [...p.queries],
    summaries: views.map((v) => v.summary),
    groups,
  };
}

interface IncidentView {
  incident: KubeWarningIncident;
  window: Window;
  summary: KubeWarningSummary;
  /** 组件在各节点上的时间段（不限于事件时间窗）：拓扑的 runs_on 区间、组件对象上带节点的观测分桶；组件本身是节点时为全部时间 */
  presence: Map<string, Window[]>;
}

function incidentView(
  inc: KubeWarningIncident,
  w: Window,
  p: ReportParts,
  attributed: readonly Attributed[],
  members: ReadonlyMap<ComponentKey, ReadonlySet<ComponentKey>>,
  complete: boolean,
): IncidentView {
  const own = new Set<ComponentKey>(inc.components);
  for (const c of inc.components) {
    for (const k of members.get(c) ?? []) {
      own.add(k);
    }
  }
  const inWin = attributed.filter((o) => inWindow(o, w, p.stepMs));
  const mine = inWin.filter((o) => o.key !== null && own.has(o.key));

  const presence = new Map<string, Window[]>();
  const via = new Map<string, Set<KubeWarningNode['via'][number]>>();
  const present = (node: string, span: Window, v: KubeWarningNode['via'][number]) => {
    presence.set(node, [...(presence.get(node) ?? []), span]);
    if (overlaps(w.from, w.to, span.from, span.to)) {
      via.set(node, (via.get(node) ?? new Set()).add(v));
    }
  };
  for (const c of inc.components) {
    const k = parseKey(c);
    if (k.kind === 'Node') {
      present(k.name, { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY }, 'component');
    }
  }
  for (const pl of p.placements) {
    if (pl.node !== null && inc.components.includes(pl.component)) {
      present(pl.node, { from: pl.from, to: pl.to }, 'topology');
    }
  }
  for (const o of attributed) {
    if (o.node !== null && o.key !== null && own.has(o.key)) {
      present(o.node, { from: o.t - p.stepMs, to: o.t }, 'events');
    }
  }
  const nodeNames = [...via.keys()].sort();
  const nodes: KubeWarningNode[] = nodeNames.map((n) => ({
    node: n,
    via: (['component', 'topology', 'events'] as const).filter((v) => via.get(n)!.has(v)),
    counts: aggregate(
      inWin.filter((o) => o.at === n),
      p.stepMs,
    ),
  }));

  const perObject = new Map<ComponentKey, Attributed[]>();
  for (const o of mine) {
    perObject.set(o.key!, [...(perObject.get(o.key!) ?? []), o]);
  }
  const objects = [...perObject.entries()].map(([key, os]): KubeWarningObject & { total: number; key: string } => {
    const o = os[0]!.object!;
    const counts = aggregate(os, p.stepMs);
    return {
      key,
      total: counts.reduce((s, c) => s + c.count, 0),
      kind: o.kind,
      namespace: scopedNamespace(o.kind, o.namespace),
      name: o.name,
      nodes: [...new Set(os.flatMap((x) => (x.at === null ? [] : [x.at])))].sort(),
      counts,
    };
  });
  objects.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    incident: inc,
    window: w,
    presence,
    summary: {
      incident_id: inc.incident_id,
      window: { from: iso(w.from), to: iso(w.to) },
      complete,
      components: [...inc.components],
      counts: aggregate(mine, p.stepMs),
      nodes,
      objects: objects.slice(0, MAX_OBJECTS).map(({ total: _t, key: _k, ...o }) => o),
      objects_truncated: objects.length > MAX_OBJECTS,
    },
  };
}

/**
 * 按 (reason, source, unit) 汇总：occurrences 为次数之和；pods 为不同 Pod 数；seconds 为不同 (节点, 分桶) 数乘 step 秒数。
 * memory 为消息提到内存的次数（occurrences）或 Pod 数（pods）；来源不带消息时为 null
 */
export function aggregate(os: readonly Observation[], stepMs: number): KubeWarningCount[] {
  const groups = new Map<string, Observation[]>();
  for (const o of os) {
    const k = JSON.stringify([o.reason, o.source, o.unit]);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const out: KubeWarningCount[] = [];
  for (const [k, g] of groups) {
    const [reason, source, unit] = JSON.parse(k) as [string, KubeWarningCount['source'], KubeWarningCount['unit']];
    const known = g.every((o) => o.memory !== null);
    let count: number;
    let memory: number | null;
    if (unit === 'occurrences') {
      count = g.reduce((s, o) => s + o.count, 0);
      memory = known ? g.filter((o) => o.memory).reduce((s, o) => s + o.count, 0) : null;
    } else if (unit === 'pods') {
      const id = (o: Observation) => JSON.stringify([o.object?.namespace ?? null, o.object?.name ?? null]);
      count = new Set(g.map(id)).size;
      memory = known ? new Set(g.filter((o) => o.memory).map(id)).size : null;
    } else {
      count = new Set(g.map((o) => `${o.node}@${o.t}`)).size * (stepMs / 1000);
      memory = null;
    }
    out.push({ reason, source, unit, count, memory });
  }
  return out.sort((a, b) =>
    a.reason !== b.reason
      ? a.reason < b.reason
        ? -1
        : 1
      : a.source !== b.source
        ? a.source < b.source
          ? -1
          : 1
        : a.unit < b.unit
          ? -1
          : a.unit > b.unit
            ? 1
            : 0,
  );
}

/** 一种以节点信号为依据的分组：哪些观测算作信号 */
interface NodeSignalRule {
  /** 写进 criteria.signal_reasons */
  reasons: readonly string[];
  signal(o: Observation): boolean;
}

/**
 * 节点信号的分组规则。node_memory_eviction：kubelet 因内存驱逐 Pod（Evicted 的消息为 low on resource: memory）、
 * 开始回收内存（EvictionThresholdMet 的消息为 Attempting to reclaim memory）、节点进入内存压力
 * （NodeHasInsufficientMemory，或 kube-state-metrics 的 MemoryPressure 条件）、节点级 OOM（SystemOOM）。
 * 容器超过自身内存限制的 OOMKilled 与节点内存无关，不算信号
 */
const NODE_SIGNAL_RULES: Record<SuspectedCommonCauseKind, NodeSignalRule> = {
  node_memory_eviction: {
    reasons: ['Evicted', 'EvictionThresholdMet', 'NodeHasInsufficientMemory', 'SystemOOM'],
    signal: (o) =>
      ((o.reason === 'Evicted' || o.reason === 'EvictionThresholdMet') && o.memory === true) ||
      o.reason === 'NodeHasInsufficientMemory' ||
      o.reason === 'SystemOOM',
  },
};

interface Episode {
  id: number;
  node: string;
  from: number;
  to: number;
}

/** 每个节点上的信号按时间并成时间段：相邻信号分桶的间隔不超过 gap 时合并 */
function episodesOf(signals: readonly Attributed[], stepMs: number, gapMs: number): Episode[] {
  const byNode = new Map<string, number[]>();
  for (const o of signals) {
    byNode.set(o.at!, [...(byNode.get(o.at!) ?? []), o.t]);
  }
  const out: Episode[] = [];
  for (const node of [...byNode.keys()].sort()) {
    const ts = [...new Set(byNode.get(node)!)].sort((a, b) => a - b);
    let cur: Episode | null = null;
    for (const t of ts) {
      if (cur && t - stepMs - cur.to <= gapMs) {
        cur.to = t;
      } else {
        cur = { id: out.length, node, from: t - stepMs, to: t };
        out.push(cur);
      }
    }
  }
  return out;
}

/** 区间并集与时间窗重叠的总长 */
function overlapMs(w: Window, spans: readonly Window[]): number {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  let total = 0;
  let cur: Window | null = null;
  const flush = () => {
    if (cur) {
      total += Math.max(0, Math.min(cur.to, w.to) - Math.max(cur.from, w.from));
    }
  };
  for (const s of sorted) {
    if (cur && s.from <= cur.to) {
      cur.to = Math.max(cur.to, s.to);
    } else {
      flush();
      cur = { ...s };
    }
  }
  flush();
  return total;
}

function nonEmpty<T>(xs: T[], what: string): [T, ...T[]] {
  if (!xs.length) {
    throw new Error(`${what} 不能为空`);
  }
  return xs as [T, ...T[]];
}

/**
 * 疑似同一根因的分组：事件时间窗与某个节点的信号时间段（向前放宽 before、向后放宽 after）重叠，并且组件在事件时间窗
 * 或信号时间段内在这个节点上（被驱逐之后重新调度失败的组件，事件时间窗里已经不在原来的节点上）时，事件与时间段相连；
 * 相连的事件与时间段（可以跨节点：一个事件的组件同时在两个有信号的节点上）构成一组。至少有 minIncidents 个事件的组才输出
 */
function groupsOf(
  kind: SuspectedCommonCauseKind,
  p: ReportParts,
  attributed: readonly Attributed[],
  views: readonly IncidentView[],
): SuspectedCommonCauseGroup[] {
  const rule = NODE_SIGNAL_RULES[kind];
  const g = p.grouping;
  const episodes = episodesOf(
    attributed.filter((o) => o.at !== null && rule.signal(o)),
    p.stepMs,
    g.gapMs,
  );
  // 并查集：0..E-1 为时间段，E.. 为事件
  const parent = Array.from({ length: episodes.length + views.length }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const links = views.map(() => [] as Episode[]);
  views.forEach((v, vi) => {
    for (const ep of episodes) {
      const near = v.window.from <= ep.to + g.afterMs && v.window.to >= ep.from - g.beforeMs;
      // 组件在事件时间窗或信号时间段内（取两者的范围）在这个节点上
      const from = Math.min(v.window.from, ep.from);
      const to = Math.max(v.window.to, ep.to);
      const onNode = (v.presence.get(ep.node) ?? []).some((s) => overlaps(from, to, s.from, s.to));
      if (near && onNode) {
        links[vi]!.push(ep);
        union(ep.id, episodes.length + vi);
      }
    }
  });
  const byRoot = new Map<number, { episodes: Episode[]; views: number[] }>();
  const entryOf = (i: number) => {
    const r = find(i);
    const e = byRoot.get(r) ?? { episodes: [], views: [] };
    byRoot.set(r, e);
    return e;
  };
  for (const ep of episodes) {
    entryOf(ep.id).episodes.push(ep);
  }
  views.forEach((_, vi) => {
    if (links[vi]!.length) {
      entryOf(episodes.length + vi).views.push(vi);
    }
  });

  const criteria = {
    signal_reasons: [...rule.reasons],
    gap_seconds: Math.round(g.gapMs / 1000),
    before_seconds: Math.round(g.beforeMs / 1000),
    after_seconds: Math.round(g.afterMs / 1000),
    min_incidents: g.minIncidents,
  };
  const out: SuspectedCommonCauseGroup[] = [];
  for (const { episodes: eps, views: vis } of byRoot.values()) {
    if (vis.length < g.minIncidents) {
      continue;
    }
    const nodes: SuspectedCommonCauseNode[] = [...new Set(eps.map((e) => e.node))].sort().map((node) => {
      const spans = eps.filter((e) => e.node === node).sort((a, b) => a.from - b.from);
      return {
        node,
        signal_windows: nonEmpty(
          spans.map((s) => ({ from: iso(s.from), to: iso(s.to) })),
          '信号时间段',
        ),
        counts: aggregate(
          attributed.filter((o) => o.at === node && spans.some((s) => inWindow(o, s, p.stepMs))),
          p.stepMs,
        ),
      };
    });
    const incidents: SuspectedCommonCauseIncident[] = vis
      .map((vi) => {
        const v = views[vi]!;
        const linked = links[vi]!;
        return {
          incident_id: v.incident.incident_id,
          window: v.summary.window,
          alertnames: [...new Set(v.incident.alertnames)].sort(),
          nodes: nonEmpty([...new Set(linked.map((e) => e.node))].sort(), '事件的信号节点'),
          overlap_seconds: Math.round(overlapMs(v.window, linked) / 1000),
          counts: v.summary.counts,
        };
      })
      .sort((a, b) =>
        a.window.from < b.window.from ? -1 : a.window.from > b.window.from ? 1 : a.incident_id < b.incident_id ? -1 : 1,
      );
    const signature = eps
      .map((e) => ({ node: e.node, from: iso(e.from), to: iso(e.to) }))
      .sort((a, b) => (a.node !== b.node ? (a.node < b.node ? -1 : 1) : a.from < b.from ? -1 : 1));
    out.push({
      group_id: `sha256:${createHash('sha256')
        .update(canonicalize([p.clusterId, kind, signature])!)
        .digest('hex')}`,
      kind,
      suspected: true,
      window: { from: iso(Math.min(...eps.map((e) => e.from))), to: iso(Math.max(...eps.map((e) => e.to))) },
      criteria,
      nodes: nonEmpty(nodes, '分组的节点'),
      incidents: nonEmpty(incidents, '分组的事件'),
      alertnames: [...new Set(incidents.flatMap((i) => i.alertnames))].sort(),
    });
  }
  return out;
}
