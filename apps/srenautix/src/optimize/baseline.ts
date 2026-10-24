import type {
  BaselineIndicator,
  DomainGates,
  GoalObjective,
  IndicatorStatistic,
  IndicatorUnit,
  OptimizationBaseline,
  OptimizationGap,
} from '@srenautix/contract';
import { HOUR_MS, quantile, statistic } from './stats.js';

// 基线与差距（ADR 0146 §2.2），全部由代码从指标信号的按小时取值计算：
// 1. 基线：窗口内按小时取值。覆盖率（有数据的小时 ÷ 窗口小时）低于 90%，或窗口里少于 3 个业务高峰（按 load_indicator，
//    负载前 20% 的小时；相邻的高峰小时算一个高峰），基线判为无法判定，运行以 failed（baseline_insufficient）结束；
// 2. 差距：有目标值时，违反目标的小时占比不低于 gates.violation_ratio，或统计值违反目标；领域体检按领域的门槛，
//    任一指标的统计值违反门槛即差距成立。

export const MIN_COVERAGE = 0.9;
export const MIN_PEAKS = 3;
export const PEAK_SHARE = 0.2;
export const DEFAULT_VIOLATION_RATIO = 0.1;

export interface IndicatorSeries {
  indicator: string;
  params: Record<string, number | string | boolean>;
  entity: string;
  unit: IndicatorUnit;
  better: 'lower' | 'higher';
  statistic: IndicatorStatistic;
  /** 按小时的取值 [毫秒, 值或 null]，覆盖整个窗口 */
  hourly: ReadonlyArray<readonly [number, number | null]>;
  /** 负载指标的按小时取值；指标没有声明 load_indicator 时为 null */
  load: ReadonlyArray<readonly [number, number | null]> | null;
}

export interface Comparison {
  comparator: 'lt' | 'le' | 'gt' | 'ge';
  value: number;
}

/** 值是否满足比较（目标或门槛） */
export function satisfies(v: number, c: Comparison): boolean {
  switch (c.comparator) {
    case 'lt':
      return v < c.value;
    case 'le':
      return v <= c.value;
    case 'gt':
      return v > c.value;
    case 'ge':
      return v >= c.value;
  }
}

/** 负载前 20% 的小时连成的高峰段数（只计指标有数据的小时） */
export function peakCount(
  hourlyValues: ReadonlyArray<readonly [number, number | null]>,
  load: ReadonlyArray<readonly [number, number | null]>,
): { peaks: number; peakHours: number } {
  const covered = new Set(hourlyValues.filter(([, v]) => v !== null).map(([t]) => t));
  const loads = load.filter((x): x is readonly [number, number] => x[1] !== null && covered.has(x[0]));
  if (!loads.length) {
    return { peaks: 0, peakHours: 0 };
  }
  const cut = quantile(
    loads.map(([, v]) => v),
    1 - PEAK_SHARE,
  ) as number;
  // 高于第 80 百分位的小时；取值大量相同（例如低负载时段都是同一个值）时，等于它的小时不算高峰，除非没有更高的
  const above = loads.filter(([, v]) => v > cut);
  const peakHours = (above.length ? above : loads.filter(([, v]) => v >= cut)).map(([t]) => t).sort((a, b) => a - b);
  let peaks = 0;
  let prev = Number.NEGATIVE_INFINITY;
  for (const t of peakHours) {
    if (t - prev > HOUR_MS) {
      peaks++;
    }
    prev = t;
  }
  return { peaks, peakHours: peakHours.length };
}

export interface IndicatorBaseline {
  row: BaselineIndicator;
  /** 覆盖率与高峰数是否足够 */
  sufficient: boolean;
  missing: string[];
  /** 统计值违反目标或门槛 */
  statisticViolates: boolean;
  /** 差距的大小（指标单位，按改善方向取正值）；没有可比较的目标或没有违反时为 0；统计值为 null 时为 null */
  gap: number | null;
}

