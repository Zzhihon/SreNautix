import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Queryable } from './pool.js';

export type Owner = 'server' | 'worker';

/** LISTEN/NOTIFY 频道；payload 为 `<owner>:<seq>`，只用于唤醒消费者，内容以 outbox 为准。 */
export const NOTIFY_CHANNEL = 'srenautix_outbox';

/** outbox 表的 DDL，server 与 worker 的迁移各自引用。 */
export function outboxDdl(schema: string): string {
  return `
CREATE TABLE ${schema}.outbox (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  type text NOT NULL,
  schema_version text NOT NULL,
  cluster_id text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_type_seq_idx ON ${schema}.outbox (type, seq);
`;
}

export interface OutboxEvent<P = unknown> {
  seq: number;
  event_id: string;
  owner: Owner;
  type: string;
  schema_version: string;
  cluster_id: string;
  occurred_at: string;
  payload: P;
}

export interface NewEvent {
  type: string;
  clusterId: string;
  payload: unknown;
  /** 重新发布其他所有者的事件时沿用原 event_id。 */
  eventId?: string;
}

/**
 * 在调用方的事务里追加事件。先取事务级 advisory lock，使 seq 的分配顺序等于提交顺序：
 * 消费者按 after=<seq> 读取时不会跳过晚提交的小 seq。NOTIFY 在提交时才送达。
 */
export async function appendEvents(
  c: Queryable,
  schema: string,
  owner: Owner,
  schemaVersion: string,
  events: NewEvent[],
): Promise<number[]> {
  if (events.length === 0) {
    return [];
  }
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`srenautix.outbox.${schema}`]);
  const seqs: number[] = [];
  for (const e of events) {
    const r = await c.query<{ seq: number }>(
      `INSERT INTO ${schema}.outbox (event_id, type, schema_version, cluster_id, payload)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING RETURNING seq`,
      [e.eventId ?? randomUUID(), e.type, schemaVersion, e.clusterId, JSON.stringify(e.payload)],
    );
    const seq = r.rows[0]?.seq;
    if (seq !== undefined) {
      seqs.push(seq);
    }
  }
  if (seqs.length) {
    await c.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, `${owner}:${seqs[seqs.length - 1]}`]);
  }
  return seqs;
}

export interface ReadOptions {
  after: number;
  limit: number;
  types?: readonly string[];
}

export async function readEvents(
  pool: pg.Pool | Queryable,
  schema: string,
  owner: Owner,
  o: ReadOptions,
): Promise<OutboxEvent[]> {
  const params: unknown[] = [o.after, o.limit];
  let filter = '';
  if (o.types && o.types.length) {
    params.push(o.types);
    filter = 'AND type = ANY($3::text[])';
  }
  const r = await pool.query<{
    seq: number;
    event_id: string;
    type: string;
    schema_version: string;
    cluster_id: string;
    payload: unknown;
    occurred_at: Date;
  }>(
    `SELECT seq, event_id, type, schema_version, cluster_id, payload, occurred_at
       FROM ${schema}.outbox WHERE seq > $1 ${filter} ORDER BY seq LIMIT $2`,
    params,
  );
  return r.rows.map((x) => ({
    seq: x.seq,
    event_id: x.event_id,
    owner,
    type: x.type,
    schema_version: x.schema_version,
    cluster_id: x.cluster_id,
    occurred_at: x.occurred_at.toISOString(),
    payload: x.payload,
  }));
}

export async function lastSeq(pool: pg.Pool | Queryable, schema: string): Promise<number> {
  const r = await pool.query<{ seq: number | null }>(`SELECT max(seq) AS seq FROM ${schema}.outbox`);
  return r.rows[0]?.seq ?? 0;
}

/** 游标 `<owner>:<seq>`。 */
export function parseCursor(raw: string | undefined, owner: Owner): number {
  if (raw === undefined || raw === '') {
    return 0;
  }
  const m = /^(server|worker):(\d{1,18})$/.exec(raw);
  if (!m || m[1] !== owner) {
    throw new CursorError(`游标必须形如 ${owner}:<seq>：${raw}`);
  }
  return Number(m[2]);
}

export function formatCursor(owner: Owner, seq: number): string {
  return `${owner}:${seq}`;
}

export class CursorError extends Error {
  override name = 'CursorError';
}
