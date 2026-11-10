import pg from 'pg';

// 计数与 seq 为 bigint，取值范围在 Number 精度内
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type PgSslMode = 'disable' | 'require' | 'verify-full';

export interface PgConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: PgSslMode;
  caCert: string | null;
}

/** 语句因 statement_timeout 被取消（SQLSTATE 57014，用户取消也是 57014，按消息区分） */
export function isStatementTimeout(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === '57014' &&
    /statement timeout/.test(String((e as { message?: unknown }).message))
  );
}

/** 每次语句超时调用 onTimeout 的连接类（srenautix_pg_statement_timeouts_total），查询本身原样转发 */
function timeoutCountingClient(onTimeout: () => void): typeof pg.Client {
  const query = pg.Client.prototype.query as (...a: unknown[]) => unknown;
  return class extends pg.Client {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg 的 query 有多个重载，这里原样转发
    override query(...args: any[]): any {
      const i = args.findLastIndex((a) => typeof a === 'function');
      if (i >= 0) {
        const cb = args[i] as (err: unknown, res: unknown) => void;
        args[i] = (err: unknown, res: unknown) => {
          if (isStatementTimeout(err)) {
            onTimeout();
          }
          cb(err, res);
        };
        return query.apply(this, args);
      }
      const r = query.apply(this, args);
      return r instanceof Promise
        ? r.catch((e: unknown) => {
            if (isStatementTimeout(e)) {
              onTimeout();
            }
            throw e;
          })
        : r;
    }
  };
}

export function createPool(cfg: PgConfig, applicationName: string, max = 10, onStatementTimeout?: () => void): pg.Pool {
  const ssl =
    cfg.sslMode === 'disable'
      ? false
      : cfg.sslMode === 'require'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true, ca: cfg.caCert ?? undefined, servername: cfg.host };
  const pool = new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl,
    max,
    application_name: applicationName,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    ...(onStatementTimeout ? { Client: timeoutCountingClient(onStatementTimeout) } : {}),
  });
  // 空闲连接被服务端断开时 pg 在 pool 上发出 error；连接会被丢弃，下一次取连接重新建立
  pool.on('error', () => undefined);
  return pool;
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

/** 在一个事务里执行 fn；fn 抛出时回滚并原样抛出。 */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
