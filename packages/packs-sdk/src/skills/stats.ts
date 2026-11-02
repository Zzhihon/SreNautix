// analyze.* 用到的统计与格式：序列对齐、Pearson 相关、错位相关、分位数、时间与数值的展示。

import { fmtBytes, fmtNum, fmtPct, fmtSecs } from '../cel/format.js';
import type { Lang, Point, Series } from './data.js';

/** 多条序列按时间点求和（同一时刻都有值的序列相加；只有部分序列有值时取有值的和） */
export function sumSeries(series: readonly Series[]): Point[] {
  const m = new Map<number, number>();
  for (const s of series) {
    for (const p of s.points) {
      if (Number.isFinite(p.v)) {
        m.set(p.t, (m.get(p.t) ?? 0) + p.v);
      }
    }
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

/** 序列在 [from, to] 内的点 */
export function within(points: readonly Point[], from: number, to: number): Point[] {
  return points.filter((p) => p.t >= from && p.t <= to);
}

/** 两条序列在相同时刻都有值的点对 */
export function aligned(a: readonly Point[], b: readonly Point[]): Array<[number, number]> {
  const m = new Map(b.map((p) => [p.t, p.v]));
  const out: Array<[number, number]> = [];
  for (const p of a) {
    const v = m.get(p.t);
    if (v !== undefined) {
      out.push([p.v, v]);
    }
  }
  return out;
}

/** Pearson 相关系数；点数不足或方差为零时为 null */
export function pearson(pairs: ReadonlyArray<readonly [number, number]>, minPoints = 10): number | null {
  const n = pairs.length;
  if (n < minPoints) {
    return null;
  }
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (const [x, y] of pairs) {
    cov += (x - mx) * (y - my);
    vx += (x - mx) ** 2;
    vy += (y - my) ** 2;
  }
  if (vx === 0 || vy === 0) {
    return null;
  }
  return cov / Math.sqrt(vx * vy);
}

/**
 * 错位相关：把 b 的时间点整体前移 k 个步长后与 a 对齐，k 取 1..maxLag，返回最大的相关系数。
 * 多个分组（每个 Pod 一组）的点对合并计算
 */
export function laggedCorr(
  groups: ReadonlyArray<{ a: readonly Point[]; b: readonly Point[] }>,
  stepMs: number,
  maxLag = 3,
): number | null {
  let best: number | null = null;
  for (let k = 1; k <= maxLag; k++) {
    const pairs: Array<[number, number]> = [];
    for (const g of groups) {
      const shifted = g.b.map((p) => ({ t: p.t - k * stepMs, v: p.v }));
      pairs.push(...aligned(g.a, shifted));
    }
    const r = pearson(pairs, 12);
    if (r !== null && (best === null || r > best)) {
      best = r;
    }
  }
  return best;
}

export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) {
    return null;
  }
  const v = [...values].sort((a, b) => a - b);
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1));
  return v[i]!;
}

export function maxOf(points: readonly Point[]): number | null {
  return points.length ? Math.max(...points.map((p) => p.v)) : null;
}

/** 最接近 t 且不晚于 t 的点 */
export function valueAt(points: readonly Point[], t: number): number | null {
  let best: Point | null = null;
  for (const p of points) {
    if (p.t <= t && (!best || p.t > best.t)) {
      best = p;
    }
  }
  return best ? best.v : null;
}

export function firstAfter(points: readonly Point[], t: number): number | null {
  let best: Point | null = null;
  for (const p of points) {
    if (p.t >= t && (!best || p.t < best.t)) {
      best = p;
    }
  }
  return best ? best.v : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** MM-DD HH:MM:SS（UTC） */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** MM-DD HH:MM–HH:MM（UTC），跨天时两端都写日期 */
export function fmtSpan(from: number, to: number): string {
  const a = fmtTime(from).slice(0, 11);
  const b = fmtTime(to);
  return b.slice(0, 5) === a.slice(0, 5) ? `${a}–${b.slice(6, 11)}` : `${a}–${b.slice(0, 11)}`;
}

export type ValueUnit = 'bytes' | 'bytes_per_second' | 'count' | 'per_second' | 'ratio' | 'cores' | 'seconds' | 'none';

export function fmtValue(v: number | null, unit: ValueUnit): string {
  if (v === null || !Number.isFinite(v)) {
    return '—';
  }
  switch (unit) {
    case 'bytes':
      return fmtBytes(v);
    case 'bytes_per_second':
      return `${fmtBytes(v)}/s`;
    case 'count':
      return fmtNum(Math.round(v));
    case 'per_second':
      return `${fmtNum(v, 3)}/s`;
    case 'ratio':
      return fmtPct(v);
    case 'cores':
      return `${fmtNum(v, 2)}`;
    case 'seconds':
      return fmtSecs(v);
    case 'none':
      return fmtNum(v);
  }
}

export const fmtRatio = (v: number | null) => (v === null ? '—' : fmtNum(v, 2));

export function pick<T>(lang: Lang, zh: T, en: T): T {
  return lang === 'zh-CN' ? zh : en;
}

/** LocalizedText 取一种语言，缺失时取另一种 */
export function localized(t: unknown, lang: Lang): string {
  if (typeof t === 'string') {
    return t;
  }
  const o = (t ?? {}) as Record<string, string | undefined>;
  return (lang === 'zh-CN' ? (o['zh-CN'] ?? o.en) : (o.en ?? o['zh-CN'])) ?? '';
}
