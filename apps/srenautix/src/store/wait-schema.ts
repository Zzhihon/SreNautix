import { logger } from '../log.js';
import { createPool, type PgConfig } from './pool.js';

export interface WaitSchemaOptions {
  /** 两次检查之间的间隔 */
  intervalMs: number;
  /** 未就绪时至多每隔这么久记一条日志 */
  logEveryMs: number;
  signal?: AbortSignal;
}

/**
 * 以角色自己的库角色等待它的 schema 就绪：schema 存在且属于当前库角色（`db bootstrap` 建好之后的状态）。
 * 连接失败（PostgreSQL 尚未就绪、库角色尚未创建）与 schema 不存在都继续等待；signal 中止时抛出。
 * chart 在 server、worker 的 initContainer 中运行（`db wait --schema=<角色>`），使主进程不会在 bootstrap 之前启动。
 */
export async function waitForSchema(cfg: PgConfig, schema: string, o: WaitSchemaOptions): Promise<void> {
  const pool = createPool(cfg, 'srenautix-db-wait', 1);
  let lastLog = 0;
  try {
    for (;;) {
      o.signal?.throwIfAborted();
      let state: string;
      try {
        const r = await pool.query<{ owner: string | null; me: string }>(
          'SELECT (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = $1) AS owner, current_user AS me',
          [schema],
        );
        const row = r.rows[0] as { owner: string | null; me: string };
        if (row.owner === row.me) {
          logger.info('schema 已就绪', { schema, owner: row.owner });
          return;
        }
        state = row.owner === null ? 'schema 不存在' : `schema 属于 ${row.owner}，不属于 ${row.me}`;
      } catch (e) {
        state = `连接或查询失败：${e instanceof Error ? e.message : String(e)}`;
      }
      if (Date.now() - lastLog >= o.logEveryMs) {
        logger.info('等待 db bootstrap 建好 schema', { schema, state });
        lastLog = Date.now();
      }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, o.intervalMs);
        o.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(o.signal?.reason);
          },
          { once: true },
        );
      });
    }
  } finally {
    await pool.end();
  }
}
