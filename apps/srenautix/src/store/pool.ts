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

export function createPool(cfg: PgConfig, applicationName: string, max = 10): pg.Pool {
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
