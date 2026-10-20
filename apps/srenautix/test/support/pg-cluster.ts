import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { bootstrap, DEFAULT_DB_ROLES } from '../../src/store/bootstrap.js';

/**
 * 测试用的一次性 PostgreSQL：在仓库的 .scratch/ 下 initdb 并用 pg_ctl 启动，测试结束后停止并删除。
 * 二进制目录取 SRENAUTIX_PG_BIN，默认 Homebrew 的 postgresql@18。
 */
export interface TestCluster {
  dir: string;
  port: number;
  superuser: string;
  database: string;
  password: string;
  stop(): void;
}

const BIN = process.env.SRENAUTIX_PG_BIN ?? '/opt/homebrew/opt/postgresql@18/bin';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? res(a.port) : rej(new Error('取不到空闲端口'))));
    });
  });
}

export async function startCluster(): Promise<TestCluster> {
  if (!existsSync(join(BIN, 'initdb'))) {
    throw new Error(`找不到 PostgreSQL 二进制：${BIN}（用 SRENAUTIX_PG_BIN 指定）`);
  }
  const root = resolve(import.meta.dirname, '../../../../.scratch');
  mkdirSync(root, { recursive: true });
  const dir = join(root, `pg-${process.pid}-${Date.now()}`);
  const port = await freePort();
  const password = 'test-password-not-secret';
  const pwfile = join(root, `pw-${process.pid}`);
  writeFileSync(pwfile, password);
  execFileSync(
    join(BIN, 'initdb'),
    ['-D', dir, '-U', 'postgres', '-A', 'scram-sha-256', '--pwfile', pwfile, '-E', 'UTF8', '--no-locale'],
    { stdio: 'ignore' },
  );
  rmSync(pwfile);
  execFileSync(
    join(BIN, 'pg_ctl'),
    [
      '-D',
      dir,
      '-l',
      join(dir, 'server.log'),
      '-o',
      `-p ${port} -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200`,
      '-w',
      'start',
    ],
    { stdio: 'ignore' },
  );
  const cluster: TestCluster = {
    dir,
    port,
    superuser: 'postgres',
    database: 'srenautix',
    password,
    stop() {
      spawn(join(BIN, 'pg_ctl'), ['-D', dir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }).on('exit', () =>
        rmSync(dir, { recursive: true, force: true }),
      );
    },
  };
  await createDatabase(port, password, 'srenautix');
  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'srenautix', max: 2 });
  for (const r of Object.values(DEFAULT_DB_ROLES)) {
    await pool.query(`ALTER ROLE ${r} PASSWORD '${password}'`);
  }
  await pool.end();
  return cluster;
}

/** 新建一个库并以管理员身份执行初始化 SQL（建角色、schema 与权限）。 */
export async function createDatabase(port: number, password: string, name: string): Promise<void> {
  const admin = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: name, max: 1 });
  await bootstrap(pool, name, DEFAULT_DB_ROLES);
  await pool.end();
}

/** 以超级用户在测试库上执行一条查询并返回行（e2e 的后端准备用来等待后台写入完成） */
export async function queryCluster<T extends Record<string, unknown>>(
  c: TestCluster,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: c.port,
    user: c.superuser,
    password: c.password,
    database: c.database,
  });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}
