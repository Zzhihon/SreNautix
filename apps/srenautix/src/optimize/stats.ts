import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { IndicatorStatistic } from '@srenautix/contract';

// 主动优化的确定性计算共用的小工具：时长、按小时分桶、分位数、发现指纹（ADR 0146 §1.4、§2.2、§2.6）。

export const HOUR_MS = 3_600_000;

const UNIT: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: HOUR_MS,
  d: 24 * HOUR_MS,
  w: 7 * 24 * HOUR_MS,
};

/** 契约 Duration（30s、5m、2h、7d、1w，可组合，例如 1d12h）→ 毫秒 */
export function durationMs(d: string): number {
  if (!/^([0-9]+(ms|s|m|h|d|w))+$/.test(d)) {
    throw new Error(`时长不合法：${d}`);
  }
  let total = 0;
  for (const m of d.matchAll(/([0-9]+)(ms|s|m|h|d|w)/g)) {
    total += Number(m[1]) * (UNIT[m[2] as string] as number);
  }
  return total;
}

/** 整点（UTC）向下取整 */
export function hourFloor(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

/**
 * 按小时取值：窗口 [from, to) 内每个整点小时一个值，为该小时内样本的平均值；没有样本的小时为 null。
 * points 是 [毫秒, 值] 的序列（多条序列先由调用方相加）
 */
export function hourly(
  points: ReadonlyArray<readonly [number, number]>,
  from: number,
  to: number,
): Array<[number, number | null]> {
  const start = hourFloor(from);
  const sums = new Map<number, { s: number; n: number }>();
  for (const [t, v] of points) {
    if (t < start || t >= to || !Number.isFinite(v)) {
      continue;
    }
    const h = hourFloor(t);
    const cur = sums.get(h) ?? { s: 0, n: 0 };
    cur.s += v;
    cur.n++;
    sums.set(h, cur);
  }
  const out: Array<[number, number | null]> = [];
  for (let h = start; h < to; h += HOUR_MS) {
    const c = sums.get(h);
    out.push([h, c ? c.s / c.n : null]);
  }
  return out;
}

/** 分位数（线性插值，与 Prometheus quantile 相同）；空集为 null */
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) {
    return null;
  }
  const s = [...values].sort((a, b) => a - b);
  const rank = q * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (rank - lo);
}

export function statistic(values: readonly number[], s: IndicatorStatistic): number | null {
  if (!values.length) {
    return null;
  }
  switch (s) {
    case 'p50':
      return quantile(values, 0.5);
    case 'p95':
      return quantile(values, 0.95);
    case 'max':
      return Math.max(...values);
  }
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/** 四分位距 */
export function iqr(values: readonly number[]): number | null {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return q1 === null || q3 === null ? null : q3 - q1;
}

/** 发现的指纹（契约 Finding.fingerprint）：sha256(JCS([cluster_id, domain, kind, entity.key])) */
export function findingFingerprint(clusterId: string, domain: string, kind: string, entityKey: string): string {
  const jcs = canonicalize([clusterId, domain, kind, entityKey]) as string;
  return `sha256:${createHash('sha256').update(jcs).digest('hex')}`;
}
