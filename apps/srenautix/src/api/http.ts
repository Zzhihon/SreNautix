import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { logger } from '../log.js';
import { HttpError } from './errors.js';

export interface AppOptions {
  /** 请求体上限（字节）；webhook 载荷可能较大。 */
  bodyLimit: number;
  /** 信任的反向代理层数，用于取客户端地址。 */
  trustProxy: boolean;
}

/**
 * fastify 实例：统一的错误格式 `{error, message}`，不使用 fastify 自带的日志（统一走 JSON 日志），
 * 原始请求体保留在 req.rawBody（webhook 签名校验需要原文）。
 */
export async function createApp(o: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: o.bodyLimit, trustProxy: o.trustProxy, disableRequestLogging: true });
  await app.register(cookie);

  app.removeAllContentTypeParsers();
  app.addContentTypeParser(['application/json', 'application/*+json'], { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    (req as RawBodyRequest).rawBody = buf;
    if (buf.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(buf.toString('utf8')));
    } catch {
      done(new HttpError(400, 'bad_request', '请求体不是合法 JSON'), undefined);
    }
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
    (req as RawBodyRequest).rawBody = body as Buffer;
    done(null, body);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) {
      void reply.code(err.status).send({ error: err.code, message: err.message });
      return;
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      void reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
      return;
    }
    logger.error('接口处理失败', { method: req.method, path: req.url, error: err });
    void reply.code(500).send({ error: 'internal', message: err.message });
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: 'not_found', message: '没有这个接口' });
  });
  return app;
}

export interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

export function rawBody(req: FastifyRequest): Buffer {
  return (req as RawBodyRequest).rawBody ?? Buffer.alloc(0);
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
