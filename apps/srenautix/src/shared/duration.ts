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
