import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ChangeEvent } from '@srenautix/contract';
import { DatasourceError, GitChangesAdapter, toIso } from '@srenautix/integration-sdk';
import type pg from 'pg';
import { readSecretFile } from '../config/files.js';
import type { ServerConfig } from '../config/server.js';
import { logger } from '../log.js';

const run = promisify(execFile);

export type ChangeSourceConfig = ServerConfig['changes']['sources'][number];

export interface ChangeSourceStatus {
  id: string;
  clusterId: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/**
 * 一个 git 变更源的只读克隆：首次 clone（--no-checkout，不下载文件内容，只需要提交与树），之后每次同步 fetch。
 * 凭证经环境变量交给 git，不出现在命令行参数中：https 令牌以 GIT_CONFIG_* 设置 http.extraHeader，
 * ssh 部署密钥经 GIT_SSH_COMMAND，并且只信任 known_hosts_file 中的主机密钥。
 */
class GitMirror {
  constructor(
    readonly dir: string,
    private readonly s: ChangeSourceConfig,
  ) {}

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (this.s.http_token_file) {
      const token = readSecretFile(`changes.sources.${this.s.id}.http_token_file`, this.s.http_token_file);
      const basic = Buffer.from(`${this.s.http_username}:${token}`).toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    if (this.s.deploy_key_file) {
      env.GIT_SSH_COMMAND = [
        'ssh',
        '-i',
        this.s.deploy_key_file,
        '-o IdentitiesOnly=yes',
        '-o StrictHostKeyChecking=yes',
        `-o UserKnownHostsFile=${this.s.known_hosts_file}`,
      ].join(' ');
    }
    return env;
  }

  private async git(args: string[]): Promise<void> {
    try {
      await run('git', args, { env: this.env(), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      // 错误信息可能含有克隆地址，不含凭证（凭证只在环境变量中）
      throw new DatasourceError(
        this.s.id,
        `git ${args[0] === '-C' ? args[2] : args[0]} 失败：${(err.stderr || err.message).trim().slice(0, 500)}`,
      );
    }
  }

  async refresh(): Promise<void> {
    if (!existsSync(join(this.dir, '.git'))) {
      mkdirSync(this.dir, { recursive: true });
      await this.git(['clone', '--quiet', '--no-checkout', '--filter=blob:none', this.s.url, this.dir]);
      return;
    }
    await this.git(['-C', this.dir, 'fetch', '--quiet', '--prune', 'origin']);
  }
}

/**
 * 变更源同步（changes/v1，DESIGN §5）：每个变更源维护只读克隆，定期 fetch，再用 integration-sdk 的 git 适配器
 * 读取回看窗口内触及映射路径的提交，按 change_id 去重写入 server.change_events。有新变更时调用 onNew（重算事件）。
 * 单个变更源失败只记录在它的状态中，不影响其他变更源。
 */
export class ChangesService {
  private readonly sources: Array<{
    cfg: ChangeSourceConfig;
    clusterId: string;
    mirror: GitMirror;
    adapter: GitChangesAdapter;
  }>;

  constructor(
    private readonly pool: pg.Pool,
    sources: readonly ChangeSourceConfig[],
    o: { cacheDir: string; defaultClusterId: string },
    private readonly lookbackMs: number,
    private readonly onNew: () => void,
  ) {
    this.sources = sources.map((cfg) => {
      const mirror = new GitMirror(join(o.cacheDir, cfg.id), cfg);
      return {
        cfg,
        clusterId: cfg.cluster_id ?? o.defaultClusterId,
        mirror,
        adapter: new GitChangesAdapter({
          id: cfg.id,
          repo_dir: mirror.dir,
          ref: cfg.ref,
          link_template: cfg.link_template ?? null,
          paths: cfg.paths,
        }),
      };
    });
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
        await s.mirror.refresh();
        const window = { from: toIso(now - this.lookbackMs), to: toIso(now) };
        const r = await s.adapter.list(
          { scope: { cluster_id: s.clusterId, namespaces: [], components: [] }, window, limit: 5_000 },
          window,
        );
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

  /** 连接测试：对一个变更源执行一次 fetch 与最近 1 小时的 changes.list，不写入变更。返回说明，失败时抛出。 */
  async verify(id: string, now = Date.now()): Promise<string> {
    const s = this.sources.find((x) => x.cfg.id === id);
    if (!s) {
      throw new Error(`没有变更源 ${id}`);
    }
    await s.mirror.refresh();
    const window = { from: toIso(now - 3600_000), to: toIso(now) };
    const r = await s.adapter.list(
      { scope: { cluster_id: s.clusterId, namespaces: [], components: [] }, window, limit: 1_000 },
      window,
    );
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
