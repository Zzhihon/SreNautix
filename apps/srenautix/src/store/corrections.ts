import type pg from 'pg';
import type { Leader } from '../api/leader.js';
import { logger } from '../log.js';

/**
 * 一次性数据修正（ADR 0176）。迁移在新版本的进程启动时执行，这时旧版本的实例可能仍是主实例、仍按旧语义写这些数据；
 * 迁移因此只改 schema，按新语义修正已有数据放在这里：本版本取得主实例之后、开始任何单活工作之前执行一次，
 * 记录在 server.data_corrections，之后的启动与主实例切换都不再执行。
 */
export interface Correction {
  /** <模块>/<说明>，全局唯一 */
  name: string;
  /** 在事务里执行，返回改动的行数 */
  run(c: pg.PoolClient): Promise<number>;
}

/** 执行还没有执行过的修正，返回本次执行的（名字，行数）。多个实例同时执行时由咨询锁串行，已记录的跳过 */
export async function runCorrections(
  pool: pg.Pool,
  list: readonly Correction[],
  holder: string,
): Promise<Array<{ name: string; rows: number }>> {
  const names = list.map((x) => x.name);
  if (new Set(names).size !== names.length) {
    throw new Error(`数据修正的名字重复：${names.join('、')}`);
  }
  const out: Array<{ name: string; rows: number }> = [];
  for (const x of list) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`srenautix.correction.${x.name}`]);
      const done = await c.query('SELECT 1 FROM server.data_corrections WHERE name = $1', [x.name]);
      if (done.rowCount) {
        await c.query('COMMIT');
        continue;
      }
      const rows = await x.run(c);
      await c.query('INSERT INTO server.data_corrections (name, holder, rows) VALUES ($1, $2, $3)', [
        x.name,
        holder,
        rows,
      ]);
      await c.query('COMMIT');
      out.push({ name: x.name, rows });
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  return out;
}

/** 修正失败后重试的间隔 */
export const CORRECTION_RETRY_MS = 30_000;

/**
 * 包装主实例身份：取得主实例之后先执行数据修正，全部完成之后 isLeader 才为 true、acquired 才 resolve，
 * 单活工作因此不会在修正之前读写这些数据。修正失败时记 error 日志，仍是主实例时按 CORRECTION_RETRY_MS 重试，
 * 期间单活工作暂停（失败的原因要修复，修正不跳过）。
 */
export function afterCorrections(
  inner: Leader,
  pool: pg.Pool,
  list: readonly Correction[],
  holder: string,
  retryMs = CORRECTION_RETRY_MS,
): Leader {
  let done = false;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((r) => (resolveReady = r));
  let stopped = false;
  const attempt = async (): Promise<void> => {
    while (!stopped) {
      await inner.acquired();
      if (stopped) {
        return;
      }
      if (!inner.isLeader()) {
        await new Promise((r) => setTimeout(r, Math.min(retryMs, 1_000)).unref());
        continue;
      }
      try {
        const applied = await runCorrections(pool, list, holder);
        if (applied.length) {
          logger.info('取得主实例后执行了数据修正', { applied, holder });
        }
        done = true;
        resolveReady();
        return;
      } catch (e) {
        logger.error('数据修正失败，单活工作暂停，稍后重试', { error: e });
        await new Promise((r) => setTimeout(r, retryMs).unref());
      }
    }
  };
  void attempt();
  return {
    isLeader: () => done && inner.isLeader(),
    acquired: () => ready,
    stop: async () => {
      stopped = true;
      await inner.stop();
    },
  };
}
