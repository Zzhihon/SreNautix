// 查询邻域快照（DESIGN §14.2 snapshot 模式）：录制每个请求与它的结果，回放时只从快照读取。
// 键是请求的规范 JSON（JCS），不含 clock_window；快照里没有的请求按"快照未命中"报错并计数。

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
import { DatasourceError } from '@srenautix/integration-sdk';
import canonicalize from 'canonicalize';
import { CapabilityMissing, type Capability, type EvidenceDataSource, type LogsLabelProfile } from './datasource.js';

type Op = 'query' | 'query_range' | 'metric_exists' | 'logs_match' | 'logs_query' | 'traces_search';

export interface SnapshotEntry {
  op: Op;
  request: unknown;
  result?: unknown;
  /** 录制时的错误；capability_missing 单独标出 */
  error?: { kind: 'datasource' | 'capability_missing'; message: string };
}

export interface SnapshotCase {
  /** <pack>/<chain>/<card> 或 <pack>/checks/<id> */
  card: string;
  entity: { cluster_id: string; kind: string; namespace: string | null; name: string; node?: string | null };
  /** 事件锚点 RFC 3339 */
  anchor: string;
  expect?: { verdict: 'normal' | 'abnormal' | 'undeterminable'; display_state?: string };
}

export interface QuerySnapshot {
  api_version: 'srenautix.io/query-snapshot/v1';
  snapshot_id: string;
  recorded_at: string;
  clock_window: TimeWindow;
  ids: EvidenceDataSource['ids'];
  capabilities: Capability[];
  metrics_dialects: Array<'promql' | 'metricsql'>;
  label_profile: LabelProfile | null;
  logs_profile: LogsLabelProfile | null;
  entries: SnapshotEntry[];
  cases: SnapshotCase[];
}

export class SnapshotMiss extends DatasourceError {
  constructor(op: Op, request: unknown) {
    super('snapshot', `快照未命中：${op} ${JSON.stringify(request).slice(0, 300)}`);
    this.name = 'SnapshotMiss';
  }
}

/** 去掉 clock_window 的请求：同一请求在不同的回放时钟窗口下命中同一条录制 */
function withoutClock(request: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(request as Record<string, unknown>).filter(([k]) => k !== 'clock_window'));
}

function key(op: Op, request: unknown): string {
  return `${op}\u0000${canonicalize(withoutClock(request))}`;
}

/** 包装一个数据源，录制所有请求与结果 */
export class RecordingDataSource implements EvidenceDataSource {
  readonly entries: SnapshotEntry[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly inner: EvidenceDataSource) {}

