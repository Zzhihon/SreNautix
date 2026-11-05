import { createHash } from 'node:crypto';
import type { Incident, NotifyMessage, ReasonCodeOf } from '@srenautix/contract';
import { incidentOccurrences, type Occurrence } from '@srenautix/core';
import type pg from 'pg';
import { countReasons, writeReason, type ReasonRecord } from '../incident/reasons.js';
import { researchRoots, type OwnerLookup } from '../incident/research-root.js';
import { issueMarkdown } from '../notify/markdown.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { appendAudit } from '../store/audit.js';
import { tx, type Queryable } from '../store/pool.js';
import { GitHubApp, GitHubError } from './app.js';

/**
 * 需要人跟进的事件在 GitHub 开 issue（ADR 0095）：
 * - 研判或阶段 A 的处置判断为 escalate，或者有需要改仓库的修复提议（拓扑覆盖 PR、gitops_pr 提议）；
 * - 每个事件最多一个 issue（server.github_issues 以 incident_id 为主键；issue 正文带事件标记，超时后按标记找回，不重复开）；
 * - 同一系列（ADR 0184）在同一仓库已有打开的 issue 时复用它（reused_from 记开出它的事件），不新开、不计入每小时上限；
 *   正文与标题跟随最近接上这个 issue 的事件；每次发生恢复时评论第几次发生、本次持续时长与累计时长；
 * - 后续进展（研判结束、事件恢复、关联的 PR）以评论追加，按 (事件, 键) 去重，评论同样带标记；
 * - 正文就地更新为最新的报告；标题跟随根因与头条症状，同一事件每小时最多改一次（ADR 0142）；
 * - 每个仓库每小时最多新开 max_per_hour 个（与覆盖缺口 issue 合计，ADR 0171），超出的事件只记录为 skipped，不开 issue；
 * - GitHub 失败时按退避重试，最多 MAX_ATTEMPTS 次；每次开出、跳过、放弃与评论写治理审计。
 * 只用 GitHub App 的安装令牌。
 */
export interface IssueSettings {
  /** owner/name */
  repo: string;
  labels: string[];
  /** 标题前缀，例如 "[影子]"；空字符串表示没有 */
  titlePrefix: string;
  maxPerHour: number;
  /** 只为最近这段时间内更新过的事件开 issue */
  lookbackMs: number;
  consoleUrl: string;
  language: 'zh' | 'en';
}

export type IssueReason = 'escalate' | 'repo_change';

export interface IssueRef {
  number: number;
  url: string;
  repo: string;
}

export const MAX_ATTEMPTS = 8;
/** 同一事件的 issue 标题两次修改之间至少间隔这么久（ADR 0142） */
export const TITLE_MIN_INTERVAL_MS = 3600_000;
/** 外部上游的事件未恢复时，隔这么久再检查一次是否出现了业务影响（ADR 0147） */
export const EXTERNAL_RECHECK_MS = 10 * 60_000;
const EXTERNAL_NOTE = '根因是外部上游且没有业务影响：进入通知的周期汇总，不开 issue（ADR 0147）';
export const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);

/**
 * 同一仓库最近 1 小时开出的 issue：事件 issue、覆盖缺口 issue（ADR 0171）与技能的 issue（ADR 0181）的合计，共用
 * issues.max_per_hour。复用同一系列已开 issue 的事件（ADR 0184）没有开出新的 issue，不算
 */
export async function openedLastHour(c: Queryable, repo: string): Promise<number> {
  const r = await c.query<{ n: number }>(
    `SELECT ((SELECT count(*) FROM server.github_issues
               WHERE repo = $1 AND state = 'open' AND reused_from IS NULL AND opened_at > now() - interval '1 hour')
           + (SELECT count(*) FROM server.coverage_gaps
               WHERE repo = $1 AND opened_at > now() - interval '1 hour')
           + (SELECT count(*) FROM server.skill_findings
               WHERE lower(repo) = lower($1) AND opened_at > now() - interval '1 hour'))::int AS n`,
    [repo],
  );
  return r.rows[0]!.n;
}

interface ReusableIssue {
  /** 接上这个 issue 的事件 */
  incident_id: string;
  number: number;
  url: string;
  title: string | null;
  title_updated_at: Date | null;
  /** 开出这个 issue 的事件 */
  opener: string;
}

/**
 * 同一集群、同一系列（ADR 0184）的其他事件在 repo 中打开、还没有被人关闭的 issue，取最近接上的一个；事件没有系列键时为
 * null
 */
