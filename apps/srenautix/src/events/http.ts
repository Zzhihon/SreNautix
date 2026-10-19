import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { badRequest } from '../api/errors.js';
import { logger } from '../log.js';
import { CursorError, formatCursor, parseCursor, readEvents, type OutboxEvent, type Owner } from '../store/outbox.js';
import type { OutboxListener } from './listener.js';

export interface EventsDeps {
  pool: pg.Pool;
  schema: string;
  owner: Owner;
  listener: OutboxListener;
  /** 认证调用方并返回事件过滤函数（按调用方的作用域）；未认证时抛出 401。 */
  authorize(req: FastifyRequest): Promise<(e: OutboxEvent) => boolean>;
  onServed?(mode: 'poll' | 'sse', n: number): void;
}

const MAX_LIMIT = 500;
const MAX_WAIT_S = 30;
const HEARTBEAT_MS = 15_000;

function cursorOf(deps: EventsDeps, raw: string | undefined): number {
  try {
    return parseCursor(raw, deps.owner);
  } catch (e) {
    if (e instanceof CursorError) {
      throw badRequest(e.message);
    }
    throw e;
  }
}

function typesOf(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const t = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (t.some((x) => !/^[a-z_]+\.[a-z_]+$/.test(x))) {
    throw badRequest('types 是逗号分隔的事件类型，例如 incident.updated,stage_a.reported');
  }
  return t;
}

/**
 * GET /v1/events：按游标读取 outbox。JSON 形态支持长轮询（wait 秒内没有新事件时等待唤醒）；
 * Accept: text/event-stream 时以 SSE 持续推送，id 为游标，event 为类型，断线后按 Last-Event-ID 续传。
 * 投递语义是至少一次，消费者按 event_id 幂等处理。
 */
export function registerEvents(app: FastifyInstance, deps: EventsDeps): void {
  app.get('/v1/events', async (req, reply) => {
    const filter = await deps.authorize(req);
    const q = req.query as Record<string, string | undefined>;
    const types = typesOf(q.types);
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw badRequest(`limit 必须是 1–${MAX_LIMIT} 的整数`);
    }
    if ((req.headers.accept ?? '').includes('text/event-stream')) {
      const lastId = req.headers['last-event-id'];
      const after = cursorOf(deps, typeof lastId === 'string' && lastId ? lastId : q.after);
      return sse(deps, req, reply, after, types, filter);
    }
    let after = cursorOf(deps, q.after);
    const wait = q.wait === undefined ? 0 : Number(q.wait);
    if (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_S) {
      throw badRequest(`wait 必须是 0–${MAX_WAIT_S} 秒`);
    }
    const deadline = Date.now() + wait * 1000;
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());
    for (;;) {
      const batch = await readEvents(deps.pool, deps.schema, deps.owner, { after, limit, types });
      const visible = batch.filter(filter);
      const next = batch.length ? (batch[batch.length - 1] as OutboxEvent).seq : after;
      if (visible.length || batch.length === limit || Date.now() >= deadline || abort.signal.aborted) {
        deps.onServed?.('poll', visible.length);
        return reply.send({ events: visible, next: formatCursor(deps.owner, next) });
      }
      after = next;
      await deps.listener.waitWake(deps.owner, Math.min(deadline - Date.now(), 5_000), abort.signal);
    }
  });
}

async function sse(
  deps: EventsDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  start: number,
  types: string[] | undefined,
  filter: (e: OutboxEvent) => boolean,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const abort = new AbortController();
  req.raw.on('close', () => abort.abort());
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), HEARTBEAT_MS);
  let after = start;
  try {
    res.write('retry: 3000\n\n');
    while (!abort.signal.aborted) {
      const batch = await readEvents(deps.pool, deps.schema, deps.owner, { after, limit: 200, types });
      let n = 0;
      for (const e of batch) {
        if (filter(e)) {
          res.write(`id: ${formatCursor(deps.owner, e.seq)}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          n++;
        }
        after = e.seq;
      }
      if (n) {
        deps.onServed?.('sse', n);
      }
      if (batch.length < 200) {
        await deps.listener.waitWake(deps.owner, 10_000, abort.signal);
      }
    }
  } catch (e) {
    // 响应已经开始，无法再返回错误码：结束流，客户端按 retry 间隔用 Last-Event-ID 续传
    logger.warn('SSE 事件流中断', { error: e });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}
