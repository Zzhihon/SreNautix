// logs/v1 的核心级适配器：Loki。logs.match 由 K8s 选择器生成 LogQL；logs.query 执行原生 LogQL。
// 日志行是不可信文本，原样返回，由展示层转义。

import type {
  LogLine,
  LogsMatchRequest,
  LogsQueryRequest,
  LogsResult,
  MetricSeries,
  MetricsQueryResult,
  TimeWindow,
} from '@srenautix/contract';
import { assertWindowInClock, toMillis } from '../clock.js';
import { DatasourceError } from '../errors.js';
import { HttpClient, type HttpAuthConfig } from '../http.js';

export interface LokiConfig extends HttpAuthConfig {
  id: string;
  url: string;
  /** 日志流上的 Kubernetes 标签名；不同采集器的命名不同 */
  labels: { namespace: string; pod: string; container: string; cluster: string | null };
  /** 单次日志查询的超时，默认 30 秒 */
  timeout_ms?: number;
}

interface LokiStreams {
  status: string;
  data: { resultType: string; result: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> };
}

interface LokiMatrix {
  status: string;
  data: { resultType: string; result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> };
}

/** LogQL 指标查询（count_over_time 等）的区间查询请求 */
export interface LokiMetricRangeRequest {
  query: string;
  /** 求值时刻为 window.from、window.from + step、…，不超过 window.to */
  window: TimeWindow;
  step_seconds: number;
  clock_window: TimeWindow;
  timeout_ms: number;
  /** 保留的序列数上限；超过时按标签排序后截断，truncated 为 true */
  max_series: number;
}

/** LogQL 字符串字面量（Go 风格双引号） */
export function logqlString(s: string): string {
  return JSON.stringify(s);
}

/** RE2 元字符转义 */
export function re2Escape(s: string): string {
  return s.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&');
}

const nanos = (ts: string) => `${BigInt(toMillis(ts)) * 1_000_000n}`;

export class LokiAdapter {
  private readonly http: HttpClient;

  constructor(readonly config: LokiConfig) {
    this.http = new HttpClient(config.id, config.url, config);
  }

  /** logs.match 生成的 LogQL，便于在证据卡中展示实际执行的查询 */
  matchQuery(req: LogsMatchRequest): string {
    const l = this.config.labels;
    const sel = req.selector;
    const matchers = [`${l.namespace}=${logqlString(sel.namespace)}`];
    if (l.cluster) {
      matchers.push(`${l.cluster}=${logqlString(sel.cluster_id)}`);
    }
    if (sel.pods.length) {
      matchers.push(`${l.pod}=~${logqlString(sel.pods.map(re2Escape).join('|'))}`);
    }
    if (sel.containers.length) {
      matchers.push(`${l.container}=~${logqlString(sel.containers.map(re2Escape).join('|'))}`);
    }
    for (const [k, v] of Object.entries(sel.labels).sort(([a], [b]) => (a < b ? -1 : 1))) {
      matchers.push(`${k}=${logqlString(v ?? '')}`);
    }
    if ((req.contains === null) === (req.regex === null)) {
      throw new TypeError('logs.match 的 contains 与 regex 必须二选一');
    }
    const filter = req.contains !== null ? `|= ${logqlString(req.contains)}` : `|~ ${logqlString(req.regex!)}`;
    return `{${matchers.join(', ')}} ${filter}`;
  }

  async match(req: LogsMatchRequest): Promise<LogsResult> {
    return this.run(this.matchQuery(req), req.window, req.limit, req.clock_window);
  }

  async query(req: LogsQueryRequest): Promise<LogsResult> {
    if (req.dialect !== 'logql') {
      throw new DatasourceError(this.config.id, `Loki 只接受 logql，收到 ${req.dialect}`);
    }
    return this.run(req.query, req.window, req.limit, req.clock_window);
  }

  /**
   * LogQL 指标查询的区间查询（/loki/api/v1/query_range 返回 matrix）。结果的形状与 metrics/v1 的区间查询相同：
   * times 为 unix 毫秒，序列按标签排序后截断，结果与后端返回的顺序无关
   */
  async metricRange(req: LokiMetricRangeRequest): Promise<MetricsQueryResult> {
    assertWindowInClock(req.window, req.clock_window);
    const body = await this.http.json<LokiMatrix>('GET', '/loki/api/v1/query_range', {
      query: new URLSearchParams({
        query: req.query,
        start: nanos(req.window.from),
        end: nanos(req.window.to),
        step: `${req.step_seconds}s`,
      }),
      timeoutMs: req.timeout_ms,
    });
    if (body.data.resultType !== 'matrix') {
      throw new DatasourceError(this.config.id, `LogQL 指标区间查询必须返回 matrix，收到 ${body.data.resultType}`);
    }
    const series: MetricSeries[] = body.data.result.map((s) => ({
      labels: s.metric,
      times: s.values.map(([t]) => Math.round(t * 1000)),
      values: s.values.map(([, v]) => Number(v)),
    }));
    const key = (s: MetricSeries) => JSON.stringify(Object.entries(s.labels).sort());
    series.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const truncated = series.length > req.max_series;
    return { series: truncated ? series.slice(0, req.max_series) : series, truncated, warnings: [] };
  }

  async labelNames(window: TimeWindow, clock: TimeWindow): Promise<string[]> {
    assertWindowInClock(window, clock);
    const body = await this.http.json<{ data: string[] }>('GET', '/loki/api/v1/labels', {
      query: new URLSearchParams({ start: nanos(window.from), end: nanos(window.to) }),
      timeoutMs: 15_000,
    });
    return body.data ?? [];
  }

  private async run(query: string, window: TimeWindow, limit: number, clock: TimeWindow): Promise<LogsResult> {
    assertWindowInClock(window, clock);
    const body = await this.http.json<LokiStreams>('GET', '/loki/api/v1/query_range', {
      query: new URLSearchParams({
        query,
        start: nanos(window.from),
        // Loki 的 end 不含端点
        end: `${BigInt(toMillis(window.to)) * 1_000_000n + 1n}`,
        limit: String(limit + 1),
        direction: 'backward',
      }),
      timeoutMs: this.config.timeout_ms ?? 30_000,
    });
    if (body.data.resultType !== 'streams') {
      throw new DatasourceError(this.config.id, `logs 查询必须返回日志流，收到 ${body.data.resultType}`);
    }
    const lines: LogLine[] = body.data.result.flatMap((s) =>
      s.values.map(([ts, line]) => ({
        time: new Date(Number(BigInt(ts) / 1_000_000n)).toISOString(),
        labels: s.stream,
        line: line.length > 8192 ? line.slice(0, 8192) : line,
      })),
    );
    // 新的在前；时间相同时按内容排序，结果与后端返回顺序无关
    lines.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
    const truncated = lines.length > limit;
    return { lines: truncated ? lines.slice(0, limit) : lines, truncated };
  }
}