async function reusableIssue(c: Queryable, incidentId: string, repo: string): Promise<ReusableIssue | null> {
  const r = await c.query<ReusableIssue>(
    `SELECT g.incident_id, g.number, g.url, g.title, g.title_updated_at, coalesce(g.reused_from, g.incident_id) AS opener
       FROM server.incidents n
       JOIN server.incidents i ON i.cluster_id = n.cluster_id AND i.series_key = n.series_key AND i.incident_id <> n.incident_id
       JOIN server.github_issues g ON g.incident_id = i.incident_id
      WHERE n.incident_id = $1 AND g.repo = $2 AND g.state = 'open' AND g.closed_at IS NULL
        AND g.number IS NOT NULL AND g.url IS NOT NULL
      ORDER BY g.opened_at DESC, g.incident_id LIMIT 1`,
    [incidentId, repo],
  );
  return r.rows[0] ?? null;
}

/** 事件报告：由 notify/source.ts 的 ReportSource.message 提供；事件或阶段 A 报告不存在时为 null */
export type IssueReport = (incidentId: string, language: 'zh' | 'en') => Promise<NotifyMessage | null>;

const incidentMarker = (id: string) => `<!-- srenautix:incident=${id} -->`;
const commentMarker = (key: string) => `<!-- srenautix:comment=${key} -->`;

interface IssueRow {
  incident_id: string;
  repo: string;
  state: 'pending' | 'open' | 'skipped' | 'failed';
  reason: IssueReason;
  number: number | null;
  url: string | null;
  attempts: number;
}

const T = {
  zh: {
    reason: { escalate: '处置判断为升级（需要人工跟进）', repo_change: '有需要修改仓库的修复提议' } as Record<
      IssueReason,
      string
    >,
    why: '开 issue 的原因',
    research: (state: string, level: string | null, root: string | null, err: string | null) =>
      state === 'completed'
        ? `研判结束：结论 \`${level ?? '-'}\`${root ? `，根因 \`${root}\`` : ''}。正文已按新结论更新。`
        : `模型研判没有给出结论（${state}）${err ? `：${err}` : ''}，正文为确定性报告。`,
    resolved: (at: string) => `事件已于 ${at} 恢复。`,
    recurred: (at: string, n: number, span: string, total: string) =>
      `事件已于 ${at} 恢复。这是同一系列第 ${n} 次发生，本次持续 ${span}，${n} 次累计 ${total}。`,
    hours: (h: number, m: number) => (h ? `${h} 小时 ${m} 分` : `${m} 分钟`),
    rootMismatch: (research: string, incident: string) =>
      `研判根因（\`${research}\`）与发现根因（\`${incident}\`）不一致。事件没有拆分，请以研判结论与证据为准核对。`,
    pull: (title: string, url: string) => `关联的 PR：[${title}](${url})`,
    proposal: (title: string, url: string) => `修复提议（审批后由 gateway 在仓库中开 PR）：[${title}](${url})`,
    footer: '由 SreNautix 生成，同一事件的后续进展会追加在评论里。',
  },
  en: {
    reason: {
      escalate: 'Disposition is escalate (needs a human)',
      repo_change: 'A fix needs a repository change',
    } as Record<IssueReason, string>,
    why: 'Why this issue',
    research: (state: string, level: string | null, root: string | null, err: string | null) =>
      state === 'completed'
        ? `Research finished: conclusion \`${level ?? '-'}\`${root ? `, root \`${root}\`` : ''}. The body now shows the new conclusion.`
        : `Model research ended without a conclusion (${state})${err ? `: ${err}` : ''}; the body is the deterministic report.`,
    resolved: (at: string) => `The incident resolved at ${at}.`,
    recurred: (at: string, n: number, span: string, total: string) =>
      `The incident resolved at ${at}. This was occurrence ${n} of the same series; it lasted ${span}, and the ${n} occurrences add up to ${total}.`,
    hours: (h: number, m: number) => (h ? `${h} h ${m} min` : `${m} min`),
    rootMismatch: (research: string, incident: string) =>
      `The research root (\`${research}\`) differs from the discovered root (\`${incident}\`). The incident was not split; check against the research conclusion and evidence.`,
    pull: (title: string, url: string) => `Linked PR: [${title}](${url})`,
    proposal: (title: string, url: string) =>
      `Fix proposal (the gateway opens the PR after approval): [${title}](${url})`,
    footer: 'Generated by SreNautix; later progress on this incident is added as comments.',
  },
};

