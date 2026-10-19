// metrics/v1 的核心级适配器：Prometheus HTTP API（在 Prometheus 与 VictoriaMetrics 上测试）。
// 每个请求先检查回放时钟窗口（含查询的回看范围），再发出。

import type {
  MetricSeries,
  MetricsQueryRangeRequest,
  MetricsQueryRequest,
  MetricsQueryResult,
  MetricsRulesResult,
  MetricsSeriesRequest,
  MetricsSeriesResult,
  TimeWindow,
} from '@srenautix/contract';
import { assertInstantInClock, assertLookbackInClock, assertWindowInClock, toMillis } from '../clock.js';
import { ClockWindowViolation, DatasourceError } from '../errors.js';
import { HttpClient, type HttpAuthConfig } from '../http.js';
import { loadPromqlEngine, type Dialect, type PromqlEngine } from '../promql/engine.js';

export interface PrometheusApiConfig extends HttpAuthConfig {
  /** 实例 id，用于报错与记录 */
  id: string;
  url: string;
  /** 后端接受的查询方言；VictoriaMetrics 也接受 promql */
  dialects: Dialect[];
}

type ApiValue = [number, string];

interface ApiResponse<T> {
  status: 'success' | 'error';
  data: T;
  errorType?: string;
  error?: string;
  warnings?: string[];
}

function parseSample(v: string): number {
  switch (v) {
    case 'NaN':
      return Number.NaN;
    case '+Inf':
      return Infinity;
    case '-Inf':
      return -Infinity;
    default: {
      const n = Number(v);
      if (Number.isNaN(n)) {
        throw new TypeError(`样本值不是数字：${v}`);
      }
      return n;
    }
  }
}

const unixSeconds = (ts: string) => (toMillis(ts) / 1000).toFixed(3);

export class PrometheusApiAdapter {
  private readonly http: HttpClient;
  private engine: PromqlEngine | undefined;

  constructor(readonly config: PrometheusApiConfig) {
    this.http = new HttpClient(config.id, config.url, config);
  }

  private async promql(): Promise<PromqlEngine> {
    this.engine ??= await loadPromqlEngine();
    return this.engine;
  }

