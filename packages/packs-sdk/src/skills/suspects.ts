// analyze.suspects@v1（docs/skills/oom-rootcause.zh-CN.md §4.3）：嫌疑项的检验、分组、置信度与证据表。
// 每个嫌疑项的检验序列（role: indicator）在三处检验：
// 1. 发生之前的窗口：任何一条检验序列上涨并与内存序列相关（Pearson ≥ rise_corr）；声明了 logs_required 时窗口内还要有其中的日志事件；
// 2. 48 小时：X 处于高位的样本中内存也高的比例（support）、相对内存高的基础比例的提升（lift）、X 高而内存不高的反例比例（counter）；
//    内存高的时段本来就少，反例比例总是接近 1，排除看的是提升：X 高位时内存高的可能并不比平时大，X 就解释不了内存高；
// 3. 先后：X 领先内存的错位相关（lead）与落后内存的错位相关（lag），lag 明显更高时记为反向（reverse）。
// 提升低于 rule_out_lift 或反向的嫌疑项被排除；每次发生归到支持它的、分数最高的嫌疑项，发生最多的一组给出主因。

import type { AroundWindow, EvidenceRow, HistoryWindow, Lang, LogRecord, LogsOutput, Point } from './data.js';
import type { ClassifiedOccurrence, MemoryKindOutput } from './memory-kind.js';
import {
  aligned,
  fmtRatio,
  fmtSpan,
  fmtTime,
  fmtValue,
  laggedCorr,
  localized,
  maxOf,
  pearson,
  pick,
  quantile,
  sumSeries,
  valueAt,
  within,
  type ValueUnit,
} from './stats.js';

export interface SuspectSeries {
  signal: string;
  role: 'indicator' | 'context';
  unit: ValueUnit;
  high?: number;
  title?: unknown;
}

export interface SuspectDecl {
  id: string;
  title: unknown;
  mechanism: unknown;
  series: SuspectSeries[];
  logs?: string[];
  /** 一次发生之前的窗口内必须出现其中至少一个日志事件，这次发生才支持该嫌疑项 */
  logs_required?: string[];
  code?: Array<{ path: string; pattern: string; before?: number; after?: number; note?: unknown }>;
  fixes?: unknown[];
  options?: Array<{ title: unknown; domain: unknown; impact: unknown; benefit: unknown; risk: unknown }>;
  references?: number[];
}

export interface SuspectThresholds {
  rise_corr: number;
  lift_min: number;
  rule_out_lift: number;
  reverse_margin: number;
  min_history_samples: number;
  memory_high_ratio: number;
}

export type Verdict = 'main' | 'other' | 'secondary' | 'ruled_out' | 'no_data' | 'unsupported';
export type Confidence = 'high' | 'medium_high' | 'medium' | 'low';

export interface HistoryStats {
  samples: number;
  x_high: number;
  support: number | null;
  lift: number | null;
  counter: number | null;
  lead: number | null;
  lag: number | null;
  reverse: boolean;
  insufficient: boolean;
  corr: number | null;
}

export interface RankedSuspect {
  id: string;
  title: string;
  mechanism: string;
  verdict: Verdict;
  verdict_text: string;
  confidence: Confidence | null;
  confidence_text: string;
  /** 支持它的发生（Pod 与时刻） */
  supported: Array<{ pod: string; at: number; at_text: string }>;
  /** 归到它这一组的发生 */
  group: Array<{ pod: string; at: number; at_text: string }>;
  pods_and_times: string;
  /** 排除为主因时，主因分组的发生之前最后 2 分钟仍在上升（次要加重因素） */
  aggravating: boolean;
  history: HistoryStats | null;
  log_hits: number;
  reason_text: string;
  code: NonNullable<SuspectDecl['code']>;
  fixes: string[];
  options: Array<{ title: string; domain: string; impact: string; benefit: string; risk: string }>;
  references: number[];
}

