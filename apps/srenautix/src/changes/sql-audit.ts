import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ChangeEvent } from '@srenautix/contract';
import { DatasourceError, READABLE_RELATIONS_SQL } from '@srenautix/integration-sdk';
import canonicalize from 'canonicalize';
import pg from 'pg';
import type { ServerConfig } from '../config/server.js';

// SQL 审计表变更源（ADR 0151）：业务库里运行时配置的审计记录（经管理接口或直接写库生效、不经过 Git 与发布的改动）
// 作为 runtime_config 变更，和其他变更一起进入事件收敛、根因排序与阶段 A 时间线。
// - 只读连接：连接池最多 1 个连接，空闲 60 秒关闭；每个查询在单独的只读事务中执行，带 statement_timeout 与 lock_timeout；
// - 查询由声明生成：只有关系名与列名（小写普通标识符，加双引号引用）进入 SQL，时间窗与行数上限是绑定参数；
// - 权限自检：角色能读取声明之外的任何业务关系时不读取（与 dbstats 的不变量 14 相同）；
// - 没有变化（新旧取值相同）与短时间内改回原来取值的记录不算变更（与发布的标签抖动相同，ADR 0142）。

export type SqlAuditSourceConfig = ServerConfig['changes']['sql_audit'][number];
export type SqlAuditQuery = SqlAuditSourceConfig['queries'][number];

/** 每个查询每次最多读取的行数；超过时只取最早的这么多行并标记截断 */
export const SQL_AUDIT_ROW_LIMIT = 1000;
/** 摘要里每个取值最多的字符数 */
const VALUE_CHARS = 80;
const SUMMARY_CHARS = 500;
/** 权限自检的间隔 */
const PRIVILEGE_CHECK_MS = 3600_000;

/** 对象的取值：规范成的文本（比较与版本用），列是 json、jsonb 对象时另带对象本身（列出变化的键用） */
export interface Value {
  text: string;
  object: Record<string, unknown> | null;
}

/** 一行审计记录，列的取值规范成文本 */
export interface AuditRow {
  key: string;
  time: string;
  object: string;
  action: string;
  actor: string | null;
  value: Value | null;
  previous: Value | null;
  details: Record<string, string | null>;
}

const quote = (ident: string) => `"${ident}"`;

/**
 * 一个查询声明生成的 SQL：$1、$2 是时间窗（含两端），$3 是行数上限。function 为 true 时 table 是返回审计记录的函数，
 * 以时间窗的起止为参数调用（函数体里的动态查询不登记对表与列的依赖，业务的迁移删改这些列时不会被它阻止）
 */
export function auditQuerySql(q: SqlAuditQuery): string {
  const [schema, rel] = q.table.split('.') as [string, string];
  const cols: Array<[string, string]> = [
    ['k', q.key],
    ['t', q.time],
    ['o', q.object],
    ['a', q.action],
    ...(q.actor ? ([['u', q.actor]] as Array<[string, string]>) : []),
    ...(q.value ? ([['v', q.value]] as Array<[string, string]>) : []),
    ...(q.previous_value ? ([['p', q.previous_value]] as Array<[string, string]>) : []),
    ...q.details.map((d, i): [string, string] => [`d${i}`, d]),
  ];
  return [
    `SELECT ${cols.map(([alias, col]) => `${quote(col)} AS ${alias}`).join(', ')}`,
    `FROM ${quote(schema)}.${quote(rel)}${q.function ? '($1::timestamptz, $2::timestamptz)' : ''}`,
    `WHERE ${quote(q.time)} >= $1 AND ${quote(q.time)} <= $2`,
    `ORDER BY ${quote(q.time)}, ${quote(q.key)}`,
    'LIMIT $3',
  ].join('\n');
}

/** 列的取值规范成文本：时间取 ISO 8601，JSON 与数组按 JCS 规范化；二进制列不能声明 */
function text(source: string, column: string, v: unknown): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (v instanceof Date) {
    return v.toISOString();
  }
  if (Buffer.isBuffer(v)) {
    throw new DatasourceError(source, `列 ${column} 是二进制，不能作为审计记录的取值`);
  }
  if (typeof v === 'object') {
    return canonicalize(v) as string;
  }
  return String(v);
}

function value(source: string, column: string, v: unknown): Value | null {
  const t = text(source, column, v);
  if (t === null) {
    return null;
  }
  const isObject = v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
  return { text: t, object: isObject ? (v as Record<string, unknown>) : null };
}

