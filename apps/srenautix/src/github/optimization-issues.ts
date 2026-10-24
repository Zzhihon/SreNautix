import type pg from 'pg';
import { logger } from '../log.js';
import { recommendationMarker } from '../optimize/render.js';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';
import { GitHubError, type GitHubApp } from './app.js';
import { backoffMs, MAX_ATTEMPTS } from './issues.js';

// 业务仓库的 issue（ADR 0146 §4.1、§4.5）：主动优化的建议在业务仓库开 issue。与事件 issue（ADR 0095）同一套机制，
// 键是建议的 recommendation_id：
// - 创建请求的结果未知（超时、连接中断、5xx）时记为 unknown；下一次先按正文的标记 srenautix:recommendation=<id>
//   在仓库中找回，找不到才再次创建，重试不会重复开 issue；
// - GitHub 失败时按退避重试，最多 MAX_ATTEMPTS 次，之后放弃（建议记为 failed）；
// - 开出、找回与放弃写治理审计。
// 请求都经 GitHub App 的业务仓库角色白名单：只有创建 issue、追加评论、改 issue 的标题与正文，以及读取 issue。

export interface IssueContent {
  title: string;
  body: string;
  labels: string[];
}

export type DeliverResult =
  | { kind: 'opened'; number: number; url: string; recovered: boolean }
  | { kind: 'retry'; error: string }
  | { kind: 'failed'; error: string };

interface Row {
  recommendation_id: string;
  repository: string;
  attempts: number;
  issue_state: 'pending' | 'unknown' | 'open' | 'closed' | null;
}

/** 结果未知的失败：请求可能已经被 GitHub 处理 */
const unknownOutcome = (e: GitHubError) => e.status === 0 || e.status >= 500;

export class OptimizationIssues {
  constructor(
    private readonly pool: pg.Pool,
    private readonly gh: GitHubApp,
  ) {}

  /** 为一个建议开出 issue（或按标记找回）；render 只在需要创建时调用 */
  async deliver(recommendationId: string, render: () => Promise<IssueContent>): Promise<DeliverResult> {
    return tx(this.pool, async (c) => {
      const r = await c.query<Row>(
        `SELECT recommendation_id, repository, attempts, issue_state FROM server.optimization_recommendations
          WHERE recommendation_id = $1 FOR UPDATE`,
        [recommendationId],
      );
      const row = r.rows[0];
      if (!row) {
        return { kind: 'failed', error: '没有这个建议' };
      }
      try {
        // 上一次的结果未知：先按建议的标记找回
        const found = row.issue_state === 'unknown' ? await this.findByMarker(row.repository, recommendationId) : null;
        const issue = found ?? (await this.create(row.repository, await render()));
        await c.query(
          `UPDATE server.optimization_recommendations SET issue_state = 'open', attempts = attempts + 1, last_error = NULL,
             updated_at = now() WHERE recommendation_id = $1`,
          [recommendationId],
        );
        await appendAudit(c, 'github.optimization_issue_opened', 'server', {
          recommendation_id: recommendationId,
          repo: row.repository,
          number: issue.number,
          url: issue.url,
          recovered: found !== null,
        });
        logger.info('业务 issue 已开', { recommendation_id: recommendationId, url: issue.url, recovered: !!found });
        return { kind: 'opened', number: issue.number, url: issue.url, recovered: found !== null };
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        const attempts = row.attempts + 1;
        const give = attempts >= MAX_ATTEMPTS;
        // 结果未知的失败之后，状态保持 unknown，直到按标记找回或确认没有开出
        const state = row.issue_state === 'unknown' || unknownOutcome(e) ? 'unknown' : 'pending';
        await c.query(
          `UPDATE server.optimization_recommendations SET issue_state = $2, attempts = $3, last_error = $4,
             next_attempt_at = now() + make_interval(secs => $5), updated_at = now() WHERE recommendation_id = $1`,
          [recommendationId, state, attempts, e.message.slice(0, 500), backoffMs(attempts) / 1000],
        );
        if (give) {
          await appendAudit(c, 'github.optimization_issue_failed', 'server', {
            recommendation_id: recommendationId,
            repo: row.repository,
            attempts,
            error: e.message.slice(0, 500),
          });
        }
        logger.warn(give ? '业务 issue 重试用尽，放弃' : '业务 issue 开出失败，稍后重试', {
          recommendation_id: recommendationId,
          attempts,
          error: e.message,
        });
        return give ? { kind: 'failed', error: e.message } : { kind: 'retry', error: e.message };
      }
    });
  }

  private async findByMarker(repo: string, recommendationId: string): Promise<{ number: number; url: string } | null> {
    const marker = recommendationMarker(recommendationId);
    const list = await this.gh.api<
      Array<{ number: number; html_url: string; body: string | null; pull_request?: unknown }>
    >(
      'GET',
      `/repos/${repo}/issues?labels=srenautix&state=all&sort=created&direction=desc&per_page=100`,
      undefined,
      'list_issues',
    );
    const hit = list.find((i) => !i.pull_request && (i.body ?? '').includes(marker));
    return hit ? { number: hit.number, url: hit.html_url } : null;
  }

  private async create(repo: string, content: IssueContent): Promise<{ number: number; url: string }> {
    const r = await this.gh.api<{ number: number; html_url: string }>(
      'POST',
      `/repos/${repo}/issues`,
      { title: content.title.slice(0, 250), body: content.body, labels: content.labels },
      'create_issue',
    );
    return { number: r.number, url: r.html_url };
  }

  /** 追加评论（验证结果、差距更新） */
  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.gh.api('POST', `/repos/${repo}/issues/${number}/comments`, { body }, 'create_comment');
  }

  /** issue 的状态与关闭原因（completed、not_planned） */
  async state(repo: string, number: number): Promise<{ open: boolean; reason: 'completed' | 'not_planned' | null }> {
    const r = await this.gh.api<{ state: string; state_reason?: string | null }>(
      'GET',
      `/repos/${repo}/issues/${number}`,
      undefined,
      'get_issue',
    );
    const reason = r.state_reason === 'completed' || r.state_reason === 'not_planned' ? r.state_reason : null;
    return { open: r.state === 'open', reason };
  }
}