export interface SuspectsOutput {
  headline: string;
  main: RankedSuspect | null;
  /** 主因的 id 与第一个代码路径（进入指纹）；没有主因时都为 unexplained */
  main_id: string;
  main_code_path: string;
  main_group: { pods: string[]; occurrences: Array<{ pod: string; at: number }> };
  others: RankedSuspect[];
  ruled_out: RankedSuspect[];
  ranked: RankedSuspect[];
  unexplained: Array<{ pod: string; at_text: string }>;
  evidence: EvidenceRow[];
  fixes: Array<{ text: string }>;
  options: RankedSuspect['options'];
  inferred: Array<{ text: string }>;
  references: number[];
}

const TWO_MIN = 2 * 60_000;

function podPoints(w: AroundWindow, key: string): Point[] {
  const d = w.signals[key];
  return d ? sumSeries(d.series.filter((s) => !s.labels.pod || s.labels.pod === w.pod)) : [];
}

function historyByPod(h: HistoryWindow, key: string): Map<string, Point[]> {
  const d = h.signals[key];
  const out = new Map<string, Point[]>();
  if (!d) {
    return out;
  }
  const by = new Map<string, typeof d.series>();
  for (const s of d.series) {
    const p = s.labels.pod ?? '';
    by.set(p, [...(by.get(p) ?? []), s]);
  }
  for (const [p, ss] of by) {
    out.set(p, sumSeries(ss));
  }
  return out;
}

/** 48 小时的支持度、提升、反例与先后 */
export function historyStats(
  h: HistoryWindow,
  memoryKey: string,
  limitKey: string,
  s: SuspectSeries,
  t: SuspectThresholds,
): HistoryStats {
  const mem = historyByPod(h, memoryKey);
  const lim = historyByPod(h, limitKey);
  const xs = historyByPod(h, s.signal);
  const samples: Array<{ m: boolean; x: number }> = [];
  const groups: Array<{ a: Point[]; b: Point[] }> = [];
  const groupsRev: Array<{ a: Point[]; b: Point[] }> = [];
  const pairs: Array<[number, number]> = [];
  for (const [pod, x] of xs) {
    const m = mem.get(pod) ?? [];
    const l = lim.get(pod) ?? [];
    const limitOf = (tm: number) => valueAt(l, tm) ?? maxOf(l);
    const ratio = m
      .map((p) => {
        const lv = limitOf(p.t);
        return lv ? { t: p.t, v: p.v / lv } : null;
      })
      .filter((p): p is Point => p !== null);
    const rm = new Map(ratio.map((p) => [p.t, p.v]));
    for (const p of x) {
      const r = rm.get(p.t);
      if (r !== undefined) {
        samples.push({ m: r >= t.memory_high_ratio, x: p.v });
      }
    }
    groups.push({ a: x, b: m });
    groupsRev.push({ a: m, b: x });
    pairs.push(...aligned(x, m));
  }
  const high =
    s.high ??
    quantile(
      samples.map((x) => x.x),
      0.9,
    );
  const xHigh = high === null ? [] : samples.filter((x) => x.x >= high && x.x > 0);
  const base = samples.length ? samples.filter((x) => x.m).length / samples.length : 0;
  const support = xHigh.length ? xHigh.filter((x) => x.m).length / xHigh.length : null;
  const lift = support !== null && base > 0 ? support / base : null;
  const step = h.step_seconds * 1000;
  const lead = laggedCorr(groups, step);
  const lag = laggedCorr(groupsRev, step);
  const reverse = lead !== null && lag !== null && lag - lead >= t.reverse_margin && lag >= 0.5;
  return {
    samples: samples.length,
    x_high: xHigh.length,
    support,
    lift,
    counter: support === null ? null : 1 - support,
    lead,
    lag,
    reverse,
    insufficient: xHigh.length < t.min_history_samples,
    corr: pearson(pairs),
  };
}

interface Check {
  supported: boolean;
  lastMinute: boolean;
  logHits: number;
  hasData: boolean;
  /** 通过检验的序列中与内存最相关的一条的相关系数 */
  corr: number;
}

