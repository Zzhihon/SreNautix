import type { ChangeEvent } from '@srenautix/contract';
import { DatasourceError } from '@srenautix/integration-sdk';
import { GitHubError, type GitHubApp } from '../github/app.js';

/**
 * changes/v1 的 GitHub 适配器（integrations/github，ADR 0096）：经 GitHub App 的安装令牌用 REST API 读取分支在窗口内的提交，
 * 再逐个读取提交的 diff（改动的文件），按路径前缀映射到拓扑节点。hub 镜像不带 git，所以不克隆仓库。
 * 与通用 git 适配器的输出相同：不含合并提交，时间取提交时间，change_id 为 <实例 id>:<sha>，新的在前。
 */
export interface GitHubChangesConfig {
  id: string;
  /** owner/name */
  repo: string;
  branch: string;
  paths: Array<{ prefix: string; targets: string[]; kind: ChangeEvent['kind'] }>;
}

interface CommitItem {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; email: string } | null; committer: { date: string } | null };
  parents: unknown[];
}

const PER_PAGE = 100;
/** 一次同步最多翻的页数；超过时只取最新的部分并标记截断 */
const MAX_PAGES = 10;

export class GitHubChangesAdapter {
  /** 已读取过 diff 的提交 → 改动的文件；只保留最近一次列表中出现过的提交 */
  private files = new Map<string, string[]>();

  constructor(
    private readonly gh: GitHubApp,
    readonly config: GitHubChangesConfig,
  ) {}

  private async call<T>(path: string, op: string): Promise<T> {
    try {
      return await this.gh.api<T>('GET', path, undefined, op);
    } catch (e) {
      if (e instanceof GitHubError) {
        throw new DatasourceError(this.config.id, `仓库 ${this.config.repo}：${e.message}`);
      }
      throw e;
    }
  }

  async list(
    window: { from: string; to: string },
    limit: number,
  ): Promise<{ changes: ChangeEvent[]; truncated: boolean }> {
    const c = this.config;
    const commits: CommitItem[] = [];
    let truncated = false;
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({
        sha: c.branch,
        since: window.from,
        until: window.to,
        per_page: String(PER_PAGE),
        page: String(page),
      });
      const items = await this.call<CommitItem[]>(`/repos/${c.repo}/commits?${q.toString()}`, 'list_commits');
      commits.push(...items);
      if (items.length < PER_PAGE) {
        break;
      }
      if (page >= MAX_PAGES) {
        truncated = true;
        break;
      }
    }
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    const seen = new Map<string, string[]>();
    const events: ChangeEvent[] = [];
    for (const item of commits) {
      // 与 git log --no-merges 相同：合并提交的改动已经在被合并的提交里
      if (item.parents.length > 1) {
        continue;
      }
      const time = item.commit.committer?.date ?? null;
      const t = time ? Date.parse(time) : NaN;
      if (!(t >= from && t <= to)) {
        continue;
      }
      let files = this.files.get(item.sha);
      if (!files) {
        const detail = await this.call<{ files?: Array<{ filename: string }> }>(
          `/repos/${c.repo}/commits/${item.sha}`,
          'get_commit',
        );
        files = (detail.files ?? []).map((f) => f.filename);
      }
      seen.set(item.sha, files);
      const hits = c.paths.filter((p) => files.some((f) => f.startsWith(p.prefix)));
      if (!hits.length) {
        continue;
      }
      const subject = item.commit.message.split('\n')[0] ?? '';
      const a = item.commit.author;
      events.push({
        change_id: `${c.id}:${item.sha}`,
        source: c.id,
        kind: hits[0]!.kind,
        refs: [item.sha.slice(0, 12)],
        revision: item.sha,
        actor: a ? `${a.name} <${a.email}>` : null,
        time: new Date(t).toISOString(),
        link: item.html_url,
        targets: [...new Set(hits.flatMap((h) => h.targets))].sort(),
        summary: subject.slice(0, 500),
      });
    }
    this.files = seen;
    events.sort((x, y) => (x.time < y.time ? 1 : x.time > y.time ? -1 : x.change_id < y.change_id ? -1 : 1));
    const over = events.length > limit;
    return { changes: over ? events.slice(0, limit) : events, truncated: truncated || over };
  }
}
