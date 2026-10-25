import { createHash } from 'node:crypto';
import { parsePatch } from 'diff';
import type pg from 'pg';
import { GitHubError, type GitHubApp } from '../github/app.js';
import { logger } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';

/**
 * 自愈 PR 的修改去重与拒绝记忆（ADR 0155）。去重键是（仓库，规范化补丁的哈希）：
 * - 规范化补丁只保留每个文件的路径与增删的行，不含 index 行、hunk 头与上下文行，基准提交前进、行号移动后同一个修改的哈希不变；
 * - 同一个修改已有未结束的提议或打开的 PR 时不再提议，改为在这个 PR 上评论新的触发，并把新事件的 issue 关联到 PR；
 * - PR 被关闭且没有合并（或提议在审批时被人拒绝）是"人已拒绝"：同一个修改不再自动提出；同一模板对同一组文件的其他修改
 *   在 rejected_cooldown 内也不提出；
 * - 记录在 server.remediation_changes（每个提议一行）与 server.remediation_triggers（重复触发），状态在 PostgreSQL 里，
 *   server 重启后照常生效。PR 的状态在需要判断时按需从 GitHub 读取（GET pulls/{n}）。
 */

const stripAB = (p: string | undefined) => (p ?? '').replace(/^[ab]\//, '');

/** 规范化补丁的哈希：按路径排序的（路径，增删的行）；补丁不能解析时抛出 */
export function changeHash(patch: string): string {
  // 空串也会解析出一个没有文件名的条目
  const files = parsePatch(patch)
    .filter((f) => f.oldFileName !== undefined || f.newFileName !== undefined)
    .map((f) => {
      const path = stripAB(f.newFileName && f.newFileName !== '/dev/null' ? f.newFileName : f.oldFileName);
      const lines = f.hunks.flatMap((h) => h.lines.filter((l) => l.startsWith('+') || l.startsWith('-')));
      return [path, lines] as const;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!files.length) {
    throw new Error('补丁没有任何文件');
  }
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export type ChangeState = 'pending' | 'open' | 'merged' | 'rejected' | 'abandoned';

export interface ChangeRow {
  proposal_id: string;
  repository: string;
  change_hash: string;
  key: string;
  files: string[];
  incident_id: string;
  state: ChangeState;
  pr_number: number | null;
  pr_url: string | null;
  closed_at: Date | null;
  created_at: Date;
}

/** 新修改的去重结论：null 表示可以提议 */
export type Verdict =
  | { code: 'duplicate_open' | 'duplicate_pending'; row: ChangeRow }
  | { code: 'rejected_before'; row: ChangeRow }
  | { code: 'rejected_cooldown'; row: ChangeRow; until: Date };

/** 提议状态 → 没有 PR 时的修改状态：人在审批时拒绝记为 rejected；策略拒绝、过期、绑定过时、执行失败记为 abandoned */
function stateWithoutPull(state: string, phase: string | null): ChangeState {
  if (state === 'rejected') {
    return 'rejected';
  }
  if (['rejected_by_policy', 'expired', 'stale', 'duplicate'].includes(state) || phase === 'failed') {
    return 'abandoned';
  }
  return 'pending';
}

const TRIGGER_MAX_ATTEMPTS = 8;
const triggerBackoffMs = (attempts: number) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
const triggerMarker = (incidentId: string) => `<!-- srenautix:trigger=${incidentId} -->`;

export interface TriggerComment {
  lang: 'zh' | 'en';
  consoleUrl: string;
  incidentId: string;
  incidentLabel: string;
  runId: string;
  level: string;
  /** 新事件 issue 的引用（#n 或 owner/name#n）；没有时省略 */
  issueRef: string | null;
}

/** PR 上记录一次重复触发的评论 */
export function triggerComment(t: TriggerComment): string {
  const base = t.consoleUrl.replace(/\/+$/, '');
  const inc = `[${t.incidentLabel}](${base}/incidents/${t.incidentId})`;
  const run = `[${t.runId}](${base}/runs/${t.runId})`;
  const lines =
    t.lang === 'zh'
      ? [
          triggerMarker(t.incidentId),
          `同一个修改再次被触发：事件 ${inc}，研判运行 ${run}（${t.level}）。SreNautix 不为它另开 PR，触发记录在这里。`,
        ]
      : [
          triggerMarker(t.incidentId),
          `The same change was triggered again: incident ${inc}, research run ${run} (${t.level}). SreNautix opens no other pull request for it and records the trigger here.`,
        ];
  return [...lines, ...(t.issueRef ? ['', `Refs ${t.issueRef}`] : [])].join('\n');
}

export interface PullLink {
  url: string;
  title: string;
  repo: string;
  number: number;
}

export class RemediationChanges {
  constructor(
    private readonly pool: pg.Pool,
    private readonly github: GitHubApp,
    /** 同一模板对同一组文件的修改被拒绝后的冷却期；0 时只记住被拒绝的那一个修改 */
    private readonly cooldownMs: number,
  ) {}

  /**
   * 补登记之前的自愈 PR 提议（去重表建立之前、或写入记录之前进程退出）：remediation_attempts 里 proposed 的提议
   * 没有修改记录时按提议参数里的补丁补上，状态在判断时刷新
   */
  async backfill(): Promise<number> {
    const r = await this.pool.query<{
      proposal_id: string;
      key: string;
      repository: string;
      files: string[];
      incident_id: string;
      patch: string;
      created_at: Date;
    }>(
      `SELECT a.proposal_id, a.key, a.repository, a.files, p.incident_id, p.params->>'patch' AS patch, p.created_at
         FROM server.remediation_attempts a JOIN server.proposals p ON p.proposal_id = a.proposal_id
        WHERE a.outcome = 'proposed' AND a.proposal_id IS NOT NULL AND p.action = 'gitops_pr'
          AND NOT EXISTS (SELECT 1 FROM server.remediation_changes c WHERE c.proposal_id = a.proposal_id)
        ORDER BY p.created_at`,
    );
    for (const x of r.rows) {
      await this.pool.query(
        `INSERT INTO server.remediation_changes (proposal_id, repository, change_hash, key, files, incident_id, state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) ON CONFLICT (proposal_id) DO NOTHING`,
        [
          x.proposal_id,
          x.repository,
          changeHash(x.patch),
          x.key,
          JSON.stringify([...x.files].sort()),
          x.incident_id,
          x.created_at,
        ],
      );
    }
    return r.rows.length;
  }

  /** 按提议、gitops_pulls 与 GitHub 上 PR 的当前状态刷新一行；merged 与 abandoned 不再变化 */
  async refresh(row: ChangeRow): Promise<ChangeRow> {
    if (row.state === 'merged' || row.state === 'abandoned') {
      return row;
    }
    let next: ChangeRow = row;
    if (row.pr_number === null) {
      const pull = await this.pool.query<{ url: string; number: number }>(
        'SELECT url, number FROM server.gitops_pulls WHERE proposal_id = $1',
        [row.proposal_id],
      );
      const pr = pull.rows[0];
      if (pr) {
        next = { ...row, pr_number: pr.number, pr_url: pr.url };
      } else {
        const p = await this.pool.query<{ state: string; phase: string | null; updated_at: Date }>(
          `SELECT state, body->'execution'->>'phase' AS phase, updated_at FROM server.proposals WHERE proposal_id = $1`,
          [row.proposal_id],
        );
        const prop = p.rows[0];
        if (!prop) {
          throw new Error(`修改记录 ${row.proposal_id} 没有对应的提议`);
        }
        const state = stateWithoutPull(prop.state, prop.phase);
        next = { ...row, state, closed_at: state === 'pending' ? null : prop.updated_at };
      }
    }
    if (next.pr_number !== null) {
      const pr = await this.github.api<{ state: string; merged_at: string | null; closed_at: string | null }>(
        'GET',
        `/repos/${next.repository}/pulls/${next.pr_number}`,
        undefined,
        'get_pull',
      );
      const state: ChangeState = pr.state === 'open' ? 'open' : pr.merged_at ? 'merged' : 'rejected';
      if (state !== 'open' && !pr.closed_at) {
        throw new Error(`${next.repository}#${next.pr_number} 已关闭却没有 closed_at`);
      }
      next = { ...next, state, closed_at: state === 'open' ? null : new Date(pr.closed_at!) };
    }
    if (next.state !== row.state || next.pr_number !== row.pr_number) {
      await tx(this.pool, async (c) => {
        await c.query(
          `UPDATE server.remediation_changes SET state = $2, pr_number = $3, pr_url = $4, closed_at = $5, checked_at = now()
            WHERE proposal_id = $1`,
          [next.proposal_id, next.state, next.pr_number, next.pr_url, next.closed_at],
        );
        if (next.state !== row.state) {
          await appendAudit(c, 'remediation.change_state', 'server', {
            proposal_id: next.proposal_id,
            repository: next.repository,
            change_hash: next.change_hash,
            from: row.state,
            to: next.state,
            pr: next.pr_url,
          });
        }
      });
    }
    return next;
  }

  /**
   * 新修改能否提议：同一仓库的同一个修改有未结束的提议或打开的 PR 时是重复；同一个修改被人拒绝过时不再提；
   * 同一模板对同一组文件的修改在冷却期内被拒绝过时等冷却期结束
   */
  async verdict(repository: string, hash: string, key: string, files: readonly string[]): Promise<Verdict | null> {
    const r = await this.pool.query<ChangeRow>(
      `SELECT proposal_id, repository, change_hash, key, files, incident_id, state, pr_number, pr_url, closed_at, created_at
         FROM server.remediation_changes
        WHERE repository = $1 AND state IN ('pending', 'open', 'rejected')
          AND (change_hash = $2 OR (key = $3 AND files = $4::jsonb))
        ORDER BY created_at`,
      [repository, hash, key, JSON.stringify([...files].sort())],
    );
    const rows: ChangeRow[] = [];
    for (const x of r.rows) {
      rows.push(await this.refresh(x));
    }
    const same = rows.filter((x) => x.change_hash === hash);
    const open = same.find((x) => x.state === 'open');
    if (open) {
      return { code: 'duplicate_open', row: open };
    }
    const pending = same.find((x) => x.state === 'pending');
    if (pending) {
      return { code: 'duplicate_pending', row: pending };
    }
    const rejected = same.find((x) => x.state === 'rejected');
    if (rejected) {
      return { code: 'rejected_before', row: rejected };
    }
    if (this.cooldownMs > 0) {
      const now = Date.now();
      const recent = rows
        .filter((x) => x.state === 'rejected' && x.closed_at && now - x.closed_at.getTime() < this.cooldownMs)
        .sort((a, b) => b.closed_at!.getTime() - a.closed_at!.getTime())[0];
      if (recent) {
        return {
          code: 'rejected_cooldown',
          row: recent,
          until: new Date(recent.closed_at!.getTime() + this.cooldownMs),
        };
      }
    }
    return null;
  }

  /** 登记一个新提出的修改（提议已经创建） */
  async record(x: {
    proposalId: string;
    repository: string;
    hash: string;
    key: string;
    files: readonly string[];
    incidentId: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO server.remediation_changes (proposal_id, repository, change_hash, key, files, incident_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending') ON CONFLICT (proposal_id) DO NOTHING`,
      [x.proposalId, x.repository, x.hash, x.key, JSON.stringify([...x.files].sort()), x.incidentId],
    );
  }

  /** 登记一次重复触发；同一个修改的同一个事件只记一次 */
  async trigger(proposalId: string, t: { incidentId: string; runId: string; body: string }): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO server.remediation_triggers (proposal_id, incident_id, run_id, body) VALUES ($1, $2, $3, $4)
       ON CONFLICT (proposal_id, incident_id) DO NOTHING`,
      [proposalId, t.incidentId, t.runId, t.body],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * 把重复触发写成 PR 评论，并把新事件的 issue 关联到 PR（link：issue 里回链，PR 描述补 Refs）。PR 还没有开出时等下一轮。
   * 评论请求结果未知（超时、连接断开）时，重试先按标记在 PR 的评论里找回，不重复发
   */
  async postTriggers(link: ((incidentId: string, pull: PullLink) => Promise<void>) | null): Promise<number> {
    const due = await this.pool.query<{
      proposal_id: string;
      incident_id: string;
      body: string;
      attempts: number;
      repository: string;
      pr_number: number;
      pr_url: string;
      title: string | null;
    }>(
      `SELECT t.proposal_id, t.incident_id, t.body, t.attempts, c.repository, c.pr_number, c.pr_url,
              p.params->>'title' AS title
         FROM server.remediation_triggers t
         JOIN server.remediation_changes c ON c.proposal_id = t.proposal_id
         JOIN server.proposals p ON p.proposal_id = t.proposal_id
        WHERE t.comment_url IS NULL AND t.attempts < $1 AND t.next_attempt_at <= now() AND c.pr_number IS NOT NULL
        ORDER BY t.created_at LIMIT 50`,
      [TRIGGER_MAX_ATTEMPTS],
    );
    let n = 0;
    for (const t of due.rows) {
      try {
        let url: string | null = null;
        if (t.attempts > 0) {
          const list = await this.github.api<Array<{ html_url: string; body: string | null }>>(
            'GET',
            `/repos/${t.repository}/issues/${t.pr_number}/comments?per_page=100`,
            undefined,
            'list_comments',
          );
          url = list.find((x) => (x.body ?? '').includes(triggerMarker(t.incident_id)))?.html_url ?? null;
        }
        if (!url) {
          const r = await this.github.api<{ html_url: string }>(
            'POST',
            `/repos/${t.repository}/issues/${t.pr_number}/comments`,
            { body: t.body },
            'create_comment',
          );
          url = r.html_url;
        }
        await link?.(t.incident_id, {
          url: t.pr_url,
          title: t.title ?? `#${t.pr_number}`,
          repo: t.repository,
          number: t.pr_number,
        });
        await tx(this.pool, async (c) => {
          await c.query(
            `UPDATE server.remediation_triggers SET comment_url = $3, attempts = attempts + 1, last_error = NULL
              WHERE proposal_id = $1 AND incident_id = $2`,
            [t.proposal_id, t.incident_id, url],
          );
          await appendAudit(c, 'remediation.trigger_comment', 'server', {
            proposal_id: t.proposal_id,
            incident_id: t.incident_id,
            pr: t.pr_url,
            comment: url,
          });
        });
        n++;
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        const attempts = t.attempts + 1;
        await this.pool.query(
          `UPDATE server.remediation_triggers SET attempts = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5)
            WHERE proposal_id = $1 AND incident_id = $2`,
          [t.proposal_id, t.incident_id, attempts, e.message.slice(0, 500), triggerBackoffMs(attempts) / 1000],
        );
        logger.warn('重复触发的 PR 评论发出失败，稍后重试', {
          proposal_id: t.proposal_id,
          incident_id: t.incident_id,
          error: e.message,
        });
      }
    }
    return n;
  }
}