function checkOccurrence(
  o: ClassifiedOccurrence,
  w: AroundWindow | undefined,
  memoryKey: string,
  sus: SuspectDecl,
  records: readonly LogRecord[],
  t: SuspectThresholds,
): Check {
  const from = w ? w.from : o.at;
  const logHits = records.filter(
    (r) => r.pod === o.pod && r.time >= from && r.time <= o.at && (sus.logs ?? []).includes(r.event),
  ).length;
  if (!w) {
    return { supported: false, lastMinute: false, logHits, hasData: false, corr: 0 };
  }
  const m = within(podPoints(w, memoryKey), w.from, o.at);
  let hasData = false;
  let any = false;
  let best = 0;
  let lastMinute = false;
  for (const s of sus.series.filter((x) => x.role === 'indicator')) {
    const x = within(podPoints(w, s.signal), w.from, o.at);
    if (x.length < 2) {
      continue;
    }
    hasData = true;
    const start = x[0]!.v;
    const end = valueAt(x, o.at) ?? x[x.length - 1]!.v;
    const peak = Math.max(...x.map((p) => p.v));
    const rise = end - start > 0.1 * Math.max(Math.abs(peak), 1e-9);
    const corr = pearson(aligned(x, m));
    // 任何一条检验序列上涨并与内存同步，这次发生就有指标上的支持（速率类序列常在请求开始时冲高，不一定与内存同步）
    if (rise && corr !== null && corr >= t.rise_corr) {
      any = true;
      best = Math.max(best, corr);
    }
    const before = valueAt(x, o.at - TWO_MIN);
    if (before !== null && end > before) {
      lastMinute = true;
    }
  }
  // logs_required 列出的事件至少出现一个：只靠指标分不开的机制（例如流量很低时的重试与大请求在途）由日志区分
  const required = sus.logs_required ?? [];
  const logsOk =
    !required.length ||
    records.some((r) => r.pod === o.pod && r.time >= from && r.time <= o.at && required.includes(r.event));
  return { supported: hasData && any && logsOk, lastMinute, logHits, hasData, corr: best };
}

const VERDICT: Record<Verdict, [string, string]> = {
  main: ['主因', 'main cause'],
  other: ['另一种触发', 'another trigger'],
  secondary: ['次要因素', 'secondary factor'],
  ruled_out: ['排除为主因', 'ruled out as the main cause'],
  no_data: ['没有数据', 'no data'],
  unsupported: ['没有得到支持', 'not supported'],
};
const CONF: Record<Confidence, [string, string]> = {
  high: ['高', 'high'],
  medium_high: ['中高', 'medium-high'],
  medium: ['中', 'medium'],
  low: ['低', 'low'],
};