export class IssueService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly gh: GitHubApp,
    private readonly s: IssueSettings,
    private readonly metrics: ServerMetrics,
    /** 事件的报告（与通知相同，notify/source.ts 的 ReportSource.message） */
    private readonly report: IssueReport,
    /** 研判根因与事件根因按属主粒度比较时取顶层属主（ADR 0104 §14）；不提供时只按键比较 */
    private readonly ownerOf: OwnerLookup = async () => null,
    /**
     * 根因是外部上游且没有业务影响的事件（ADR 0147）返回它的状态，这类事件不开 issue：未恢复时推迟检查（之后出现业务影响
     * 仍会开出），恢复后记为跳过。其余事件为 null
     */
    private readonly externalOf: (incidentId: string) => Promise<'firing' | 'ended' | null> = async () => null,
  ) {}

  get repo(): string {
    return this.s.repo;
  }

  /** 登记事件需要 issue；已有记录（不论状态）时不变 */
  async request(incidentId: string, reason: IssueReason, c: Queryable = this.pool): Promise<void> {
    await c.query(
      `INSERT INTO server.github_issues (incident_id, repo, state, reason) VALUES ($1, $2, 'pending', $3)
       ON CONFLICT (incident_id) DO NOTHING`,
      [incidentId, this.s.repo, reason],
    );
  }

  /** 已开的 issue；没有时为 null */
  async issueOf(incidentId: string): Promise<IssueRef | null> {
    const r = await this.pool.query<{ number: number; url: string; repo: string }>(
      "SELECT number, url, repo FROM server.github_issues WHERE incident_id = $1 AND state = 'open'",
      [incidentId],
    );
    return r.rows[0] ?? null;
  }

  /** 从 fromRepo 引用该事件 issue 的写法（#n 或 owner/name#n）；没有已开的 issue 时为 null */
  async refFrom(incidentId: string, fromRepo: string): Promise<string | null> {
    const i = await this.issueOf(incidentId);
    return i ? GitHubApp.ref(fromRepo, i.repo, i.number) : null;
  }

  /**
   * 立即确保事件有 issue（需要改仓库的修复提议在开 PR 之前调用）：登记并尝试开出一次，受同样的限速约束。
   * GitHub 失败时不抛出，返回 null，issue 由后台循环重试，开出后再回链 PR。
   */
  async ensure(incidentId: string, reason: IssueReason): Promise<IssueRef | null> {
    await this.request(incidentId, reason);
    try {
      await this.openDue(incidentId);
    } catch (e) {
      logger.warn('事件 issue 没有立即开出，后台重试', { incident_id: incidentId, error: e });
    }
    return this.issueOf(incidentId);
  }

  /** 登记与事件关联的 PR 或提议：issue 里回链；PR 描述还没有 Refs 时补上 */
  async link(
    incidentId: string,
    l: {
      kind: 'pull' | 'proposal';
      url: string;
      title: string;
      repo: string | null;
      number: number | null;
      refsInBody: boolean;
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO server.github_issue_links (incident_id, kind, url, repo, number, title, refs_in_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (incident_id, url) DO NOTHING`,
      [incidentId, l.kind, l.url, l.repo, l.number, l.title.slice(0, 200), l.refsInBody],
    );
  }

  /** 后台一轮：登记需要 issue 的事件 → 开出到期的 issue → 生成并发出进展评论 → 给关联的 PR 补 Refs */
  async runOnce(): Promise<void> {
    await this.scan();
    await this.openDue(null);
    await this.refreshContent();
    await this.syncComments();
    await this.postDueComments();
    await this.patchPullRefs();
  }

  /**
   * 处置判断为 escalate 的事件：最新的阶段 A 报告，或已完成的研判；
   * 研判处置为 act 而没有提议的事件（修复是修改仓库中的声明或按修复模板开 PR，ADR 0162）：原因为 repo_change，
   * 修复模板没有开出 PR 时也有 issue 跟进
   */
  private async scan(): Promise<void> {
    await this.pool.query(
      `INSERT INTO server.github_issues (incident_id, repo, state, reason)
       SELECT i.incident_id, $1, 'pending', 'repo_change' FROM server.incidents i
        WHERE NOT i.suppressed AND i.state <> 'merged' AND i.updated_at > now() - make_interval(secs => $2)
          AND NOT EXISTS (SELECT 1 FROM server.github_issues g WHERE g.incident_id = i.incident_id)
          AND EXISTS (SELECT 1 FROM server.research_runs r WHERE r.incident_id = i.incident_id
                        AND r.state = 'completed' AND r.disposition = 'act'
                        AND jsonb_array_length(coalesce(r.output->'proposals', '[]'::jsonb)) = 0)
       ON CONFLICT (incident_id) DO NOTHING`,
      [this.s.repo, this.s.lookbackMs / 1000],
    );
    await this.pool.query(
      `INSERT INTO server.github_issues (incident_id, repo, state, reason)
       SELECT i.incident_id, $1, 'pending', 'escalate' FROM server.incidents i
        WHERE NOT i.suppressed AND i.state <> 'merged' AND i.updated_at > now() - make_interval(secs => $2)
          AND NOT EXISTS (SELECT 1 FROM server.github_issues g WHERE g.incident_id = i.incident_id)
          AND (
            (SELECT s.disposition FROM server.stage_a_reports s WHERE s.incident_id = i.incident_id
              ORDER BY s.incident_version DESC LIMIT 1) = 'escalate'
            OR EXISTS (SELECT 1 FROM server.research_runs r WHERE r.incident_id = i.incident_id
                        AND r.state = 'completed' AND r.disposition = 'escalate'))
       ON CONFLICT (incident_id) DO NOTHING`,
      [this.s.repo, this.s.lookbackMs / 1000],
    );
  }

  /** 开出到期的 issue（或指定事件的一个） */
  private async openDue(only: string | null): Promise<void> {
    const due = await this.pool.query<{ incident_id: string }>(
      `SELECT incident_id FROM server.github_issues WHERE state = 'pending' AND (${only ? 'incident_id = $1' : 'next_attempt_at <= now()'})
        ORDER BY created_at LIMIT 20`,
      only ? [only] : [],
    );
    for (const { incident_id } of due.rows) {
      await this.openOne(incident_id);
    }
  }

  private async openOne(incidentId: string): Promise<void> {
    // issue 的结果写进事件的终态记录（ADR 0172），与 issue 状态在同一事务里，提交后计数
    const written: ReasonRecord[] = [];
    const record = async (c: Queryable, code: ReasonCodeOf<'issue'>, detail: string | null, ref: string | null) => {
      const r: ReasonRecord = { incidentId, stage: 'issue', code, detail, ref, once: code };
      if (await writeReason(c, r)) {
        written.push(r);
      }
    };
    await tx(this.pool, async (c) => {
      const r = await c.query<IssueRow>(
        `SELECT incident_id, repo, state, reason, number, url, attempts FROM server.github_issues
          WHERE incident_id = $1 FOR UPDATE`,
        [incidentId],
      );
      const row = r.rows[0];
      if (!row || row.state !== 'pending') {
        return;
      }
      // 外部上游的事件（ADR 0147）：进入周期汇总，不开 issue；需要改仓库的修复提议（repo_change）照常开
      const external = row.reason === 'escalate' ? await this.externalOf(incidentId) : null;
      if (external === 'firing') {
        await c.query(
          `UPDATE server.github_issues SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3), updated_at = now()
            WHERE incident_id = $1`,
          [incidentId, EXTERNAL_NOTE, EXTERNAL_RECHECK_MS / 1000],
        );
        return;
      }
      if (external === 'ended') {
        await c.query(
          `UPDATE server.github_issues SET state = 'skipped', last_error = $2, updated_at = now() WHERE incident_id = $1`,
          [incidentId, EXTERNAL_NOTE],
        );
        await appendAudit(c, 'github.issue_skipped', 'server', {
          incident_id: incidentId,
          repo: row.repo,
          reason: 'external_root',
        });
        this.metrics.githubIssues.inc({ repo: row.repo, outcome: 'skipped_external' });
        await record(c, 'external_root', null, row.repo);
        logger.info('外部上游的事件不开 issue', { incident_id: incidentId, repo: row.repo });
        return;
      }
      // 同一系列在这个仓库已有打开的 issue（ADR 0184）：复用它，不新开，不计入每小时上限。正文哈希清空，下一轮正文换成
      // 这个事件的报告；标题沿用 issue 现在的标题与上次改标题的时刻
      const reuse = await reusableIssue(c, incidentId, row.repo);
      if (reuse) {
        await c.query(
          `UPDATE server.github_issues SET state = 'open', number = $2, url = $3, opened_at = now(), attempts = attempts + 1,
             last_error = NULL, body_hash = NULL, title = $4, title_updated_at = $5, reused_from = $6, updated_at = now()
           WHERE incident_id = $1`,
          [incidentId, reuse.number, reuse.url, reuse.title, reuse.title_updated_at, reuse.opener],
        );
        await appendAudit(c, 'github.issue_reused', 'server', {
          incident_id: incidentId,
          repo: row.repo,
          number: reuse.number,
          url: reuse.url,
          reason: row.reason,
          from_incident_id: reuse.incident_id,
        });
        this.metrics.githubIssues.inc({ repo: row.repo, outcome: 'reused' });
        await record(c, 'reused', `#${reuse.number}`, reuse.url);
        logger.info('同一系列已有打开的 issue，复用', { incident_id: incidentId, url: reuse.url });
        return;
      }
      if ((await openedLastHour(c, row.repo)) >= this.s.maxPerHour) {
        const why = `仓库 ${row.repo} 最近 1 小时已开 ${this.s.maxPerHour} 个 issue（事件 issue 与覆盖 issue 合计），达到上限`;
        await c.query(
          `UPDATE server.github_issues SET state = 'skipped', last_error = $2, updated_at = now() WHERE incident_id = $1`,
          [incidentId, why],
        );
        await record(c, 'rate_limit', why, row.repo);
        await appendAudit(c, 'github.issue_skipped', 'server', {
          incident_id: incidentId,
          repo: row.repo,
          reason: 'rate_limit',
          max_per_hour: this.s.maxPerHour,
        });
        this.metrics.githubIssues.inc({ repo: row.repo, outcome: 'skipped_rate_limit' });
        logger.warn('事件 issue 达到每小时上限，只记录不开', { incident_id: incidentId, repo: row.repo });
        return;
      }
      try {
        // 上一次可能已经开出但没有收到响应：先按事件标记找回
        const found = row.attempts > 0 ? await this.findByMarker(row.repo, incidentMarker(incidentId)) : null;
        const issue = found ? { ...found, bodyHash: null } : await this.create(row);
        await c.query(
          `UPDATE server.github_issues SET state = 'open', number = $2, url = $3, opened_at = now(), attempts = attempts + 1,
             last_error = NULL, body_hash = $4, title = $5, updated_at = now() WHERE incident_id = $1`,
          [incidentId, issue.number, issue.url, issue.bodyHash, issue.title],
        );
        await appendAudit(c, 'github.issue_opened', 'server', {
          incident_id: incidentId,
          repo: row.repo,
          number: issue.number,
          url: issue.url,
          reason: row.reason,
          recovered: found !== null,
        });
        this.metrics.githubIssues.inc({ repo: row.repo, outcome: 'opened' });
        await record(c, 'opened', null, issue.url);
        logger.info('事件 issue 已开', { incident_id: incidentId, url: issue.url });
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        const attempts = row.attempts + 1;
        const give = attempts >= MAX_ATTEMPTS;
        await c.query(
          `UPDATE server.github_issues SET state = $2, attempts = $3, last_error = $4,
             next_attempt_at = now() + make_interval(secs => $5), updated_at = now() WHERE incident_id = $1`,
          [incidentId, give ? 'failed' : 'pending', attempts, e.message.slice(0, 500), backoffMs(attempts) / 1000],
        );
        if (give) {
          await appendAudit(c, 'github.issue_failed', 'server', {
            incident_id: incidentId,
            repo: row.repo,
            attempts,
            error: e.message.slice(0, 500),
          });
          await record(c, 'failed', `重试 ${attempts} 次：${e.message.slice(0, 500)}`, row.repo);
        }
        this.metrics.githubIssues.inc({ repo: row.repo, outcome: give ? 'failed' : 'retry' });
        logger.warn(give ? '事件 issue 重试用尽，放弃' : '事件 issue 开出失败，稍后重试', {
          incident_id: incidentId,
          attempts,
          error: e.message,
        });
      }
    });
    countReasons(this.metrics, written);
  }

  private async findByMarker(repo: string, marker: string): Promise<(IssueRef & { title: string | null }) | null> {
    const label = encodeURIComponent(this.s.labels[0] ?? 'srenautix');
    const list = await this.gh.api<
      Array<{ number: number; html_url: string; title?: string; body: string | null; pull_request?: unknown }>
    >(
      'GET',
      `/repos/${repo}/issues?labels=${label}&state=all&sort=created&direction=desc&per_page=50`,
      undefined,
      'list_issues',
    );
    const hit = list.find((i) => !i.pull_request && (i.body ?? '').includes(marker));
    return hit ? { number: hit.number, url: hit.html_url, repo, title: hit.title ?? null } : null;
  }

  private async create(row: IssueRow): Promise<IssueRef & { bodyHash: string; title: string }> {
    const content = await this.render(row.incident_id, row.reason);
    const r = await this.gh.api<{ number: number; html_url: string }>(
      'POST',
      `/repos/${row.repo}/issues`,
      { title: content.title, body: content.body, labels: this.s.labels },
      'create_issue',
    );
    return {
      number: r.number,
      url: r.html_url,
      repo: row.repo,
      bodyHash: createHash('sha256').update(content.body).digest('hex'),
      title: content.title,
    };
  }

  /**
   * issue 的标题与正文（ADR 0125）：与通知同一份报告（现状、关键问题、拓扑联系、解决方案、证据链）的全文，
   * 开头是事件标记与开 issue 的原因
   */
  private async render(incidentId: string, reason: IssueReason): Promise<{ title: string; body: string }> {
    const t = T[this.s.language];
    const m = await this.report(incidentId, this.s.language);
    if (!m) {
      throw new Error(`没有事件 ${incidentId} 或它的阶段 A 报告`);
    }
    const lead = `${incidentMarker(incidentId)}\n**${t.why}**：${t.reason[reason]}\n`;
    const r = issueMarkdown({ ...m, prefix: this.s.titlePrefix }, lead, t.footer);
    return { title: r.title, body: r.body };
  }

  /**
   * 标题与正文跟随事件：研判结束、事件恢复、证据变化后重新生成，与上次写入的不同时就地更新（一次 PATCH，只含变化的字段）。
   * - 正文变了就更新；
   * - 标题是根因与头条症状（ADR 0142）。它们变了就更新标题，否则按事件开出时的标题搜不到这个 issue。同一事件每小时最多改一次标题
   *   （TITLE_MIN_INTERVAL），根因或症状来回抖动时不跟着来回改；没到时间的标题留到之后的轮次，正文照常更新。
   * - 不知道 GitHub 上现在的标题时（按标记找回、这一版之前开出的 issue）先读回一次。
   * 只处理最近更新过的事件；同一系列的几个事件共用一个 issue 时（ADR 0184），只按最近接上它的事件更新
   */
  private async refreshContent(): Promise<void> {
    const open = await this.pool.query<{
      incident_id: string;
      repo: string;
      number: number;
      reason: IssueReason;
      body_hash: string | null;
      title: string | null;
      title_due: boolean;
    }>(
      `SELECT g.incident_id, g.repo, g.number, g.reason, g.body_hash, g.title,
              (g.title_updated_at IS NULL OR g.title_updated_at <= now() - make_interval(secs => $2)) AS title_due
         FROM server.github_issues g
         JOIN server.incidents i ON i.incident_id = g.incident_id
        WHERE g.state = 'open' AND i.updated_at > now() - make_interval(secs => $1)
          AND NOT EXISTS (SELECT 1 FROM server.github_issues x
                           WHERE x.repo = g.repo AND x.number = g.number AND x.state = 'open'
                             AND (x.opened_at, x.incident_id) > (g.opened_at, g.incident_id))
        ORDER BY g.opened_at LIMIT 50`,
      [this.s.lookbackMs / 1000, TITLE_MIN_INTERVAL_MS / 1000],
    );
    for (const row of open.rows) {
      const content = await this.render(row.incident_id, row.reason);
      const hash = createHash('sha256').update(content.body).digest('hex');
      let current = row.title;
      let retitled = false;
      try {
        if (current === null) {
          const issue = await this.gh.api<{ title: string }>(
            'GET',
            `/repos/${row.repo}/issues/${row.number}`,
            undefined,
            'get_issue',
          );
          current = issue.title;
          await this.pool.query('UPDATE server.github_issues SET title = $2 WHERE incident_id = $1', [
            row.incident_id,
            current,
          ]);
        }
        retitled = content.title !== current && row.title_due;
        if (hash === row.body_hash && !retitled) {
          continue;
        }
        const patch: { title?: string; body?: string } = {};
        if (retitled) {
          patch.title = content.title;
        }
        if (hash !== row.body_hash) {
          patch.body = content.body;
        }
        await this.gh.api('PATCH', `/repos/${row.repo}/issues/${row.number}`, patch, 'update_issue');
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        logger.warn('事件 issue 更新失败，下一轮重试', { incident_id: row.incident_id, error: e.message });
        continue;
      }
      await tx(this.pool, async (c) => {
        await c.query(
          `UPDATE server.github_issues SET body_hash = $2, title = $3,
             title_updated_at = CASE WHEN $4 THEN now() ELSE title_updated_at END, updated_at = now() WHERE incident_id = $1`,
          [row.incident_id, hash, retitled ? content.title : current, retitled],
        );
        if (retitled) {
          await appendAudit(c, 'github.issue_retitled', 'server', {
            incident_id: row.incident_id,
            repo: row.repo,
            number: row.number,
            from: current,
            to: content.title,
          });
        }
      });
      if (hash !== row.body_hash) {
        this.metrics.githubIssues.inc({ repo: row.repo, outcome: 'body_updated' });
      }
      if (retitled) {
        this.metrics.githubIssues.inc({ repo: row.repo, outcome: 'title_updated' });
        logger.info('事件 issue 标题已随根因与头条症状更新', { incident_id: row.incident_id, title: content.title });
      }
    }
  }

  /** 进展评论：issue 开出之后结束的研判、事件恢复、关联的 PR 与提议 */
  private async syncComments(): Promise<void> {
    const t = T[this.s.language];
    const runs = await this.pool.query<{
      incident_id: string;
      run_id: string;
      state: string;
      conclusion_level: string | null;
      root_component: string | null;
      error: { message?: string } | null;
    }>(
      `SELECT r.incident_id, r.run_id, r.state, r.conclusion_level, r.root_component, r.error FROM server.research_runs r
         JOIN server.github_issues g ON g.incident_id = r.incident_id
        WHERE g.state = 'open' AND r.finished_at > g.opened_at AND r.state IN ('completed', 'failed', 'stage_a_only')`,
    );
    // 还没有写下恢复评论的恢复（键与下面的 resolved:<ISO 时间> 相同）
    const resolved = await this.pool.query<{ incident_id: string; ended_at: Date; repo: string; number: number }>(
      `SELECT i.incident_id, i.ended_at, g.repo, g.number FROM server.incidents i
         JOIN server.github_issues g ON g.incident_id = i.incident_id
        WHERE g.state = 'open' AND i.state = 'resolved' AND i.ended_at > g.opened_at
          AND NOT EXISTS (SELECT 1 FROM server.github_issue_comments c WHERE c.incident_id = i.incident_id
                           AND c.key = 'resolved:' || to_char(i.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
    );
    const resolvedText = await this.resolvedTexts(resolved.rows);
    const links = await this.pool.query<{ incident_id: string; kind: 'pull' | 'proposal'; url: string; title: string }>(
      `SELECT l.incident_id, l.kind, l.url, l.title FROM server.github_issue_links l
         JOIN server.github_issues g ON g.incident_id = l.incident_id WHERE g.state = 'open'`,
    );
    // 最近一次完成的研判根因与事件根因不一致时追加一条评论（每次研判一条），事件不拆分
    const open = await this.pool.query<{ incident_id: string; cluster_id: string; root_component: string | null }>(
      `SELECT i.incident_id, i.cluster_id, i.root_component FROM server.incidents i
         JOIN server.github_issues g ON g.incident_id = i.incident_id WHERE g.state = 'open'`,
    );
    const roots = await researchRoots(this.pool, this.ownerOf, open.rows);
    const incidentRoot = new Map(open.rows.map((r) => [r.incident_id, r.root_component]));
    const want: Array<[string, string, string]> = [
      ...[...roots]
        .filter(([, r]) => r.mismatch)
        .map(([incidentId, r]): [string, string, string] => [
          incidentId,
          `root-mismatch:${r.run_id}`,
          t.rootMismatch(r.component, incidentRoot.get(incidentId) ?? '-'),
        ]),
      ...runs.rows.map((r): [string, string, string] => [
        r.incident_id,
        `research:${r.run_id}`,
        t.research(r.state, r.conclusion_level, r.root_component, r.error?.message?.slice(0, 300) ?? null),
      ]),
      ...resolved.rows.map((r): [string, string, string] => [
        r.incident_id,
        `resolved:${r.ended_at.toISOString()}`,
        resolvedText.get(r.incident_id)!,
      ]),
      ...links.rows.map((l): [string, string, string] => [
        l.incident_id,
        `link:${l.url}`,
        l.kind === 'pull' ? t.pull(l.title, l.url) : t.proposal(l.title, l.url),
      ]),
    ];
    for (const [incidentId, key, text] of want) {
      await this.pool.query(
        `INSERT INTO server.github_issue_comments (incident_id, key, body) VALUES ($1, $2, $3)
         ON CONFLICT (incident_id, key) DO NOTHING`,
        [incidentId, key, `${commentMarker(key)}\n${text}`],
      );
    }
  }

  /**
   * 恢复评论的文字（ADR 0184）：issue 上第一次发生恢复时只写恢复时刻；之后每次发生恢复时写第几次发生、本次持续时长与到这次
   * 为止的累计时长。发生次数是接上同一个 issue 的全部事件（同一事件的重开，复用 issue 的同系列事件）的成员告警触发区间
   * 合并后的时段（core 的 incidentOccurrences）
   */
  private async resolvedTexts(
    rows: ReadonlyArray<{ incident_id: string; ended_at: Date; repo: string; number: number }>,
  ): Promise<Map<string, string>> {
    const t = T[this.s.language];
    const out = new Map<string, string>();
    if (rows.length === 0) {
      return out;
    }
    const linked = await this.pool.query<{ repo: string; number: number; body: Incident }>(
      `SELECT g.repo, g.number, i.body FROM server.github_issues g JOIN server.incidents i ON i.incident_id = g.incident_id
        WHERE g.state = 'open' AND (g.repo, g.number) IN (SELECT * FROM unnest($1::text[], $2::int[]))`,
      [rows.map((r) => r.repo), rows.map((r) => r.number)],
    );
    const byIssue = new Map<string, Incident[]>();
    for (const l of linked.rows) {
      const k = `${l.repo}#${l.number}`;
      byIssue.set(k, [...(byIssue.get(k) ?? []), l.body]);
    }
    const span = (ms: number) => {
      const m = Math.max(0, Math.round(ms / 60_000));
      return t.hours(Math.floor(m / 60), m % 60);
    };
    for (const r of rows) {
      const at = r.ended_at.toISOString();
      const ended = r.ended_at.getTime();
      const occurrences = incidentOccurrences(byIssue.get(`${r.repo}#${r.number}`) ?? []);
      // 这次恢复所在的那次发生：开始不晚于恢复时刻的最后一次
      const k = occurrences.findLastIndex((o) => o.start <= ended);
      if (k <= 0) {
        out.set(r.incident_id, t.resolved(at));
        continue;
      }
      const length = (o: Occurrence) => (o.end ?? ended) - o.start;
      const total = occurrences.slice(0, k + 1).reduce((a, o) => a + length(o), 0);
      out.set(r.incident_id, t.recurred(at, k + 1, span(length(occurrences[k]!)), span(total)));
    }
    return out;
  }

  private async postDueComments(): Promise<void> {
    const due = await this.pool.query<{
      incident_id: string;
      key: string;
      body: string;
      attempts: number;
      repo: string;
      number: number;
    }>(
      `SELECT c.incident_id, c.key, c.body, c.attempts, g.repo, g.number FROM server.github_issue_comments c
         JOIN server.github_issues g ON g.incident_id = c.incident_id
        WHERE c.posted_at IS NULL AND c.attempts < $1 AND c.next_attempt_at <= now() AND g.state = 'open'
        ORDER BY c.created_at LIMIT 50`,
      [MAX_ATTEMPTS],
    );
    for (const c of due.rows) {
      try {
        let url: string | null = null;
        if (c.attempts > 0) {
          const list = await this.gh.api<Array<{ html_url: string; body: string | null }>>(
            'GET',
            `/repos/${c.repo}/issues/${c.number}/comments?per_page=100`,
            undefined,
            'list_comments',
          );
          url = list.find((x) => (x.body ?? '').includes(commentMarker(c.key)))?.html_url ?? null;
        }
        if (!url) {
          const r = await this.gh.api<{ html_url: string }>(
            'POST',
            `/repos/${c.repo}/issues/${c.number}/comments`,
            { body: c.body },
            'create_comment',
          );
          url = r.html_url;
        }
        await tx(this.pool, async (cl) => {
          await cl.query(
            `UPDATE server.github_issue_comments SET posted_at = now(), url = $3, attempts = attempts + 1, last_error = NULL
              WHERE incident_id = $1 AND key = $2`,
            [c.incident_id, c.key, url],
          );
          await appendAudit(cl, 'github.issue_comment', 'server', {
            incident_id: c.incident_id,
            repo: c.repo,
            number: c.number,
            key: c.key,
            url,
          });
        });
        this.metrics.githubComments.inc({ repo: c.repo, outcome: 'posted' });
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        const attempts = c.attempts + 1;
        await this.pool.query(
          `UPDATE server.github_issue_comments SET attempts = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5)
            WHERE incident_id = $1 AND key = $2`,
          [c.incident_id, c.key, attempts, e.message.slice(0, 500), backoffMs(attempts) / 1000],
        );
        this.metrics.githubComments.inc({ repo: c.repo, outcome: attempts >= MAX_ATTEMPTS ? 'failed' : 'retry' });
        logger.warn('issue 评论发出失败，稍后重试', { incident_id: c.incident_id, key: c.key, error: e.message });
      }
    }
  }

  /** 关联的 PR 描述里还没有 Refs 时补上（PR 先于 issue 开出的情况） */
  private async patchPullRefs(): Promise<void> {
    const r = await this.pool.query<{
      incident_id: string;
      url: string;
      repo: string;
      number: number;
      issue_repo: string;
      issue: number;
    }>(
      `SELECT l.incident_id, l.url, l.repo, l.number, g.repo AS issue_repo, g.number AS issue FROM server.github_issue_links l
         JOIN server.github_issues g ON g.incident_id = l.incident_id
        WHERE g.state = 'open' AND l.kind = 'pull' AND NOT l.refs_in_body AND l.repo IS NOT NULL AND l.number IS NOT NULL`,
    );
    for (const l of r.rows) {
      const ref = `Refs ${GitHubApp.ref(l.repo, l.issue_repo, l.issue)}`;
      try {
        const pr = await this.gh.api<{ body: string | null }>(
          'GET',
          `/repos/${l.repo}/pulls/${l.number}`,
          undefined,
          'get_pull',
        );
        if (!(pr.body ?? '').includes(ref)) {
          await this.gh.api(
            'PATCH',
            `/repos/${l.repo}/pulls/${l.number}`,
            { body: `${pr.body ?? ''}\n\n${ref}` },
            'update_pull',
          );
        }
        await tx(this.pool, async (c) => {
          await c.query(
            'UPDATE server.github_issue_links SET refs_in_body = true WHERE incident_id = $1 AND url = $2',
            [l.incident_id, l.url],
          );
          await appendAudit(c, 'github.pr_refs', 'server', { incident_id: l.incident_id, pr: l.url, refs: ref });
        });
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        logger.warn('给 PR 补 Refs 失败，下一轮重试', { pr: l.url, error: e.message });
      }
    }
  }
}
