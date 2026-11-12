// 证据链（纯函数）：把一次研判的证据卡按它们在论证里的位置分组（支持结论、与结论相反、用于其他假设、没有被引用的
// 异常、平时也成立的异常、无法判定、正常），标出每张卡被哪些假设引用，求出事故的几个关键时刻，并把一张卡的序列按查询
// 归并成图。

import type { EvidenceResult, Hypothesis, Incident, ResearchOutput } from '../contract';
import type { Formatters } from '../i18n';
import { SERIES_SLOTS } from '../theme/tokens';
import { sortEvidence } from './model';

export type EvidenceUnit = NonNullable<EvidenceResult['unit']>;

/** supports、refutes 取自假设的 supporting 与 refuting；checked 是为这个假设做的区分性检查，结果没有被列为支持或推翻。 */
export type RoleKind = 'supports' | 'refutes' | 'checked';

export interface EvidenceRole {
  hypothesis: Hypothesis;
  kind: RoleKind;
  /** 结论采用的假设。 */
  leader: boolean;
}

export type ChainGroupId = 'for' | 'against' | 'others' | 'abnormal' | 'routine' | 'undetermined' | 'normal';

export const CHAIN_GROUPS: readonly ChainGroupId[] = [
  'for',
  'against',
  'others',
  'abnormal',
  'routine',
  'undetermined',
  'normal',
];

export interface ChainGroup {
  id: ChainGroupId;
  cards: EvidenceResult[];
}

export interface EvidenceChain {
  /** 只含非空的组，按 CHAIN_GROUPS 的顺序。 */
  groups: ChainGroup[];
  roles: ReadonlyMap<string, readonly EvidenceRole[]>;
  leader: Hypothesis | null;
}

/** 几个来源的卡按 ref 合并，先出现的保留（研判明细里的卡带序列，排在前面）。 */
export function mergeEvidence(...lists: ReadonlyArray<readonly EvidenceResult[] | null | undefined>): EvidenceResult[] {
  const seen = new Map<string, EvidenceResult>();
  for (const list of lists) {
    for (const r of list ?? []) {
      if (!seen.has(r.ref)) {
        seen.set(r.ref, r);
      }
    }
  }
  return [...seen.values()];
}

function rolesOf(output: ResearchOutput | null): { roles: Map<string, EvidenceRole[]>; leader: Hypothesis | null } {
  const roles = new Map<string, EvidenceRole[]>();
  if (!output) {
    return { roles, leader: null };
  }
  const leader = output.hypotheses.find((h) => h.id === output.conclusion.hypothesis_id) ?? null;
  const add = (ref: string, hypothesis: Hypothesis, kind: RoleKind) => {
    const cur = roles.get(ref) ?? [];
    if (!cur.some((x) => x.hypothesis.id === hypothesis.id)) {
      cur.push({ hypothesis, kind, leader: hypothesis.id === leader?.id });
      roles.set(ref, cur);
    }
  };
  // 结论采用的假设排在每张卡的引用列表最前
  const ordered = leader ? [leader, ...output.hypotheses.filter((h) => h !== leader)] : output.hypotheses;
  for (const h of ordered) {
    h.supporting.forEach((ref) => add(ref, h, 'supports'));
    h.refuting.forEach((ref) => add(ref, h, 'refutes'));
    for (const c of output.next_checks) {
      if (c.hypothesis_id === h.id && c.result_ref) {
        add(c.result_ref, h, 'checked');
      }
    }
  }
  return { roles, leader };
}

function groupOf(r: EvidenceResult, roles: readonly EvidenceRole[] | undefined): ChainGroupId {
  const lead = roles?.find((x) => x.leader);
  if (lead) {
    return lead.kind === 'refutes' ? 'against' : 'for';
  }
  if (roles?.length) {
    return 'others';
  }
  if (r.display_state === 'abnormal') {
    return r.novelty?.status === 'routine' ? 'routine' : 'abnormal';
  }
  return r.display_state === 'normal' ? 'normal' : 'undetermined';
}

/** 没有研判输出（只有阶段 A）时只按判定与是否常态分组。 */
export function buildEvidenceChain(cards: readonly EvidenceResult[], output: ResearchOutput | null): EvidenceChain {
  const { roles, leader } = rolesOf(output);
  const by = new Map<ChainGroupId, EvidenceResult[]>();
  for (const r of sortEvidence(cards)) {
    const id = groupOf(r, roles.get(r.ref));
    by.set(id, [...(by.get(id) ?? []), r]);
  }
  return {
    groups: CHAIN_GROUPS.flatMap((id) => (by.has(id) ? [{ id, cards: by.get(id)! }] : [])),
    roles,
    leader,
  };
}

/** 默认展开的卡：论证用到的异常与未被引用的新异常；正常、常态、无法判定的卡收成一行。 */
export function expandedByDefault(group: ChainGroupId, r: EvidenceResult): boolean {
  if (group === 'for' || group === 'against' || group === 'abnormal') {
    return true;
  }
  return group === 'others' && r.display_state === 'abnormal' && r.novelty?.status !== 'routine';
}

export interface KeyMoment {
  kind: 'onset' | 'firing' | 'concluded' | 'resolved';
  at: number;
  /** onset：最早出现异常的那张卡。 */
  card: EvidenceResult | null;
}

