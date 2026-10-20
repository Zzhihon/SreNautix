import { createServer, type Server } from 'node:http';
import { logger } from '../log.js';

// 启动时等待数据库就绪（ADR 0102）。chart 的 initContainer（db wait，store/wait-schema.ts）先等 schema 建好；
// 主进程这一层兜底 initContainer 之后的情况（数据库重启、bootstrap 被重做、不用 chart 的部署）：schema、数据库、角色或授权还没有由 db bootstrap 建好，或者数据库暂时连不上时，
// 不退出，按退避重试扩展迁移；等待期间临时的探针端口 /healthz 为 200（进程活着，kubelet 不重启它），
// /readyz 为 503 并写明原因。其他迁移错误（SQL 错误、收缩迁移不兼容）照常抛出，进程退出。

/** 数据库还没准备好的 PostgreSQL 错误码：schema 不存在、数据库不存在、角色或口令不对、没有授权、正在启动 */
const NOT_READY_PG = new Set(['3F000', '3D000', '28000', '28P01', '42501', '57P03']);
/** 连接层的错误：数据库暂时连不上 */
const NOT_READY_NET = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'EAI_AGAIN']);

export function databaseNotReady(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') {
    return null;
  }
  if (NOT_READY_PG.has(code) || NOT_READY_NET.has(code)) {
    return `${code}: ${(e as Error).message}`;
  }
  return null;
}

export interface WaitOptions {
  /** 等待期间临时监听的探针地址；null 时不监听（测试与不开辅助端口的运行方式） */
  probes: { host?: string | undefined; port: number } | null;
  signal?: AbortSignal;
  /** 第一次重试的间隔，之后倍增到 maxDelayMs */
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** 执行 migrate，数据库没准备好时重试直到成功；返回 migrate 的结果 */
export async function migrateWhenReady<T>(role: string, migrate: () => Promise<T>, o: WaitOptions): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let delay = o.initialDelayMs ?? 2_000;
  const max = o.maxDelayMs ?? 30_000;
  let reason = '';
  let probes: Server | null = null;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await migrate();
      } catch (e) {
        const why = databaseNotReady(e);
        if (why === null || o.signal?.aborted) {
          throw e;
        }
        reason = why;
        if (!probes && o.probes) {
          probes = createServer((req, res) => {
            if (req.url === '/healthz') {
              res.writeHead(200).end('ok');
            } else if (req.url === '/readyz') {
              res.writeHead(503).end(`not ready: waiting for the database (${reason})`);
            } else {
              res.writeHead(404).end();
            }
          });
          probes.listen(o.probes.port, o.probes.host ?? '0.0.0.0');
        }
        logger.warn('数据库还没有准备好，稍后重试扩展迁移', { role, attempt, reason, retry_in_ms: delay });
        await sleep(delay);
        delay = Math.min(max, delay * 2);
      }
    }
  } finally {
    const p = probes as Server | null;
    if (p) {
      await new Promise<void>((r) => p.close(() => r()));
    }
  }
}
