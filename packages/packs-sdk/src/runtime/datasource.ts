// 证据卡读取数据的接口。研判、阶段 A、pack test 与回放都通过它取数：
// LiveDataSource 直接调用集成适配器；RecordingDataSource 在取数的同时录制查询邻域；
// ReplayDataSource 只从录制的快照读取（VCR），快照里没有的请求返回"快照未命中"。

import type {
  LabelProfile,
  LogsMatchRequest,
  LogsQueryRequest,
  LogsResult,
  MetricsQueryRangeRequest,
  MetricsQueryRequest,
  MetricsQueryResult,
  TimeWindow,
  TracesSearchRequest,
  TracesSearchResult,
} from '@srenautix/contract';
import type { LokiAdapter, PrometheusApiAdapter, TempoAdapter } from '@srenautix/integration-sdk';

export type Capability =
  | 'metrics.query'
  | 'metrics.query_range'
  | 'metrics.series'
  | 'logs.match'
  | 'logs.query'
  | 'traces.search';

export interface LogsLabelProfile {
  namespace: string;
  pod: string;
  container: string;
  cluster: string | null;
}

export interface EvidenceDataSource {
  /** 集成实例 id，写进每条查询记录 */
  readonly ids: { metrics: string | null; logs: string | null; traces: string | null };
  readonly capabilities: ReadonlySet<Capability>;
  readonly metricsDialects: ReadonlySet<'promql' | 'metricsql'>;
  readonly labelProfile: LabelProfile | null;
  readonly logsProfile: LogsLabelProfile | null;
  query(req: MetricsQueryRequest): Promise<MetricsQueryResult>;
  queryRange(req: MetricsQueryRangeRequest): Promise<MetricsQueryResult>;
  /** 指标名在区间内是否有序列（信号备选的探测） */
  metricExists(name: string, window: TimeWindow, clock: TimeWindow): Promise<boolean>;
  logsMatch(req: LogsMatchRequest): Promise<LogsResult>;
  logsQuery(req: LogsQueryRequest): Promise<LogsResult>;
  tracesSearch(req: TracesSearchRequest): Promise<TracesSearchResult>;
}

export class CapabilityMissing extends Error {
  constructor(readonly capability: Capability) {
    super(`能力 ${capability} 不可用`);
    this.name = 'CapabilityMissing';
  }
}

export interface LiveSources {
  metrics?: { adapter: PrometheusApiAdapter; profile: LabelProfile };
  logs?: { adapter: LokiAdapter; profile: LogsLabelProfile };
  traces?: { adapter: TempoAdapter };
  /** 已通过 verify() 的能力；不填时按提供的适配器推断 */
  capabilities?: Capability[];
}

export class LiveDataSource implements EvidenceDataSource {
  readonly ids;
  readonly capabilities: ReadonlySet<Capability>;
  readonly metricsDialects: ReadonlySet<'promql' | 'metricsql'>;
  readonly labelProfile: LabelProfile | null;
  readonly logsProfile: LogsLabelProfile | null;

  constructor(private readonly s: LiveSources) {
    this.ids = {
      metrics: s.metrics?.adapter.config.id ?? null,
      logs: s.logs?.adapter.config.id ?? null,
      traces: s.traces?.adapter.config.id ?? null,
    };
    const inferred: Capability[] = [
      ...(s.metrics ? (['metrics.query', 'metrics.query_range', 'metrics.series'] as const) : []),
      ...(s.logs ? (['logs.match', 'logs.query'] as const) : []),
      ...(s.traces ? (['traces.search'] as const) : []),
    ];
    this.capabilities = new Set(s.capabilities ?? inferred);
    this.metricsDialects = new Set(s.metrics?.adapter.config.dialects ?? []);
    this.labelProfile = s.metrics?.profile ?? null;
    this.logsProfile = s.logs?.profile ?? null;
  }

  private need(c: Capability): void {
    if (!this.capabilities.has(c)) {
      throw new CapabilityMissing(c);
    }
  }

  query(req: MetricsQueryRequest) {
    this.need('metrics.query');
    return this.s.metrics!.adapter.query(req);
  }
  queryRange(req: MetricsQueryRangeRequest) {
    this.need('metrics.query_range');
    return this.s.metrics!.adapter.queryRange(req);
  }
  async metricExists(name: string, window: TimeWindow, clock: TimeWindow) {
    this.need('metrics.series');
    const r = await this.s.metrics!.adapter.series({ match: [`{__name__=${JSON.stringify(name)}}`], window, limit: 1 }, clock);
    return r.series.length > 0;
  }
  logsMatch(req: LogsMatchRequest) {
    this.need('logs.match');
    return this.s.logs!.adapter.match(req);
  }
  logsQuery(req: LogsQueryRequest) {
    this.need('logs.query');
    return this.s.logs!.adapter.query(req);
  }
  tracesSearch(req: TracesSearchRequest) {
    this.need('traces.search');
    return this.s.traces!.adapter.search(req);
  }
}
