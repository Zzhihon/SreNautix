// 证据卡判定的输入数据：每个引用名对应一次查询的结果。
// 指标序列的时间为 unix 毫秒，缺失点为 null（与 metrics/v1 契约一致）。

export interface MetricSeries {
  labels: Record<string, string>;
  times: number[];
  values: Array<number | null>;
}

export interface LogLine {
  time: number;
  labels: Record<string, string>;
  line: string;
}

export interface TraceHit {
  trace_id: string;
  root_service: string;
  root_name: string;
  start: number;
  duration_ms: number;
  attributes: Record<string, string>;
}

export type RefData =
  | { kind: 'metrics'; series: MetricSeries[]; truncated: boolean }
  | { kind: 'logs'; lines: LogLine[]; truncated: boolean }
  | { kind: 'traces'; traces: TraceHit[]; truncated: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'capability_missing'; capability: string };

/** 引用没有任何样本（指标无点、日志无行、链路无命中） */
export function isEmpty(d: RefData): boolean {
  switch (d.kind) {
    case 'metrics':
      return d.series.every((s) => s.values.every((v) => v === null));
    case 'logs':
      return d.lines.length === 0;
    case 'traces':
      return d.traces.length === 0;
    case 'error':
    case 'capability_missing':
      return true;
  }
}

/** 进入 CEL 的序列：只保留有值的点，时间换算为 unix 秒 */
export interface CelSeries {
  labels: Record<string, string>;
  times: number[];
  values: number[];
}

export function toCelSeries(s: MetricSeries): CelSeries {
  const times: number[] = [];
  const values: number[] = [];
  s.values.forEach((v, i) => {
    if (v !== null) {
      times.push(s.times[i]! / 1000);
      values.push(v);
    }
  });
  return { labels: s.labels, times, values };
}
