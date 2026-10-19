// 时间工具：契约中的时间都是 RFC 3339 UTC，core 内部统一用 unix 毫秒
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Prometheus 风格的时长（30s、5m、1h30m、7d）转毫秒 */
export function parseDuration(text: string): number {
  const re = /([0-9]+)(ms|s|m|h|d|w)/g;
  let total = 0;
  let consumed = 0;
  for (const m of text.matchAll(re)) {
    total += Number(m[1]) * UNIT_MS[m[2]!]!;
    consumed += m[0].length;
  }
  if (consumed === 0 || consumed !== text.length) {
    throw new Error(`不是合法的时长：${text}`);
  }
  return total;
}

export function parseTime(text: string): number {
  const t = Date.parse(text);
  if (Number.isNaN(t)) {
    throw new Error(`不是合法的时间：${text}`);
  }
  return t;
}

/** RFC 3339 UTC，整秒时省略毫秒 */
export function formatTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
}

export function floorTo(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}

/** Alertmanager 的零值时间（0001-01-01T00:00:00Z）表示没有结束时间 */
export function isZeroTime(text: string | undefined): boolean {
  return text === undefined || text === '' || text.startsWith('0001-01-01');
}
