import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import type { EvalRatio } from '@srenautix/contract';

// 评测统计（DESIGN §14.4）：
// - 置信区间用聚类自助法：以用例为聚类单位有放回抽样，同一用例的多次运行整体随用例进出；
//   比例 = 抽中用例的分子之和 ÷ 分母之和。区间取 90%（5% 与 95% 分位）。
// - 发布门禁的配对比较：按用例配对，统计量为新减旧的平均差，单侧 90% 下界取自助分布的 10% 分位。
// 随机数生成器固定种子，同一输入得到同一结果。

export const BOOTSTRAP_ITERATIONS = 2000;
export const DEFAULT_SEED = 20261020;

/** 一个用例（聚类）对某个比例的贡献 */
export interface Cluster {
  numerator: number;
  denominator: number;
}

/** 线性插值分位数（R 的第 7 类，与 numpy 默认一致） */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    throw new RangeError('空样本没有分位数');
  }
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (h - lo) * (b - a);
}

export function ratioPoint(clusters: readonly Cluster[]): {
  numerator: number;
  denominator: number;
  value: number | null;
} {
  const numerator = clusters.reduce((s, c) => s + c.numerator, 0);
  const denominator = clusters.reduce((s, c) => s + c.denominator, 0);
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : null };
}

/** 聚类自助法的比例与 90% 置信区间 */
export function clusteredRatio(
  clusters: readonly Cluster[],
  seed = DEFAULT_SEED,
  iterations = BOOTSTRAP_ITERATIONS,
): EvalRatio {
  const point = ratioPoint(clusters);
  const usable = clusters.filter((c) => c.denominator > 0);
  if (point.value === null || usable.length === 0) {
    return { ...point, ci_low: null, ci_high: null };
  }
  const rng = xoroshiro128plus(seed);
  const stats: number[] = [];
  const n = clusters.length;
  for (let b = 0; b < iterations; b++) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const c = clusters[uniformInt(rng, 0, n - 1)] as Cluster;
      num += c.numerator;
      den += c.denominator;
    }
    if (den > 0) {
      stats.push(num / den);
    }
  }
  stats.sort((a, b) => a - b);
  return { ...point, ci_low: quantile(stats, 0.05), ci_high: quantile(stats, 0.95) };
}

export interface PairedDelta {
  n: number;
  delta: number;
  /** 单侧 90% 下界 */
  low: number;
}

/** 按用例配对的平均差（候选减基线）与单侧 90% 下界 */
export function pairedDelta(
  pairs: ReadonlyArray<{ baseline: number; candidate: number }>,
  seed = DEFAULT_SEED,
  iterations = BOOTSTRAP_ITERATIONS,
): PairedDelta {
  const n = pairs.length;
  if (n === 0) {
    throw new RangeError('没有可配对的用例');
  }
  const diffs = pairs.map((p) => p.candidate - p.baseline);
  const delta = diffs.reduce((a, b) => a + b, 0) / n;
  const rng = xoroshiro128plus(seed);
  const stats: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += diffs[uniformInt(rng, 0, n - 1)] as number;
    }
    stats.push(s / n);
  }
  stats.sort((a, b) => a - b);
  return { n, delta, low: quantile(stats, 0.1) };
}

/** 门禁阈值：n < 100 时 −10 个百分点，否则 −5 个百分点 */
export function gateThreshold(n: number): number {
  return n < 100 ? -0.1 : -0.05;
}
