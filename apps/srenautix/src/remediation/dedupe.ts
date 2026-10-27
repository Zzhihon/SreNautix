import { createHash } from 'node:crypto';
import { locationChanged, type RemediationLocation } from '@srenautix/packs-sdk';
import { applyPatch, parsePatch, type StructuredPatch } from 'diff';
import type pg from 'pg';
import { GitHubError, type GitHubApp } from '../github/app.js';
import { closureDetails, type ClosureSink } from '../github/closures.js';
import { logger } from '../log.js';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';
import { GitHubRepoReader } from './github-repo.js';

/**
 * 自愈 PR 的修改去重与拒绝记忆（ADR 0155）。去重键是（仓库，变更哈希）：
 * - 变更哈希由规范化补丁与修改定位一起计算。规范化补丁只保留每个文件的路径与增删的行，不含 index 行、hunk 头与上下文行，
 *   基准提交前进、行号移动后同一个修改的哈希不变；修改定位是模板 edits 声明的目标（规则名、YAML 路径、资源名），
 *   同一个文件里增删的行相同、改的是不同规则的两个补丁哈希不同；
 * - 同一个修改已有未结束的提议或打开的 PR 时不再提议，改为在这个 PR 上评论新的触发，并把新事件的 issue 关联到 PR；
 * - PR 被关闭且没有合并（或提议在审批时被人拒绝）是"人已拒绝"：同一个修改不再自动提出；同一模板对同一组文件的其他修改
 *   在 rejected_cooldown 内也不提出；
 * - 旧算法（hash_version 1，只含规范化补丁）记录的行按原样保留：它们按旧哈希参与 duplicate_open、duplicate_pending；
 *   rejected_before 要求旧哈希相同并且定位相同，定位相同由旧补丁在它的基准内容上是否改动了新修改的每个定位确认；
 * - 记录在 server.remediation_changes（每个提议一行）与 server.remediation_triggers（重复触发），状态在 PostgreSQL 里，
 *   server 重启后照常生效。PR 的状态在需要判断时按需从 GitHub 读取（GET pulls/{n}）。
 */