export function rankSuspects(i: {
  suspects: readonly SuspectDecl[];
  /** 只进入证据表的序列 */
  context: readonly SuspectSeries[];
  classified: MemoryKindOutput;
  around: readonly AroundWindow[];
  history: HistoryWindow | null;
  /** logs.events 与 logs.extract 的输出 */
  logs: readonly LogsOutput[];
  thresholds: SuspectThresholds;
  lang: Lang;
}): SuspectsOutput {
  const L = i.lang;
  const t = i.thresholds;
  const memKey = i.classified.memory_signal;
  const limKey = i.classified.limit_signal;
  const occs = i.classified.occurrences;
  const win = (o: ClassifiedOccurrence) => i.around.find((w) => w.pod === o.pod && w.at === o.at);
  const records = i.logs.flatMap((x) => x.records);
  const queries = new Map<string, string[]>();
  for (const x of i.logs) {
    for (const [ev, qs] of Object.entries(x.queries)) {
      queries.set(ev, [...new Set([...(queries.get(ev) ?? []), ...qs])]);
    }
  }

  const stats = i.suspects.map((s) => {
    const primary = s.series.find((x) => x.role === 'indicator');
    const hist = primary && i.history ? historyStats(i.history, memKey, limKey, primary, t) : null;
    const checks = occs.map((o) => checkOccurrence(o, win(o), memKey, s, records, t));
    const ruledOut = !!hist && !hist.insufficient && ((hist.lift ?? 0) < t.rule_out_lift || hist.reverse);
    // 一次发生上的分数：48 小时的提升 × 这次发生之前与内存的相关系数
    const score = (k: number) => (hist && !hist.insufficient ? (hist.lift ?? 1) : 1) * checks[k]!.corr;
    return { s, hist, checks, ruledOut, score };
  });

  // 每次发生归到支持它的、没有被排除的、在这次发生上分数最高的嫌疑项（同分时取绑定中的顺序）
  const groupOf = occs.map((_, k) => {
    let best: number | null = null;
    for (const [j, x] of stats.entries()) {
      if (x.ruledOut || !x.checks[k]!.supported) {
        continue;
      }
      if (best === null || x.score(k) > stats[best]!.score(k)) {
        best = j;
      }
    }
    return best;
  });
  const groups = new Map<number, number[]>();
  groupOf.forEach((g, k) => {
    if (g !== null) {
      groups.set(g, [...(groups.get(g) ?? []), k]);
    }
  });
  const total = (j: number, members: number[]) => members.reduce((s, k) => s + stats[j]!.score(k), 0);
  const order = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || total(b[0], b[1]) - total(a[0], a[1]) || a[0] - b[0],
  );
  const mainIdx = order[0]?.[0] ?? null;
  const mainOccs = mainIdx !== null ? groups.get(mainIdx)! : [];

  const confidence = (j: number, members: number[]): Confidence => {
    const x = stats[j]!;
    const h = x.hist;
    const n = members.length;
    const logs = members.some((k) => x.checks[k]!.logHits > 0);
    const lift = h?.lift ?? 0;
    const capped = !h || h.insufficient;
    const atLimit = members.every((k) => {
      const o = occs[k]!;
      return o.kind === 'container_limit' && (i.classified.runtime !== 'go' || o.heap === 'live_heap_at_limit');
    });
    // 高：这一组解释了全部发生，没有另一种触发与它并存
    if (!capped && n >= 2 && n === occs.length && lift >= 3 && logs && atLimit) {
      return 'high';
    }
    if (!capped && n >= 2 && lift >= t.lift_min && logs) {
      return 'medium_high';
    }
    if (lift >= t.lift_min || logs) {
      return 'medium';
    }
    return 'low';
  };

  const at = (k: number) => ({ pod: occs[k]!.pod, at: occs[k]!.at, at_text: occs[k]!.at_text });
  const ranked: RankedSuspect[] = stats.map((x, j) => {
    const supported = x.checks.flatMap((c, k) => (c.supported ? [at(k)] : []));
    const members = groups.get(j) ?? [];
    let verdict: Verdict;
    let conf: Confidence | null = null;
    if (x.ruledOut) {
      verdict = 'ruled_out';
      const h = x.hist!;
      conf = (h.lift ?? 0) < 1 && h.x_high >= 3 * t.min_history_samples ? 'high' : 'medium';
    } else if (j === mainIdx) {
      verdict = 'main';
      conf = confidence(j, members);
    } else if (members.length) {
      verdict = 'other';
      conf = confidence(j, members);
    } else if (supported.length || x.checks.some((c) => c.logHits > 0)) {
      verdict = 'secondary';
      conf = 'low';
    } else if (!x.checks.some((c) => c.hasData) && !x.hist?.samples) {
      verdict = 'no_data';
    } else {
      verdict = 'unsupported';
    }
    const aggravating = verdict === 'ruled_out' && mainOccs.some((k) => x.checks[k]!.lastMinute);
    const h = x.hist;
    const reason =
      verdict === 'ruled_out' && h
        ? [
            (h.lift ?? 0) < t.rule_out_lift
              ? pick(
                  L,
                  `48 小时内它处于高位的 ${h.x_high} 个样本中 ${fmtValue(h.counter, 'ratio')} 内存不高（反例），提升 ${fmtRatio(h.lift)}：它处于高位时内存高的可能不比平时大`,
                  `of the ${h.x_high} samples in 48 h where it was high, ${fmtValue(h.counter, 'ratio')} had memory that was not high (counter-examples), lift ${fmtRatio(h.lift)}: high memory was no more likely than usual while it was high`,
                )
              : '',
            h.reverse
              ? pick(
                  L,
                  `它的变化落后于内存（lag ${fmtRatio(h.lag)} > lead ${fmtRatio(h.lead)}），更像是内存高带来的结果`,
                  `it moves after memory (lag ${fmtRatio(h.lag)} > lead ${fmtRatio(h.lead)}), more likely a result of high memory`,
                )
              : '',
            aggravating
              ? pick(
                  L,
                  '主因分组的发生之前最后 2 分钟它仍在上升，可能是压垮的最后一下（推断）',
                  'it was still rising in the last 2 minutes before the main group occurrences, possibly the last straw (inferred)',
                )
              : '',
          ]
            .filter(Boolean)
            .join(pick(L, '；', '; '))
        : h
          ? pick(
              L,
              `48 小时支持度 ${fmtValue(h.support, 'ratio')}，提升 ${fmtRatio(h.lift)}，反例 ${fmtValue(h.counter, 'ratio')}`,
              `48 h support ${fmtValue(h.support, 'ratio')}, lift ${fmtRatio(h.lift)}, counter-examples ${fmtValue(h.counter, 'ratio')}`,
            )
          : '';
    const g = members.map(at);
    return {
      id: x.s.id,
      title: localized(x.s.title, L),
      mechanism: localized(x.s.mechanism, L),
      verdict,
      verdict_text: pick(L, ...VERDICT[verdict]),
      confidence: conf,
      confidence_text: conf ? pick(L, ...CONF[conf]) : '',
      supported,
      group: g,
      pods_and_times: g.map((o) => `${o.pod} ${o.at_text}`).join(pick(L, '、', ', ')),
      aggravating,
      history: h,
      log_hits: x.checks.reduce((a, c) => a + c.logHits, 0),
      reason_text: reason,
      code: x.s.code ?? [],
      fixes: (x.s.fixes ?? []).map((f) => localized(f, L)),
      options: (x.s.options ?? []).map((o) => ({
        title: localized(o.title, L),
        domain: localized(o.domain, L),
        impact: localized(o.impact, L),
        benefit: localized(o.benefit, L),
        risk: localized(o.risk, L),
      })),
      references: x.s.references ?? [],
    };
  });
  const rank: Record<Verdict, number> = { main: 0, other: 1, secondary: 2, ruled_out: 3, unsupported: 4, no_data: 5 };
  const sorted = [...ranked].sort(
    (a, b) =>
      rank[a.verdict] - rank[b.verdict] || b.group.length - a.group.length || ranked.indexOf(a) - ranked.indexOf(b),
  );
  const main = sorted.find((r) => r.verdict === 'main') ?? null;

  // 证据表：发生之前的窗口里每个嫌疑项与上下文序列的起点 → 终点，日志事件，48 小时的统计
  const evidence: EvidenceRow[] = [...i.classified.rows];
  const observed = pick(L, '观测', 'observed');
  for (const [k, o] of occs.entries()) {
    const w = win(o);
    if (!w) {
      continue;
    }
    const shown = [...i.context, ...stats.filter((x) => x.checks[k]!.hasData).flatMap((x) => x.s.series)];
    for (const s of shown.filter((x, n) => shown.findIndex((y) => y.signal === x.signal) === n)) {
      const pts = within(podPoints(w, s.signal), w.from, o.at);
      if (pts.length < 2) {
        continue;
      }
      evidence.push({
        when: fmtSpan(w.from, o.at),
        pod: o.pod,
        what: localized(s.title, L) || s.signal,
        value: `${fmtValue(pts[0]!.v, s.unit)} → ${fmtValue(valueAt(pts, o.at), s.unit)}${pick(L, '（峰值 ', ' (peak ')}${fmtValue(maxOf(pts), s.unit)}${pick(L, '）', ')')}`,
        basis: observed,
        query: w.signals[s.signal]?.expr ?? '',
      });
    }
  }
  const byEvent = new Map<string, LogRecord[]>();
  for (const r of records) {
    byEvent.set(r.event, [...(byEvent.get(r.event) ?? []), r]);
  }
  for (const [ev, rs] of byEvent) {
    const pods = [...new Set(rs.map((r) => r.pod))].sort();
    const times = rs.map((r) => r.time);
    const fields = Object.keys(rs[0]!.text).filter((f) => !['request_id', 'org', 'path'].includes(f));
    const peak = fields
      .map((f) => {
        const nums = rs.map((r) => r.fields[f]).filter((v): v is number => typeof v === 'number');
        if (!nums.length) {
          return null;
        }
        const top = rs.find((r) => r.fields[f] === Math.max(...nums))!;
        return `${f} ${pick(L, '最高', 'max')} ${top.text[f]}`;
      })
      .filter((x): x is string => x !== null)
      .slice(0, 3);
    evidence.push({
      when: fmtSpan(Math.min(...times), Math.max(...times)),
      pod: pods.join(pick(L, '、', ', ')),
      what: ev,
      value: [pick(L, `${rs.length} 条`, `${rs.length} lines`), ...peak].join(pick(L, '，', ', ')),
      basis: observed,
      query: (queries.get(ev) ?? [])[0] ?? '',
    });
  }
  const statBasis = pick(L, '推断（统计）', 'inferred (statistics)');
  for (const x of stats) {
    const primary = x.s.series.find((s) => s.role === 'indicator');
    if (!x.hist || !primary || !i.history) {
      continue;
    }
    const h = x.hist;
    evidence.push({
      when: fmtSpan(i.history.from, i.history.to),
      pod: pick(L, '全部', 'all'),
      what: pick(
        L,
        `${localized(primary.title, L) || primary.signal} 与内存高`,
        `${localized(primary.title, L) || primary.signal} vs high memory`,
      ),
      value: h.insufficient
        ? pick(
            L,
            `高位样本 ${h.x_high} 个，不足 ${t.min_history_samples} 个`,
            `${h.x_high} high samples, fewer than ${t.min_history_samples}`,
          )
        : pick(
            L,
            `支持度 ${fmtValue(h.support, 'ratio')}，提升 ${fmtRatio(h.lift)}，反例 ${fmtValue(h.counter, 'ratio')}，相关 ${fmtRatio(h.corr)}，lead ${fmtRatio(h.lead)} / lag ${fmtRatio(h.lag)}`,
            `support ${fmtValue(h.support, 'ratio')}, lift ${fmtRatio(h.lift)}, counter ${fmtValue(h.counter, 'ratio')}, corr ${fmtRatio(h.corr)}, lead ${fmtRatio(h.lead)} / lag ${fmtRatio(h.lag)}`,
          ),
      basis: statBasis,
      query: i.history.signals[primary.signal]?.expr ?? '',
    });
  }

  const inferred: Array<{ text: string }> = i.classified.inferred.map((text) => ({ text }));
  for (const r of sorted.filter((x) => x.verdict === 'main' || x.verdict === 'other')) {
    inferred.push({
      text: pick(
        L,
        `${r.title}的机制来自领域包声明，与指标、日志的关系由统计得出，没有在运行中验证`,
        `the mechanism of "${r.title}" is declared by the pack; its link to metrics and logs is statistical and was not verified at runtime`,
      ),
    });
  }
  const unexplained = occs
    .map((o, k) => ({ o, k }))
    .filter(({ k }) => groupOf[k] === null)
    .map(({ o }) => ({ pod: o.pod, at_text: fmtTime(o.at) }));
  const relevant = sorted.filter((r) => r.verdict !== 'no_data' && r.verdict !== 'unsupported');
  return {
    headline: main ? main.title : pick(L, '原因未解释', 'cause not explained'),
    main,
    main_id: main?.id ?? 'unexplained',
    main_code_path: main?.code[0]?.path ?? 'unexplained',
    main_group: {
      pods: [...new Set(mainOccs.map((k) => occs[k]!.pod))],
      occurrences: mainOccs.map((k) => ({ pod: occs[k]!.pod, at: occs[k]!.at })),
    },
    others: sorted.filter((r) => r.verdict === 'other'),
    ruled_out: sorted.filter((r) => r.verdict === 'ruled_out'),
    ranked: relevant,
    unexplained,
    evidence,
    fixes: relevant
      .filter((r) => r.verdict !== 'ruled_out')
      .flatMap((r) => r.fixes.map((text) => ({ text })))
      .concat(relevant.filter((r) => r.verdict === 'ruled_out').flatMap((r) => r.fixes.map((text) => ({ text })))),
    options: relevant.flatMap((r) => r.options),
    inferred,
    references: [...new Set(relevant.flatMap((r) => r.references))].sort((a, b) => a - b),
  };
}
