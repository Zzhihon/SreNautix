// dbstats 信号（契约 2.28.0，ADR 0146 §3.3）：数据库统计视图的读取、两次采样与序列化。
// - 信号的备选写操作名与参数，SQL 在适配器里；参数中的 $params.<名字> 在执行时换成卡片参数，按操作的 schema 校验；
// - 结果的每一行是一条序列：标签为行的字符串与布尔列，取值为 column 列；rate 为 true 时取值为两次采样的差值除以间隔秒数；
// - 累计计数器需要两次采样：DbstatsSampler 保存同一实体与请求的第一次采样，相隔不少于 300 秒之后的读取才有速率。

import type { DbstatsRequest, DbstatsSample, SignalAlternative } from '@srenautix/contract';
import { assertValid } from '@srenautix/contract';
import { DatasourceError, toIso, toMillis } from '@srenautix/integration-sdk';
import canonicalize from 'canonicalize';
import type { MetricSeries } from '../judge/data.js';
import type { RenderEntity } from '../signals/render.js';
import { RenderError } from '../signals/render.js';

export type DbstatsOperation = DbstatsSample['op'];

export type DbstatsCapability =
  | 'dbstats.statements_top'
  | 'dbstats.statements_text'
  | 'dbstats.tables_top'
  | 'dbstats.indexes_usage'
  | 'dbstats.settings_get'
  | 'dbstats.activity_summary'
  | 'dbstats.locks_summary';

/** 操作对应的能力名：dbstats.<操作名中的 . 换成 _> */
export function dbstatsCapability(op: DbstatsOperation): DbstatsCapability {
  return `dbstats.${op.replace('.', '_')}` as DbstatsCapability;
}

export const DBSTATS_OPERATIONS: readonly DbstatsOperation[] = [
  'statements.top',
  'statements.text',
  'tables.top',
  'indexes.usage',
  'settings.get',
  'activity.summary',
  'locks.summary',
];

/** 信号可用的操作（statements.text 返回语句文本，只经工具 pg_statement_text 读取） */
export const DBSTATS_SIGNAL_OPERATIONS: readonly DbstatsOperation[] = DBSTATS_OPERATIONS.filter(
  (o) => o !== 'statements.text',
);

/**
 * 每个操作的行身份列：两次采样按它们配对；它们与其余字符串、布尔列一起成为序列标签。
 * 时间戳列（last_autovacuum 等）每次采样都可能变化，不作为标签
 */
const IDENTITY: Record<DbstatsOperation, string[]> = {
  'statements.top': ['queryid', 'database', 'role', 'toplevel'],
  'statements.text': ['queryid'],
  'tables.top': ['schema', 'table'],
  'indexes.usage': ['schema', 'table', 'index'],
  'settings.get': ['name'],
  'activity.summary': ['state', 'wait_event_type', 'wait_event'],
  'locks.summary': ['locktype', 'mode', 'granted'],
};

/** 不作为标签的字符串列 */
const NOT_LABELS = new Set(['last_autovacuum', 'last_autoanalyze', 'setting', 'min_val', 'max_val']);

/** 每个操作可以作为序列取值的列 */
export const DBSTATS_COLUMNS: Record<DbstatsOperation, readonly string[]> = {
  'statements.top': [
    'calls',
    'total_exec_time_ms',
    'mean_exec_time_ms',
    'rows',
    'shared_blks_hit',
    'shared_blks_read',
    'temp_blks_written',
    'blk_read_time_ms',
    'wal_bytes',
  ],
  'statements.text': [],
  'tables.top': [
    'chunks',
    'seq_scan',
    'seq_tup_read',
    'idx_scan',
    'idx_tup_fetch',
    'n_tup_ins',
    'n_tup_upd',
    'n_tup_del',
    'n_tup_hot_upd',
    'n_live_tup',
    'n_dead_tup',
    'heap_blks_read',
    'heap_blks_hit',
    'idx_blks_read',
    'idx_blks_hit',
  ],
  'indexes.usage': ['idx_scan', 'idx_tup_read', 'idx_tup_fetch', 'size_bytes'],
  // setting 是文本，数值参数按数字解析（带单位的取值按 pg_settings 的 unit 原样计数）
  'settings.get': ['setting'],
  'activity.summary': ['count'],
  'locks.summary': ['count'],
};

/** 一次读取的两次采样：current 为最近一次，previous 为相隔不少于最小间隔的前一次（没有时为 null） */
export interface DbstatsSamples {
  current: DbstatsSample;
  previous: DbstatsSample | null;
}

/** 读取一次统计：真实适配器或夹具 */
export interface DbstatsReader {
  read(entity: RenderEntity, req: DbstatsRequest): Promise<DbstatsSample>;
}

/** 第二次采样还没有到最小间隔：速率引用为缺数据 */
export class DbstatsNotReady extends DatasourceError {
  constructor(integration: string, detail: string) {
    super(integration, detail);
    this.name = 'DbstatsNotReady';
  }
}

