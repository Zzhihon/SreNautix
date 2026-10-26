import type pg from 'pg';
import { logger } from '../log.js';
import type { Closure } from '../proposals/feedback.js';
import type { RemediationChanges } from '../remediation/dedupe.js';
import { appendAudit } from '../store/audit.js';
import { tx, type Queryable } from '../store/pool.js';
import { GitHubError, type GitHubApp } from './app.js';

// 关闭的跟踪（ADR 0174）：人在 GitHub 上关闭自愈 PR 与事件 issue 也是对研判的反馈。
// - 自愈 PR 关闭且没有合并：隐式反馈 pr_closed，reason 取关闭之前的最后一条人工评论（RemediationChanges.refresh）；
// - 事件 issue 以 not planned 关闭：隐式反馈 issue_not_planned；以 completed 关闭只记下关闭时刻与原因，不写反馈。
// 两者都按规则生成评测候选（ADR 0175）。定时任务每 10 分钟一轮，只刷新打开的 PR 与 issue，每个仓库每轮有上限。

/** 隐式反馈的写入方：FeedbackService.recordClosure，与关闭状态的更新同一事务 */
export type ClosureSink = (c: Queryable, x: Closure) => Promise<unknown>;

/** 每轮每个仓库最多读取的 PR 与 issue 各这么多个 */
export const CLOSURES_PER_REPO = 30;

/** 评论正文带这个标记的是 SreNautix 自己写的（重复触发、进展），不作为人的关闭理由 */
const OWN_MARKER = '<!-- srenautix:';

const COMMENT_PAGE = 100;
/** 最多读取这么多页评论（每页 100 条）找关闭之前的最后一条 */
const MAX_COMMENT_PAGES = 10;

/**
 * 关闭者（GET issues/{n} 的 closed_by，PR 同样适用）与关闭之前的最后一条人工评论（不含 SreNautix 自己的评论；
 * withComment 为 false 时不读评论）
 */
export async function closureDetails(
  gh: GitHubApp,
  repo: string,
  number: number,
  closedAt: Date,
  withComment: boolean,
): Promise<{ closedBy: string | null; comment: string | null }> {
  const issue = await gh.api<{ closed_by?: { login?: string } | null }>(
    'GET',
    `/repos/${repo}/issues/${number}`,
    undefined,
    'get_issue',
  );
  let comment: string | null = null;
  if (withComment) {
    let last: { at: number; body: string } | null = null;
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const list = await gh.api<Array<{ body: string | null; created_at: string }>>(
        'GET',
        `/repos/${repo}/issues/${number}/comments?per_page=${COMMENT_PAGE}&page=${page}`,
        undefined,
        'list_comments',
      );
      for (const c of list) {
        const at = Date.parse(c.created_at);
        const body = (c.body ?? '').trim();
        if (body && !body.includes(OWN_MARKER) && at <= closedAt.getTime() && (!last || at >= last.at)) {
          last = { at, body };
        }
      }
      if (list.length < COMMENT_PAGE) {
        break;
      }
    }
    comment = last?.body ?? null;
  }
  return { closedBy: issue.closed_by?.login ?? null, comment };
}

interface OpenIssue {
  incident_id: string;
  repo: string;
  number: number;
  url: string;
}

export class ClosureTracker {
  constructor(
    private readonly pool: pg.Pool,
    private readonly gh: GitHubApp,
    private readonly changes: RemediationChanges,
    private readonly closed: ClosureSink,
    private readonly perRepo = CLOSURES_PER_REPO,
  ) {}

  /** 一轮：先刷新打开的自愈 PR，再刷新打开的事件 issue；返回两者各自发现的关闭数 */
  async runOnce(): Promise<{ pulls: number; issues: number }> {
    const pulls = await this.changes.refreshOpen(this.perRepo);
    const issues = await this.issues();
    return { pulls, issues };
  }

  private async issues(): Promise<number> {
    const r = await this.pool.query<OpenIssue>(
      `SELECT incident_id, repo, number, url FROM (
         SELECT *, row_number() OVER (PARTITION BY repo ORDER BY checked_at NULLS FIRST, incident_id) AS n
           FROM server.github_issues
          WHERE state = 'open' AND closed_at IS NULL AND number IS NOT NULL AND url IS NOT NULL) x
        WHERE n <= $1 ORDER BY checked_at NULLS FIRST, incident_id`,
      [this.perRepo],
    );
    let closed = 0;
    for (const i of r.rows) {
      try {
        if (await this.issue(i)) {
          closed++;
        }
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        logger.warn('事件 issue 的状态读取失败，下一轮重试', { incident_id: i.incident_id, error: e.message });
        await this.pool.query('UPDATE server.github_issues SET checked_at = now() WHERE incident_id = $1', [
          i.incident_id,
        ]);
      }
    }
    return closed;
  }

  /** 读取一个 issue 的状态；关闭时记下关闭时刻与原因，not planned 时写隐式反馈。返回是否已关闭 */
  private async issue(i: OpenIssue): Promise<boolean> {
    const g = await this.gh.api<{
      state: string;
      state_reason?: string | null;
      closed_at?: string | null;
      closed_by?: { login?: string } | null;
    }>('GET', `/repos/${i.repo}/issues/${i.number}`, undefined, 'get_issue');
    if (g.state !== 'closed') {
      await this.pool.query('UPDATE server.github_issues SET checked_at = now() WHERE incident_id = $1', [
        i.incident_id,
      ]);
      return false;
    }
    if (!g.closed_at) {
      throw new Error(`${i.repo}#${i.number} 已关闭却没有 closed_at`);
    }
    const reason = g.state_reason ?? null;
    await tx(this.pool, async (c) => {
      await c.query(
        `UPDATE server.github_issues SET closed_at = $2, state_reason = $3, checked_at = now() WHERE incident_id = $1`,
        [i.incident_id, new Date(g.closed_at as string), reason],
      );
      await appendAudit(c, 'github.issue_closed', 'server', {
        incident_id: i.incident_id,
        issue: i.url,
        state_reason: reason,
        closed_by: g.closed_by?.login ?? null,
      });
      if (reason === 'not_planned') {
        const run = await c.query<{ run_id: string }>(
          `SELECT run_id FROM server.research_runs WHERE incident_id = $1 AND state = 'completed'
            ORDER BY finished_at DESC LIMIT 1`,
          [i.incident_id],
        );
        await this.closed(c, {
          kind: 'issue_not_planned',
          incidentId: i.incident_id,
          researchRunId: run.rows[0]?.run_id ?? null,
          closedBy: g.closed_by?.login ?? null,
          reason: null,
          url: i.url,
        });
      }
    });
    return true;
  }
}