/** 查询结果的一行转成审计记录；时间列必须是时间类型，键、对象与动作不能为空 */
export function auditRow(source: string, q: SqlAuditQuery, r: Record<string, unknown>): AuditRow {
  if (!(r.t instanceof Date)) {
    throw new DatasourceError(source, `${q.table}.${q.time} 不是时间类型（timestamp 或 timestamptz）`);
  }
  const need = (alias: string, column: string): string => {
    const v = text(source, column, r[alias]);
    if (v === null) {
      throw new DatasourceError(source, `${q.table}.${column} 有空值，审计记录的键、对象与动作不能为空`);
    }
    return v;
  };
  return {
    key: need('k', q.key),
    time: r.t.toISOString(),
    object: need('o', q.object),
    action: need('a', q.action),
    actor: q.actor ? text(source, q.actor, r.u) : null,
    value: q.value ? value(source, q.value, r.v) : null,
    previous: q.previous_value ? value(source, q.previous_value, r.p) : null,
    details: Object.fromEntries(q.details.map((d, i) => [d, text(source, d, r[`d${i}`])])),
  };
}

/** 变更的目标：按顺序取第一条匹配的规则；没有匹配时为 null（不是任何组件的变更） */
export function auditTargets(q: SqlAuditQuery, row: Pick<AuditRow, 'action' | 'object'>): string[] | null {
  for (const c of q.components) {
    if (
      (!c.match.action || c.match.action.includes(row.action)) &&
      (!c.match.object || c.match.object.includes(row.object))
    ) {
      return c.targets;
    }
  }
  return null;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 版本：取值不长时就是取值本身，长的（例如整个配置对象）取 sha256 的前 12 位，回退的识别按它比较 */
const revisionOf = (v: Value): string =>
  v.text.length <= VALUE_CHARS ? v.text : `sha256:${createHash('sha256').update(v.text).digest('hex').slice(0, 12)}`;

/**
 * 取值的变化：两边都是对象（json、jsonb 列）时只列出变化的键（`enabled: true → false`），
 * 否则写成 `旧 → 新`；不知道旧取值时只写新取值
 */
export function transitionText(before: Value | null, value: Value): string {
  const a = before?.object ?? null;
  const b = value.object;
  if (a && b) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys
      .filter((k) => canonicalize(a[k] ?? null) !== canonicalize(b[k] ?? null))
      .map(
        (k) =>
          `${k}: ${cut(canonicalize(a[k] ?? null) as string, VALUE_CHARS)} → ${cut(canonicalize(b[k] ?? null) as string, VALUE_CHARS)}`,
      )
      .join('，');
  }
  return `${before !== null ? `${cut(before.text, VALUE_CHARS)} → ` : ''}${cut(value.text, VALUE_CHARS)}`;
}

/**
 * 一个查询读到的审计记录（按时间排序）转成变更（ADR 0151）：
 * - 变更之前的取值：声明了 previous_value 列时取它，否则取同一对象上一条记录的取值（读到的范围之内）；
 * - 同一对象从一条记录起 groupWithinMs 之内（含这条记录本身）回到这条记录之前的取值，这几条都不算变更：
 *   新旧取值相同的一条记录，以及短时间内改动又改回的几条记录；
 * - 没有匹配组件规则的记录不算变更
 */
