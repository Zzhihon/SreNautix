import type { FastifyInstance } from 'fastify';
import type { Counter } from 'prom-client';
import { SESSION_COOKIE } from '../identity/sessions.js';

// 控制台读接口的限流（防护前端请求风暴）：同一个浏览器会话对同一个读接口（按路由模板，不含查询参数）
// 用令牌桶限流，超过时返回 429 与 Retry-After，并计数。只限 GET 与会话 cookie：服务调用方（worker、gateway、
// Grafana 插件）各自的令牌由各自的协议约束；长连接的事件流不受限。

export interface ReadLimitOptions {
  /** 每秒补充的请求数 */
  perSecond: number;
  /** 桶容量（短时突发） */
  burst: number;
}

/** 正常页面每个读接口每秒最多几次（首屏、事件流触发的合并重取、手动刷新）；风暴是每秒数十到数百次 */
export const DEFAULT_READ_LIMIT: ReadLimitOptions = { perSecond: 5, burst: 20 };

/** 不限流的读接口：长连接或探活 */
const EXEMPT = new Set(['/v1/events', '/healthz', '/readyz', '/v1/auth/session']);

const IDLE_MS = 5 * 60_000;

interface Bucket {
  tokens: number;
  at: number;
}

export class ReadLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly o: ReadLimitOptions = DEFAULT_READ_LIMIT) {}

  /** 取一个令牌；返回 0 表示放行，否则为需要等待的秒数（向上取整，至少 1） */
  take(key: string, now: number): number {
    this.sweep(now);
    const b = this.buckets.get(key) ?? { tokens: this.o.burst, at: now };
    b.tokens = Math.min(this.o.burst, b.tokens + ((now - b.at) / 1000) * this.o.perSecond);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.o.perSecond));
  }

  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < IDLE_MS) {
      return;
    }
    this.lastSweep = now;
    for (const [k, b] of this.buckets) {
      if (now - b.at > IDLE_MS) {
        this.buckets.delete(k);
      }
    }
  }
}

/** 在注册路由之前调用：对带会话 cookie 的 GET 读接口限流 */
export function registerReadLimit(
  app: FastifyInstance,
  limited: Counter<'route'>,
  o: ReadLimitOptions = DEFAULT_READ_LIMIT,
  now: () => number = Date.now,
): ReadLimiter {
  const limiter = new ReadLimiter(o);
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'GET') {
      return;
    }
    const session = req.cookies[SESSION_COOKIE];
    const route = req.routeOptions.url;
    if (!session || !route || !route.startsWith('/v1/') || EXEMPT.has(route)) {
      return;
    }
    const wait = limiter.take(`${session}\0${route}`, now());
    if (wait === 0) {
      return;
    }
    limited.inc({ route });
    return reply
      .code(429)
      .header('retry-after', String(wait))
      .send({ error: 'rate_limited', message: `对 ${route} 的请求过于频繁，请 ${wait} 秒后重试` });
  });
  return limiter;
}