export interface DbstatsSamplerOptions {
  /** 两次采样的最小间隔，默认 300 秒（ADR 0146 §3.3） */
  minIntervalMs?: number;
  /** 不需要速率的读取在这个时间内复用上一次采样，默认 60 秒 */
  reuseMs?: number;
  now?: () => number;
}

function requestKey(entity: RenderEntity, req: DbstatsRequest): string {
  return canonicalize({
    entity: { cluster_id: entity.cluster_id, kind: entity.kind, namespace: entity.namespace, name: entity.name },
    req,
  })!;
}

/**
 * 两次采样（ADR 0146 §3.3）：同一实体与请求的第一次读取保存下来；需要速率时，与第一次相隔不少于 minIntervalMs 的读取
 * 再采样一次，之后一直用这两次采样。不需要速率的读取在 reuseMs 内复用最近一次采样。一个运行用一个实例
 */
export class DbstatsSampler {
  private readonly samples = new Map<string, DbstatsSample[]>();
  private readonly minIntervalMs: number;
  private readonly reuseMs: number;
  private readonly now: () => number;
  /** 实际发给后端的读取次数 */
  reads = 0;

  constructor(
    readonly id: string,
    private readonly reader: DbstatsReader,
    opts: DbstatsSamplerOptions = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? 300_000;
    this.reuseMs = opts.reuseMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  private async take(key: string, entity: RenderEntity, req: DbstatsRequest): Promise<DbstatsSample> {
    this.reads++;
    const s = await this.reader.read(entity, req);
    const list = this.samples.get(key) ?? [];
    list.push(s);
    this.samples.set(key, list.slice(-2));
    return s;
  }

  /** 先取第一次采样（运行开始时调用，最小间隔之后的读取才有速率） */
  async prime(entity: RenderEntity, req: DbstatsRequest): Promise<void> {
    const key = requestKey(entity, req);
    if (!this.samples.has(key)) {
      await this.take(key, entity, req);
    }
  }

  async sample(entity: RenderEntity, req: DbstatsRequest, rate: boolean): Promise<DbstatsSamples> {
    const key = requestKey(entity, req);
    const list = this.samples.get(key) ?? [];
    const age = (s: DbstatsSample) => this.now() - toMillis(s.sampled_at);
    if (!rate) {
      const last = list[list.length - 1];
      const current = last && age(last) < this.reuseMs ? last : await this.take(key, entity, req);
      return { current, previous: null };
    }
    if (list.length === 2) {
      return { current: list[1]!, previous: list[0]! };
    }
    if (list.length === 0) {
      const first = await this.take(key, entity, req);
      return { current: first, previous: null };
    }
    if (age(list[0]!) < this.minIntervalMs) {
      return { current: list[0]!, previous: null };
    }
    const second = await this.take(key, entity, req);
    return { current: second, previous: list[0]! };
  }
}

/** 信号备选渲染成 dbstats 请求：$params.<名字> 换成参数值，按操作的 schema 校验 */
export function renderDbstats(
  alt: SignalAlternative,
  params: Record<string, number | string | boolean>,
): DbstatsRequest {
  const param = (v: unknown): unknown => {
    if (typeof v !== 'string') {
      return v;
    }
    const m = /^\$params\.([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(v);
    if (!m) {
      return v;
    }
    if (!(m[1]! in params)) {
      throw new RenderError(`dbstats 参数引用了未定义的 $params.${m[1]}`);
    }
    return params[m[1]!];
  };
  const args = Object.fromEntries(
    Object.entries(alt.args ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(param) : param(v)]),
  );
  const req = { op: alt.expr, args };
  try {
    return assertValid<DbstatsRequest>('integrations/dbstats/v1/dbstats.schema.json#/$defs/Request', req);
  } catch (err) {
    throw new RenderError(`dbstats 请求不符合契约：${err instanceof Error ? err.message : String(err)}`);
  }
}

function numeric(v: unknown): number | null {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function rowLabels(op: DbstatsOperation, row: DbstatsSample['rows'][number]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (NOT_LABELS.has(k) && !IDENTITY[op].includes(k)) {
      continue;
    }
    if (typeof v === 'string') {
      out[k] = v;
    } else if (typeof v === 'boolean') {
      out[k] = String(v);
    }
  }
  return out;
}

function identityOf(op: DbstatsOperation, row: DbstatsSample['rows'][number]): string {
  return JSON.stringify(IDENTITY[op].map((k) => (row[k] === undefined ? null : row[k])));
}

/**
 * 两次采样转成序列：每行一条，点在采样时刻。rate 为 true 时不含计数器回绕的行；只在第二次采样中出现的行，前一次采样
 * 没有被截断时按从 0 开始计，被截断时不计；
 * 没有前一次采样时抛出 DbstatsNotReady
 */
export function dbstatsSeries(
  integration: string,
  samples: DbstatsSamples,
  column: string,
  rate: boolean,
): MetricSeries[] {
  const { current, previous } = samples;
  const op = current.op;
  const t = toMillis(current.sampled_at);
  if (!rate) {
    return current.rows.flatMap((row) => {
      const v = numeric(row[column]);
      return v === null ? [] : [{ labels: rowLabels(op, row), times: [t], values: [v] }];
    });
  }
  if (!previous) {
    throw new DbstatsNotReady(
      integration,
      `${op} 的速率需要相隔不少于最小间隔的两次采样，第二次采样还没有到时间（第一次在 ${current.sampled_at}）`,
    );
  }
  const dt = (t - toMillis(previous.sampled_at)) / 1000;
  if (dt <= 0) {
    throw new DbstatsNotReady(integration, `${op} 的两次采样时间相同`);
  }
  const before = new Map(previous.rows.map((r) => [identityOf(op, r), r]));
  return current.rows.flatMap((row) => {
    const p = before.get(identityOf(op, row));
    const a = numeric(row[column]);
    // 前一次采样没有被截断时，不在其中的行是两次采样之间新出现的（计数从 0 开始）；被截断时无法区分，不计速率
    const b = p ? numeric(p[column]) : previous.truncated ? null : 0;
    if (a === null || b === null || a < b) {
      return [];
    }
    return [{ labels: rowLabels(op, row), times: [t], values: [(a - b) / dt] }];
  });
}

const STATEMENT_ORDER: Record<string, string> = {
  total_exec_time: 'total_exec_time_ms',
  mean_exec_time: 'mean_exec_time_ms',
  calls: 'calls',
  rows: 'rows',
  shared_blks_read: 'shared_blks_read',
  temp_blks_written: 'temp_blks_written',
  blk_read_time: 'blk_read_time_ms',
  wal_bytes: 'wal_bytes',
};

/**
 * 按适配器的语义把请求作用在一份完整的行上（夹具与录制）：过滤、排序（降序）与 limit。
 * statements.top 与 tables.top 按 order_by，indexes.usage 按 size_bytes
 */
export function applyDbstatsRequest(
  req: DbstatsRequest,
  rows: DbstatsSample['rows'],
): { rows: DbstatsSample['rows']; truncated: boolean } {
  const num = (r: DbstatsSample['rows'][number], k: string) => numeric(r[k]) ?? 0;
  const top = (list: DbstatsSample['rows'], score: (r: DbstatsSample['rows'][number]) => number, limit: number) => {
    const sorted = [...list].sort(
      (a, b) => score(b) - score(a) || identityOf(req.op, a).localeCompare(identityOf(req.op, b)),
    );
    return { rows: sorted.slice(0, limit), truncated: sorted.length > limit };
  };
  switch (req.op) {
    case 'statements.top': {
      const a = req.args;
      const list = rows.filter(
        (r) =>
          (a.database === undefined || a.database === null || r.database === a.database) &&
          (a.queryids === undefined || a.queryids.includes(String(r.queryid))),
      );
      return top(list, (r) => num(r, STATEMENT_ORDER[a.order_by]!), a.limit);
    }
    case 'statements.text':
      return { rows: rows.filter((r) => req.args.queryids.includes(String(r.queryid))), truncated: false };
    case 'tables.top': {
      const a = req.args;
      const score =
        a.order_by === 'writes'
          ? (r: DbstatsSample['rows'][number]) => num(r, 'n_tup_ins') + num(r, 'n_tup_upd') + num(r, 'n_tup_del')
          : (r: DbstatsSample['rows'][number]) => num(r, a.order_by);
      return top(rows, score, a.limit);
    }
    case 'indexes.usage': {
      const a = req.args;
      const list =
        a.table === undefined || a.table === null
          ? rows
          : rows.filter((r) => `${String(r.schema)}.${String(r.table)}` === a.table);
      return top(list, (r) => num(r, 'size_bytes'), a.limit);
    }
    case 'settings.get':
      return { rows: rows.filter((r) => req.args.names.includes(String(r.name))), truncated: false };
    case 'activity.summary':
    case 'locks.summary':
      return { rows: [...rows], truncated: false };
  }
}

/**
 * 夹具的 dbstats：每个操作若干次采样（时间为 unix 毫秒）。读取时取不晚于 at 的最近一次采样与它的前一次，
 * 请求按 applyDbstatsRequest 作用在采样的行上
 */
export class FixtureDbstats {
  constructor(
    readonly id: string,
    private readonly samples: ReadonlyMap<DbstatsOperation, Array<{ at: number; rows: DbstatsSample['rows'] }>>,
  ) {}

  get operations(): DbstatsOperation[] {
    return [...this.samples.keys()];
  }

  read(req: DbstatsRequest, at: number): DbstatsSamples {
    const list = (this.samples.get(req.op) ?? []).filter((s) => s.at <= at).sort((a, b) => a.at - b.at);
    if (!list.length) {
      throw new DatasourceError(this.id, `夹具中没有 ${req.op} 在 ${toIso(at)} 之前的采样`);
    }
    const toSample = (s: { at: number; rows: DbstatsSample['rows'] }): DbstatsSample => {
      const r = applyDbstatsRequest(req, s.rows);
      return { op: req.op, sampled_at: toIso(s.at), server_version: 'fixture', rows: r.rows, truncated: r.truncated };
    };
    const cur = list[list.length - 1]!;
    const prev = list.length > 1 ? list[list.length - 2]! : null;
    return { current: toSample(cur), previous: prev ? toSample(prev) : null };
  }
}
