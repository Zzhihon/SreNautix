import type {
  Alert,
  ComponentType,
  EvidenceResult,
  Incident,
  LocalizedText,
  NotifyBlock,
  NotifyRun,
  StageAReport,
  TopologyEdge,
  TopologyNode,
} from '@srenautix/contract';
import { ACCESS_RELATIONS, displayKey, matchTypeByName, TopologyGraph, tryNodeKey } from '@srenautix/core';
import type pg from 'pg';
import { isBusinessImpact, matcherKeys, matchersText, type AlertMatcher } from '../alerts/business-impact.js';
import { parseStoredKey } from '../topology/keys.js';
import type { ComposeInput } from './compose.js';

// 外部上游的周期汇总（ADR 0147）：根因是集群之外的上游（领域包声明 external 的组件类型，例如模型服务方 provider 与 model，
// 或配置列出的逻辑组件）的事件不逐条即时推送、不逐条开 issue，每个周期（默认整点、1 小时）发一条汇总。
// 例外：同时有与这个上游事件相关的业务影响时照常即时推送，横幅写“上游故障已影响业务”与相关的依据（ADR 0150）：
// 本事件异常的影响卡；业务告警（或其他事件的影响卡）在上游事件开始后的时间窗内开始，或它的组件经拓扑依赖到上游根因。

export interface ExternalRootSettings {
  enabled: boolean;
  /** 汇总周期；窗口按 UTC 纪元对齐，1 小时即整点 */
  periodMs: number;
  /** 另外按外部上游处理的根因组件键（例如按主题聚合的逻辑组件 component:provider） */
  components: readonly string[];
  /** 全部成员告警都满足这些标签条件（每个键取值之一）的事件也按外部上游处理；为空时不用 */
  alertLabels: Readonly<Record<string, readonly string[]>>;
  /** 业务影响的判定：业务影响告警（notify.business_impact_alerts，ADR 0166）、或异常的影响卡（impact: true），并且与上游事件相关 */
  impact: {
    alerts: readonly AlertMatcher[];
    impactCards: boolean;
    /** 在上游事件开始后这么久之内开始的业务告警（与其他事件）算相关；开始早于上游事件的不算 */
    withinMs: number;
    /** 组件沿依赖边最多这么多跳到达上游根因时也算相关；0 时不看拓扑 */
    topologyHops: number;
  };
}

/**
 * 业务影响信号与上游事件相关的依据（ADR 0150）：
 * - own_card：本事件自己异常的影响卡；
 * - window：业务告警（subject: alert）或影响卡所在的事件（subject: incident）在上游事件开始后 withinMs 之内开始；
 * - topology：信号的组件（告警的组件，或影响卡所在事件的根因）沿依赖边到达上游根因，path 是组件级的路径，首尾是这两个组件
 */
export type ImpactBasis =
  | { kind: 'own_card' }
  | { kind: 'window'; subject: 'alert' | 'incident'; upstream_at: string; starts_at: string }
  | { kind: 'topology'; path: string[] };

export interface ImpactSignal {
  /** 告警名，或影响卡标题与值（按事件的语言） */
  signal: string;
  basis: ImpactBasis;
}

/** 从 from 沿依赖边到达 to 的组件级路径；没有路径时为 null */
export type TopologyPathLookup = (clusterId: string, from: string, to: string) => Promise<string[] | null>;

/**
 * 依赖路径（ADR 0150）：从 from 的对象及其成员出发，沿依赖边（from 依赖 to）最多 maxHops 跳，到达 to 所属组件的对象时，
 * 返回经过的组件序列。展开规则与 TopologyGraph.reach 相同：枢纽可以被到达但不再展开，经访问边（egress_to）到达的组件不再
 * 沿它的依赖展开，命名推断的边只用于展示，不算。两者是同一个组件时路径只有这一个组件
 */
