import type { ChangeEvent } from '@srenautix/contract';
import { DatasourceError, toIso } from '@srenautix/integration-sdk';
import type pg from 'pg';
import { parseDuration } from '../config/files.js';
import type { ServerConfig } from '../config/server.js';
import type { GitHubApp } from '../github/app.js';
import { logger } from '../log.js';
import { GitHubChangesAdapter } from './github.js';
import { SqlAuditReader, type SqlAuditSourceConfig } from './sql-audit.js';

export type ChangeSourceConfig = ServerConfig['changes']['sources'][number];

export interface ChangeSourceStatus {
  id: string;
  clusterId: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/** 一个变更源：读取一段时间内的变更；reconcile 为 true 时这段时间内的变更以本次读到的为准（不再成立的删除） */
interface Source {
  id: string;
  clusterId: string;
  reconcile: boolean;
  list(from: Date, to: Date, limit: number): Promise<{ changes: ChangeEvent[]; truncated: boolean }>;
}

/**
 * 变更源同步（changes/v1，DESIGN §5）：按 change_id 写入 server.change_events，有新变更时调用 onNew（重算事件）。
 * - GitHub 仓库：经 GitHub App 的 REST API 读取回看窗口内触及映射路径的提交（ADR 0096），已写入的变更不再改动；
 * - SQL 审计表（ADR 0151）：业务库里运行时配置的审计记录。每次重算回看窗口内的全部变更：内容变了的更新，
 *   之后变得不成立的（短时间内又改回原来的取值）从窗口内删除，与从拓扑推导的发布每次重算相同。
 * 单个变更源失败只记录在它的状态中，不影响其他变更源。
 */
export class ChangesService {
  private readonly sources: Source[];
  private readonly audits: SqlAuditReader[];

  constructor(
    private readonly pool: pg.Pool,
    sources: readonly ChangeSourceConfig[],
    o: { github: GitHubApp | null; defaultClusterId: string; sqlAudit: readonly SqlAuditSourceConfig[] },
    private readonly lookbackMs: number,
    private readonly onNew: () => void,
  ) {
    const gh = o.github;
    if (sources.length && !gh) {
      throw new Error('GitHub 变更源需要 github_app');
    }
    this.audits = o.sqlAudit.map(
      (cfg) => new SqlAuditReader(cfg, parseDuration(`changes.sql_audit.${cfg.id}.group_within`, cfg.group_within)),
    );
    this.sources = [
      ...sources.map((cfg): Source => {
        const adapter = new GitHubChangesAdapter(gh!, {
          id: cfg.id,
          repo: cfg.repo,
          branch: cfg.branch,
          paths: cfg.paths,
        });
        return {
          id: cfg.id,
          clusterId: cfg.cluster_id ?? o.defaultClusterId,
          reconcile: false,
          list: (from, to, limit) => adapter.list({ from: toIso(from.getTime()), to: toIso(to.getTime()) }, limit),
        };
      }),
      ...this.audits.map((r): Source => ({
        id: r.cfg.id,
        clusterId: r.cfg.cluster_id ?? o.defaultClusterId,
        reconcile: true,
        list: (from, to) => r.list(from, to),
      })),
    ];
  }

  get configured(): boolean {
    return this.sources.length > 0;
  }

  /**
   * 经同一个连接（host、port、database、user）读取的审计关系：dbstats 与 SQL 审计表变更源共用只读角色时，
   * dbstats 的权限自检不把它们算作越权（ADR 0151）
   */
  auditRelations(conn: { host: string; port: number; database: string; user: string }): string[] {
    return [
      ...new Set(
        this.audits
          .filter(
            (r) =>
              r.cfg.connection.host === conn.host &&
              r.cfg.connection.port === conn.port &&
              r.cfg.connection.database === conn.database &&
              r.cfg.connection.user === conn.user,
          )
          .flatMap((r) => r.relations),
      ),
    ];
  }

  /** 同步全部变更源一次；返回每个变更源写入、更新与删除的条数（失败的为 null）。 */
  async syncOnce(now = Date.now()): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    let changed = 0;
    const from = new Date(now - this.lookbackMs);
    const to = new Date(now);
    for (const s of this.sources) {
      try {
        const r = await s.list(from, to, 5_000);
        if (r.truncated) {
          logger.warn('变更源在回看窗口内的变更超过上限，只取一部分', { source: s.id });
        }
        const n = await this.store(s, r.changes, from);
        await this.pool.query(
          `INSERT INTO server.change_sources (source_id, last_synced_at, last_error, last_error_at) VALUES ($1, now(), NULL, NULL)
           ON CONFLICT (source_id) DO UPDATE SET last_synced_at = now(), last_error = NULL, last_error_at = NULL`,
          [s.id],
        );
        out[s.id] = n;
        changed += n;
      } catch (e) {
        if (!(e instanceof DatasourceError)) {
          throw e;
        }
        logger.warn('变更源同步失败，下一轮重试', { source: s.id, error: e.message });
        await this.pool.query(
          `INSERT INTO server.change_sources (source_id, last_error, last_error_at) VALUES ($1, $2, now())
           ON CONFLICT (source_id) DO UPDATE SET last_error = $2, last_error_at = now()`,
          [s.id, e.message],
        );
        out[s.id] = null;
      }
    }
    if (changed) {
      this.onNew();
    }
    return out;
  }

  private async store(s: Source, changes: ChangeEvent[], from: Date): Promise<number> {
    let n = 0;
    for (const c of changes) {
      const r = await this.pool.query(
        s.reconcile
          ? `INSERT INTO server.change_events (change_id, cluster_id, source, time, targets, body) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (change_id) DO UPDATE SET time = EXCLUDED.time, targets = EXCLUDED.targets, body = EXCLUDED.body
             WHERE server.change_events.body IS DISTINCT FROM EXCLUDED.body`
          : `INSERT INTO server.change_events (change_id, cluster_id, source, time, targets, body) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (change_id) DO NOTHING`,
        [c.change_id, s.clusterId, c.source, c.time, c.targets, JSON.stringify(c)],
      );
      n += r.rowCount ?? 0;
    }
    if (s.reconcile) {
      const r = await this.pool.query(
        `DELETE FROM server.change_events
          WHERE source = $1 AND cluster_id = $2 AND time >= $3 AND NOT (change_id = ANY($4::text[]))`,
        [s.id, s.clusterId, from, changes.map((c) => c.change_id)],
      );
      n += r.rowCount ?? 0;
    }
    return n;
  }

  /** 连接测试：对一个变更源读取最近 1 小时的变更，不写入。返回说明，失败时抛出。 */
  async verify(id: string, now = Date.now()): Promise<string> {
    const s = this.sources.find((x) => x.id === id);
    if (!s) {
      throw new Error(`没有变更源 ${id}`);
    }
    const r = await s.list(new Date(now - 3600_000), new Date(now), 1_000);
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
      const row = r.rows.find((x) => x.source_id === s.id);
      return {
        id: s.id,
        clusterId: s.clusterId,
        lastSyncedAt: row?.last_synced_at ?? null,
        lastError: row?.last_error ?? null,
        lastErrorAt: row?.last_error_at ?? null,
      };
    });
  }

  /** 关闭 SQL 审计表变更源的连接 */
  async close(): Promise<void> {
    await Promise.all(this.audits.map((r) => r.close()));
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