/** 一个指标的基线：comparison 是目标或门槛，没有时为 null */
export function indicatorBaseline(s: IndicatorSeries, comparison: Comparison | null): IndicatorBaseline {
  const hours = s.hourly.length;
  const values = s.hourly.filter((x): x is readonly [number, number] => x[1] !== null);
  const covered = values.length;
  const value = statistic(
    values.map(([, v]) => v),
    s.statistic,
  );
  const missing: string[] = [];
  const coverage = hours ? covered / hours : 0;
  if (coverage < MIN_COVERAGE) {
    missing.push(`${s.indicator} 覆盖率 ${Math.round(coverage * 100)}%（${covered}/${hours} 小时），需要不低于 90%`);
  }
  let peakHours = 0;
  if (s.load) {
    const p = peakCount(s.hourly, s.load);
    peakHours = p.peakHours;
    if (p.peaks < MIN_PEAKS) {
      missing.push(`${s.indicator} 的基线窗口只有 ${p.peaks} 个业务高峰，需要至少 ${MIN_PEAKS} 个`);
    }
  }
  const violation_ratio =
    comparison && covered ? values.filter(([, v]) => !satisfies(v, comparison)).length / covered : null;
  const statisticViolates = comparison !== null && value !== null && !satisfies(value, comparison);
  // 差距：统计值违反时为统计值与目标之差；只有部分小时违反时为这些小时超出目标的平均值；没有违反为 0
  const violating = comparison ? values.filter(([, v]) => !satisfies(v, comparison)).map(([, v]) => v) : [];
  let gap: number | null = null;
  if (value !== null) {
    if (comparison && statisticViolates) {
      gap = Math.abs(value - comparison.value);
    } else if (comparison && violating.length) {
      gap = violating.reduce((n, v) => n + Math.abs(v - comparison.value), 0) / violating.length;
    } else {
      gap = 0;
    }
  }
  return {
    row: {
      indicator: s.indicator,
      params: s.params,
      entity: s.entity,
      unit: s.unit,
      better: s.better,
      statistic: s.statistic,
      value,
      hours,
      covered_hours: covered,
      peak_hours: peakHours,
      violation_ratio,
      hourly: s.hourly.map(([t, v]) => [Math.floor(t / 1000), v] as [number, number | null]),
    },
    sufficient: missing.length === 0,
    missing,
    statisticViolates,
    gap,
  };
}

export interface BaselineResult {
  baseline: OptimizationBaseline;
  gap: OptimizationGap;
  /** 每个指标（按 indicator 与 entity）的差距大小，供候选排序与 G2 使用 */
  gaps: Map<string, number | null>;
  /** 每个指标的统计值 */
  values: Map<string, number | null>;
}

export const seriesKey = (indicator: string, entity: string) => `${indicator}@${entity}`;

/**
 * 基线与差距：objective 为目标值（指标目标，series 只有这个指标）；没有目标值时按 gates.thresholds（领域体检）。
 */
export function baselineAndGap(
  window: { from: number; to: number },
  series: readonly IndicatorSeries[],
  objective: GoalObjective | null,
  gates: DomainGates,
): BaselineResult {
  const violationRatio = gates.violation_ratio ?? DEFAULT_VIOLATION_RATIO;
  const thresholds = gates.thresholds ?? [];
  const rows: IndicatorBaseline[] = series.map((s) => {
    if (objective) {
      return indicatorBaseline(s, { comparator: objective.comparator, value: objective.target });
    }
    const t = thresholds.find((x) => x.indicator === s.indicator);
    return indicatorBaseline(
      t?.statistic ? { ...s, statistic: t.statistic } : s,
      t ? { comparator: t.comparator, value: t.value } : null,
    );
  });
  const missing = rows.flatMap((r) => r.missing);
  const sufficient = rows.length > 0 && rows.every((r) => r.sufficient);
  const baseline: OptimizationBaseline = {
    window: { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
    sufficient,
    missing: rows.length ? missing : ['没有可计算基线的指标'],
    indicators: rows.map((r) => r.row),
  };
  const gaps = new Map(rows.map((r) => [seriesKey(r.row.indicator, r.row.entity), r.gap] as const));
  const values = new Map(rows.map((r) => [seriesKey(r.row.indicator, r.row.entity), r.row.value] as const));
  if (!sufficient) {
    return { baseline, gap: { exists: false, basis: 'none', detail: '基线不足，无法判定差距' }, gaps, values };
  }
  if (objective) {
    const hit = rows.filter(
      (r) => r.statisticViolates || (r.row.violation_ratio !== null && r.row.violation_ratio >= violationRatio),
    );
    const r = rows[0] as IndicatorBaseline;
    const detail = `${r.row.indicator} 的 ${r.row.statistic} 为 ${fmt(r.row.value)}，目标 ${objective.comparator} ${objective.target}；违反目标的小时占比 ${fmt(r.row.violation_ratio)}（门槛 ${violationRatio}）`;
    return { baseline, gap: { exists: hit.length > 0, basis: 'objective', detail }, gaps, values };
  }
  const withThreshold = rows.filter((r) => thresholds.some((t) => t.indicator === r.row.indicator));
  if (!withThreshold.length) {
    return {
      baseline,
      gap: { exists: false, basis: 'none', detail: '目标没有目标值，领域也没有指标门槛' },
      gaps,
      values,
    };
  }
  const hit = withThreshold.filter((r) => r.statisticViolates);
  const detail = hit.length
    ? `违反领域门槛的指标：${hit.map((r) => `${r.row.indicator} 的 ${r.row.statistic} 为 ${fmt(r.row.value)}`).join('、')}`
    : '全部指标都在领域门槛之内';
  return { baseline, gap: { exists: hit.length > 0, basis: 'gate', detail }, gaps, values };
}

function fmt(v: number | null): string {
  if (v === null) {
    return '无数据';
  }
  return Number.isInteger(v) ? String(v) : v.toPrecision(4);
}
