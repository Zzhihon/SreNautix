import type pg from 'pg';
import { GitHubError, type GitHubApp } from '../github/app.js';
import { backoffMs, MAX_ATTEMPTS, openedLastHour } from '../github/issues.js';
import { logger } from '../kernel/log.js';
import { appendAudit } from '../kernel/store/audit.js';
import { tx, type Queryable } from '../kernel/store/pool.js';
import type { SkillMetrics } from './metrics.js';

// 技能的 issue（ADR 0181 §7.6，用户决定 2026-11-02）：按指纹去重。
// - 指纹第一次出现：开新 issue（第 1 代）；
// - 同一指纹的 issue 打开着（含等待开出、结果未知）：追加评论；
// - 以 completed 关闭：开下一代 issue，正文引用上一代（修复后再次出现）；
// - 以 not planned 关闭：关闭之后 30 天内只计数，之后再出现时开下一代；
// - 开出失败重试用尽（failed）：再出现时开下一代。
// 创建请求的结果未知（超时、连接中断、5xx）时状态记为 unknown，下一次先按正文的标记在仓库中找回，找不到才再创建。
// 每小时上限：技能自己的 issues 与 comments（budgets.hourly），以及同一仓库的事件、覆盖与技能 issue 合计（issues.max_per_hour）。

export const NOT_PLANNED_COOLDOWN_MS = 30 * 24 * 3600_000;
export const DEFER_MS = 10 * 60_000;
/** 打开的 issue 每隔这么久核对一次是否已被关闭 */
export const CHECK_INTERVAL_MS = 3600_000;

export const findingMarker = (skill: string, fingerprint: string, generation: number) =>
  `<!-- srenautix:skill=${skill}/${fingerprint}/${generation} -->`;

const unknownOutcome = (e: GitHubError) => e.status === 0 || e.status >= 500;

export type FindingAction = 'open' | 'comment' | 'counted';

export interface FindingRow {
  cluster_id: string;
  skill: string;
  fingerprint: string;
  generation: number;
  repo: string;
  state: 'pending' | 'unknown' | 'open' | 'completed' | 'not_planned' | 'failed';
  number: number | null;
  url: string | null;
  title: string;
  body: string;
  labels: string[];
  occurrences: number;
  previous_number: number | null;
  cooldown_until: Date | null;
  attempts: number;
}

export interface Decision {
  action: FindingAction;
  generation: number;
  /** 上一代 issue 的编号（开下一代时） */
  previous_number: number | null;
  /** 这个指纹出现过的运行数（含这一次） */
  occurrences: number;
  /** 评论的目标（comment 时） */
  target: FindingRow | null;
}

export interface HourlyCaps {
  issues: number;
  comments: number;
}

export class SkillPublisher {
  constructor(
    private readonly pool: pg.Pool,
    private readonly gh: GitHubApp,
    private readonly metrics: SkillMetrics,
    /** 同一仓库每小时新开 issue 的合计上限 */
    private readonly repoMaxPerHour: number,
    /** 技能 → 每小时上限（budgets.hourly） */
    private readonly caps: (skill: string) => HourlyCaps | null,
    private readonly now: () => number = Date.now,
  ) {}

