// traces/v1 的核心级适配器：Tempo。traces.search 执行 TraceQL；traces.trace 读取单条链路；
// traces.service_graph 读取 metrics-generator 写入指标库的服务图指标。

import type {
  ServiceGraph,
  TimeWindow,
  Trace,
  TraceHit,
  TracesSearchRequest,
  TracesSearchResult,
} from '@srenautix/contract';
import { assertWindowInClock, toIso, toMillis } from '../clock.js';
import { DatasourceError } from '../errors.js';
import { HttpClient, type HttpAuthConfig } from '../http.js';
import type { PrometheusApiAdapter } from '../metrics/prometheus-api.js';

export interface TempoConfig extends HttpAuthConfig {
  id: string;
  url: string;
}

type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean };
type OtlpAttr = { key: string; value: OtlpValue };

function attrValue(v: OtlpValue): string {
  if (v.stringValue !== undefined) {
    return v.stringValue;
  }
  if (v.intValue !== undefined) {
    return String(v.intValue);
  }
  if (v.doubleValue !== undefined) {
    return String(v.doubleValue);
  }
  if (v.boolValue !== undefined) {
    return String(v.boolValue);
  }
  return '';
}

interface SearchResponse {
  traces?: Array<{
    traceID: string;
    rootServiceName?: string;
    rootTraceName?: string;
    startTimeUnixNano: string;
    durationMs?: number;
    spanSets?: Array<{ spans?: Array<{ attributes?: OtlpAttr[] }> }>;
    spanSet?: { spans?: Array<{ attributes?: OtlpAttr[] }> };
  }>;
}

const seconds = (ts: string) => String(Math.floor(toMillis(ts) / 1000));

export class TempoAdapter {
  private readonly http: HttpClient;

  constructor(readonly config: TempoConfig) {
    this.http = new HttpClient(config.id, config.url, config);
  }

  async search(req: TracesSearchRequest): Promise<TracesSearchResult> {
    if (req.dialect !== 'traceql') {
      throw new DatasourceError(this.config.id, `Tempo 只接受 traceql，收到 ${req.dialect}`);
    }
    assertWindowInClock(req.window, req.clock_window);
    const body = await this.http.json<SearchResponse>('GET', '/api/search', {
      query: new URLSearchParams({
        q: req.query,
        start: seconds(req.window.from),
        // Tempo 的 end 精度为秒，向上取整以包含端点
        end: String(Math.ceil(toMillis(req.window.to) / 1000)),
        limit: String(req.limit + 1),
      }),
      timeoutMs: 30_000,
    });
    const hits: TraceHit[] = (body.traces ?? [])
      .map((t) => {
        const sets = t.spanSets ?? (t.spanSet ? [t.spanSet] : []);
        const attrs = sets[0]?.spans?.[0]?.attributes ?? [];
        return {
          // Tempo 返回的 traceID 去掉了前导零
          trace_id: t.traceID.toLowerCase().padStart(32, '0'),
          root_service: t.rootServiceName ?? '',
          root_name: t.rootTraceName ?? '',
          start: new Date(Number(BigInt(t.startTimeUnixNano) / 1_000_000n)).toISOString(),
          duration_ms: t.durationMs ?? 0,
          attributes: Object.fromEntries(attrs.map((a) => [a.key, attrValue(a.value)])),
        };
      })
      // 窗口外的命中（Tempo 按块粒度过滤）不返回
      .filter((h) => toMillis(h.start) >= toMillis(req.window.from) && toMillis(h.start) <= toMillis(req.window.to))
      .sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : a.trace_id < b.trace_id ? -1 : 1));
    const truncated = hits.length > req.limit;
    return { hits: truncated ? hits.slice(0, req.limit) : hits, truncated };
  }

  async trace(traceId: string, maxSpans: number): Promise<Trace> {
    if (!/^[0-9a-fA-F]{1,32}$/.test(traceId)) {
      throw new TypeError(`trace id 格式不对：${traceId}`);
    }
    const body = await this.http.json<{
      trace?: {
        resourceSpans?: Array<{
          resource?: { attributes?: OtlpAttr[] };
          scopeSpans?: Array<{
            spans?: Array<{
              spanId: string;
              parentSpanId?: string;
              name: string;
              startTimeUnixNano: string;
              endTimeUnixNano: string;
              status?: { code?: string | number };
              attributes?: OtlpAttr[];
            }>;
          }>;
        }>;
      };
    }>('GET', `/api/v2/traces/${traceId}`, { timeoutMs: 30_000 });
    const spans = (body.trace?.resourceSpans ?? []).flatMap((rs) => {
      const service = attrValue(rs.resource?.attributes?.find((a) => a.key === 'service.name')?.value ?? {});
      return (rs.scopeSpans ?? []).flatMap((ss) =>
        (ss.spans ?? []).map((s) => {
          const start = BigInt(s.startTimeUnixNano);
          const code = s.status?.code;
          return {
            span_id: Buffer.from(s.spanId, 'base64').toString('hex'),
            parent_span_id: s.parentSpanId ? Buffer.from(s.parentSpanId, 'base64').toString('hex') : null,
            service,
            name: s.name,
            start: new Date(Number(start / 1_000_000n)).toISOString(),
            duration_ms: Number(BigInt(s.endTimeUnixNano) - start) / 1e6,
            status:
              code === 2 || code === 'STATUS_CODE_ERROR'
                ? 'error'
                : code === 1 || code === 'STATUS_CODE_OK'
                  ? 'ok'
                  : 'unset',
            attributes: Object.fromEntries((s.attributes ?? []).map((a) => [a.key, attrValue(a.value)])),
          };
        }),
      );
    });
    spans.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const truncated = spans.length > maxSpans;
    return {
      trace_id: traceId.toLowerCase().padStart(32, '0'),
      spans: truncated ? spans.slice(0, maxSpans) : spans,
      truncated,
    } as Trace;
  }

  /** 服务图：Tempo metrics-generator 写入的 traces_service_graph_request_total 与 *_failed_total */
  async serviceGraph(metrics: PrometheusApiAdapter, window: TimeWindow, clock: TimeWindow): Promise<ServiceGraph> {
    assertWindowInClock(window, clock);
    const range = `${Math.max(60, Math.round((toMillis(window.to) - toMillis(window.from)) / 1000))}s`;
    const q = async (expr: string) =>
      metrics.query({ expr, dialect: 'promql', time: window.to, clock_window: clock, timeout_ms: 15_000 });
    const req = await q(`sum by (client, server) (increase(traces_service_graph_request_total[${range}]))`);
    const failed = await q(`sum by (client, server) (increase(traces_service_graph_request_failed_total[${range}]))`);
    const last = await q(`max by (client, server) (timestamp(traces_service_graph_request_total))`);
    const key = (l: Record<string, string | undefined>) => `${l['client']}\u0000${l['server']}`;
    const errors = new Map(failed.series.map((s) => [key(s.labels), s.values[0] ?? 0]));
    const seen = new Map(last.series.map((s) => [key(s.labels), s.values[0] ?? null]));
    return {
      window,
      edges: req.series
        .filter((s) => (s.values[0] ?? 0) > 0)
        .map((s) => {
          const ts = seen.get(key(s.labels));
          return {
            client: s.labels['client'] ?? '',
            server: s.labels['server'] ?? '',
            requests: s.values[0] ?? 0,
            errors: errors.get(key(s.labels)) ?? 0,
            last_seen: toIso(ts === null || ts === undefined ? toMillis(window.to) : ts * 1000),
          };
        })
        .sort((a, b) => (a.client + a.server < b.client + b.server ? -1 : 1)),
    };
  }
}
