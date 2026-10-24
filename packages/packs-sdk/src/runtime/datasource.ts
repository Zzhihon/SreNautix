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
import type { DbstatsRequest } from '@srenautix/contract';
import type { LokiAdapter, PrometheusApiAdapter, TempoAdapter } from '@srenautix/integration-sdk';
import type { RenderEntity } from '../signals/render.js';
import { dbstatsCapability, type DbstatsCapability, type DbstatsSampler, type DbstatsSamples } from './dbstats.js';

export type Capability =
  | 'metrics.query'
  | 'metrics.query_range'
  | 'metrics.series'
  | 'logs.match'
  | 'logs.query'
  | 'traces.search'
  | DbstatsCapability;

/** dbstats 读取的选项：at 为判定窗口的结束时刻（夹具按它选择采样）；rate 为需要两次采样的速率 */
export interface DbstatsReadOptions {
  at: number;
  rate: boolean;
}

export interface LogsLabelProfile {
  namespace: string;
  pod: string;
  container: string;
  cluster: string | null;
}

export interface EvidenceDataSource {
  /** 集成实例 id，写进每条查询记录 */
  readonly ids: { metrics: string | null; logs: string | null; traces: string | null; dbstats?: string | null };
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
  /** dbstats 信号（契约 2.28.0）：实体所在数据库的统计视图；没有 dbstats 集成的数据源不实现 */
  dbstats?(entity: RenderEntity, req: DbstatsRequest, opts: DbstatsReadOptions): Promise<DbstatsSamples>;
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
  /** dbstats：一次运行一个采样器（两次采样，ADR 0146 §3.3）；能力不填时为全部 dbstats 能力 */
  dbstats?: { sampler: DbstatsSampler; capabilities?: DbstatsCapability[] };
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
      dbstats: s.dbstats?.sampler.id ?? null,
    };
    const inferred: Capability[] = [
      ...(s.metrics ? (['metrics.query', 'metrics.query_range', 'metrics.series'] as const) : []),
      ...(s.logs ? (['logs.match', 'logs.query'] as const) : []),
      ...(s.traces ? (['traces.search'] as const) : []),
      ...(s.dbstats ? (s.dbstats.capabilities ?? ALL_DBSTATS_CAPABILITIES) : []),
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
    const r = await this.s.metrics!.adapter.series(
      { match: [`{__name__=${JSON.stringify(name)}}`], window, limit: 1 },
      clock,
    );
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
  async dbstats(entity: RenderEntity, req: DbstatsRequest, opts: DbstatsReadOptions): Promise<DbstatsSamples> {
    this.need(dbstatsCapability(req.op));
    return this.s.dbstats!.sampler.sample(entity, req, opts.rate);
  }
}

export const ALL_DBSTATS_CAPABILITIES: DbstatsCapability[] = [
  'dbstats.statements_top',
  'dbstats.statements_text',
  'dbstats.tables_top',
  'dbstats.indexes_usage',
  'dbstats.settings_get',
  'dbstats.activity_summary',
  'dbstats.locks_summary',
];

/**
 * 给一个数据源加上 dbstats（包测试的夹具、PostgreSQL 上的夹具与回放）：其余读取原样转给 inner
 */
export class DbstatsOverlay implements EvidenceDataSource {
  readonly ids: EvidenceDataSource['ids'];
  readonly capabilities: ReadonlySet<Capability>;

  constructor(
    private readonly inner: EvidenceDataSource,
    id: string,
    private readonly provider: (
      entity: RenderEntity,
      req: DbstatsRequest,
      opts: DbstatsReadOptions,
    ) => Promise<DbstatsSamples>,
    capabilities: readonly DbstatsCapability[] = ALL_DBSTATS_CAPABILITIES,
  ) {
    this.ids = { ...inner.ids, dbstats: id };
    this.capabilities = new Set([...inner.capabilities, ...capabilities]);
  }
  get metricsDialects() {
    return this.inner.metricsDialects;
  }
  get labelProfile() {
    return this.inner.labelProfile;
  }
  get logsProfile() {
    return this.inner.logsProfile;
  }
  query(req: MetricsQueryRequest) {
    return this.inner.query(req);
  }
  queryRange(req: MetricsQueryRangeRequest) {
    return this.inner.queryRange(req);
  }
  metricExists(name: string, window: TimeWindow, clock: TimeWindow) {
    return this.inner.metricExists(name, window, clock);
  }
  logsMatch(req: LogsMatchRequest) {
    return this.inner.logsMatch(req);
  }
  logsQuery(req: LogsQueryRequest) {
    return this.inner.logsQuery(req);
  }
  tracesSearch(req: TracesSearchRequest) {
    return this.inner.tracesSearch(req);
  }
  async dbstats(entity: RenderEntity, req: DbstatsRequest, opts: DbstatsReadOptions): Promise<DbstatsSamples> {
    if (!this.capabilities.has(dbstatsCapability(req.op))) {
      throw new CapabilityMissing(dbstatsCapability(req.op));
    }
    return this.provider(entity, req, opts);
  }
}