  private async latest(c: Queryable, cluster: string, skill: string, fp: string): Promise<FindingRow | undefined> {
    const r = await c.query<FindingRow>(
      `SELECT cluster_id, skill, fingerprint, generation, repo, state, number, url, title, body, labels, occurrences,
              previous_number, cooldown_until, attempts
         FROM server.skill_findings WHERE cluster_id = $1 AND skill = $2 AND fingerprint = $3
        ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
      [cluster, skill, fp],
    );
    return r.rows[0];
  }

  /** 读取 issue 的状态并在关闭时记下（completed 或 not planned 与冷却期限）；调用方计入 GitHub 请求 */
  async refresh(c: Queryable, f: FindingRow): Promise<FindingRow> {
    if (f.state !== 'open' || f.number === null) {
      return f;
    }
    const r = await this.gh.api<{ state: string; state_reason?: string | null; closed_at?: string | null }>(
      'GET',
      `/repos/${f.repo}/issues/${f.number}`,
      undefined,
      'get_issue',
    );
    if (r.state === 'open') {
      await c.query(
        `UPDATE server.skill_findings SET checked_at = now() WHERE cluster_id = $1 AND skill = $2 AND fingerprint = $3 AND generation = $4`,
        [f.cluster_id, f.skill, f.fingerprint, f.generation],
      );
      return f;
    }
    const closedAt = r.closed_at ? Date.parse(r.closed_at) : this.now();
    const state = r.state_reason === 'completed' ? 'completed' : 'not_planned';
    const cooldown = state === 'not_planned' ? new Date(closedAt + NOT_PLANNED_COOLDOWN_MS) : null;
    await c.query(
      `UPDATE server.skill_findings SET state = $5, closed_at = $6, cooldown_until = $7, checked_at = now()
        WHERE cluster_id = $1 AND skill = $2 AND fingerprint = $3 AND generation = $4`,
      [f.cluster_id, f.skill, f.fingerprint, f.generation, state, new Date(closedAt), cooldown],
    );
    await appendAudit(c, 'github.skill_issue_closed', 'server', {
      skill: f.skill,
      fingerprint: f.fingerprint,
      generation: f.generation,
      repo: f.repo,
      number: f.number,
      state_reason: state,
    });
    this.metrics.issues.inc({ skill: f.skill, repo: f.repo, outcome: state });
    return { ...f, state, cooldown_until: cooldown };
  }

  /** 按指纹决定这次运行的结果写成新 issue、评论还是只计数（在运行的事务内，行锁住） */
  async decide(
    c: Queryable,
    cluster: string,
    skill: string,
    fp: string,
    refresh: (f: FindingRow) => Promise<FindingRow>,
  ): Promise<Decision> {
    const prev0 = await this.latest(c, cluster, skill, fp);
    if (!prev0) {
      return { action: 'open', generation: 1, previous_number: null, occurrences: 1, target: null };
    }
    const prev = await refresh(prev0);
    const n = prev.occurrences + 1;
    switch (prev.state) {
      case 'pending':
      case 'unknown':
      case 'open':
        return { action: 'comment', generation: prev.generation, previous_number: null, occurrences: n, target: prev };
      case 'not_planned':
        if (prev.cooldown_until && prev.cooldown_until.getTime() > this.now()) {
          return {
            action: 'counted',
            generation: prev.generation,
            previous_number: null,
            occurrences: n,
            target: prev,
          };
        }
        return {
          action: 'open',
          generation: prev.generation + 1,
          previous_number: prev.number,
          occurrences: 1,
          target: null,
        };
      case 'completed':
      case 'failed':
        return {
          action: 'open',
          generation: prev.generation + 1,
          previous_number: prev.number,
          occurrences: 1,
          target: null,
        };
    }
  }

  /** 写入决定：新的一代（等待开出）、一条等待投递的评论，或只增加计数 */
  async record(
    c: Queryable,
    d: Decision,
    f: {
      cluster: string;
      skill: string;
      fingerprint: string;
      subject: unknown;
      repo: string;
      runId: string;
      title: string;
      body: string;
      comment: string;
      labels: string[];
    },
  ): Promise<void> {
    if (d.action === 'open') {
      await c.query(
        `INSERT INTO server.skill_findings (cluster_id, skill, fingerprint, generation, subject, repo, state, title, body, labels,
           occurrences, previous_number)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, 1, $10)`,
        [
          f.cluster,
          f.skill,
          f.fingerprint,
          d.generation,
          JSON.stringify(f.subject),
          f.repo,
          f.title,
          f.body,
          JSON.stringify(f.labels),
          d.previous_number,
        ],
      );
      return;
    }
    await c.query(
      `UPDATE server.skill_findings SET occurrences = occurrences + 1, last_seen_at = now()
        WHERE cluster_id = $1 AND skill = $2 AND fingerprint = $3 AND generation = $4`,
      [f.cluster, f.skill, f.fingerprint, d.generation],
    );
    if (d.action === 'comment') {
      await c.query(
        `INSERT INTO server.skill_finding_comments (run_id, cluster_id, skill, fingerprint, generation, body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [f.runId, f.cluster, f.skill, f.fingerprint, d.generation, f.comment],
      );
    } else {
      this.metrics.issues.inc({ skill: f.skill, repo: f.repo, outcome: 'counted' });
    }
  }

  /** 后台一轮：开出到期的 issue，投递评论，核对打开的 issue 是否已被关闭 */
  async deliverOnce(): Promise<void> {
    const due = await this.pool.query<{ cluster_id: string; skill: string; fingerprint: string; generation: number }>(
      `SELECT cluster_id, skill, fingerprint, generation FROM server.skill_findings
        WHERE state IN ('pending', 'unknown') AND next_attempt_at <= now() ORDER BY first_seen_at LIMIT 20`,
    );
    for (const k of due.rows) {
      await this.openOne(k.cluster_id, k.skill, k.fingerprint, k.generation);
    }
    const comments = await this.pool.query<{ run_id: string }>(
      `SELECT x.run_id FROM server.skill_finding_comments x JOIN server.skill_findings f USING (cluster_id, skill, fingerprint, generation)
        WHERE x.posted_at IS NULL AND x.next_attempt_at <= now() AND x.attempts < $1 AND f.state = 'open'
        ORDER BY x.created_at LIMIT 20`,
      [MAX_ATTEMPTS],
    );
    for (const r of comments.rows) {
      await this.commentOne(r.run_id);
    }
    const open = await this.pool.query<{ cluster_id: string; skill: string; fingerprint: string; generation: number }>(
      `SELECT cluster_id, skill, fingerprint, generation FROM server.skill_findings
        WHERE state = 'open' AND (checked_at IS NULL OR checked_at < now() - make_interval(secs => $1))
        ORDER BY checked_at NULLS FIRST LIMIT 10`,
      [CHECK_INTERVAL_MS / 1000],
    );
    for (const k of open.rows) {
      await tx(this.pool, async (c) => {
        const f = await this.lockGen(c, k.cluster_id, k.skill, k.fingerprint, k.generation);
        if (f) {
          try {
            await this.refresh(c, f);
          } catch (e) {
            if (!(e instanceof GitHubError)) {
              throw e;
            }
            logger.warn('技能 issue 的状态读取失败，下一轮重试', { skill: k.skill, error: e.message });
          }
        }
      });
    }
  }

  private async lockGen(
    c: Queryable,
    cluster: string,
    skill: string,
    fp: string,
    gen: number,
  ): Promise<FindingRow | undefined> {
    const r = await c.query<FindingRow>(
      `SELECT cluster_id, skill, fingerprint, generation, repo, state, number, url, title, body, labels, occurrences,
              previous_number, cooldown_until, attempts
         FROM server.skill_findings WHERE cluster_id = $1 AND skill = $2 AND fingerprint = $3 AND generation = $4 FOR UPDATE`,
      [cluster, skill, fp, gen],
    );
    return r.rows[0];
  }

  private async defer(c: Queryable, f: FindingRow, note: string): Promise<void> {
    await c.query(
      `UPDATE server.skill_findings SET last_error = $5, next_attempt_at = now() + make_interval(secs => $6)
        WHERE cluster_id = $1 AND skill = $2 AND fingerprint = $3 AND generation = $4`,
      [f.cluster_id, f.skill, f.fingerprint, f.generation, note, DEFER_MS / 1000],
    );
    this.metrics.issues.inc({ skill: f.skill, repo: f.repo, outcome: 'deferred' });
    logger.info('技能 issue 达到每小时上限，推迟', { skill: f.skill, repo: f.repo, note });
  }

  async openOne(cluster: string, skill: string, fp: string, gen: number): Promise<void> {
    await tx(this.pool, async (c) => {
      const f = await this.lockGen(c, cluster, skill, fp, gen);
      if (!f || (f.state !== 'pending' && f.state !== 'unknown')) {
        return;
      }
      const caps = this.caps(skill);
      const own = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM server.skill_findings WHERE skill = $1 AND opened_at > now() - interval '1 hour'`,
        [skill],
      );
      if (caps && own.rows[0]!.n >= caps.issues) {
        await this.defer(c, f, `技能 ${skill} 最近 1 小时已开 ${own.rows[0]!.n} 个 issue，达到上限 ${caps.issues}`);
        return;
      }
      const repoN = await openedLastHour(c, f.repo);
      if (repoN >= this.repoMaxPerHour) {
        await this.defer(c, f, `仓库 ${f.repo} 最近 1 小时已开 ${repoN} 个 issue，达到上限 ${this.repoMaxPerHour}`);
        return;
      }
      const marker = findingMarker(skill, fp, gen);
      try {
        const found = f.state === 'unknown' ? await this.findByMarker(f.repo, marker) : null;
        let issue: { number: number; url: string };
        if (found) {
          issue = found;
        } else {
          const r = await this.gh.api<{ number: number; html_url: string }>(
            'POST',
            `/repos/${f.repo}/issues`,
            { title: f.title.slice(0, 250), body: `${marker}\n${f.body}`.slice(0, 60_000), labels: f.labels },
            'create_issue',
          );
          issue = { number: r.number, url: r.html_url };
        }
        await c.query(
          `UPDATE server.skill_findings SET state = 'open', number = $5, url = $6, opened_at = now(), checked_at = now(),
             attempts = 0, last_error = NULL WHERE cluster_id = $1 AND skill = $2 AND fingerprint = $3 AND generation = $4`,
          [cluster, skill, fp, gen, issue.number, issue.url],
        );
        await appendAudit(c, 'github.skill_issue_opened', 'server', {
          skill,
          fingerprint: fp,
          generation: gen,
          repo: f.repo,
          number: issue.number,
          url: issue.url,
          previous_number: f.previous_number,
          recovered: found !== null,
        });
        this.metrics.issues.inc({ skill, repo: f.repo, outcome: found ? 'recovered' : 'opened' });
        logger.info('技能 issue 已开', { skill, url: issue.url, recovered: !!found });
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        const attempts = f.attempts + 1;
        const give = attempts >= MAX_ATTEMPTS;
        const state = give ? 'failed' : f.state === 'unknown' || unknownOutcome(e) ? 'unknown' : 'pending';
        await c.query(
          `UPDATE server.skill_findings SET state = $5, attempts = $6, last_error = $7,
             next_attempt_at = now() + make_interval(secs => $8)
           WHERE cluster_id = $1 AND skill = $2 AND fingerprint = $3 AND generation = $4`,
          [cluster, skill, fp, gen, state, attempts, e.message.slice(0, 500), backoffMs(attempts) / 1000],
        );
        if (give) {
          await appendAudit(c, 'github.skill_issue_failed', 'server', {
            skill,
            fingerprint: fp,
            generation: gen,
            repo: f.repo,
            attempts,
            error: e.message.slice(0, 500),
          });
        }
        this.metrics.issues.inc({ skill, repo: f.repo, outcome: give ? 'failed' : 'retry' });
        logger.warn(give ? '技能 issue 重试用尽，放弃' : '技能 issue 开出失败，稍后重试', {
          skill,
          attempts,
          error: e.message,
        });
      }
    });
  }

  async commentOne(runId: string): Promise<void> {
    await tx(this.pool, async (c) => {
      const r = await c.query<{
        cluster_id: string;
        skill: string;
        fingerprint: string;
        generation: number;
        body: string;
        attempts: number;
      }>(
        `SELECT cluster_id, skill, fingerprint, generation, body, attempts FROM server.skill_finding_comments
          WHERE run_id = $1 AND posted_at IS NULL FOR UPDATE`,
        [runId],
      );
      const x = r.rows[0];
      if (!x) {
        return;
      }
      const f = await this.lockGen(c, x.cluster_id, x.skill, x.fingerprint, x.generation);
      if (!f || f.state !== 'open' || f.number === null) {
        return;
      }
      const caps = this.caps(x.skill);
      const own = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM server.skill_finding_comments WHERE skill = $1 AND posted_at > now() - interval '1 hour'`,
        [x.skill],
      );
      if (caps && own.rows[0]!.n >= caps.comments) {
        await c.query(
          `UPDATE server.skill_finding_comments SET next_attempt_at = now() + make_interval(secs => $2), last_error = $3 WHERE run_id = $1`,
          [runId, DEFER_MS / 1000, `技能 ${x.skill} 最近 1 小时已评论 ${own.rows[0]!.n} 次，达到上限 ${caps.comments}`],
        );
        this.metrics.issues.inc({ skill: x.skill, repo: f.repo, outcome: 'deferred' });
        return;
      }
      try {
        const res = await this.gh.api<{ html_url: string }>(
          'POST',
          `/repos/${f.repo}/issues/${f.number}/comments`,
          { body: `<!-- srenautix:skill-comment=${runId} -->\n${x.body}`.slice(0, 60_000) },
          'create_comment',
        );
        await c.query(
          'UPDATE server.skill_finding_comments SET posted_at = now(), url = $2, last_error = NULL WHERE run_id = $1',
          [runId, res.html_url],
        );
        await appendAudit(c, 'github.skill_issue_comment', 'server', {
          skill: x.skill,
          fingerprint: x.fingerprint,
          generation: x.generation,
          repo: f.repo,
          number: f.number,
          run_id: runId,
        });
        this.metrics.issues.inc({ skill: x.skill, repo: f.repo, outcome: 'commented' });
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        const attempts = x.attempts + 1;
        await c.query(
          `UPDATE server.skill_finding_comments SET attempts = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4)
            WHERE run_id = $1`,
          [runId, attempts, e.message.slice(0, 500), backoffMs(attempts) / 1000],
        );
        this.metrics.issues.inc({ skill: x.skill, repo: f.repo, outcome: 'retry' });
        logger.warn('技能 issue 的评论失败，稍后重试', { skill: x.skill, attempts, error: e.message });
      }
    });
  }

  private async findByMarker(repo: string, marker: string): Promise<{ number: number; url: string } | null> {
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
}