const stripAB = (p: string | undefined) => (p ?? '').replace(/^[ab]\//, '');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const pathOf = (f: StructuredPatch) =>
  stripAB(f.newFileName && f.newFileName !== '/dev/null' ? f.newFileName : f.oldFileName);

/** 补丁里的文件（空串也会解析出一个没有文件名的条目）；补丁不能解析或没有文件时抛出 */
function patchFiles(patch: string): StructuredPatch[] {
  const files = parsePatch(patch).filter((f) => f.oldFileName !== undefined || f.newFileName !== undefined);
  if (!files.length) {
    throw new Error('补丁没有任何文件');
  }
  return files;
}

/** 规范化补丁：按路径排序的（路径，增删的行） */
function normalized(patch: string): Array<readonly [string, string[]]> {
  return patchFiles(patch)
    .map(
      (f) =>
        [pathOf(f), f.hunks.flatMap((h) => h.lines.filter((l) => l.startsWith('+') || l.startsWith('-')))] as const,
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** 旧算法（hash_version 1）的变更哈希：只含规范化补丁 */
export function legacyChangeHash(patch: string): string {
  return sha256(JSON.stringify(normalized(patch)));
}

/** 修改定位的哈希：去重后排序的（路径，kind，name，locate）；没有定位时抛出 */
export function locationHash(locations: readonly RemediationLocation[]): string {
  if (!locations.length) {
    throw new Error('修改没有任何定位');
  }
  const keys = [...new Set(locations.map((l) => JSON.stringify([l.path, l.kind, l.name, l.locate])))].sort();
  return sha256(JSON.stringify(keys));
}

/** 变更哈希（hash_version 2）：规范化补丁与修改定位一起 */
export function changeHash(patch: string, locations: readonly RemediationLocation[]): string {
  return sha256(JSON.stringify({ files: normalized(patch), locations: locationHash(locations) }));
}

export type ChangeState = 'pending' | 'open' | 'merged' | 'rejected' | 'abandoned';

export interface ChangeRow {
  proposal_id: string;
  repository: string;
  change_hash: string;
  /** 1：change_hash 只含规范化补丁（旧算法）；2：change_hash 含修改定位 */
  hash_version: 1 | 2;
  /** 修改定位的哈希；旧算法的行在过渡规则确认定位之前为 null */
  location_hash: string | null;
  key: string;
  files: string[];
  incident_id: string;
  state: ChangeState;
  pr_number: number | null;
  pr_url: string | null;
  closed_at: Date | null;
  created_at: Date;
}

const COLUMNS =
  'proposal_id, repository, change_hash, hash_version, location_hash, key, files, incident_id, state, pr_number, pr_url, closed_at, created_at';

/** 计划出的一个修改 */
export interface PlannedChange {
  repository: string;
  patch: string;
  locations: readonly RemediationLocation[];
  /** 模板键 */
  key: string;
  files: readonly string[];
}

/** 新修改用于比较的键 */
export interface ChangeKeys {
  hash: string;
  legacy: string;
  location: string;
  key: string;
  /** 排序后的文件列表的 JSON */
  files: string;
}

export function changeKeys(c: PlannedChange): ChangeKeys {
  return {
    hash: changeHash(c.patch, c.locations),
    legacy: legacyChangeHash(c.patch),
    location: locationHash(c.locations),
    key: c.key,
    files: JSON.stringify([...c.files].sort()),
  };
}

/** 新修改的去重结论：null 表示可以提议 */
export type Verdict =
  | { code: 'duplicate_open' | 'duplicate_pending'; row: ChangeRow }
  | { code: 'rejected_before'; row: ChangeRow }
  | { code: 'rejected_cooldown'; row: ChangeRow; until: Date };

/**
 * 按已有的修改（状态已刷新，旧算法被拒绝的行已经过定位确认）给出去重结论：
 * - 同一个修改：hash_version 2 的行变更哈希相同，或 hash_version 1 的行旧哈希相同；有打开的 PR 时 duplicate_open，
 *   有未结束的提议时 duplicate_pending；
 * - rejected_before：被拒绝的行变更哈希相同，或旧哈希相同并且定位相同（location_hash 相同）；
 * - rejected_cooldown：同一模板对同一组文件的修改在冷却期内被拒绝
 */
export function classify(rows: readonly ChangeRow[], k: ChangeKeys, now: number, cooldownMs: number): Verdict | null {
  const same = (x: ChangeRow) => x.hash_version === 2 && x.change_hash === k.hash;
  const legacy = (x: ChangeRow) => x.hash_version === 1 && x.change_hash === k.legacy;
  const duplicate = rows.filter((x) => same(x) || legacy(x));
  const open = duplicate.find((x) => x.state === 'open');
  if (open) {
    return { code: 'duplicate_open', row: open };
  }
  const pending = duplicate.find((x) => x.state === 'pending');
  if (pending) {
    return { code: 'duplicate_pending', row: pending };
  }
  const rejected = rows.find(
    (x) => x.state === 'rejected' && (same(x) || (legacy(x) && x.location_hash === k.location)),
  );
  if (rejected) {
    return { code: 'rejected_before', row: rejected };
  }
  if (cooldownMs > 0) {
    const recent = rows
      .filter(
        (x) =>
          x.state === 'rejected' &&
          x.key === k.key &&
          JSON.stringify(x.files) === k.files &&
          x.closed_at &&
          now - x.closed_at.getTime() < cooldownMs,
      )
      .sort((a, b) => b.closed_at!.getTime() - a.closed_at!.getTime())[0];
    if (recent) {
      return { code: 'rejected_cooldown', row: recent, until: new Date(recent.closed_at!.getTime() + cooldownMs) };
    }
  }
  return null;
}

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
    /** PR 关闭且没有合并时写隐式反馈 pr_closed 与评测候选（ADR 0174），与状态更新同一事务 */
    private readonly closed: ClosureSink,
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
        // 提议参数里没有修改定位：补登记的行按旧算法记录，按过渡规则参与去重
        `INSERT INTO server.remediation_changes (proposal_id, repository, change_hash, key, files, incident_id, state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) ON CONFLICT (proposal_id) DO NOTHING`,
        [
          x.proposal_id,
          x.repository,
          legacyChangeHash(x.patch),
          x.key,
          JSON.stringify([...x.files].sort()),
          x.incident_id,
          x.created_at,
        ],
      );
    }
    return r.rows.length;
  }

  /**
   * 按提议、gitops_pulls 与 GitHub 上 PR 的当前状态刷新一行；merged 与 abandoned 不再变化。PR 从打开变为关闭且没有合并时
   * 读取关闭者与关闭之前的最后一条评论，写隐式反馈 pr_closed（关联事件与提议所属的研判）
   */
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
    // PR 关闭且没有合并（审批时被拒绝的提议没有 PR，已经有隐式反馈 rejected）
    const closure =
      next.state === 'rejected' && row.state !== 'rejected' && next.pr_number !== null
        ? await closureDetails(this.github, next.repository, next.pr_number, next.closed_at as Date, true)
        : null;
    if (next.state !== row.state || next.pr_number !== row.pr_number) {
      await tx(this.pool, async (c) => {
        await c.query(
          `UPDATE server.remediation_changes SET state = $2, pr_number = $3, pr_url = $4, closed_at = $5, checked_at = now()
            WHERE proposal_id = $1`,
          [next.proposal_id, next.state, next.pr_number, next.pr_url, next.closed_at],
        );
        if (closure) {
          const run = await c.query<{ run_id: string | null }>(
            `SELECT coalesce((SELECT a.run_id FROM server.remediation_attempts a WHERE a.proposal_id = $1 LIMIT 1),
                             (SELECT (p.body->>'research_run_id')::uuid FROM server.proposals p WHERE p.proposal_id = $1)) AS run_id`,
            [next.proposal_id],
          );
          await this.closed(c, {
            kind: 'pr_closed',
            incidentId: next.incident_id,
            researchRunId: run.rows[0]?.run_id ?? null,
            closedBy: closure.closedBy,
            reason: closure.comment,
            url: next.pr_url ?? `https://github.com/${next.repository}/pull/${next.pr_number}`,
          });
        }
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
   * 关闭跟踪（ADR 0174）：刷新 PR 仍打开的修改，每个仓库最多 perRepo 个、最久没有检查的在前，检查过的（包括 GitHub
   * 请求失败的）更新 checked_at，下一轮先检查其他的。单个 PR 的 GitHub 请求失败只记日志；返回状态发生变化的个数
   */
  async refreshOpen(perRepo: number): Promise<number> {
    const r = await this.pool.query<ChangeRow>(
      `SELECT ${COLUMNS}
         FROM (SELECT *, row_number() OVER (PARTITION BY repository ORDER BY checked_at, proposal_id) AS n
                 FROM server.remediation_changes WHERE state = 'open') x
        WHERE n <= $1 ORDER BY checked_at, proposal_id`,
      [perRepo],
    );
    let changed = 0;
    for (const row of r.rows) {
      try {
        const next = await this.refresh(row);
        if (next.state !== row.state) {
          changed++;
        }
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        logger.warn('自愈 PR 的状态读取失败，下一轮重试', { proposal_id: row.proposal_id, error: e.message });
      }
      await this.pool.query('UPDATE server.remediation_changes SET checked_at = now() WHERE proposal_id = $1', [
        row.proposal_id,
      ]);
    }
    return changed;
  }

  /**
   * 新修改能否提议：同一仓库的同一个修改有未结束的提议或打开的 PR 时是重复；同一个修改被人拒绝过时不再提；
   * 同一模板对同一组文件的修改在冷却期内被拒绝过时等冷却期结束（classify）。旧算法被拒绝、旧哈希相同、还没有确认过定位的
   * 行先确认定位：旧补丁改动了新修改的每个定位时记下这组定位，按 rejected_before 处理
   */
  async verdict(change: PlannedChange): Promise<Verdict | null> {
    const k = changeKeys(change);
    const r = await this.pool.query<ChangeRow>(
      `SELECT ${COLUMNS} FROM server.remediation_changes
        WHERE repository = $1 AND state IN ('pending', 'open', 'rejected')
          AND ((hash_version = 2 AND change_hash = $2) OR (hash_version = 1 AND change_hash = $3)
               OR (key = $4 AND files = $5::jsonb))
        ORDER BY created_at`,
      [change.repository, k.hash, k.legacy, k.key, k.files],
    );
    const rows: ChangeRow[] = [];
    for (const x of r.rows) {
      let row = await this.refresh(x);
      if (
        row.state === 'rejected' &&
        row.hash_version === 1 &&
        row.change_hash === k.legacy &&
        row.location_hash === null &&
        (await this.sameLocation(row, change.locations))
      ) {
        await this.pool.query(
          'UPDATE server.remediation_changes SET locations = $2, location_hash = $3 WHERE proposal_id = $1',
          [row.proposal_id, JSON.stringify(change.locations), k.location],
        );
        row = { ...row, location_hash: k.location };
      }
      rows.push(row);
    }
    return classify(rows, k, Date.now(), this.cooldownMs);
  }

  /**
   * 旧算法记录的修改是否与这组定位相同：把它的补丁应用到它的基准提交上的内容，每个定位上的内容都发生了变化。
   * 基准提交取提议的尝试记录；补丁在基准内容上不能应用说明记录不一致，抛出
   */
  private async sameLocation(row: ChangeRow, locations: readonly RemediationLocation[]): Promise<boolean> {
    const r = await this.pool.query<{ patch: string | null; base: string | null }>(
      `SELECT p.params->>'patch' AS patch,
              (SELECT a.base FROM server.remediation_attempts a
                WHERE a.proposal_id = p.proposal_id AND a.base IS NOT NULL LIMIT 1) AS base
         FROM server.proposals p WHERE p.proposal_id = $1`,
      [row.proposal_id],
    );
    const x = r.rows[0];
    if (!x?.patch || !x.base) {
      throw new Error(`修改记录 ${row.proposal_id} 没有补丁或基准提交`);
    }
    const files = new Map(patchFiles(x.patch).map((f) => [pathOf(f), f]));
    const reader = new GitHubRepoReader(this.github, row.repository, x.base);
    for (const at of locations) {
      const f = files.get(at.path);
      if (!f) {
        return false;
      }
      const before = f.oldFileName === '/dev/null' ? '' : await reader.readAt(x.base, at.path);
      if (before === null) {
        throw new Error(`${row.repository} 的 ${at.path} 在基准提交 ${x.base.slice(0, 12)} 上不存在`);
      }
      const after = applyPatch(before, f);
      if (after === false) {
        throw new Error(`修改记录 ${row.proposal_id} 的补丁不能应用到基准提交 ${x.base.slice(0, 12)} 上的 ${at.path}`);
      }
      if (!locationChanged(at, before, after)) {
        return false;
      }
    }
    return true;
  }

  /** 登记一个新提出的修改（提议已经创建）：按新算法记下变更哈希与修改定位 */
  async record(x: { proposalId: string; incidentId: string; change: PlannedChange }): Promise<void> {
    const k = changeKeys(x.change);
    await this.pool.query(
      `INSERT INTO server.remediation_changes (proposal_id, repository, change_hash, hash_version, locations, location_hash,
         key, files, incident_id, state)
       VALUES ($1, $2, $3, 2, $4, $5, $6, $7, $8, 'pending') ON CONFLICT (proposal_id) DO NOTHING`,
      [
        x.proposalId,
        x.change.repository,
        k.hash,
        JSON.stringify(x.change.locations),
        k.location,
        k.key,
        k.files,
        x.incidentId,
      ],
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
