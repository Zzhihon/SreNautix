import { createHash } from 'node:crypto';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import { tx } from './pool.js';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * 按 (调用方, Idempotency-Key) 执行一次写操作：第一次执行 fn 并把结果与操作写在同一个事务里；
 * 之后同样的请求直接返回第一次的结果；同一个键配上不同的请求体返回 422。
 */
export async function idempotent<T>(
  pool: pg.Pool,
  caller: string,
  key: string | undefined,
  request: unknown,
  fn: (c: pg.PoolClient) => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (key === undefined) {
    const r = await tx(pool, fn);
    return { ...r, replayed: false };
  }
  if (!KEY.test(key)) {
    throw new HttpError(400, 'bad_request', 'Idempotency-Key 必须是 8–128 个字符的 [A-Za-z0-9._:-]');
  }
  const hash = createHash('sha256')
    .update(JSON.stringify(request ?? null))
    .digest('hex');
  return tx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`idem:${caller}:${key}`]);
    const prev = await c.query<{ request_hash: string; status: number; response: T }>(
      `SELECT request_hash, status, response FROM server.idempotency_keys
        WHERE caller = $1 AND key = $2 AND created_at > now() - interval '24 hours'`,
      [caller, key],
    );
    const row = prev.rows[0];
    if (row) {
      if (row.request_hash !== hash) {
        throw new HttpError(422, 'idempotency_key_reused', '同一个 Idempotency-Key 用于不同的请求');
      }
      return { status: row.status, body: row.response, replayed: true };
    }
    const r = await fn(c);
    await c.query(
      `INSERT INTO server.idempotency_keys (caller, key, request_hash, status, response) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (caller, key) DO UPDATE SET request_hash = excluded.request_hash, status = excluded.status,
         response = excluded.response, created_at = now()`,
      [caller, key, hash, r.status, JSON.stringify(r.body)],
    );
    return { ...r, replayed: false };
  });
}

export async function purgeIdempotencyKeys(pool: pg.Pool): Promise<number> {
  const r = await pool.query("DELETE FROM server.idempotency_keys WHERE created_at < now() - interval '24 hours'");
  return r.rowCount ?? 0;
}
