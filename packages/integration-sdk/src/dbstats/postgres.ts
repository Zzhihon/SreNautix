// dbstats/v1 的核心级适配器：PostgreSQL（契约 2.28.0，ADR 0146 §3.3、§6.1）。
// - 操作固定，SQL 写在这里，请求只绑定参数（排序列从固定的映射里取，不拼接请求里的文本）；
// - 每个查询在单独的只读事务中执行，SET LOCAL statement_timeout 与 lock_timeout；连接池最多 1 个连接，空闲 60 秒关闭；
// - 每小时的调用上限（默认 60 次，其中语句文本 6 次），超过时不发出查询；
// - 权限自检：启动时与每小时检查一次角色能否读取任何业务表，能读取时集成不可用（DatasourceOverPrivileged）；
//   allowed_relations 声明的关系（server 的 SQL 审计表变更源经同一个角色读取的审计表或视图，ADR 0151）不算；
// - 不读取业务数据行；statements.top 用 pg_stat_statements(false)，不读取语句文本文件，语句文本只经 statements.text 读取。

import { readFileSync } from 'node:fs';
import {
  assertValid,
  type DbstatsPrivilegeReport,
  type DbstatsRequest,
  type DbstatsSample,
  type DbstatsStatementText,
} from '@srenautix/contract';
import pg from 'pg';
import { CapabilityUnavailable, DatasourceError } from '../errors.js';
import { normalizeStatement } from './normalize.js';

export interface PostgresDbstatsConfig {
  id: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  /** 口令文件（挂载的 Secret）；测试可以直接给 password */
  password_file?: string;
  password?: string;
  /** TLS：true 为校验证书的 TLS；不填为明文（集群内网络策略限定的连接） */
  ssl?: boolean | { ca_file?: string; servername?: string };
  /** 单个查询的超时，默认 3000 毫秒（与角色级 statement_timeout 相同） */
  statement_timeout_ms?: number;
  /** 每小时的调用上限，默认 60；语句文本另有 6 次的上限（ADR 0146 §6.1） */
  hourly_limit?: number;
  text_hourly_limit?: number;
  /** 连接空闲多久关闭，默认 60 秒 */
  idle_ms?: number;
  /** 权限自检的间隔，默认 1 小时 */
  privilege_check_ms?: number;
  /**
   * 权限自检不计入的关系（<schema>.<名称>）：同一个角色按声明读取的审计表或视图（ADR 0151）。只能写明确的名字，
   * 角色能读取的其他业务表照样让集成不可用
   */
  allowed_relations?: readonly string[];
  /** 每次权限自检的结果（server 据此发布状态条件 DatasourceOverPrivileged） */
  onPrivilegeReport?: (r: DbstatsPrivilegeReport) => void;
  now?: () => number;
}

/** 超过每小时的调用上限：查询没有发出 */
export class DbstatsLimitExceeded extends DatasourceError {
  constructor(integration: string, detail: string) {
    super(integration, detail);
    this.name = 'DbstatsLimitExceeded';
  }
}

const HOUR = 3600_000;

const STATEMENT_ORDER: Record<string, (blkRead: string) => string> = {
  total_exec_time: () => 's.total_exec_time',
  mean_exec_time: () => 's.mean_exec_time',
  calls: () => 's.calls',
  rows: () => 's.rows',
  shared_blks_read: () => 's.shared_blks_read',
  temp_blks_written: () => 's.temp_blks_written',
  blk_read_time: (b) => `s.${b}`,
  wal_bytes: () => 's.wal_bytes',
};

const TABLE_ORDER: Record<string, string> = {
  seq_scan: 'sum(seq_scan)',
  seq_tup_read: 'sum(seq_tup_read)',
  idx_scan: 'sum(idx_scan)',
  n_dead_tup: 'sum(n_dead_tup)',
  n_live_tup: 'sum(n_live_tup)',
  heap_blks_read: 'sum(heap_blks_read)',
  writes: 'sum(n_tup_ins + n_tup_upd + n_tup_del)',
};

