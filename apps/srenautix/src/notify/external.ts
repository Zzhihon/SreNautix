import type { ComponentType, EvidenceResult, LocalizedText, NotifyBlock, NotifyRun } from '@srenautix/contract';
import { displayKey, matchTypeByName, tryNodeKey } from '@srenautix/core';
import type pg from 'pg';
import { parseStoredKey } from '../topology/keys.js';
import type { ComposeInput } from './compose.js';

// 外部上游的周期汇总（ADR 0147）：根因是集群之外的上游（领域包声明 external 的组件类型，例如模型服务方 provider 与 model，
// 或配置列出的逻辑组件）的事件不逐条即时推送、不逐条开 issue，每个周期（默认整点、1 小时）发一条汇总。
// 例外：同时有业务影响（配置的业务告警在触发、影响卡异常）时照常即时推送，横幅写“上游故障已影响业务”。

export interface ExternalRootSettings {
  enabled: boolean;
  /** 汇总周期；窗口按 UTC 纪元对齐，1 小时即整点 */
  periodMs: number;
  /** 另外按外部上游处理的根因组件键（例如按主题聚合的逻辑组件 component:provider） */
  components: readonly string[];
  /** 全部成员告警都满足这些标签条件（每个键取值之一）的事件也按外部上游处理；为空时不用 */
  alertLabels: Readonly<Record<string, readonly string[]>>;
  /** 业务影响的判定：触发中的告警满足这些标签条件、或影响卡（impact: true）异常 */
  impact: {
    alertLabels: Readonly<Record<string, readonly string[]>>;
    impactCards: boolean;
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
  /** 业务影响的信号（告警名、影响卡与值）；外部上游的事件有这些信号时即时推送 */
  impact: string[];
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

/** 事件的根因：完成的研判给出的根因，否则为发现根因 */
export function rootOf(i: ComposeInput): string | null {
  const out = i.research?.state === 'completed' ? i.research.output : null;
  return out?.conclusion.root_component ?? i.incident.root.component;
}

const title = (t: LocalizedText, lang: 'zh' | 'en'): string =>
  (lang === 'zh' ? (t['zh-CN'] ?? t.en) : (t.en ?? t['zh-CN'])) ?? '';

const impactCard = (c: EvidenceResult): boolean => c.impact === true && c.verdict === 'abnormal';

const impactText = (c: EvidenceResult, lang: 'zh' | 'en'): string =>
  `${title(c.title, lang)}${c.value ? ` ${c.value}` : ''}`;

/** 触发中的业务告警（某个集群）：告警名与开始时间 */
interface ImpactAlert {
  cluster_id: string;
  alertname: string;
  starts_at: string;
  ends_at: string | null;
}

/** 类型查询缓存 60 秒：同步每 5 秒对全部期望消息分类一次 */
const TYPE_CACHE_MS = 60_000;

export class ExternalRoots {
  private readonly cache = new Map<string, { at: number; v: boolean }>();

  constructor(
    private readonly pool: pg.Pool,
    readonly s: ExternalRootSettings,
    private readonly externalType: ExternalTypeLookup,
    private readonly now: () => number = Date.now,
  ) {}

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
  async isExternal(i: ComposeInput): Promise<boolean> {
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

  /** 时间段内满足业务告警条件的告警（[from, to) 内触发过；不给时间段时为当前触发中的） */
  async impactAlerts(clusterIds: readonly string[], from?: Date, to?: Date): Promise<ImpactAlert[]> {
    const keys = Object.keys(this.s.impact.alertLabels);
    if (!keys.length || !clusterIds.length) {
      return [];
    }
    const r = await this.pool.query<{
      cluster_id: string;
      alertname: string;
      labels: Record<string, string>;
      starts_at: Date;
      ends_at: Date | null;
    }>(
      from && to
        ? `SELECT cluster_id, alertname, labels, starts_at, ends_at FROM server.alert_state
            WHERE cluster_id = ANY($1::text[]) AND labels ?& $2::text[] AND starts_at < $4
              AND (ends_at IS NULL OR ends_at >= $3) ORDER BY starts_at, alert_id`
        : `SELECT cluster_id, alertname, labels, starts_at, ends_at FROM server.alert_state
            WHERE cluster_id = ANY($1::text[]) AND labels ?& $2::text[] AND status = 'firing' ORDER BY starts_at, alert_id`,
      from && to ? [clusterIds, keys, from, to] : [clusterIds, keys],
    );
    // 同一集群的同名告警合成一项：最早的开始；有一次仍在触发时没有结束时间，否则取最晚的结束
    const merged = new Map<string, ImpactAlert>();
    for (const a of r.rows.filter((x) => matchesLabels(x.labels, this.s.impact.alertLabels))) {
      const k = `${a.cluster_id}|${a.alertname}`;
      const ends = a.ends_at ? a.ends_at.toISOString() : null;
      const prev = merged.get(k);
      if (!prev) {
        merged.set(k, {
          cluster_id: a.cluster_id,
          alertname: a.alertname,
          starts_at: a.starts_at.toISOString(),
          ends_at: ends,
        });
      } else {
        prev.ends_at = prev.ends_at === null || ends === null ? null : ends > prev.ends_at ? ends : prev.ends_at;
      }
    }
    return [...merged.values()];
  }

  /**
   * 对一组事件分类（期望消息与 issue 共用）。业务影响取：本事件异常的影响卡、同一集群触发中的业务告警、
   * 同一集群其他触发中且根因不是外部上游的事件里异常的影响卡
   */
  async classify(inputs: readonly ComposeInput[]): Promise<Map<string, Classification>> {
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
    const cardsOf = (i: ComposeInput) => (this.s.impact.impactCards ? i.stageA.cards.filter(impactCard) : []);
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
      const impact = [
        ...new Set([
          ...cardsOf(i).map(text),
          ...alerts.filter((a) => a.cluster_id === cluster).map((a) => a.alertname),
          ...others.flatMap(cardsOf).map(text),
        ]),
      ];
      out.set(id, { external: true, impact });
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
    const clusters = [...new Set(ext.map((i) => i.incident.cluster_id))];
    const alerts = ext.length ? await this.impactAlerts(clusters, from, to) : [];
    const cards = this.s.impact.impactCards
      ? inputs
          .filter((i) => !cls.get(i.incident.incident_id)?.external)
          .flatMap((i) => i.stageA.cards.filter(impactCard))
          .map((c) => ({ title: c.title, value: c.value }))
      : [];
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
      impact: {
        labels: this.s.impact.alertLabels,
        alerts: alerts.map((a) => ({ alertname: a.alertname, starts_at: a.starts_at, ends_at: a.ends_at })),
        cards,
      },
    };
  }
}

const rank = (s: string): number => ({ critical: 3, warning: 2, info: 1 })[s] ?? 0;

/** 根因上的关键数值：根因自己的卡，异常的在前，最多 2 张有主值的；根因上没有时取任意对象上异常的卡 */
function valuesOf(i: ComposeInput, root: string): ExternalRootStat['values'] {
  const withValue = i.stageA.cards.filter((c) => c.value !== null && c.verdict !== 'undeterminable');
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
    labels: Readonly<Record<string, readonly string[]>>;
    alerts: Array<{ alertname: string; starts_at: string; ends_at: string | null }>;
    cards: Array<{ title: LocalizedText; value: string | null }>;
  };
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
      `业务影响：无${labels ? `（业务告警 ${labels} 0 条，影响卡无异常）` : '（影响卡无异常）'}`,
    impact: '业务影响：',
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
      `Business impact: none${labels ? ` (0 business alerts ${labels}, no abnormal impact card)` : ' (no abnormal impact card)'}`,
    impact: 'Business impact: ',
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
const labelsText = (m: Readonly<Record<string, readonly string[]>>) =>
  Object.entries(m)
    .map(([k, v]) => `${k}=${v.join('|')}`)
    .join(',');

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
  const impact: NotifyRun[][] = [
    ...cur.impact.alerts.map((a) => [
      B(a.alertname),
      P(d.paren(d.since(hhmm(a.starts_at), a.ends_at ? hhmm(a.ends_at) : null))),
    ]),
    ...cur.impact.cards.map((c) => [P(title(c.title, lang)), ...(c.value ? [P(' '), C(c.value)] : [])]),
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
    blocks.push(blk('text', [P(d.impactNone(labelsText(cur.impact.labels)))]));
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
