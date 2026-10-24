import type { Proposal } from '@srenautix/contract';
import type pg from 'pg';
import { GitHubError, type GitHubApp } from '../github/app.js';
import type { IssueService } from '../github/issues.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';

/**
 * gitops_pr 开出的 PR（ADR 0108）：gateway 在执行事件的消息里写 "PR <url> #<n>"（执行结果与 pr_open 检查）；
 * 消息里没有时，执行进入校验之后按分支查 GitHub（GET pulls?head=<owner>:<branch>，只读）。
 * 找到后记入 server.gitops_pulls，事件 issue 里回链，通知消息的修复段落显示链接。
 */
const PR_RE = /PR (\S+) #(\d+)/;
const AFTER_EXECUTE = ['verifying', 'verified', 'verify_failed', 'needs_human', 'reverted'];

export function prFromMessages(messages: Array<string | null | undefined>): { url: string; number: number } | null {
  for (const m of messages) {
    const hit = m ? PR_RE.exec(m) : null;
    if (hit) {
      return { url: hit[1] as string, number: Number(hit[2]) };
    }
  }
  return null;
}

export class GitOpsPulls {
  constructor(
    private readonly pool: pg.Pool,
    private readonly github: GitHubApp | null,
    private readonly issues: IssueService | null,
    private readonly metrics: ServerMetrics,
  ) {}

  async runOnce(): Promise<number> {
    const r = await this.pool.query<{ body: Proposal }>(
      `SELECT p.body FROM server.proposals p
        WHERE p.action = 'gitops_pr' AND p.state IN ('dispatched', 'approved')
          AND p.updated_at > now() - interval '2 days'
          AND NOT EXISTS (SELECT 1 FROM server.gitops_pulls g WHERE g.proposal_id = p.proposal_id)
        ORDER BY p.updated_at LIMIT 50`,
    );
    let n = 0;
    for (const { body: p } of r.rows) {
      try {
        if (await this.one(p)) {
          n++;
        }
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        logger.warn('查找 gitops_pr 的 PR 失败，下一轮重试', { proposal_id: p.proposal_id, error: e.message });
      }
    }
    return n;
  }

  private async one(p: Proposal): Promise<boolean> {
    const params = p.params as { repository: string; title?: string; body?: string; branch?: string };
    const ev = await this.pool.query<{ phase: string; message: string | null; execution_id: string }>(
      `SELECT phase, body->>'message' AS message, execution_id FROM server.execution_events
        WHERE proposal_id = $1 ORDER BY seq DESC`,
      [p.proposal_id],
    );
    if (!ev.rows.length) {
      return false;
    }
    const branch = params.branch ?? `srenautix/${ev.rows[0]!.execution_id}`;
    let pr = prFromMessages(ev.rows.map((x) => x.message));
    let via: 'event' | 'lookup' = 'event';
    if (!pr && this.github && ev.rows.some((x) => AFTER_EXECUTE.includes(x.phase))) {
      const owner = params.repository.split('/')[0];
      const list = await this.github.api<Array<{ html_url: string; number: number; head?: { ref?: string } }>>(
        'GET',
        `/repos/${params.repository}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=5`,
        undefined,
        'list_pulls',
      );
      const hit = list.find((x) => !x.head?.ref || x.head.ref === branch);
      pr = hit ? { url: hit.html_url, number: hit.number } : null;
      via = 'lookup';
    }
    if (!pr) {
      return false;
    }
    const found = pr;
    const inserted = await tx(this.pool, async (c) => {
      const ins = await c.query(
        `INSERT INTO server.gitops_pulls (proposal_id, incident_id, repo, branch, url, number)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (proposal_id) DO NOTHING`,
        [p.proposal_id, p.incident_id, params.repository, branch, found.url, found.number],
      );
      if (ins.rowCount) {
        await appendAudit(c, 'gitops.pr_opened', 'server', {
          proposal_id: p.proposal_id,
          incident_id: p.incident_id,
          repo: params.repository,
          branch,
          url: found.url,
          number: found.number,
        });
      }
      return (ins.rowCount ?? 0) > 0;
    });
    if (!inserted) {
      return false;
    }
    this.metrics.gitopsPulls.inc({ via });
    // 目标的提议（ADR 0146）没有事件 issue；它的 PR 由验证循环按 gitops_pulls 跟踪
    if (p.subject?.type === 'goal') {
      logger.info('gitops_pr 已开出 PR', { proposal_id: p.proposal_id, url: found.url, via, goal_id: p.incident_id });
      return true;
    }
    await this.issues?.link(p.incident_id, {
      kind: 'pull',
      url: found.url,
      title: params.title ?? branch,
      repo: params.repository,
      number: found.number,
      refsInBody: (params.body ?? '').includes('Refs '),
    });
    logger.info('gitops_pr 已开出 PR', { proposal_id: p.proposal_id, url: found.url, via });
    return true;
  }
}

/** 事件的 gitops_pr 提议 → PR 地址（通知与控制台显示） */
export async function pullsOf(pool: pg.Pool, incidentIds: readonly string[]): Promise<Map<string, string>> {
  if (!incidentIds.length) {
    return new Map();
  }
  const r = await pool.query<{ proposal_id: string; url: string }>(
    'SELECT proposal_id, url FROM server.gitops_pulls WHERE incident_id = ANY($1::uuid[])',
    [incidentIds],
  );
  return new Map(r.rows.map((x) => [x.proposal_id, x.url]));
}