/** 扩展的成员对象（pg_stat_statements 视图、Timescale 目录表等）不算业务表 */
const NOT_EXTENSION_MEMBER = (oid: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = 'pg_class'::regclass AND dep.objid = ${oid} AND dep.deptype = 'e')`;

const TABLE_BASE = `
  SELECT t.schemaname AS schema, t.relname AS tbl,
    t.seq_scan::float8 AS seq_scan, t.seq_tup_read::float8 AS seq_tup_read,
    coalesce(t.idx_scan, 0)::float8 AS idx_scan, coalesce(t.idx_tup_fetch, 0)::float8 AS idx_tup_fetch,
    t.n_tup_ins::float8 AS n_tup_ins, t.n_tup_upd::float8 AS n_tup_upd, t.n_tup_del::float8 AS n_tup_del,
    t.n_tup_hot_upd::float8 AS n_tup_hot_upd, t.n_live_tup::float8 AS n_live_tup, t.n_dead_tup::float8 AS n_dead_tup,
    coalesce(io.heap_blks_read, 0)::float8 AS heap_blks_read, coalesce(io.heap_blks_hit, 0)::float8 AS heap_blks_hit,
    coalesce(io.idx_blks_read, 0)::float8 AS idx_blks_read, coalesce(io.idx_blks_hit, 0)::float8 AS idx_blks_hit,
    t.last_autovacuum, t.last_autoanalyze
  FROM pg_stat_user_tables t JOIN pg_statio_user_tables io USING (relid)
  WHERE ${NOT_EXTENSION_MEMBER('t.relid')}`;

// Timescale：分块按 hypertable 汇总（目录表 PUBLIC 可读），hypertable 本身也计入
const TABLE_OWNER_TS = `
  SELECT b.*, coalesce(h.schema_name, b.schema) AS o_schema, coalesce(h.table_name, b.tbl) AS o_table,
    (h.id IS NOT NULL OR hs.id IS NOT NULL) AS hyper, (h.id IS NOT NULL) AS is_chunk
  FROM base b
  LEFT JOIN _timescaledb_catalog.chunk c ON c.schema_name = b.schema AND c.table_name = b.tbl
  LEFT JOIN _timescaledb_catalog.hypertable h ON h.id = c.hypertable_id
  LEFT JOIN _timescaledb_catalog.hypertable hs ON hs.schema_name = b.schema AND hs.table_name = b.tbl`;
const TABLE_OWNER_PLAIN = `
  SELECT b.*, b.schema AS o_schema, b.tbl AS o_table, false AS hyper, false AS is_chunk FROM base b`;

const tablesSql = (timescale: boolean, order: string) => `
WITH base AS (${TABLE_BASE}), owner AS (${timescale ? TABLE_OWNER_TS : TABLE_OWNER_PLAIN})
SELECT o_schema AS schema, o_table AS "table", bool_or(hyper) AS hypertable,
  (count(*) FILTER (WHERE is_chunk))::int AS chunks,
  sum(seq_scan) AS seq_scan, sum(seq_tup_read) AS seq_tup_read, sum(idx_scan) AS idx_scan,
  sum(idx_tup_fetch) AS idx_tup_fetch, sum(n_tup_ins) AS n_tup_ins, sum(n_tup_upd) AS n_tup_upd,
  sum(n_tup_del) AS n_tup_del, sum(n_tup_hot_upd) AS n_tup_hot_upd, sum(n_live_tup) AS n_live_tup,
  sum(n_dead_tup) AS n_dead_tup, sum(heap_blks_read) AS heap_blks_read, sum(heap_blks_hit) AS heap_blks_hit,
  sum(idx_blks_read) AS idx_blks_read, sum(idx_blks_hit) AS idx_blks_hit,
  max(last_autovacuum) AS last_autovacuum, max(last_autoanalyze) AS last_autoanalyze
