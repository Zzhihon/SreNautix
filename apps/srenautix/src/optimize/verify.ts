import type { IndicatorStatistic, RecommendationOutcome } from '@srenautix/contract';
import { iqr, statistic } from './stats.js';

// 验证（ADR 0146 §2.6）：与基线按“星期 × 小时”匹配的时段比较，按小时取值。
// - 改善不低于 estimate.lower 的 50% 并且超出噪声带（基线窗口内同一时段的四分位距的一半）时为 improved；
// - 守护指标（错误率、其他语句的执行时间、CPU 限流、OOM）恶化超过 10% 时为 regressed（优先于 improved）；
// - 其余为 no_effect。

export const IMPROVED_SHARE_OF_LOWER = 0.5;
export const GUARD_REGRESSION = 0.1;

type Hourly = ReadonlyArray<readonly [number, number | null]>;

const slot = (t: number) => {
  const d = new Date(t);
  return d.getUTCDay() * 24 + d.getUTCHours();
};

/** 基线中与 window 的时段（星期 × 小时）相同的取值 */
export function matchedBaseline(baseline: Hourly, window: Hourly): number[] {
  const slots = new Set(window.filter(([, v]) => v !== null).map(([t]) => slot(t)));
  return baseline
    .filter((x): x is readonly [number, number] => x[1] !== null && slots.has(slot(x[0])))
    .map(([, v]) => v);
}

export interface GuardSeries {
  indicator: string;
  better: 'lower' | 'higher';
  statistic: IndicatorStatistic;
  baseline: Hourly;
  window: Hourly;
}

export interface VerifyInput {
  better: 'lower' | 'higher';
  statistic: IndicatorStatistic;
  baseline: Hourly;
  window: Hourly;
  windowRange: { from: string; to: string };
  estimateLower: number;
  guards: readonly GuardSeries[];
  cards: RecommendationOutcome['cards'];
  verifiedAt: string;
}

/** 改善量：按改善方向取正值 */
function gain(better: 'lower' | 'higher', base: number, observed: number): number {
  return better === 'lower' ? base - observed : observed - base;
}

export function verifyOutcome(i: VerifyInput): RecommendationOutcome {
  const matched = matchedBaseline(i.baseline, i.window);
  const observedValues = i.window.filter((x): x is readonly [number, number] => x[1] !== null).map(([, v]) => v);
  const baseline = statistic(matched, i.statistic);
  const observed = statistic(observedValues, i.statistic);
  const improvement = baseline !== null && observed !== null ? gain(i.better, baseline, observed) : null;
  const spread = iqr(matched);
  const noise = spread === null ? null : spread / 2;
  const guards = i.guards.map((g) => {
    const b = statistic(matchedBaseline(g.baseline, g.window), g.statistic);
    const o = statistic(
      g.window.filter((x): x is readonly [number, number] => x[1] !== null).map(([, v]) => v),
      g.statistic,
    );
    // 恶化方向为正：lower 更好的指标上升、higher 更好的指标下降
    let change_ratio: number | null = null;
    if (b !== null && o !== null && b !== 0) {
      change_ratio = g.better === 'lower' ? (o - b) / Math.abs(b) : (b - o) / Math.abs(b);
    }
    const regressed = change_ratio !== null && change_ratio > GUARD_REGRESSION;
    return { indicator: g.indicator, change_ratio, regressed };
  });
  let result: RecommendationOutcome['result'] = 'no_effect';
  if (guards.some((g) => g.regressed)) {
    result = 'regressed';
  } else if (
    improvement !== null &&
    improvement >= IMPROVED_SHARE_OF_LOWER * i.estimateLower &&
    improvement > (noise ?? 0)
  ) {
    result = 'improved';
  }
  return {
    result,
    window: i.windowRange,
    baseline,
    observed,
    improvement,
    noise_band: noise,
    estimate_lower: i.estimateLower,
    guards,
    cards: i.cards,
    revert_proposal_id: null,
    verified_at: i.verifiedAt,
  };
}