/** 事故的关键时刻，按时间排列：最早的异常起点、告警触发、研判结论、恢复。 */
export function keyMoments(
  cards: readonly EvidenceResult[],
  incident: Pick<Incident, 'first_firing_at' | 'ended_at'>,
  concludedAt: string | null,
): KeyMoment[] {
  const out: KeyMoment[] = [{ kind: 'firing', at: Date.parse(incident.first_firing_at), card: null }];
  let first: EvidenceResult | null = null;
  for (const r of cards) {
    if (r.display_state === 'abnormal' && r.anomaly_started_at) {
      if (!first || Date.parse(r.anomaly_started_at) < Date.parse(first.anomaly_started_at as string)) {
        first = r;
      }
    }
  }
  if (first) {
    out.push({ kind: 'onset', at: Date.parse(first.anomaly_started_at as string), card: first });
  }
  if (concludedAt) {
    out.push({ kind: 'concluded', at: Date.parse(concludedAt), card: null });
  }
  if (incident.ended_at) {
    out.push({ kind: 'resolved', at: Date.parse(incident.ended_at), card: null });
  }
  // 同一时刻异常起点排在告警之前：先有异常，再有告警
  const order = { onset: 0, firing: 1, concluded: 2, resolved: 3 };
  return out.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
}

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

/** 按单位写一个数：percent 的数值是比例（0.9 写成 90%）。 */
export function formatValue(n: number, unit: EvidenceUnit | undefined, fmt: Formatters): string {
  const abs = Math.abs(n);
  switch (unit) {
    case 'percent':
      return fmt.percent(n, abs < 0.1 ? 2 : 1);
    case 'bytes': {
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
      let v = n;
      let i = 0;
      while (Math.abs(v) >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return `${fmt.number(v, Math.abs(v) < 10 ? 2 : 1)} ${units[i]}`;
    }
    case 'seconds':
      return abs < 1 ? `${fmt.number(n * 1000, 0)} ms` : abs < 120 ? `${fmt.number(n, 1)} s` : fmt.duration(n * 1000);
    case 'per_second':
      return `${fmt.number(n, abs < 10 ? 2 : 1)}/s`;
    default:
      // 没有单位的大数（例如按字节算的表达式值）写成紧凑形式，坐标轴上放得下
      if (abs >= 1e5) {
        return COMPACT.format(n);
      }
      return unit === 'count' ? fmt.number(n, Number.isInteger(n) ? 0 : 2) : fmt.number(n, abs < 10 ? 3 : 1);
  }
}

export interface ChartLine {
  label: string;
  t: number[];
  v: Array<number | null>;
}

export interface CardChart {
  /** 卡片里的查询引用名。 */
  ref: string;
  /** 峰值最高的在前，最多 SERIES_SLOTS 条。 */
  lines: ChartLine[];
  /** 超出 SERIES_SLOTS 没有画出的序列数。 */
  folded: number;
  /** 这张图与卡片的主值同一个量纲：阈值线与卡片的单位适用。 */
  scaled: boolean;
}

const peakOf = (v: ReadonlyArray<number | null>) =>
  v.reduce<number>((m, x) => (x === null ? m : Math.max(m, Math.abs(x))), 0);

/**
 * 一张卡的图：同一个查询引用的序列画在一张图里，按取值不同的标签命名。只有一个点的序列（即时查询）不画图，它们的值
 * 在卡片的表格里。
 * 卡片只声明主值的单位与一条阈值，没有声明它们属于哪个查询，所以按量纲推断：单位是 percent、ratio 时只适用于取值
 * 在比例范围内的图，其他单位只适用于与阈值同一数量级的图。
 */
export function cardCharts(r: Pick<EvidenceResult, 'series' | 'unit' | 'threshold' | 'value_number'>): CardChart[] {
  const by = new Map<string, EvidenceResult['series']>();
  for (const s of r.series) {
    if (s.points.length >= 2) {
      by.set(s.ref, [...(by.get(s.ref) ?? []), s]);
    }
  }
  const anchor = r.threshold ?? r.value_number ?? null;
  return [...by.entries()].map(([ref, list]) => {
    const keys = new Set<string>();
    for (const s of list) {
      for (const k of Object.keys(s.labels)) {
        if (list.some((o) => o.labels[k] !== s.labels[k])) {
          keys.add(k);
        }
      }
    }
    const lines = list
      .map((s) => ({
        label: keys.size ? [...keys].map((k) => s.labels[k] ?? '-').join(' · ') : ref,
        t: s.points.map((p) => p[0]),
        v: s.points.map((p) => p[1]),
      }))
      .sort((a, b) => peakOf(b.v) - peakOf(a.v));
    const peak = Math.max(...lines.map((l) => peakOf(l.v)));
    const ratio = r.unit === 'percent' || r.unit === 'ratio';
    const scaled = ratio
      ? peak <= 1.5
      : anchor === null || peak === 0 || (Math.abs(anchor) <= peak * 20 && Math.abs(anchor) >= peak / 20);
    return { ref, lines: lines.slice(0, SERIES_SLOTS), folded: Math.max(0, lines.length - SERIES_SLOTS), scaled };
  });
}

/** 时长写法 "1h"、"24h"、"7d" → 数量与单位；不是这种写法时为 null。 */
export function parseOffset(offset: string): { n: number; unit: 'm' | 'h' | 'd' } | null {
  const m = /^(\d+)(m|h|d)$/.exec(offset);
  return m ? { n: Number(m[1]), unit: m[2] as 'm' | 'h' | 'd' } : null;
}