FROM owner GROUP BY o_schema, o_table
ORDER BY ${order} DESC NULLS LAST, o_schema, o_table
LIMIT $1`;

const INDEX_BASE = `
  SELECT i.schemaname AS schema, i.relname AS tbl, i.indexrelname AS idx,
    i.idx_scan::float8 AS idx_scan, i.idx_tup_read::float8 AS idx_tup_read, i.idx_tup_fetch::float8 AS idx_tup_fetch,
    pg_relation_size(i.indexrelid)::float8 AS size_bytes, x.indisunique AS uniq, x.indisprimary AS prim
  FROM pg_stat_user_indexes i JOIN pg_index x ON x.indexrelid = i.indexrelid
  WHERE ${NOT_EXTENSION_MEMBER('i.relid')}`;
const INDEX_OWNER_TS = `
  SELECT b.*, coalesce(h.schema_name, b.schema) AS o_schema, coalesce(h.table_name, b.tbl) AS o_table,
    coalesce(ci.hypertable_index_name, b.idx) AS o_index
  FROM base b
  LEFT JOIN _timescaledb_catalog.chunk c ON c.schema_name = b.schema AND c.table_name = b.tbl
  LEFT JOIN _timescaledb_catalog.hypertable h ON h.id = c.hypertable_id
  LEFT JOIN _timescaledb_catalog.chunk_index ci ON ci.chunk_id = c.id AND ci.index_name = b.idx`;
const INDEX_OWNER_PLAIN = `
  SELECT b.*, b.schema AS o_schema, b.tbl AS o_table, b.idx AS o_index FROM base b`;

const indexesSql = (timescale: boolean) => `
WITH base AS (${INDEX_BASE}), owner AS (${timescale ? INDEX_OWNER_TS : INDEX_OWNER_PLAIN})
SELECT o_schema AS schema, o_table AS "table", o_index AS "index",
  sum(idx_scan) AS idx_scan, sum(idx_tup_read) AS idx_tup_read, sum(idx_tup_fetch) AS idx_tup_fetch,
  sum(size_bytes) AS size_bytes, bool_and(uniq) AS "unique", bool_and(prim) AS "primary"
FROM owner
WHERE $1::text IS NULL OR o_schema || '.' || o_table = $1
GROUP BY o_schema, o_table, o_index
ORDER BY sum(size_bytes) DESC, o_schema, o_table, o_index
LIMIT $2`;

const statementsTopSql = (blkRead: string, order: string) => `
SELECT s.queryid::text AS queryid, d.datname AS database, coalesce(r.rolname, s.userid::text) AS role, s.toplevel,
  s.calls::float8 AS calls, s.total_exec_time::float8 AS total_exec_time_ms, s.mean_exec_time::float8 AS mean_exec_time_ms,
  s.rows::float8 AS rows, s.shared_blks_hit::float8 AS shared_blks_hit, s.shared_blks_read::float8 AS shared_blks_read,
  s.temp_blks_written::float8 AS temp_blks_written, s.${blkRead}::float8 AS blk_read_time_ms, s.wal_bytes::float8 AS wal_bytes
FROM pg_stat_statements(false) s
JOIN pg_database d ON d.oid = s.dbid
LEFT JOIN pg_roles r ON r.oid = s.userid
WHERE s.queryid IS NOT NULL
  AND ($1::text IS NULL OR d.datname = $1) AND ($2::text[] IS NULL OR s.queryid::text = ANY($2))
ORDER BY ${order} DESC NULLS LAST, s.queryid
LIMIT $3`;

const STATEMENTS_TEXT_SQL = `
SELECT DISTINCT ON (s.queryid) s.queryid::text AS queryid, s.query
FROM pg_stat_statements(true) s
WHERE s.queryid::text = ANY($1)
ORDER BY s.queryid`;

const SETTINGS_SQL = `
SELECT name, setting, unit, vartype, context, source, min_val, max_val, pending_restart
FROM pg_settings WHERE name = ANY($1) ORDER BY name`;

const ACTIVITY_SQL = `
SELECT * FROM (
  SELECT coalesce(state, 'unknown') AS state, wait_event_type, wait_event, count(*)::int AS count
  FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
  GROUP BY 1, 2, 3
  UNION ALL
  SELECT 'max_connections', NULL, NULL, current_setting('max_connections')::int
) a ORDER BY count DESC, state, wait_event_type NULLS FIRST, wait_event NULLS FIRST
LIMIT 51`;

const LOCKS_SQL = `
SELECT locktype, mode, granted, count(*)::int AS count
FROM pg_locks WHERE pid <> pg_backend_pid()
GROUP BY 1, 2, 3 ORDER BY count DESC, 1, 2, 3
LIMIT 51`;

/**
 * 当前角色能读取的业务关系（表、视图、物化视图、外部表；系统 schema 与扩展的成员对象除外），最多 20 个。
 * $1 是不计入的关系名（<schema>.<名称> 的文本数组）
 */
export const READABLE_RELATIONS_SQL = `
SELECT n.nspname || '.' || c.relname AS name
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
  AND ${NOT_EXTENSION_MEMBER('c.oid')}
  AND (has_table_privilege(c.oid, 'SELECT') OR has_any_column_privilege(c.oid, 'SELECT'))
  AND NOT (n.nspname || '.' || c.relname = ANY($1::text[]))
