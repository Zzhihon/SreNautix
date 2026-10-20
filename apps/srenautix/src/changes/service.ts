import type { ChangeEvent } from '@srenautix/contract';
import { DatasourceError, toIso } from '@srenautix/integration-sdk';
import type pg from 'pg';
import type { ServerConfig } from '../config/server.js';
import type { GitHubApp } from '../github/app.js';
import { logger } from '../log.js';
import { GitHubChangesAdapter } from './github.js';

export type ChangeSourceConfig = ServerConfig['changes']['sources'][number];

export interface ChangeSourceStatus {
  id: string;
  clusterId: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/**
 * 变更源同步（changes/v1，DESIGN §5）：每个变更源是 GitHub 上的一个仓库分支，经 GitHub App 的 REST API 读取回看窗口内
 * 触及映射路径的提交（ADR 0096），按 change_id 去重写入 server.change_events。有新变更时调用 onNew（重算事件）。
 * 单个变更源失败只记录在它的状态中，不影响其他变更源。
 */
export class ChangesService {
  private readonly sources: Array<{ cfg: ChangeSourceConfig; clusterId: string; adapter: GitHubChangesAdapter }>;

  constructor(
    private readonly pool: pg.Pool,
    sources: readonly ChangeSourceConfig[],
    o: { github: GitHubApp | null; defaultClusterId: string },
    private readonly lookbackMs: number,
    private readonly onNew: () => void,
  ) {
    const gh = o.github;
    if (sources.length && !gh) {
      throw new Error('GitHub 变更源需要 github_app');
    }
    this.sources = sources.map((cfg) => ({
      cfg,
      clusterId: cfg.cluster_id ?? o.defaultClusterId,
      adapter: new GitHubChangesAdapter(gh!, { id: cfg.id, repo: cfg.repo, branch: cfg.branch, paths: cfg.paths }),
    }));
  }

  get configured(): boolean {
    return this.sources.length > 0;
  }

  /** 同步全部变更源一次；返回每个变更源新写入的条数（失败的为 null）。 */
  async syncOnce(now = Date.now()): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    let added = 0;
    for (const s of this.sources) {
      try {
        const r = await s.adapter.list({ from: toIso(now - this.lookbackMs), to: toIso(now) }, 5_000);
        if (r.truncated) {
          logger.warn('变更源在回看窗口内的变更超过上限，只取最新的部分', { source: s.cfg.id });
        }
        const n = await this.store(s.clusterId, r.changes);
        await this.pool.query(
          `INSERT INTO server.change_sources (source_id, last_synced_at, last_error, last_error_at) VALUES ($1, now(), NULL, NULL)
           ON CONFLICT (source_id) DO UPDATE SET last_synced_at = now(), last_error = NULL, last_error_at = NULL`,
          [s.cfg.id],
        );
        out[s.cfg.id] = n;
        added += n;
      } catch (e) {
        if (!(e instanceof DatasourceError)) {
          throw e;
        }
        logger.warn('变更源同步失败，下一轮重试', { source: s.cfg.id, error: e.message });
        await this.pool.query(
          `INSERT INTO server.change_sources (source_id, last_error, last_error_at) VALUES ($1, $2, now())
           ON CONFLICT (source_id) DO UPDATE SET last_error = $2, last_error_at = now()`,
          [s.cfg.id, e.message],
        );
        out[s.cfg.id] = null;
      }
    }
    if (added) {
      this.onNew();
    }
    return out;
  }

  private async store(clusterId: string, changes: ChangeEvent[]): Promise<number> {
    let n = 0;
    for (const c of changes) {
      const r = await this.pool.query(
        `INSERT INTO server.change_events (change_id, cluster_id, source, time, targets, body) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (change_id) DO NOTHING`,
        [c.change_id, clusterId, c.source, c.time, c.targets, JSON.stringify(c)],
      );
      n += r.rowCount ?? 0;
    }
    return n;
  }

  /** 连接测试：对一个变更源读取最近 1 小时的 changes.list，不写入变更。返回说明，失败时抛出。 */
  async verify(id: string, now = Date.now()): Promise<string> {
    const s = this.sources.find((x) => x.cfg.id === id);
    if (!s) {
      throw new Error(`没有变更源 ${id}`);
    }
    const r = await s.adapter.list({ from: toIso(now - 3600_000), to: toIso(now) }, 1_000);
    return `最近 1 小时 ${r.changes.length}${r.truncated ? '+' : ''} 个变更`;
  }

  async statuses(): Promise<ChangeSourceStatus[]> {
    const r = await this.pool.query<{
      source_id: string;
      last_synced_at: Date | null;
      last_error: string | null;
      last_error_at: Date | null;
    }>('SELECT source_id, last_synced_at, last_error, last_error_at FROM server.change_sources');
    return this.sources.map((s) => {
      const row = r.rows.find((x) => x.source_id === s.cfg.id);
      return {
        id: s.cfg.id,
        clusterId: s.clusterId,
        lastSyncedAt: row?.last_synced_at ?? null,
        lastError: row?.last_error ?? null,
        lastErrorAt: row?.last_error_at ?? null,
      };
    });
  }
}

/** 事件引擎读取的变更：集群在 [from, to] 内的全部变更，按时间排序。 */
export async function changesInWindow(pool: pg.Pool, clusterId: string, from: Date, to: Date): Promise<ChangeEvent[]> {
  const r = await pool.query<{ body: ChangeEvent }>(
    'SELECT body FROM server.change_events WHERE cluster_id = $1 AND time >= $2 AND time <= $3 ORDER BY time, change_id',
    [clusterId, from, to],
  );
  return r.rows.map((x) => x.body);
}
