// 只读工具的查询约束与结果整形：时间范围、步长、序列数、点数、日志行数、结果字节数都有上限，
// 超出部分在服务端截断，并在结果中说明截掉了多少。

export const LIMITS = {
  maxRangeMs: 24 * 3600_000,
  minStepSeconds: 15,
  series: 20,
  points: 60,
  logLines: 50,
  resultBytes: 16 * 1024,
} as const;

export class ToolArgError extends Error {
  override name = 'ToolArgError';
}

/** RFC3339 字符串或 unix 秒（字符串或数字）→ 毫秒 */
export function parseTime(v: unknown, name: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v * 1000;
  }
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) {
    return Number(v) * 1000;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) {
      return t;
    }
  }
  throw new ToolArgError(`${name} 必须是 RFC3339 时间或 unix 秒：${JSON.stringify(v)}`);
}

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** `30s`、`5m` 这类时长或纯数字（秒）→ 秒 */
export function parseDuration(v: unknown, name: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string') {
    if (/^\d+(\.\d+)?$/.test(v)) {
      return Number(v);
    }
    const m = /^(\d+)(ms|s|m|h|d|w)$/.exec(v);
    if (m) {
      return Number(m[1]) * (UNIT_SECONDS[m[2] as string] as number);
    }
  }
  throw new ToolArgError(`${name} 必须是时长（如 30s、5m）：${JSON.stringify(v)}`);
}

export interface Window {
  from: number;
  to: number;
}

/**
 * 把请求的时间范围约束到允许的窗口内：先裁到 bounds（回放时是快照窗口，日常研判是事件窗口前后各 24 小时），
 * 再限制最长 24 小时。完全落在 bounds 之外时拒绝。
 */
export function clampRange(from: number, to: number, bounds: Window): { window: Window; notes: string[] } {
  if (to < from) {
    throw new ToolArgError('时间范围的终点早于起点');
  }
  const notes: string[] = [];
  let f = from;
  let t = to;
  if (t > bounds.to) {
    notes.push(`终点晚于允许的窗口，已改为 ${new Date(bounds.to).toISOString()}`);
    t = bounds.to;
  }
  if (f < bounds.from) {
    notes.push(`起点早于允许的窗口，已改为 ${new Date(bounds.from).toISOString()}`);
    f = bounds.from;
  }
  if (t < f) {
    throw new ToolArgError(
      `时间范围不在允许的窗口 ${new Date(bounds.from).toISOString()} – ${new Date(bounds.to).toISOString()} 内`,
    );
  }
  if (t - f > LIMITS.maxRangeMs) {
    f = t - LIMITS.maxRangeMs;
    notes.push(`时间范围超过 24 小时，起点已改为 ${new Date(f).toISOString()}`);
  }
  return { window: { from: f, to: t }, notes };
}

/** 均匀抽取最多 limit 个元素，保留首尾 */
export function thin<T>(xs: T[], limit: number): T[] {
  if (xs.length <= limit) {
    return xs;
  }
  const out: T[] = [];
  for (let i = 0; i < limit; i++) {
    out.push(xs[Math.round((i * (xs.length - 1)) / (limit - 1))] as T);
  }
  return out;
}

/** 按 UTF-8 字节截断，不切断多字节字符 */
export function cutBytes(s: string, limit: number): { text: string; cut: number } {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= limit) {
    return { text: s, cut: 0 };
  }
  let end = limit;
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) {
    end--;
  }
  return { text: buf.subarray(0, end).toString('utf8'), cut: buf.length - end };
}

export interface Shaped {
  text: string;
  truncated: boolean;
  bytes: number;
}

/** 结果整形：附上截断说明，再按字节上限截断 */
export function shape(payload: unknown, notes: string[]): Shaped {
  const body = JSON.stringify(notes.length ? { truncation: notes, result: payload } : { result: payload });
  const bytes = Buffer.byteLength(body, 'utf8');
  const { text, cut } = cutBytes(body, LIMITS.resultBytes - 200);
  if (!cut) {
    return { text, truncated: notes.length > 0, bytes };
  }
  return { text: `${text}\n[截断：结果超过 16 KiB，末尾 ${cut} 字节已截去]`, truncated: true, bytes };
}

interface PromLike {
  status?: string;
  data?: { resultType?: string; result?: unknown };
}

/** Prometheus 风格结果限制为 20 个序列 × 60 点 */
export function capPromResult(r: PromLike): { result: PromLike; notes: string[] } {
  const notes: string[] = [];
  const data = r.data;
  if (!data || !Array.isArray(data.result)) {
    return { result: r, notes };
  }
  let rows = data.result as Array<{ metric?: unknown; values?: unknown[]; value?: unknown }>;
  if (rows.length > LIMITS.series) {
    notes.push(`共 ${rows.length} 个序列，只返回前 ${LIMITS.series} 个`);
    rows = rows.slice(0, LIMITS.series);
  }
  let thinned = 0;
  rows = rows.map((row) => {
    if (Array.isArray(row.values) && row.values.length > LIMITS.points) {
      thinned++;
      return { ...row, values: thin(row.values, LIMITS.points) };
    }
    return row;
  });
  if (thinned) {
    notes.push(`${thinned} 个序列的点数超过 ${LIMITS.points}，已均匀抽样`);
  }
  return { result: { ...r, data: { ...data, result: rows } }, notes };
}

/** 文本行限制为最后 50 行 */
export function capLines(text: string): { text: string; notes: string[] } {
  const lines = text.split('\n');
  if (lines.length <= LIMITS.logLines) {
    return { text, notes: [] };
  }
  return {
    text: lines.slice(-LIMITS.logLines).join('\n'),
    notes: [`共 ${lines.length} 行，只返回最后 ${LIMITS.logLines} 行`],
  };
}