ORDER BY 1
LIMIT 20`;

const ROLE_SQL = `
SELECT current_user AS role,
  pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS stats,
  pg_has_role(current_user, 'pg_read_all_settings', 'MEMBER') AS settings,
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS pss,
  current_setting('default_transaction_read_only') = 'on' AS read_only,
  current_setting('server_version_num') AS version,
  to_regclass('_timescaledb_catalog.chunk') IS NOT NULL AS timescale`;

type Row = Record<string, unknown>;

function plain(row: Row): DbstatsSample['rows'][number] {
  const out: DbstatsSample['rows'][number] = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] =
      v instanceof Date
        ? v.toISOString()
        : typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v === null
          ? v
          : String(v);
  }
  return out;
}

export class PostgresDbstatsAdapter {
  private readonly pool: pg.Pool;
  private readonly calls: number[] = [];
  private readonly textCalls: number[] = [];
  private readonly now: () => number;
  private server: { version: number; timescale: boolean } | null = null;
  private checked: { at: number; report: DbstatsPrivilegeReport } | null = null;

  constructor(readonly config: PostgresDbstatsConfig) {
    this.now = config.now ?? Date.now;
    const password =
      config.password ?? (config.password_file ? readFileSync(config.password_file, 'utf8').trim() : undefined);
    const ssl =
      config.ssl === undefined || config.ssl === false
        ? false
        : config.ssl === true
          ? { rejectUnauthorized: true }
          : {
              rejectUnauthorized: true,
              ...(config.ssl.ca_file ? { ca: readFileSync(config.ssl.ca_file, 'utf8') } : {}),
              ...(config.ssl.servername ? { servername: config.ssl.servername } : {}),
            };
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port ?? 5432,
      database: config.database,
      user: config.user,
      ...(password !== undefined ? { password } : {}),
      ssl,
      max: 1,
      idleTimeoutMillis: config.idle_ms ?? 60_000,
      application_name: 'srenautix-dbstats',
      connectionTimeoutMillis: 5000,
    });
    // 空闲连接被服务端断开时 pg.Pool 发出 error：只影响这个连接，下次查询重新连接
    this.pool.on('error', () => undefined);
  }

  /** 最近一次权限自检的结果；还没有检查时为 null */
  get privileges(): DbstatsPrivilegeReport | null {
    return this.checked?.report ?? null;
  }

  /** 本小时已经发出的查询数（权限自检不计） */
  get queriesThisHour(): number {
    this.prune(this.calls);
    return this.calls.length;
  }

  private prune(list: number[]): void {
    const cutoff = this.now() - HOUR;
    while (list.length && list[0]! <= cutoff) {
      list.shift();
    }
  }

  /** 在单独的只读事务中执行一个查询 */
  private async tx<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw new DatasourceError(this.config.id, `连接失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const timeout = Math.max(100, Math.floor(this.config.statement_timeout_ms ?? 3000));
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${timeout}`);
      await client.query(`SET LOCAL lock_timeout = 200`);
      const r = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return r.rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new DatasourceError(this.config.id, err instanceof Error ? err.message : String(err));
    } finally {
      client.release();
    }
  }

  private async serverInfo(): Promise<{ version: number; timescale: boolean }> {
    if (!this.server) {
      const [r] = await this.tx<{ version: string; timescale: boolean }>(ROLE_SQL);
      this.server = { version: Number(r!.version), timescale: r!.timescale };
    }
    return this.server;
  }

  /**
   * 权限自检（ADR 0146 §3.3）：角色能读取的业务表（扩展的成员对象与系统 schema 之外），缺少的 pg_read_all_stats、
   * pg_read_all_settings 成员关系与 pg_stat_statements 扩展。能读取任何业务表时 ok 为 false
   */
  async checkPrivileges(): Promise<DbstatsPrivilegeReport> {
    const [role] = await this.tx<{
      role: string;
      stats: boolean;
      settings: boolean;
      pss: boolean;
      read_only: boolean;
      version: string;
      timescale: boolean;
    }>(ROLE_SQL);
    const readable = (
      await this.tx<{ name: string }>(READABLE_RELATIONS_SQL, [[...(this.config.allowed_relations ?? [])]])
    ).map((r) => r.name);
    this.server = { version: Number(role!.version), timescale: role!.timescale };
    const report: DbstatsPrivilegeReport = {
      ok: readable.length === 0,
      role: role!.role,
      readable_tables: readable,
      missing: [
        ...(role!.stats ? [] : ['pg_read_all_stats']),
        ...(role!.settings ? [] : ['pg_read_all_settings']),
        ...(role!.pss ? [] : ['extension:pg_stat_statements']),
      ],
      read_only: role!.read_only,
      checked_at: new Date(this.now()).toISOString(),
    };
    this.checked = { at: this.now(), report };
    this.config.onPrivilegeReport?.(report);
    return report;
  }

  /** 读取之前确认权限：从未检查或超过间隔时重新检查；能读取业务表时集成不可用 */
  private async ensurePrivileges(): Promise<void> {
    const every = this.config.privilege_check_ms ?? HOUR;
    if (!this.checked || this.now() - this.checked.at >= every) {
      await this.checkPrivileges();
    }
    const r = this.checked!.report;
    if (!r.ok) {
      throw new CapabilityUnavailable(
        this.config.id,
        `dbstats（角色 ${r.role} 能读取业务表 ${r.readable_tables.join('、')}，DatasourceOverPrivileged）`,
      );
    }
  }

  /** 计入每小时上限；超过时抛出 DbstatsLimitExceeded，查询不发出 */
  private admit(op: DbstatsRequest['op']): void {
    this.prune(this.calls);
    this.prune(this.textCalls);
    const limit = this.config.hourly_limit ?? 60;
    const textLimit = this.config.text_hourly_limit ?? 6;
    if (this.calls.length >= limit) {
      throw new DbstatsLimitExceeded(this.config.id, `本小时的 dbstats 查询已达上限 ${limit} 次`);
    }
    if (op === 'statements.text' && this.textCalls.length >= textLimit) {
      throw new DbstatsLimitExceeded(this.config.id, `本小时的语句文本读取已达上限 ${textLimit} 次`);
    }
    this.calls.push(this.now());
    if (op === 'statements.text') {
      this.textCalls.push(this.now());
    }
  }

  /** 执行一个 dbstats 操作 */
  async read(request: DbstatsRequest): Promise<DbstatsSample> {
    let req: DbstatsRequest;
    try {
      req = assertValid<DbstatsRequest>('integrations/dbstats/v1/dbstats.schema.json#/$defs/Request', request);
    } catch (err) {
      throw new DatasourceError(this.config.id, err instanceof Error ? err.message : String(err));
    }
    await this.ensurePrivileges();
    this.admit(req.op);
    const info = await this.serverInfo();
    const sampledAt = new Date(this.now()).toISOString();
    const limited = (rows: Row[], limit: number) => ({
      rows: rows.slice(0, limit).map(plain),
      truncated: rows.length > limit,
    });
    let out: { rows: DbstatsSample['rows']; truncated: boolean };
    switch (req.op) {
      case 'statements.top': {
        const a = req.args;
        // PG 17 起 blk_read_time 改名为 shared_blk_read_time
        const blkRead = info.version >= 170000 ? 'shared_blk_read_time' : 'blk_read_time';
        const rows = await this.tx(statementsTopSql(blkRead, STATEMENT_ORDER[a.order_by]!(blkRead)), [
          a.database ?? null,
          a.queryids && a.queryids.length ? a.queryids : null,
          a.limit + 1,
        ]);
        out = limited(rows, a.limit);
        break;
      }
      case 'statements.text': {
        const rows = await this.tx<{ queryid: string; query: string | null }>(STATEMENTS_TEXT_SQL, [req.args.queryids]);
        const texts: DbstatsStatementText[] = [];
        for (const r of rows) {
          const n =
            r.query === null || r.query === '<insufficient privilege>'
              ? { text: null, fingerprint: null, truncated: false, error: '语句文本不可读（没有 pg_read_all_stats）' }
              : await normalizeStatement(r.query);
          texts.push({
            queryid: r.queryid,
            text: n.text,
            fingerprint: n.fingerprint,
            truncated: n.truncated,
            normalize_error: n.error,
          });
        }
        out = { rows: texts as unknown as DbstatsSample['rows'], truncated: false };
        break;
      }
      case 'tables.top': {
        const a = req.args;
        out = limited(await this.tx(tablesSql(info.timescale, TABLE_ORDER[a.order_by]!), [a.limit + 1]), a.limit);
        break;
      }
      case 'indexes.usage': {
        const a = req.args;
        out = limited(await this.tx(indexesSql(info.timescale), [a.table ?? null, a.limit + 1]), a.limit);
        break;
      }
      case 'settings.get':
        out = limited(await this.tx(SETTINGS_SQL, [req.args.names]), 50);
        break;
      case 'activity.summary':
        out = limited(await this.tx(ACTIVITY_SQL), 50);
        break;
      case 'locks.summary':
        out = limited(await this.tx(LOCKS_SQL), 50);
        break;
    }
    return { op: req.op, sampled_at: sampledAt, server_version: String(info.version), ...out };
  }

  /**
   * 两次采样（ADR 0146 §3.3）：读取一次，等待 intervalMs（生产环境不少于 300 秒，测试可以更短），再读取一次
   */
  async sampleTwice(
    req: DbstatsRequest,
    intervalMs: number,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<{ previous: DbstatsSample; current: DbstatsSample }> {
    const previous = await this.read(req);
    await wait(intervalMs);
    return { previous, current: await this.read(req) };
  }

  /** 每项能力的探测：权限自检通过、各操作能执行（计入调用上限） */
  async verify(): Promise<Record<string, { ok: boolean; detail: string }>> {
    const out: Record<string, { ok: boolean; detail: string }> = {};
    let report: DbstatsPrivilegeReport;
    try {
      report = await this.checkPrivileges();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      for (const c of CAPABILITIES) {
        out[c] = { ok: false, detail };
      }
      return out;
    }
    const probes: Array<[string, DbstatsRequest]> = [
      ['dbstats.statements_top', { op: 'statements.top', args: { order_by: 'total_exec_time', limit: 1 } }],
      ['dbstats.tables_top', { op: 'tables.top', args: { order_by: 'seq_scan', limit: 1 } }],
      ['dbstats.indexes_usage', { op: 'indexes.usage', args: { limit: 1 } }],
      ['dbstats.settings_get', { op: 'settings.get', args: { names: ['max_connections'] } }],
      ['dbstats.activity_summary', { op: 'activity.summary', args: {} }],
      ['dbstats.locks_summary', { op: 'locks.summary', args: {} }],
    ];
    for (const [cap, req] of probes) {
      try {
        const s = await this.read(req);
        out[cap] = { ok: true, detail: `${s.rows.length} 行` };
      } catch (err) {
        out[cap] = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }
    const textOk = report.ok && !report.missing.includes('pg_read_all_stats') && out['dbstats.statements_top']!.ok;
    out['dbstats.statements_text'] = {
      ok: textOk,
      detail: textOk ? '语句文本可读' : '需要 pg_read_all_stats 与 pg_stat_statements',
    };
    return out;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

const CAPABILITIES = [
  'dbstats.statements_top',
  'dbstats.statements_text',
  'dbstats.tables_top',
  'dbstats.indexes_usage',
  'dbstats.settings_get',
  'dbstats.activity_summary',
  'dbstats.locks_summary',
];