  get ids() {
    return this.inner.ids;
  }
  get capabilities() {
    return this.inner.capabilities;
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

  private async rec<T>(op: Op, request: unknown, run: () => Promise<T>): Promise<T> {
    const k = key(op, request);
    const stored = withoutClock(request);
    try {
      const result = await run();
      if (!this.seen.has(k)) {
        this.seen.add(k);
        this.entries.push({ op, request: stored, result });
      }
      return result;
    } catch (err) {
      if (!(err instanceof DatasourceError) && !(err instanceof CapabilityMissing)) {
        throw err;
      }
      if (!this.seen.has(k)) {
        this.seen.add(k);
        this.entries.push({
          op,
          request: stored,
          error: { kind: err instanceof CapabilityMissing ? 'capability_missing' : 'datasource', message: err.message },
        });
      }
      throw err;
    }
  }

  query(req: MetricsQueryRequest) {
    return this.rec('query', req, () => this.inner.query(req));
  }
  queryRange(req: MetricsQueryRangeRequest) {
    return this.rec('query_range', req, () => this.inner.queryRange(req));
  }
  metricExists(name: string, window: TimeWindow, clock: TimeWindow) {
    return this.rec('metric_exists', { name, window }, () => this.inner.metricExists(name, window, clock));
  }
  logsMatch(req: LogsMatchRequest) {
    return this.rec('logs_match', req, () => this.inner.logsMatch(req));
  }
  logsQuery(req: LogsQueryRequest) {
    return this.rec('logs_query', req, () => this.inner.logsQuery(req));
  }
  tracesSearch(req: TracesSearchRequest) {
    return this.rec('traces_search', req, () => this.inner.tracesSearch(req));
  }

  snapshot(clock: TimeWindow, cases: SnapshotCase[]): QuerySnapshot {
    return {
      api_version: 'srenautix.io/query-snapshot/v1',
      snapshot_id: randomUUID(),
      recorded_at: new Date().toISOString(),
      clock_window: clock,
      ids: this.ids,
      capabilities: [...this.capabilities].sort(),
      metrics_dialects: [...this.metricsDialects].sort(),
      label_profile: this.labelProfile,
      logs_profile: this.logsProfile,
      entries: this.entries,
      cases,
    };
  }
}

/** 只从快照读取的数据源 */
export class ReplayDataSource implements EvidenceDataSource {
  readonly ids;
  readonly capabilities: ReadonlySet<Capability>;
  readonly metricsDialects: ReadonlySet<'promql' | 'metricsql'>;
  readonly labelProfile: LabelProfile | null;
  readonly logsProfile: LogsLabelProfile | null;
  private readonly byKey = new Map<string, SnapshotEntry>();
  hits = 0;
  misses = 0;

  constructor(readonly snap: QuerySnapshot) {
    if (snap.api_version !== 'srenautix.io/query-snapshot/v1') {
      throw new TypeError(`不支持的快照版本 ${String(snap.api_version)}`);
    }
    this.ids = snap.ids;
    this.capabilities = new Set(snap.capabilities);
    this.metricsDialects = new Set(snap.metrics_dialects);
    this.labelProfile = snap.label_profile;
    this.logsProfile = snap.logs_profile;
    for (const e of snap.entries) {
      this.byKey.set(key(e.op, e.request), e);
    }
  }

  static fromFile(path: string): ReplayDataSource {
    return new ReplayDataSource(JSON.parse(readFileSync(path, 'utf8')) as QuerySnapshot);
  }

  /** 快照未命中率 */
  missRate(): number {
    const n = this.hits + this.misses;
    return n === 0 ? 0 : this.misses / n;
  }

  private get<T>(op: Op, request: unknown, capability: Capability): T {
    if (!this.capabilities.has(capability)) {
      throw new CapabilityMissing(capability);
    }
    const e = this.byKey.get(key(op, request));
    if (!e) {
      this.misses++;
      throw new SnapshotMiss(op, request);
    }
    this.hits++;
    if (e.error) {
      if (e.error.kind === 'capability_missing') {
        throw new CapabilityMissing(capability);
      }
      throw new DatasourceError(this.ids.metrics ?? 'snapshot', e.error.message);
    }
    return structuredClone(e.result) as T;
  }

  async query(req: MetricsQueryRequest) {
    return this.get<MetricsQueryResult>('query', req, 'metrics.query');
  }
  async queryRange(req: MetricsQueryRangeRequest) {
    return this.get<MetricsQueryResult>('query_range', req, 'metrics.query_range');
  }
  async metricExists(name: string, window: TimeWindow, _clock: TimeWindow) {
    return this.get<boolean>('metric_exists', { name, window }, 'metrics.series');
  }
  async logsMatch(req: LogsMatchRequest) {
    return this.get<LogsResult>('logs_match', req, 'logs.match');
  }
  async logsQuery(req: LogsQueryRequest) {
    return this.get<LogsResult>('logs_query', req, 'logs.query');
  }
  async tracesSearch(req: TracesSearchRequest) {
    return this.get<TracesSearchResult>('traces_search', req, 'traces.search');
  }
}

export function writeSnapshot(path: string, snap: QuerySnapshot): void {
  writeFileSync(path, JSON.stringify(snap, null, 1) + '\n');
}
