// 证据卡判定的输入数据：每个引用名对应一次查询的结果。
// 指标序列的时间为 unix 毫秒，缺失点为 null（与 metrics/v1 契约一致）。

// 标签与契约的 Labels 一致：索引访问可能为 undefined
export type LabelMap = Record<string, string | undefined>;

export interface MetricSeries {
  labels: LabelMap;
  times: number[];
  values: Array<number | null>;
}

export interface LogLine {
  time: number;
  labels: LabelMap;
  line: string;
}

export interface TraceHit {
  trace_id: string;
  root_service: string;
  root_name: string;
  start: number;
  duration_ms: number;
  attributes: LabelMap;
}

export type RefData =
  | { kind: 'metrics'; series: MetricSeries[]; truncated: boolean }
  | { kind: 'logs'; lines: LogLine[]; truncated: boolean }
  | { kind: 'traces'; traces: TraceHit[]; truncated: boolean }
  | { kind: 'error'; message: string; /** 数据源在超时之前没有响应 */ timeout?: boolean }
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
  return { labels: denseLabels(s.labels), times, values };
}

export function denseLabels(l: LabelMap): Record<string, string> {
  return Object.fromEntries(Object.entries(l).filter((e): e is [string, string] => e[1] !== undefined));
}
