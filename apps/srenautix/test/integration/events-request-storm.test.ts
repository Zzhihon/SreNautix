import type { FastifyInstance } from 'fastify';
import { Counter, Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { ReadLimiter, registerReadLimit } from '../../src/api/read-limit.js';
import { registerEvents } from '../../src/events/http.js';
import { OutboxListener } from '../../src/events/listener.js';
import { SESSION_COOKIE } from '../../src/identity/sessions.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { appendEvents } from '../../src/store/outbox.js';
import { tx } from '../../src/store/pool.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 控制台请求风暴的两道防线：
// 1. 事件流不带游标时从当前位置开始（契约：不填时从当前位置开始），不再把整个 outbox 从头回放给浏览器——
//    控制台对每条事件各失效一次查询，回放上千条历史事件就是上千次重取；
// 2. 同一个会话对同一个读接口超过每秒上限时返回 429 并计数。

let db: TestDb;
let listener: OutboxListener;
let app: FastifyInstance;
let base: string;

async function append(n: number, type = 'incident.updated'): Promise<void> {
  await tx(db.server, (c) =>
    appendEvents(
      c,
      'server',
      'server',
      '2.0.0',
      Array.from({ length: n }, (_, i) => ({ type, clusterId: 'c1', payload: { i } })),
    ),
  );
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack]);
  listener = new OutboxListener(db.serverConfig, 'events-storm-test');
  listener.start();
  app = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerEvents(app, {
    pool: db.server,
    schema: 'server',
    owner: 'server',
    listener,
    authorize: async () => () => true,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const a = app.server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  // 页面打开之前已经积累的历史事件
  await append(500);
}, 120_000);

afterAll(async () => {
  app?.server.closeAllConnections();
  await app?.close();
  await listener?.stop();
  await db?.close();
});

describe('事件流的起始位置', () => {
  it('长轮询不带游标：不返回历史事件，next 指向当前末尾；带游标照常从游标读', async () => {
    const r = (await (await fetch(`${base}/v1/events?limit=500`)).json()) as { events: unknown[]; next: string };
    expect(r.events).toHaveLength(0);
    const tail = Number(r.next.split(':')[1]);
    expect(tail).toBeGreaterThanOrEqual(500);
    const from0 = (await (await fetch(`${base}/v1/events?after=server:0&limit=500`)).json()) as { events: unknown[] };
    expect(from0.events).toHaveLength(500);
  });

  it('SSE 不带 Last-Event-ID：只推送连接之后的新事件；带 Last-Event-ID 时从游标续传', async () => {
    const live = sse(`${base}/v1/events`, {});
    await live.until((t) => t.includes('retry:'), 2_000);
    await new Promise((r) => setTimeout(r, 600));
    expect(live.text().match(/^event: /gm) ?? []).toHaveLength(0);
    await append(3, 'condition.changed');
    await live.until((t) => (t.match(/^event: /gm) ?? []).length >= 3, 5_000);
    expect(live.text().match(/^event: .+$/gm)).toEqual([
      'event: condition.changed',
      'event: condition.changed',
      'event: condition.changed',
    ]);
    live.close();

    const resumed = sse(`${base}/v1/events`, { 'last-event-id': 'server:0' });
    await resumed.until((t) => t.includes('"i":499'), 5_000);
    expect(resumed.text()).toContain('"i":499');
    resumed.close();
  });
});

/** 在后台持续读取一个 SSE 响应，累积文本 */
function sse(url: string, headers: Record<string, string>) {
  const ac = new AbortController();
  let text = '';
  void fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal })
    .then(async (res) => {
      const dec = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        text += dec.decode(chunk, { stream: true });
      }
    })
    .catch(() => undefined);
  return {
    text: () => text,
    async until(pred: (t: string) => boolean, ms: number) {
      const deadline = Date.now() + ms;
      while (!pred(text) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: () => ac.abort(),
  };
}

describe('读接口限流', () => {
  it('令牌桶：突发用完后按速率补充，返回需要等待的秒数', () => {
    const l = new ReadLimiter({ perSecond: 5, burst: 3 });
    expect([l.take('a', 0), l.take('a', 0), l.take('a', 0)]).toEqual([0, 0, 0]);
    expect(l.take('a', 0)).toBe(1);
    expect(l.take('b', 0)).toBe(0);
    expect(l.take('a', 200)).toBe(0);
    expect(l.take('a', 200)).toBe(1);
  });

  it('同一个会话对同一个读接口超过每秒上限时 429 并计数；其他会话、其他接口、服务令牌与事件流不受影响', async () => {
    const reg = new Registry();
    const limited = new Counter({ name: 'limited_total', help: 'x', labelNames: ['route'] as const, registers: [reg] });
    const a = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
    let t = 0;
    registerReadLimit(a, limited, { perSecond: 5, burst: 10 }, () => t);
    a.get('/v1/incidents', async () => ({ items: [] }));
    a.get('/v1/conditions', async () => ({ items: [] }));
    a.get('/v1/events', async () => ({ events: [] }));
    const get = (url: string, session: string | null, headers: Record<string, string> = {}) =>
      a.inject({
        method: 'GET',
        url,
        headers: { ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}), ...headers },
      });
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) {
      codes.push((await get('/v1/incidents?state=firing&feedback=all&suppressed=false', 's1')).statusCode);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(20);
    const r = await get('/v1/incidents?state=firing', 's1');
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
    expect(r.json()).toMatchObject({ error: 'rate_limited' });
    expect((await get('/v1/incidents', 's2')).statusCode).toBe(200);
    expect((await get('/v1/conditions', 's1')).statusCode).toBe(200);
    expect((await get('/v1/incidents', null, { authorization: 'Bearer svc' })).statusCode).toBe(200);
    for (let i = 0; i < 30; i++) {
      expect((await get('/v1/events', 's1')).statusCode).toBe(200);
    }
    t += 1000;
    expect((await get('/v1/incidents', 's1')).statusCode).toBe(200);
    const m = await reg.getSingleMetric('limited_total')?.get();
    expect(m?.values).toEqual([{ labels: { route: '/v1/incidents' }, value: 21 }]);
    await a.close();
  });
});