export function auditChanges(
  sourceId: string,
  q: SqlAuditQuery,
  rows: readonly AuditRow[],
  groupWithinMs: number,
): ChangeEvent[] {
  type Entry = AuditRow & { before: Value | null };
  const entries: Entry[] = [];
  const byObject = new Map<string, Entry[]>();
  for (const r of rows) {
    const list = byObject.get(r.object) ?? [];
    const before = q.previous_value ? r.previous : q.value ? (list[list.length - 1]?.value ?? null) : null;
    const e = { ...r, before };
    list.push(e);
    entries.push(e);
    byObject.set(r.object, list);
  }
  const drop = new Set<Entry>();
  for (const list of byObject.values()) {
    let i = 0;
    while (i < list.length) {
      const first = list[i]!;
      let back = -1;
      for (
        let j = i;
        first.before !== null && j < list.length && Date.parse(list[j]!.time) - Date.parse(first.time) <= groupWithinMs;
        j++
      ) {
        if (list[j]!.value?.text === first.before.text) {
          back = j;
          break;
        }
      }
      if (back < 0) {
        i++;
        continue;
      }
      list.slice(i, back + 1).forEach((e) => drop.add(e));
      i = back + 1;
    }
  }
  const out: ChangeEvent[] = [];
  for (const e of entries) {
    const targets = drop.has(e) ? null : auditTargets(q, e);
    if (!targets) {
      continue;
    }
    const details = Object.entries(e.details)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${cut(v as string, VALUE_CHARS)}`);
    const transition = e.value !== null ? transitionText(e.before, e.value) : null;
    out.push({
      change_id: `${sourceId}:${q.id}:${e.key}`,
      source: sourceId,
      kind: 'runtime_config',
      refs: [`${q.id}/${e.object}`, e.action],
      revision: e.value === null ? null : revisionOf(e.value),
      previous_revision: e.before === null ? null : revisionOf(e.before),
      actor: e.actor,
      time: e.time,
      link: null,
      targets: [...targets],
      summary: cut(
        [`${e.action} ${q.id}/${e.object}`, ...(transition ? [transition] : []), ...details].join('；'),
        SUMMARY_CHARS,
      ),
    });
  }
  return out;
}

/** 一个 SQL 审计表变更源的读取 */
export class SqlAuditReader {
  private readonly pool: pg.Pool;
  private checkedAt: number | null = null;
  readonly groupWithinMs: number;

  constructor(
    readonly cfg: SqlAuditSourceConfig,
    groupWithinMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.groupWithinMs = groupWithinMs;
    const c = cfg.connection;
    const ssl =
      c.ssl === false
        ? false
        : c.ssl === true
          ? { rejectUnauthorized: true }
          : {
              rejectUnauthorized: true,
              ...(c.ssl.ca_file ? { ca: readFileSync(c.ssl.ca_file, 'utf8') } : {}),
              ...(c.ssl.servername ? { servername: c.ssl.servername } : {}),
            };
    this.pool = new pg.Pool({
      host: c.host,
      port: c.port,
      database: c.database,
      user: c.user,
      password: readFileSync(c.password_file, 'utf8').trim(),
      ssl,
      max: 1,
      idleTimeoutMillis: 60_000,
      application_name: 'srenautix-sql-audit',
      connectionTimeoutMillis: 5000,
    });
    // 空闲连接被服务端断开时 pg.Pool 发出 error：只影响这个连接，下次查询重新连接
    this.pool.on('error', () => undefined);
  }

  /** 声明读取的关系（<schema>.<名称>，表或视图；函数不是关系） */
  get relations(): string[] {
    return [...new Set(this.cfg.queries.filter((q) => !q.function).map((q) => q.table))];
  }

  /** 在单独的只读事务中执行一个查询 */
  private async tx<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw new DatasourceError(this.cfg.id, `连接失败：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL statement_timeout = 3000');
      await client.query('SET LOCAL lock_timeout = 200');
      const r = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return r.rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new DatasourceError(this.cfg.id, err instanceof Error ? err.message : String(err));
    } finally {
      client.release();
    }
  }

  /** 权限自检：角色能读取声明之外的业务关系时不读取；每小时检查一次 */
  private async ensurePrivileges(): Promise<void> {
    if (this.checkedAt !== null && this.now() - this.checkedAt < PRIVILEGE_CHECK_MS) {
      return;
    }
    const extra = (await this.tx<{ name: string }>(READABLE_RELATIONS_SQL, [this.relations])).map((r) => r.name);
    if (extra.length) {
      this.checkedAt = null;
      throw new DatasourceError(
        this.cfg.id,
        `角色 ${this.cfg.connection.user} 能读取声明之外的业务关系 ${extra.join('、')}，不读取审计记录（DatasourceOverPrivileged）`,
      );
    }
    this.checkedAt = this.now();
  }

  /** 读取 [from, to] 内的审计记录并转成变更；某个查询读满上限时 truncated 为 true */
  async list(from: Date, to: Date): Promise<{ changes: ChangeEvent[]; truncated: boolean }> {
    await this.ensurePrivileges();
    const changes: ChangeEvent[] = [];
    let truncated = false;
    for (const q of this.cfg.queries) {
      const raw = await this.tx<Record<string, unknown>>(auditQuerySql(q), [from, to, SQL_AUDIT_ROW_LIMIT]);
      truncated = truncated || raw.length >= SQL_AUDIT_ROW_LIMIT;
      const rows = raw.map((r) => auditRow(this.cfg.id, q, r));
      changes.push(...auditChanges(this.cfg.id, q, rows, this.groupWithinMs));
    }
    return {
      changes: changes.sort((a, b) => a.time.localeCompare(b.time) || a.change_id.localeCompare(b.change_id)),
      truncated,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
