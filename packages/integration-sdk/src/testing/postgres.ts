// 测试用的一次性 PostgreSQL（dbstats 的一致性测试与包测试的 input_sql）：initdb 到工作区的 .scratch，
// 预加载 pg_stat_statements，只监听 127.0.0.1，停止时删除数据目录。
// 二进制目录：SRENAUTIX_PG_BINS（逗号分隔，多个版本）、SRENAUTIX_PG_BIN，或 Homebrew 的 postgresql@16/17/18。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DbstatsRequest, DbstatsSample } from '@srenautix/contract';
import pg from 'pg';
import { PostgresDbstatsAdapter } from '../dbstats/postgres.js';
import { freePort } from './process.js';

export interface TestPostgres {
  bin: string;
  /** 主版本号，例如 17 */
  major: number;
  host: string;
  port: number;
  superuser: string;
  password: string;
  dir: string;
  /** 以超级用户连接一个库 */
  connect(database?: string): Promise<pg.Client>;
  /** 以超级用户在一个库上依次执行语句 */
  exec(database: string, statements: string[]): Promise<void>;
  stop(): Promise<void>;
}

/** 可用的 PostgreSQL 二进制目录（含 initdb 与 pg_stat_statements） */
export function postgresBins(): string[] {
  const env = process.env['SRENAUTIX_PG_BINS'] ?? process.env['SRENAUTIX_PG_BIN'];
  const candidates = env
    ? env
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : ['16', '17', '18'].map((v) => `/opt/homebrew/opt/postgresql@${v}/bin`);
  return candidates.filter((b) => existsSync(join(b, 'initdb')));
}

function workspaceScratch(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return join(dir, '.scratch');
    }
    const up = dirname(dir);
    if (up === dir) {
      return resolve('.scratch');
    }
    dir = up;
  }
}

/** 启动一个预加载 pg_stat_statements 的 PostgreSQL */
export async function startPostgres(bin: string): Promise<TestPostgres> {
  const root = workspaceScratch();
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'pg-dbstats-'));
  const data = join(dir, 'data');
  const password = 'test-password-not-secret';
  const pwfile = join(dir, 'pw');
  writeFileSync(pwfile, password);
  const version = execFileSync(join(bin, 'postgres'), ['--version'], { encoding: 'utf8' });
  const major = Number(/(\d+)(?:\.\d+)?/.exec(version)![1]);
  execFileSync(
    join(bin, 'initdb'),
    ['-D', data, '-U', 'postgres', '-A', 'scram-sha-256', '--pwfile', pwfile, '-E', 'UTF8', '--no-locale'],
    { stdio: 'ignore' },
  );
  rmSync(pwfile);
  const port = await freePort();
  execFileSync(
    join(bin, 'pg_ctl'),
    [
      '-D',
      data,
      '-l',
      join(dir, 'server.log'),
      '-o',
      [
        `-p ${port}`,
        '-c unix_socket_directories=',
        '-c listen_addresses=127.0.0.1',
        '-c fsync=off',
        '-c max_connections=40',
        '-c shared_preload_libraries=pg_stat_statements',
        '-c pg_stat_statements.track=top',
        '-c track_io_timing=on',
      ].join(' '),
      '-w',
      'start',
    ],
    { stdio: 'ignore' },
  );
  const connect = async (database = 'postgres') => {
    const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password, database });
    await c.connect();
    return c;
  };
  return {
    bin,
    major,
    host: '127.0.0.1',
    port,
    superuser: 'postgres',
    password,
    dir,
    connect,
    async exec(database, statements) {
      const c = await connect(database);
      try {
        for (const s of statements) {
          await c.query(s);
        }
      } finally {
        await c.end();
      }
    },
    stop: () =>
      new Promise((res) => {
        spawn(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }).on(
          'exit',
          () => {
            rmSync(dir, { recursive: true, force: true });
            res();
          },
        );
      }),
  };
}

/**
 * dbstats 的只读角色（ADR 0146 §3.3）：只授予 pg_read_all_stats 与 pg_read_all_settings，CONNECTION LIMIT 2，
 * 角色级设置只读事务与各项超时，不授予任何表的 SELECT。CCHP 在 CNPG 的 managed.roles 中按同样的设置声明
 */
export function dbstatsRoleStatements(role: string, password: string): string[] {
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return [
    `CREATE ROLE ${role} LOGIN PASSWORD ${q(password)} CONNECTION LIMIT 2`,
    `GRANT pg_read_all_stats, pg_read_all_settings TO ${role}`,
    `ALTER ROLE ${role} SET default_transaction_read_only = on`,
    `ALTER ROLE ${role} SET statement_timeout = '3s'`,
    `ALTER ROLE ${role} SET lock_timeout = '200ms'`,
    `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '5s'`,
    `ALTER ROLE ${role} SET work_mem = '4MB'`,
  ];
}

/** runSqlFixture 结果的键：请求的 JSON，对象键按字典序排列 */
export function sqlFixtureKey(req: DbstatsRequest): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sorted(req));
}

export interface SqlFixture {
  database?: string;
  setup: string[];
  workload: Array<{ sql: string; repeat: number }>;
}

/**
 * 在真实 PostgreSQL 上执行一个 dbstats 夹具（包测试的 input_sql）：重建库并执行 setup，重置语句统计，
 * 以 dbstats 只读角色按每个请求采样一次，执行 workload，再采样一次。返回请求（JSON）→ 两次采样
 */
export async function runSqlFixture(
  pgsql: TestPostgres,
  fixture: SqlFixture,
  requests: DbstatsRequest[],
): Promise<Map<string, { previous: DbstatsSample; current: DbstatsSample }>> {
  const database = fixture.database ?? 'app';
  const role = 'srenautix_stats';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) {
    throw new Error(`库名不合法：${database}`);
  }
  const admin = await pgsql.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!exists.rowCount) {
      for (const s of dbstatsRoleStatements(role, pgsql.password)) {
        await admin.query(s);
      }
    }
  } finally {
    await admin.end();
  }
  await pgsql.exec(database, ['CREATE EXTENSION IF NOT EXISTS pg_stat_statements', ...fixture.setup]);
  await pgsql.exec(database, ['SELECT pg_stat_statements_reset()']);
  const adapter = new PostgresDbstatsAdapter({
    id: `pg${pgsql.major}`,
    host: pgsql.host,
    port: pgsql.port,
    database,
    user: role,
    password: pgsql.password,
    hourly_limit: 1000,
    text_hourly_limit: 1000,
  });
  try {
    const previous = new Map<string, DbstatsSample>();
    for (const r of requests) {
      previous.set(sqlFixtureKey(r), await adapter.read(r));
    }
    const c = await pgsql.connect(database);
    try {
      for (const w of fixture.workload) {
        for (let i = 0; i < w.repeat; i++) {
          await c.query(w.sql);
        }
      }
    } finally {
      await c.end();
    }
    // 两次采样的时间至少相差 1 毫秒，速率的分母不为 0
    await new Promise((r) => setTimeout(r, 5));
    const out = new Map<string, { previous: DbstatsSample; current: DbstatsSample }>();
    for (const r of requests) {
      const key = sqlFixtureKey(r);
      out.set(key, { previous: previous.get(key)!, current: await adapter.read(r) });
    }
    return out;
  } finally {
    await adapter.close();
  }
}