  private async call<T>(
    path: string,
    params: URLSearchParams,
    timeoutMs: number,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<ApiResponse<T>> {
    const r = await this.http.request(
      method,
      path,
      method === 'GET' ? { query: params, timeoutMs } : { form: params, timeoutMs },
    );
    let body: ApiResponse<T>;
    try {
      body = JSON.parse(r.text) as ApiResponse<T>;
    } catch {
      throw new DatasourceError(this.config.id, `${path} 返回 HTTP ${r.status}：${r.text.slice(0, 500)}`);
    }
    if (r.status < 200 || r.status >= 300 || body.status !== 'success') {
      throw new DatasourceError(
        this.config.id,
        `${path} 返回 HTTP ${r.status}：${body.errorType ?? ''} ${body.error ?? r.text.slice(0, 500)}`,
      );
    }
    return body;
  }

  private async checkQuery(expr: string, dialect: Dialect, evalFromMs: number, evalToMs: number, clock: TimeWindow) {
    if (!this.config.dialects.includes(dialect)) {
      throw new DatasourceError(this.config.id, `后端不接受 ${dialect} 方言`);
    }
    const a = (await this.promql()).analyze(expr, dialect);
    if (a.has_at) {
      throw new ClockWindowViolation(`查询使用了 @ 修饰符：${expr}`);
    }
    assertLookbackInClock(evalFromMs, a.lookback_ms, clock);
    if (evalToMs + a.lookahead_ms > toMillis(clock.to)) {
      throw new ClockWindowViolation(`查询的负 offset 读取到时钟窗口终点之后：${expr}`);
    }
  }

  async query(req: MetricsQueryRequest): Promise<MetricsQueryResult> {
    assertInstantInClock(req.time, req.clock_window);
    const t = toMillis(req.time);
    await this.checkQuery(req.expr, req.dialect, t, t, req.clock_window);
    const body = await this.call<{ resultType: string; result: unknown }>(
      '/api/v1/query',
      new URLSearchParams({ query: req.expr, time: unixSeconds(req.time), timeout: `${req.timeout_ms}ms` }),
      req.timeout_ms + 1000,
    );
    return { series: this.toSeries(body.data), truncated: false, warnings: body.warnings ?? [] };
  }

  async queryRange(req: MetricsQueryRangeRequest): Promise<MetricsQueryResult> {
    assertWindowInClock(req.window, req.clock_window);
    await this.checkQuery(req.expr, req.dialect, toMillis(req.window.from), toMillis(req.window.to), req.clock_window);
    const body = await this.call<{ resultType: string; result: unknown }>(
      '/api/v1/query_range',
      new URLSearchParams({
        query: req.expr,
        start: unixSeconds(req.window.from),
        end: unixSeconds(req.window.to),
        step: `${req.step_seconds}s`,
        timeout: `${req.timeout_ms}ms`,
      }),
      req.timeout_ms + 1000,
    );
    const series = this.toSeries(body.data);
    // 后端按标签排序返回的顺序不同；先按标签排序再截断，结果与后端无关
    series.sort((a, b) => {
      const ka = JSON.stringify(Object.entries(a.labels).sort());
      const kb = JSON.stringify(Object.entries(b.labels).sort());
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const truncated = series.length > req.max_series;
    return { series: truncated ? series.slice(0, req.max_series) : series, truncated, warnings: body.warnings ?? [] };
  }

  async series(req: MetricsSeriesRequest, clock: TimeWindow): Promise<MetricsSeriesResult> {
    assertWindowInClock(req.window, clock);
    const params = new URLSearchParams({
      start: unixSeconds(req.window.from),
      end: unixSeconds(req.window.to),
      limit: String(req.limit + 1),
    });
    req.match.forEach((m) => params.append('match[]', m));
    const body = await this.call<Array<Record<string, string>>>('/api/v1/series', params, 30_000);
    const truncated = body.data.length > req.limit;
    return { series: truncated ? body.data.slice(0, req.limit) : body.data, truncated };
  }

  /** 区间内出现过的标签名 */
  async labelNames(window: TimeWindow, clock: TimeWindow, match: string[] = []): Promise<string[]> {
    assertWindowInClock(window, clock);
    const params = new URLSearchParams({ start: unixSeconds(window.from), end: unixSeconds(window.to) });
    match.forEach((m) => params.append('match[]', m));
    return (await this.call<string[]>('/api/v1/labels', params, 30_000)).data;
  }

  /** 区间内某个标签出现过的值；__name__ 即指标名 */
  async labelValues(name: string, window: TimeWindow, clock: TimeWindow, match: string[] = []): Promise<string[]> {
    assertWindowInClock(window, clock);
    const params = new URLSearchParams({ start: unixSeconds(window.from), end: unixSeconds(window.to) });
    match.forEach((m) => params.append('match[]', m));
    // 标签值接口只接受 GET
    return (await this.call<string[]>(`/api/v1/label/${encodeURIComponent(name)}/values`, params, 30_000, 'GET')).data;
  }

  async rules(): Promise<MetricsRulesResult> {
    const body = await this.call<{
      groups: Array<{
        name: string;
        rules: Array<{
          type: string;
          name: string;
          query: string;
          duration?: number;
          labels?: Record<string, string>;
          annotations?: Record<string, string>;
        }>;
      }>;
    }>('/api/v1/rules', new URLSearchParams({ type: 'alert' }), 30_000, 'GET');
    return {
      rules: body.data.groups.flatMap((g) =>
        g.rules
          .filter((r) => r.type === 'alerting')
          .map((r) => ({
            group: g.name,
            name: r.name,
            expr: r.query,
            for: r.duration ? `${r.duration}s` : null,
            labels: r.labels ?? {},
            annotations: r.annotations ?? {},
          })),
      ),
    };
  }

  private toSeries(data: { resultType: string; result: unknown }): MetricSeries[] {
    switch (data.resultType) {
      case 'matrix':
        return (data.result as Array<{ metric: Record<string, string>; values: ApiValue[] }>).map((s) => ({
          labels: s.metric,
          times: s.values.map((v) => Math.round(v[0] * 1000)),
          values: s.values.map((v) => parseSample(v[1])),
        }));
      case 'vector':
        return (data.result as Array<{ metric: Record<string, string>; value: ApiValue }>).map((s) => ({
          labels: s.metric,
          times: [Math.round(s.value[0] * 1000)],
          values: [parseSample(s.value[1])],
        }));
      case 'scalar': {
        const v = data.result as ApiValue;
        return [{ labels: {}, times: [Math.round(v[0] * 1000)], values: [parseSample(v[1])] }];
      }
      default:
        throw new DatasourceError(this.config.id, `不支持的结果类型 ${data.resultType}`);
    }
  }
}