export function dependencyPath(graph: TopologyGraph, from: string, to: string, maxHops: number): string[] | null {
  const target = graph.componentOf(to);
  const start = graph.componentOf(from);
  if (start === target) {
    return [target];
  }
  const prev = new Map<string, string | null>();
  let frontier: string[] = [];
  for (const m of graph.membersOf(from)) {
    prev.set(m, null);
    frontier.push(m);
  }
  const pathTo = (k: string): string[] => {
    const chain: string[] = [];
    for (let cur: string | null = k; cur !== null; cur = prev.get(cur) ?? null) {
      chain.unshift(graph.componentOf(cur));
    }
    return chain.filter((c, i) => i === 0 || chain[i - 1] !== c);
  };
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const cur of frontier) {
      if (graph.componentOf(cur) !== start && graph.isHub(cur)) {
        continue;
      }
      for (const e of graph.dependencies(cur)) {
        if (e.provenance === 'naming' || prev.has(e.to)) {
          continue;
        }
        prev.set(e.to, cur);
        if (graph.componentOf(e.to) === target) {
          return pathTo(e.to);
        }
        if (!ACCESS_RELATIONS.has(e.relation)) {
          next.push(e.to);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/** 拓扑子图的读取：从 seeds 出发不超过 hops 跳（边的两个方向），与 TopologyStore.subgraph 相同 */
export type SubgraphReader = (
  clusterId: string,
  seeds: readonly string[],
  t: Date,
  hops: number,
) => Promise<{ nodes: TopologyNode[]; edges: TopologyEdge[]; version: number }>;

/** 路径查询缓存 60 秒：同步每 5 秒对全部期望消息分类一次 */
const PATH_CACHE_MS = 60_000;

/** 依赖路径的查询：读取上游根因 hops 跳以内的子图，在子图上找路径；结果缓存 60 秒 */
export function topologyPaths(read: SubgraphReader, hops: number, now: () => number = Date.now): TopologyPathLookup {
  const cache = new Map<string, { at: number; v: string[] | null }>();
  return async (clusterId, from, to) => {
    if (hops <= 0) {
      return null;
    }
    const k = `${clusterId}|${from}|${to}`;
    const t = now();
    const hit = cache.get(k);
    if (hit && t - hit.at < PATH_CACHE_MS) {
      return hit.v;
    }
    const sub = await read(clusterId, [to], new Date(t), hops);
    const v = dependencyPath(new TopologyGraph(sub.nodes, sub.edges, sub.version), from, to, hops);
    cache.set(k, { at: t, v });
    return v;
  };
}

/** 组件类型是否声明为集群外部（领域包 ComponentType.external） */
export type ExternalTypeLookup = (clusterId: string, key: string) => Promise<boolean>;

/**
 * 组件类型的查询：拓扑节点上匹配出的类型；节点不在拓扑里（provider、model 这类只来自告警的实体）时按 kind 与名字
 * 匹配领域包的组件类型。没有任何 external 类型时不查
 */
export function externalTypeLookup(
  types: () => readonly ComponentType[],
  componentType: (clusterId: string, key: string) => Promise<string | null>,
): ExternalTypeLookup {
  return async (clusterId, key) => {
    const all = types();
    if (!all.some((t) => t.external === true)) {
      return false;
    }
    let id = await componentType(clusterId, key);
    if (!id) {
      const k = parseStoredKey(key);
      id = matchTypeByName(k.kind, k.namespace, k.name, all)?.id ?? null;
    }
    return id !== null && all.some((t) => t.id === id && t.external === true);
  };
}

export interface Classification {
  /** 根因是外部上游 */
  external: boolean;
  /** 与这个上游事件相关的业务影响信号及依据；外部上游的事件有这些信号时即时推送 */
  impact: ImpactSignal[];
}

/** 标签条件：每个键都有，且取值在列出的值中；条件为空时不命中 */
export function matchesLabels(
  labels: Readonly<Record<string, string | undefined>>,
  m: Readonly<Record<string, readonly string[]>>,
): boolean {
  const keys = Object.keys(m);
  return (
    keys.length > 0 &&
    keys.every((k) => {
      const v = labels[k];
      return v !== undefined && (m[k] ?? []).includes(v);
    })
  );
}

/**
 * 分类用到的报告输入：ComposeInput 的子集。重建评测按每次运行的研判结论构造（ADR 0175），研判只需要状态与结论选中的根因
 */
export interface ClassifyInput {
  incident: Incident;
  alerts: Alert[];
  /** 还没有阶段 A 报告的事件（ADR 0173）为 null */
  stageA: Pick<StageAReport, 'cards'> | null;
  language: 'zh' | 'en';
  research: { state: string; output: { conclusion: { root_component: string | null } } | null } | null;
}

/** 事件的根因：完成的研判给出的根因，否则为发现根因 */
export function rootOf(i: ClassifyInput): string | null {
  const out = i.research?.state === 'completed' ? i.research.output : null;
  return out?.conclusion.root_component ?? i.incident.root.component;
}

const title = (t: LocalizedText, lang: 'zh' | 'en'): string =>
  (lang === 'zh' ? (t['zh-CN'] ?? t.en) : (t.en ?? t['zh-CN'])) ?? '';

const impactCard = (c: EvidenceResult): boolean => c.impact === true && c.verdict === 'abnormal';

const impactText = (c: EvidenceResult, lang: 'zh' | 'en'): string =>
  `${title(c.title, lang)}${c.value ? ` ${c.value}` : ''}`;

/** 满足业务告警条件的一条告警（某个集群）：告警名、组件与开始、结束时间 */
export interface ImpactAlert {
  cluster_id: string;
  alertname: string;
  component: string | null;
  starts_at: string;
  ends_at: string | null;
}

/**
 * 业务影响告警（ADR 0166）的来源，按开始时间排序：给出时间段时为 [from, to) 内触发过的，否则为当前触发中的。
 * server 读状态库（pgImpactAlerts），重建评测读重建包（ADR 0175）
 */
export type ImpactAlertSource = (
  clusterIds: readonly string[],
  matchers: readonly AlertMatcher[],
  from?: Date,
  to?: Date,
) => Promise<ImpactAlert[]>;

/** 状态库中的业务影响告警（server.alert_state） */
export function pgImpactAlerts(pool: pg.Pool): ImpactAlertSource {
  return async (clusterIds, matchers, from, to) => {
    // 状态库先按每项 labels 的键预先筛选（满足任一项的键集合），取值与排除在这里判断
    const keys = JSON.stringify(matcherKeys(matchers));
    const hasKeys = `EXISTS (SELECT 1 FROM jsonb_array_elements($2::jsonb) k WHERE labels ?& ARRAY(SELECT jsonb_array_elements_text(k)))`;
    const r = await pool.query<{
      cluster_id: string;
      alertname: string;
      labels: Record<string, string>;
      component: string | null;
      starts_at: Date;
      ends_at: Date | null;
    }>(
      from && to
        ? `SELECT cluster_id, alertname, labels, component, starts_at, ends_at FROM server.alert_state
            WHERE cluster_id = ANY($1::text[]) AND ${hasKeys} AND starts_at < $4
              AND (ends_at IS NULL OR ends_at >= $3) ORDER BY starts_at, alert_id`
        : `SELECT cluster_id, alertname, labels, component, starts_at, ends_at FROM server.alert_state
            WHERE cluster_id = ANY($1::text[]) AND ${hasKeys} AND status = 'firing' ORDER BY starts_at, alert_id`,
      from && to ? [clusterIds, keys, from, to] : [clusterIds, keys],
    );
    return r.rows
      .filter((x) => isBusinessImpact(x.labels, matchers))
      .map((a) => ({
        cluster_id: a.cluster_id,
        alertname: a.alertname,
        component: a.component,
        starts_at: a.starts_at.toISOString(),
        ends_at: a.ends_at ? a.ends_at.toISOString() : null,
      }));
  };
}

/** 类型查询缓存 60 秒：同步每 5 秒对全部期望消息分类一次 */
const TYPE_CACHE_MS = 60_000;

export class ExternalRoots {
  private readonly cache = new Map<string, { at: number; v: boolean }>();

  constructor(
    private readonly alerts: ImpactAlertSource,
    readonly s: ExternalRootSettings,
    private readonly externalType: ExternalTypeLookup,
    private readonly paths: TopologyPathLookup,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 一个信号与上游事件是否相关（ADR 0150）：信号在上游事件开始后 withinMs 之内开始（开始早于上游事件的不算），
   * 或信号的组件沿依赖边到达上游根因。都不成立时为 null
   */
  private async relevance(
    upstream: ClassifyInput,
    subject: 'alert' | 'incident',
    startsAt: string,
    component: string | null,
  ): Promise<ImpactBasis | null> {
    const from = Date.parse(upstream.incident.first_firing_at);
    const t = Date.parse(startsAt);
    if (t >= from && t - from <= this.s.impact.withinMs) {
      return { kind: 'window', subject, upstream_at: upstream.incident.first_firing_at, starts_at: startsAt };
    }
    const root = rootOf(upstream);
    if (root && component) {
      const path = await this.paths(upstream.incident.cluster_id, component, root);
      if (path) {
        return { kind: 'topology', path };
      }
    }
    return null;
  }

  /** 与上游事件相关的业务告警：每个告警名一项，取最早开始的相关告警的依据 */
  private async relevantAlerts(
    upstream: ClassifyInput,
    alerts: readonly ImpactAlert[],
  ): Promise<Array<{ alert: ImpactAlert; basis: ImpactBasis }>> {
    const out = new Map<string, { alert: ImpactAlert; basis: ImpactBasis }>();
    for (const a of alerts) {
      if (a.cluster_id !== upstream.incident.cluster_id || out.has(a.alertname)) {
        continue;
      }
      const basis = await this.relevance(upstream, 'alert', a.starts_at, a.component);
      if (basis) {
        out.set(a.alertname, { alert: a, basis });
      }
    }
    return [...out.values()];
  }

  private async typeIsExternal(clusterId: string, key: string): Promise<boolean> {
    const k = `${clusterId}|${key}`;
    const hit = this.cache.get(k);
    const now = this.now();
    if (hit && now - hit.at < TYPE_CACHE_MS) {
      return hit.v;
    }
    const v = await this.externalType(clusterId, key);
    this.cache.set(k, { at: now, v });
    return v;
  }

  /** 根因是不是外部上游 */
  async isExternal(i: ClassifyInput): Promise<boolean> {
    const root = rootOf(i);
    if (root && (this.s.components.includes(root) || (await this.typeIsExternal(i.incident.cluster_id, root)))) {
      return true;
    }
    const active = i.incident.members.filter((m) => m.left_version === null).map((m) => m.alert_id);
    const alerts = i.alerts.filter((a) => active.includes(a.alert_id));
    return (
      Object.keys(this.s.alertLabels).length > 0 &&
      alerts.length > 0 &&
      alerts.every((a) => matchesLabels(a.labels, this.s.alertLabels))
    );
  }

  /** 业务影响告警（ADR 0166），按开始时间排序（[from, to) 内触发过；不给时间段时为当前触发中的） */
  async impactAlerts(clusterIds: readonly string[], from?: Date, to?: Date): Promise<ImpactAlert[]> {
    const matchers = this.s.impact.alerts;
    if (!matchers.length || !clusterIds.length) {
      return [];
    }
    return this.alerts(clusterIds, matchers, from, to);
  }

  /**
   * 对一组事件分类（期望消息与 issue 共用）。业务影响取（ADR 0150）：本事件异常的影响卡；同一集群触发中、与本事件相关的
   * 业务告警；同一集群其他触发中、根因不是外部上游、与本事件相关的事件里异常的影响卡。相关的依据见 relevance
   */
  async classify(inputs: readonly ClassifyInput[]): Promise<Map<string, Classification>> {
    const out = new Map<string, Classification>();
    if (!this.s.enabled) {
      return out;
    }
    const external = new Map<string, boolean>();
    for (const i of inputs) {
      external.set(i.incident.incident_id, await this.isExternal(i));
    }
    const ext = inputs.filter((i) => external.get(i.incident.incident_id));
    if (!ext.length) {
      for (const i of inputs) {
        out.set(i.incident.incident_id, { external: false, impact: [] });
      }
      return out;
    }
    const clusters = [...new Set(ext.map((i) => i.incident.cluster_id))];
    const alerts = await this.impactAlerts(clusters);
    // 还没有阶段 A 报告的事件（ADR 0173）没有影响卡
    const cardsOf = (i: ClassifyInput) => (this.s.impact.impactCards ? (i.stageA?.cards ?? []).filter(impactCard) : []);
    for (const i of inputs) {
      const id = i.incident.incident_id;
      if (!external.get(id)) {
        out.set(id, { external: false, impact: [] });
        continue;
      }
      // 业务影响只对仍在触发的事件成立：已经恢复的上游故障不再即时推送
      if (i.incident.state !== 'firing') {
        out.set(id, { external: true, impact: [] });
        continue;
      }
      const cluster = i.incident.cluster_id;
      const others = inputs.filter(
        (o) =>
          o !== i &&
          o.incident.cluster_id === cluster &&
          o.incident.state === 'firing' &&
          !external.get(o.incident.incident_id),
      );
      const text = (c: EvidenceResult) => impactText(c, i.language);
      const impact: ImpactSignal[] = cardsOf(i).map((c) => ({ signal: text(c), basis: { kind: 'own_card' } }));
      for (const { alert, basis } of await this.relevantAlerts(i, alerts)) {
        impact.push({ signal: alert.alertname, basis });
      }
      for (const o of others) {
        const cards = cardsOf(o);
        const basis = cards.length ? await this.relevance(i, 'incident', o.incident.first_firing_at, rootOf(o)) : null;
        if (basis) {
          impact.push(...cards.map((c) => ({ signal: text(c), basis })));
        }
      }
      // 同一信号只列一次，取先出现的依据
      const seen = new Set<string>();
      out.set(id, { external: true, impact: impact.filter((x) => !seen.has(x.signal) && seen.add(x.signal)) });
    }
    return out;
  }

  /** 一个时间段的汇总统计：时间段内触发过的外部上游事件，按根因归组 */
  async window(inputs: readonly ComposeInput[], from: Date, to: Date): Promise<ExternalWindowStats> {
    const cls = await this.classify(inputs);
    const ext = inputs.filter((i) => cls.get(i.incident.incident_id)?.external);
    const roots = new Map<string, ExternalRootStat>();
    const inWindow = (at: string) => Date.parse(at) >= from.getTime() && Date.parse(at) < to.getTime();
    // 新的事件在前：同一根因的数值取最新的事件
    const byNewest = [...ext].sort(
      (a, b) => Date.parse(b.incident.first_firing_at) - Date.parse(a.incident.first_firing_at),
    );
    for (const i of byNewest) {
      const inc = i.incident;
      const root = rootOf(i) ?? `incident:${inc.incident_id}`;
      const st: ExternalRootStat = roots.get(root) ?? {
        root,
        name: inc.component_names?.[root] ?? null,
        incidents: 0,
        triggers: 0,
        alertnames: [],
        severity: 'info',
        firing: false,
        ended_at: null,
        first_at: inc.first_firing_at,
        immediate: false,
        values: valuesOf(i, root),
      };
      st.incidents++;
      st.triggers += inc.members.filter((m) => inWindow(m.starts_at)).length;
      st.alertnames = [...new Set([...st.alertnames, ...inc.members.map((m) => m.alertname)])].slice(0, 3);
      st.severity = rank(inc.severity) > rank(st.severity) ? inc.severity : st.severity;
      const firing = inc.state === 'firing' && (!inc.ended_at || Date.parse(inc.ended_at) >= to.getTime());
      st.firing = st.firing || firing;
      if (!firing && inc.ended_at && (!st.ended_at || inc.ended_at > st.ended_at)) {
        st.ended_at = inc.ended_at;
      }
      if (inc.first_firing_at < st.first_at) {
        st.first_at = inc.first_firing_at;
      }
      st.immediate = st.immediate || (cls.get(inc.incident_id)?.impact.length ?? 0) > 0;
      roots.set(root, st);
    }
    for (const st of roots.values()) {
      if (st.firing) {
        st.ended_at = null;
      }
    }
    // 业务影响：时间段内触发过、与其中某个外部上游事件相关的业务告警与其他事件的影响卡（ADR 0150）。
    // 同一集群的同名告警合成一项：最早的相关开始；有一次仍在触发时没有结束时间，否则取最晚的结束
    const clusters = [...new Set(ext.map((i) => i.incident.cluster_id))];
    const rows = ext.length ? await this.impactAlerts(clusters, from, to) : [];
    const alerts = new Map<string, ExternalWindowStats['impact']['alerts'][number]>();
    for (const a of rows) {
      const k = `${a.cluster_id}|${a.alertname}`;
      const prev = alerts.get(k);
      if (prev) {
        prev.ends_at =
          prev.ends_at === null || a.ends_at === null ? null : a.ends_at > prev.ends_at ? a.ends_at : prev.ends_at;
        continue;
      }
      const hit = await this.firstRelevant(ext, (u) =>
        u.incident.cluster_id === a.cluster_id ? this.relevance(u, 'alert', a.starts_at, a.component) : null,
      );
      if (hit) {
        alerts.set(k, { alertname: a.alertname, starts_at: a.starts_at, ends_at: a.ends_at, ...hit });
      }
    }
    const cards: ExternalWindowStats['impact']['cards'] = [];
    if (this.s.impact.impactCards) {
      for (const o of inputs.filter((x) => !cls.get(x.incident.incident_id)?.external)) {
        const list = (o.stageA?.cards ?? []).filter(impactCard);
        const hit = list.length
          ? await this.firstRelevant(ext, (u) =>
              u.incident.cluster_id === o.incident.cluster_id
                ? this.relevance(u, 'incident', o.incident.first_firing_at, rootOf(o))
                : null,
            )
          : null;
        if (hit) {
          cards.push(...list.map((c) => ({ title: c.title, value: c.value, ...hit })));
        }
      }
    }
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      roots: [...roots.values()].sort(
        (a, b) =>
          Number(b.firing) - Number(a.firing) ||
          rank(b.severity) - rank(a.severity) ||
          b.triggers - a.triggers ||
          a.root.localeCompare(b.root),
      ),
      impact: { condition: matchersText(this.s.impact.alerts), alerts: [...alerts.values()], cards },
    };
  }

  /** 按事件的先后找第一个与信号相关的外部上游事件：它的根因与依据 */
  private async firstRelevant(
    ext: readonly ComposeInput[],
    judge: (u: ComposeInput) => Promise<ImpactBasis | null> | null,
  ): Promise<{ upstream: string; basis: ImpactBasis } | null> {
    const ordered = [...ext].sort(
      (a, b) => Date.parse(a.incident.first_firing_at) - Date.parse(b.incident.first_firing_at),
    );
    for (const u of ordered) {
      const basis = await judge(u);
      if (basis) {
        return { upstream: rootOf(u) ?? `incident:${u.incident.incident_id}`, basis };
      }
    }
    return null;
  }
}

const rank = (s: string): number => ({ critical: 3, warning: 2, info: 1 })[s] ?? 0;

/** 根因上的关键数值：根因自己的卡，异常的在前，最多 2 张有主值的；根因上没有时取任意对象上异常的卡 */
function valuesOf(i: ComposeInput, root: string): ExternalRootStat['values'] {
  const withValue = (i.stageA?.cards ?? []).filter((c) => c.value !== null && c.verdict !== 'undeterminable');
  const on = withValue.filter(
    (c) => (c.entity ? tryNodeKey(c.entity.kind, c.entity.namespace, c.entity.name) : null) === root,
  );
  const pool = on.length ? on : withValue.filter((c) => c.verdict === 'abnormal');
  return [...pool]
    .sort((a, b) => Number(b.verdict === 'abnormal') - Number(a.verdict === 'abnormal'))
    .slice(0, 2)
    .map((c) => ({ card_id: c.card_id, title: c.title, value: c.value as string, abnormal: c.verdict === 'abnormal' }));
}

export interface ExternalRootStat {
  root: string;
  name: string | null;
  incidents: number;
  /** 时间段内开始的成员告警数 */
  triggers: number;
  alertnames: string[];
  severity: string;
  /** 时间段结束时仍未恢复 */
  firing: boolean;
  /** 全部恢复时最后一个事件的恢复时间 */
  ended_at: string | null;
  first_at: string;
  /** 伴随业务影响，已即时推送 */
  immediate: boolean;
  values: Array<{ card_id: string; title: LocalizedText; value: string; abnormal: boolean }>;
}

/** 一个时间段的统计（server.notify_external_windows.stats，与语言无关） */
export interface ExternalWindowStats {
  from: string;
  to: string;
  roots: ExternalRootStat[];
  impact: {
    /** 业务影响告警的条件（matchersText）；没有匹配器时为空字符串 */
    condition: string;
    /** upstream 与 basis：信号相关的外部上游根因与依据（ADR 0150） */
    alerts: Array<{
      alertname: string;
      starts_at: string;
      ends_at: string | null;
      upstream: string;
      basis: ImpactBasis;
    }>;
    cards: Array<{ title: LocalizedText; value: string | null; upstream: string; basis: ImpactBasis }>;
  };
}

const minutesBetween = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / 60_000);

/** 事件横幅里一条业务影响信号：信号与括号中的依据（ADR 0150）。names 是组件的可读名称 */
export function impactLine(
  x: ImpactSignal,
  lang: 'zh' | 'en',
  names: Readonly<Record<string, string | undefined>> | null | undefined,
): string {
  const d = D[lang];
  return `${x.signal}${d.paren(basisText(x.basis, lang, (k) => names?.[k] ?? displayKey(k), null))}`;
}

/** 依据的说明；upstream 是上游的显示名（汇总里写明是哪个上游，事件横幅里为 null） */
function basisText(b: ImpactBasis, lang: 'zh' | 'en', name: (k: string) => string, upstream: string | null): string {
  const d = D[lang];
  switch (b.kind) {
    case 'own_card':
      return d.basisOwn;
    case 'window':
      return d.basisWindow(b.subject, minutesBetween(b.upstream_at, b.starts_at), upstream);
    case 'topology':
      return b.path.length === 1 ? d.basisSame(name(b.path[0]!)) : d.basisPath(b.path.map(name).join(' → '));
  }
}

/** 渠道无关的汇总消息：标题与若干块，渠道各自渲染 */
export interface ExternalDigestView {
  title: string;
  blocks: NotifyBlock[];
  consoleUrl: string | null;
}

const P = (text: string): NotifyRun => ({ text, style: 'plain', href: null });
const B = (text: string): NotifyRun => ({ text, style: 'bold', href: null });
const C = (text: string): NotifyRun => ({ text, style: 'code', href: null });
const blk = (type: NotifyBlock['type'], runs: NotifyRun[]): NotifyBlock => ({
  type,
  text: runs.map((r) => r.text).join(''),
  source: null,
  model_generated: false,
  runs,
});

/** 汇总消息最多列出的上游数，其余写一行“其余 n 个见控制台” */
export const DIGEST_MAX_ROOTS = 15;

const D = {
  zh: {
    title: (from: string, to: string) => `外部上游汇总 ${from}–${to} UTC`,
    summary: (n: number, prev: number, fresh: number, cont: number, firing: number, recovered: number) =>
      `本时段 ${n} 个上游有问题（上一时段 ${prev} 个）：新增 ${fresh}、持续 ${cont}；未恢复 ${firing}、已恢复 ${recovered}。`,
    impactNone: (labels: string) =>
      `业务影响：无${labels ? `（与上游事件相关的业务告警 ${labels} 0 条，相关的影响卡无异常）` : '（相关的影响卡无异常）'}`,
    impact: '业务影响：',
    basisOwn: '本事件的影响卡',
    basisWindow: (subject: 'alert' | 'incident', m: number, upstream: string | null) =>
      `${subject === 'alert' ? '' : '所在事件'}在${upstream ? `上游 ${upstream} 的事件` : '上游事件'}开始后 ${m < 1 ? '1 分钟内' : `${m} 分钟`}开始`,
    basisSame: (name: string) => `落在上游组件 ${name} 上`,
    basisPath: (path: string) => `拓扑路径 ${path}`,
    semi: '；',
    impactImmediate: '，相关事件已即时推送',
    since: (at: string, ended: string | null) => (ended ? `${at}–${ended}` : `${at} 起，未恢复`),
    triggers: (n: number) => `触发 ${n} 次`,
    prev: (n: number) => `（上一时段 ${n} 次）`,
    fresh: '新增',
    firing: '未恢复',
    recovered: (at: string) => `${at} 恢复`,
    immediate: '波及业务，已即时推送',
    critical: '[严重] ',
    alerts: (names: string) => `告警 ${names}`,
    cleared: (names: string) => `上一时段有问题、本时段没有告警：${names}`,
    more: (n: number) => `其余 ${n} 个上游见控制台`,
    list: '、',
    sep: ' · ',
    paren: (s: string) => `（${s}）`,
  },
  en: {
    title: (from: string, to: string) => `External upstreams ${from}–${to} UTC`,
    summary: (n: number, prev: number, fresh: number, cont: number, firing: number, recovered: number) =>
      `${n} upstreams had problems (${prev} in the previous period): ${fresh} new, ${cont} continuing; ${firing} firing, ${recovered} recovered.`,
    impactNone: (labels: string) =>
      `Business impact: none${labels ? ` (0 business alerts ${labels} related to the upstream incidents, no related abnormal impact card)` : ' (no related abnormal impact card)'}`,
    impact: 'Business impact: ',
    basisOwn: 'impact card of this incident',
    basisWindow: (subject: 'alert' | 'incident', m: number, upstream: string | null) =>
      `${subject === 'alert' ? 'started' : 'its incident started'} ${m < 1 ? 'within 1 min' : `${m} min`} after ${upstream ? `the incident of upstream ${upstream}` : 'the upstream incident'}`,
    basisSame: (name: string) => `on the upstream component ${name}`,
    basisPath: (path: string) => `topology path ${path}`,
    semi: '; ',
    impactImmediate: '; the incidents were sent immediately',
    since: (at: string, ended: string | null) => (ended ? `${at}–${ended}` : `since ${at}, firing`),
    triggers: (n: number) => `${n} firings`,
    prev: (n: number) => ` (${n} in the previous period)`,
    fresh: 'new',
    firing: 'firing',
    recovered: (at: string) => `recovered ${at}`,
    immediate: 'affects the business, sent immediately',
    critical: '[CRITICAL] ',
    alerts: (names: string) => `alerts ${names}`,
    cleared: (names: string) => `Problems in the previous period, no alerts in this one: ${names}`,
    more: (n: number) => `${n} more upstreams in the console`,
    list: ', ',
    sep: ' · ',
    paren: (s: string) => ` (${s})`,
  },
};

const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16);

/**
 * 汇总消息：一行标题、一行总数与上一时段的对比、一行业务影响，每个上游一行（名称、关键数值、触发次数与上一时段、
 * 恢复情况），最后是上一时段有问题而本时段没有告警的上游
 */
export function composeExternalDigest(
  cur: ExternalWindowStats,
  prev: ExternalWindowStats | null,
  lang: 'zh' | 'en',
  consoleUrl: string | null,
): ExternalDigestView {
  const d = D[lang];
  const prevRoots = new Map((prev?.roots ?? []).map((r) => [r.root, r]));
  const fresh = cur.roots.filter((r) => !prevRoots.has(r.root)).length;
  const firing = cur.roots.filter((r) => r.firing).length;
  const blocks: NotifyBlock[] = [
    blk('text', [
      P(
        d.summary(cur.roots.length, prevRoots.size, fresh, cur.roots.length - fresh, firing, cur.roots.length - firing),
      ),
    ]),
  ];
  // 依据里的组件与上游用汇总中的可读名称，没有时用组件键
  const rootNames = new Map(cur.roots.map((r) => [r.root, r.name ?? displayKey(r.root)]));
  const name = (k: string) => rootNames.get(k) ?? displayKey(k);
  const why = (x: { upstream: string; basis: ImpactBasis }) => basisText(x.basis, lang, name, name(x.upstream));
  const impact: NotifyRun[][] = [
    ...cur.impact.alerts.map((a) => [
      B(a.alertname),
      P(d.paren(`${d.since(hhmm(a.starts_at), a.ends_at ? hhmm(a.ends_at) : null)}${d.semi}${why(a)}`)),
    ]),
    ...cur.impact.cards.map((c) => [
      P(title(c.title, lang)),
      ...(c.value ? [P(' '), C(c.value)] : []),
      P(d.paren(why(c))),
    ]),
  ];
  if (impact.length) {
    const immediate = cur.roots.some((r) => r.immediate);
    blocks.push(
      blk('text', [
        P(d.impact),
        ...impact.slice(0, 4).flatMap((x, k) => (k ? [P(d.list), ...x] : x)),
        ...(immediate ? [P(d.impactImmediate)] : []),
      ]),
    );
  } else {
    blocks.push(blk('text', [P(d.impactNone(cur.impact.condition))]));
  }
  for (const r of cur.roots.slice(0, DIGEST_MAX_ROOTS)) {
    const runs: NotifyRun[] = [];
    if (r.severity === 'critical') {
      runs.push(P(d.critical));
    }
    runs.push(B(r.name ?? displayKey(r.root)));
    if (r.values.length) {
      r.values.forEach((v, k) => runs.push(P(`${k ? d.list : ' '}${title(v.title, lang)} `), C(v.value)));
    } else {
      runs.push(P(` ${d.alerts(r.alertnames.join(d.list))}`));
    }
    const p = prevRoots.get(r.root);
    runs.push(P(`${d.sep}${d.triggers(r.triggers)}${p ? d.prev(p.triggers) : `${d.sep}${d.fresh}`}`));
    runs.push(P(`${d.sep}${r.firing ? d.firing : r.ended_at ? d.recovered(hhmm(r.ended_at)) : d.firing}`));
    if (r.immediate) {
      runs.push(P(`${d.sep}${d.immediate}`));
    }
    blocks.push(blk('list_item', runs));
  }
  if (cur.roots.length > DIGEST_MAX_ROOTS) {
    blocks.push(blk('list_item', [P(d.more(cur.roots.length - DIGEST_MAX_ROOTS))]));
  }
  const cleared = [...prevRoots.values()].filter((r) => !cur.roots.some((x) => x.root === r.root));
  if (cleared.length) {
    blocks.push(
      blk('text', [
        P(
          d.cleared(
            cleared
              .map((r) => r.name ?? displayKey(r.root))
              .slice(0, 10)
              .join(d.list),
          ),
        ),
      ]),
    );
  }
  return { title: d.title(hhmm(cur.from), hhmm(cur.to)), blocks, consoleUrl };
}

/** 汇总窗口：now 所在周期之前的那个完整周期 [from, to) */
export function lastWindow(now: number, periodMs: number): { from: number; to: number } {
  const to = Math.floor(now / periodMs) * periodMs;
  return { from: to - periodMs, to };
}
