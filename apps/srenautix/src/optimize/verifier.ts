import type { Finding, OptimizationRecommendation, RecommendationOutcome, TopologyNode } from '@srenautix/contract';
import type { PackSet } from '@srenautix/packs-sdk';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import { GitHubError, type GitHubApp } from '../github/app.js';
import { logger } from '../log.js';
import type { ProposalService } from '../proposals/service.js';
import { appendAudit } from '../store/audit.js';
import { appendEvents, type NewEvent } from '../store/outbox.js';
import { tx } from '../store/pool.js';
import { managingApplications, type ArgoReader } from './argo.js';
import { GoalDataUnavailable, type GoalEvidence } from './evidence.js';
import { OPTIMIZATION_RULE } from './publisher.js';
import type { Lang } from './render.js';
import type { GoalRunContext } from './runner.js';
import { EVENTS_SCHEMA_VERSION } from './runner.js';
import { durationMs } from './stats.js';
import { OPEN_GOAL_STATES, type OptimizationStore } from './store.js';
import { verifyOutcome, type GuardSeries } from './verify.js';

// 验证循环（ADR 0146 §2.6）：每轮只读取 recommended 与 verifying 的建议。
// - ops PR：gateway 开出的 PR（gitops_pulls）合并之后，等管理被修改文件的 Argo 应用同步到包含合并提交的版本并且 Healthy；
//   GUC 另外核对 pg_settings 中的值等于新值；PR 未合并就关闭为 rejected（unmerged）；
// - 业务 issue：以 not planned 关闭为 rejected；以 completed 关闭时修复视为已部署，开始验证窗口；
// - 窗口结束：与基线按"星期 × 小时"匹配的时段比较（verify.ts），结果写回建议与发现，在 PR 或 issue 上评论；
//   regressed 的 ops PR 由 server 提交 revert 的 gitops_pr 提议（标题前缀 [回退]），按普通 PR 流程由人合并。

/** 等待合并、同步或部署时的检查间隔 */
export const VERIFY_POLL_MS = 10 * 60_000;
/** 出错之后的重试间隔 */
const RETRY_MS = 30 * 60_000;

export interface VerifierDeps {
  pool: pg.Pool;
  store: OptimizationStore;
  evidence: GoalEvidence;
  set: () => PackSet;
  github: GitHubApp | null;
  proposals: ProposalService;
  language: Lang;
  /** Argo CD 应用的读取；没有时 PR 合并即开始验证（日志说明） */
  argo?: ArgoReader | null;
  now?: () => number;
}

interface Row {
  body: OptimizationRecommendation;
  plan: { patch?: string; files?: string[]; base?: string } | null;
}

/**
 * 反转统一 diff（revert 提议的补丁）：+ 与 - 行互换，hunk 头的新旧范围互换；新建文件的补丁反转为删除
 */
export function invertPatch(patch: string): string {
  const lines = patch.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const from = l.slice(4);
      const to = (lines[i + 1] as string).slice(4);
      out.push(`--- ${to.replace(/^b\//, 'a/')}`, `+++ ${from.replace(/^a\//, 'b/')}`);
      i++;
      continue;
    }
    const h = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/.exec(l);
    if (h) {
      out.push(`@@ -${h[2]} +${h[1]} @@${h[3]}`);
    } else if (l.startsWith('+')) {
      out.push(`-${l.slice(1)}`);
    } else if (l.startsWith('-')) {
      out.push(`+${l.slice(1)}`);
    } else {
      out.push(l);
    }
  }
  return out.join('\n');
}

/** PostgreSQL 内存参数的取值换算为 kB（96MB、4096kB、1GB）；不是内存参数时为 null */
function pgKb(v: string, unit: string | null = null): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(kB|MB|GB|TB)?\s*$/.exec(v);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  const u = m[2] ?? unit ?? null;
  const k: Record<string, number> = { kB: 1, '8kB': 8, MB: 1024, GB: 1024 ** 2, TB: 1024 ** 3 };
  return u && k[u] !== undefined ? n * k[u] : u === null ? n : null;
}

/** pg_settings 的取值（带 unit 列）是否等于计划的新值 */
export function settingApplied(expected: string, actual: { setting: string; unit: string | null }): boolean {
  if (expected.trim() === actual.setting.trim()) {
    return true;
  }
  const e = pgKb(expected);
  const a = pgKb(actual.setting, actual.unit);
  return e !== null && a !== null && Math.abs(e - a) < 1e-6;
}

export class GoalVerifier {
  private readonly now: () => number;

  constructor(private readonly d: VerifierDeps) {
    this.now = d.now ?? Date.now;
  }

  /** 一轮：到期的 recommended 与 verifying 建议 */
  async runOnce(signal: AbortSignal, limit = 20): Promise<number> {
    const r = await this.d.pool.query<Row>(
      `SELECT body, plan FROM server.optimization_recommendations
        WHERE state IN ('recommended', 'verifying') AND delivered_at IS NOT NULL AND next_attempt_at <= $1
        ORDER BY next_attempt_at LIMIT $2`,
      [new Date(this.now()), limit],
    );
    let n = 0;
    for (const row of r.rows) {
      if (signal.aborted) {
        break;
      }
      try {
        await this.one(row, signal);
        n++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!(e instanceof GitHubError) && !(e instanceof GoalDataUnavailable)) {
          logger.error('验证建议失败', { recommendation_id: row.body.recommendation_id, error: e });
        }
        await this.later(row.body, RETRY_MS, message);
      }
    }
    return n;
  }

  private async later(rec: OptimizationRecommendation, ms: number, error: string | null = null): Promise<void> {
    await this.d.pool.query(
      `UPDATE server.optimization_recommendations SET next_attempt_at = $2, last_error = $3 WHERE recommendation_id = $1`,
      [rec.recommendation_id, new Date(this.now() + ms), error?.slice(0, 500) ?? null],
    );
  }

  private async one(row: Row, signal: AbortSignal): Promise<void> {
    const rec = row.body;
    if (rec.state === 'verifying') {
      const to = rec.verify.window ? Date.parse(rec.verify.window.to) : this.now();
      if (this.now() < to) {
        await this.later(rec, Math.min(to - this.now(), 3600_000));
        return;
      }
      await this.conclude(rec, row, signal);
      return;
    }
    if (!this.d.github) {
      await this.later(rec, RETRY_MS, '没有 github_app，无法跟踪 PR 与 issue');
      return;
    }
    if (rec.kind === 'ops_pr') {
      await this.opsPending(rec, row, signal);
    } else {
      await this.issuePending(rec, signal);
    }
  }

  private async opsPending(rec: OptimizationRecommendation, row: Row, signal: AbortSignal): Promise<void> {
    const gh = this.d.github as GitHubApp;
    let d = rec.delivery!;
    if (d.number === null) {
      const pull = await this.d.pool.query<{ repo: string; number: number; url: string }>(
        'SELECT repo, number, url FROM server.gitops_pulls WHERE proposal_id = $1',
        [d.proposal_id],
      );
      const p = pull.rows[0];
      if (!p) {
        const prop = await this.d.pool.query<{ state: string }>(
          'SELECT state FROM server.proposals WHERE proposal_id = $1',
          [d.proposal_id],
        );
        const st = prop.rows[0]?.state;
        if (st === 'rejected') {
          await this.reject(rec, { ...d, closed_reason: 'unmerged' }, '提议被拒绝');
        } else if (st === 'expired' || st === 'stale' || st === 'duplicate' || st === 'rejected_by_policy') {
          await this.save({ ...rec, state: 'failed' }, [], `提议 ${st}，没有开出 PR`);
        } else {
          await this.later(rec, VERIFY_POLL_MS);
        }
        return;
      }
      d = { ...d, number: p.number, url: p.url };
    }
    const pr = await gh.api<{ state: string; merged_at: string | null; merge_commit_sha: string | null }>(
      'GET',
      `/repos/${d.repository}/pulls/${d.number}`,
      undefined,
      'optimization_pr',
    );
    if (!pr.merged_at) {
      if (pr.state === 'closed') {
        await this.reject(rec, { ...d, closed_reason: 'unmerged' }, 'PR 未合并即关闭');
        return;
      }
      await this.saveDelivery(rec, d);
      await this.later(rec, VERIFY_POLL_MS);
      return;
    }
    d = { ...d, merged_at: pr.merged_at, merge_commit: pr.merge_commit_sha };
    const synced = await this.synced(d.repository, d.merge_commit, row.plan?.files ?? []);
    if (!synced.ok) {
      await this.saveDelivery(rec, d);
      await this.later(rec, VERIFY_POLL_MS, synced.reason);
      return;
    }
    const settings = Object.entries(rec.verify.settings).filter((x): x is [string, string] => x[1] !== undefined);
    if (settings.length) {
      const f = await this.finding(rec.finding);
      const entity = f ? await this.entityOf(rec, f) : null;
      const actual = entity
        ? await this.d.evidence.settings(
            entity,
            settings.map(([k]) => k),
            this.now(),
            signal,
          )
        : null;
      const pending = actual ? settings.filter(([k, v]) => !actual.get(k) || !settingApplied(v, actual.get(k)!)) : [];
      if (pending.length) {
        await this.saveDelivery(rec, d);
        await this.later(rec, VERIFY_POLL_MS, `参数还没有生效：${pending.map(([k, v]) => `${k}=${v}`).join('、')}`);
        return;
      }
    }
    await this.start(rec, d);
  }

  private async issuePending(rec: OptimizationRecommendation, _signal: AbortSignal): Promise<void> {
    const gh = this.d.github as GitHubApp;
    const d = rec.delivery!;
    if (d.number === null) {
      await this.later(rec, VERIFY_POLL_MS);
      return;
    }
    const issue = await gh.api<{ state: string; state_reason: string | null }>(
      'GET',
      `/repos/${d.repository}/issues/${d.number}`,
      undefined,
      'optimization_issue_state',
    );
    if (issue.state !== 'closed') {
      await this.later(rec, 3600_000);
      return;
    }
    if (issue.state_reason === 'not_planned') {
      await this.reject(rec, { ...d, closed_reason: 'not_planned' }, 'issue 以 not planned 关闭');
      return;
    }
    // 以 completed 关闭：修复视为已部署（发布输入的版本核对需要 release_input 的读取，见 ADR 0146 §2.6 的偏离说明）
    await this.start(rec, { ...d, closed_reason: 'completed' });
  }

  /** 管理被修改文件的 Argo 应用都已同步到包含合并提交的版本并且 Healthy */
  private async synced(
    repo: string,
    merge: string | null,
    files: readonly string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.d.argo || !merge) {
      return { ok: true };
    }
    const apps = managingApplications(await this.d.argo.applications(), repo, files);
    if (!apps.length) {
      logger.info('没有管理这些文件的 Argo 应用，合并即开始验证', { repo, files });
      return { ok: true };
    }
    for (const a of apps) {
      if (!a.synced || !a.healthy) {
        return { ok: false, reason: `Argo 应用 ${a.name} 还没有同步或不健康` };
      }
      let contains = false;
      for (const rev of a.revisions) {
        if (rev === merge || (await this.contains(repo, merge, rev))) {
          contains = true;
          break;
        }
      }
      if (!contains) {
        return { ok: false, reason: `Argo 应用 ${a.name} 同步的版本还不包含合并提交 ${merge.slice(0, 12)}` };
      }
    }
    return { ok: true };
  }

  private async contains(repo: string, base: string, head: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,40}$/.test(head)) {
      return false;
    }
    const c = await (this.d.github as GitHubApp).api<{ status: string }>(
      'GET',
      `/repos/${repo}/compare/${base}...${head}`,
      undefined,
      'optimization_synced',
    );
    return c.status === 'ahead' || c.status === 'identical';
  }

  private async finding(fp: string): Promise<Finding | null> {
    return (await this.d.store.findings([fp])).get(fp)?.body ?? null;
  }

  private async context(runId: string): Promise<GoalRunContext | null> {
    const r = await this.d.pool.query<{ context: GoalRunContext | null }>(
      'SELECT context FROM server.goal_runs WHERE run_id = $1',
      [runId],
    );
    return r.rows[0]?.context ?? null;
  }

  private async entityOf(rec: OptimizationRecommendation, f: Finding) {
    const ctx = await this.context(rec.run_id);
    const n: TopologyNode | undefined = ctx?.topology.nodes.find((x) => x.key === f.component);
    if (!n) {
      return null;
    }
    return {
      cluster_id: f.cluster_id,
      kind: n.kind,
      namespace: n.namespace,
      name: n.name,
      node: n.kind === 'Node' ? n.name : null,
      uid: n.uid,
    };
  }

  private async saveDelivery(rec: OptimizationRecommendation, d: OptimizationRecommendation['delivery']) {
    if (JSON.stringify(d) === JSON.stringify(rec.delivery)) {
      return;
    }
    await this.save({ ...rec, delivery: d }, [], null);
  }

  /** 开始验证窗口 */
  private async start(rec: OptimizationRecommendation, d: NonNullable<OptimizationRecommendation['delivery']>) {
    const from = this.now();
    const to = from + durationMs(rec.verify.within);
    const window = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    const updated: OptimizationRecommendation = {
      ...rec,
      state: 'verifying',
      delivery: d,
      verify: { ...rec.verify, window },
    };
    await this.save(updated, [], null, async (c, events) => {
      const f = (await this.d.store.findings([rec.finding], c)).get(rec.finding)?.body;
      if (f) {
        const nf: Finding = { ...f, status: 'verifying', updated_at: new Date(from).toISOString() };
        await this.d.store.saveFinding(c, nf);
        await c.query('UPDATE server.optimization_findings SET verifying_until = $2 WHERE fingerprint = $1', [
          f.fingerprint,
          new Date(to),
        ]);
        events.push({ type: 'finding.updated', clusterId: nf.cluster_id, payload: nf });
      }
      await this.goalState(c, rec.goal_id, 'verifying');
    });
    await this.d.pool.query(
      'UPDATE server.optimization_recommendations SET next_attempt_at = $2, merged_at = coalesce(merged_at, $3) WHERE recommendation_id = $1',
      [rec.recommendation_id, new Date(to), d.merged_at ? new Date(d.merged_at) : null],
    );
    await this.comment(
      updated,
      this.d.language === 'zh'
        ? `SreNautix 开始验证：窗口 ${window.from} – ${window.to}，与基线中星期与小时相同的时段比较 ${rec.verify.indicator}。`
        : `SreNautix started verification: window ${window.from} – ${window.to}, comparing ${rec.verify.indicator} with matching weekday-hours of the baseline.`,
    );
  }

  /** 建议被拒绝（issue not planned、PR 未合并即关闭）：发现进入冷却期 */
  private async reject(
    rec: OptimizationRecommendation,
    d: NonNullable<OptimizationRecommendation['delivery']>,
    reason: string,
  ): Promise<void> {
    const at = new Date(this.now()).toISOString();
    await this.save({ ...rec, state: 'rejected', delivery: d }, [], reason, async (c, events) => {
      const f = (await this.d.store.findings([rec.finding], c)).get(rec.finding)?.body;
      if (f) {
        const cooldown = this.d.set().domains.get(f.domain)?.gates.cooldown ?? '30d';
        const nf: Finding = {
          ...f,
          status: 'rejected',
          cooldown_until: new Date(this.now() + durationMs(cooldown)).toISOString(),
          updated_at: at,
        };
        await this.d.store.saveFinding(c, nf, { gapAtRejection: f.gap });
        events.push({ type: 'finding.updated', clusterId: nf.cluster_id, payload: nf });
      }
      await this.settleGoal(c, rec.goal_id);
    });
  }

  /** 窗口结束：计算验证结果，写回建议与发现，评论；regressed 的 ops PR 提交 revert */
  private async conclude(rec: OptimizationRecommendation, row: Row, signal: AbortSignal): Promise<void> {
    const f = await this.finding(rec.finding);
    const ctx = await this.context(rec.run_id);
    const entity = f ? await this.entityOf(rec, f) : null;
    const window = rec.verify.window!;
    const set = this.d.set();
    const ind = set.indicators.get(rec.verify.indicator);
    if (!f || !ctx || !entity || !ind) {
      await this.later(rec, RETRY_MS, '发现、运行上下文、实体或指标已不存在，无法验证');
      return;
    }
    const range = { from: Date.parse(window.from), to: Date.parse(window.to) };
    const baseRange = { from: Date.parse(ctx.baseline.window.from), to: Date.parse(ctx.baseline.window.to) };
    const params: Record<string, number | string | boolean> = {};
    for (const [k, v] of Object.entries(rec.verify.params)) {
      if (v !== undefined) {
        params[k] = v;
      }
    }
    const stored = ctx.baseline.indicators.find(
      (i) => i.indicator === rec.verify.indicator && i.entity === f.component,
    );
    const baseline =
      stored?.hourly.map(([t, v]) => [t * 1000, v] as const) ??
      (await this.d.evidence.indicatorHourly(rec.verify.indicator, entity, params, baseRange, signal));
    const observed = await this.d.evidence.indicatorHourly(rec.verify.indicator, entity, params, range, signal);
    const guards: GuardSeries[] = [];
    for (const g of rec.verify.guards) {
      const gi = set.indicators.get(g);
      if (!gi) {
        continue;
      }
      try {
        guards.push({
          indicator: g,
          better: gi.def.better,
          statistic: gi.def.statistic,
          baseline: await this.d.evidence.indicatorHourly(g, entity, {}, baseRange, signal),
          window: await this.d.evidence.indicatorHourly(g, entity, {}, range, signal),
        });
      } catch (e) {
        if (!(e instanceof GoalDataUnavailable)) {
          throw e;
        }
      }
    }
    const cards: RecommendationOutcome['cards'] = [];
    for (const card of rec.verify.cards) {
      try {
        const r = await this.d.evidence.checkCard(card, entity, this.now(), signal);
        cards.push({ card_id: card, verdict: r.verdict });
      } catch (e) {
        if (!(e instanceof GoalDataUnavailable)) {
          throw e;
        }
        cards.push({ card_id: card, verdict: 'undeterminable' });
      }
    }
    const outcome = verifyOutcome({
      better: ind.def.better,
      statistic: ind.def.statistic,
      baseline,
      window: observed,
      windowRange: window,
      estimateLower: rec.estimate.lower,
      guards,
      cards,
      verifiedAt: new Date(this.now()).toISOString(),
    });
    if (outcome.result === 'regressed' && rec.kind === 'ops_pr' && row.plan?.patch && row.plan.base) {
      outcome.revert_proposal_id = await this.revert(rec, f, row.plan.patch, row.plan.base);
    }
    const status: Finding['status'] =
      outcome.result === 'improved' ? 'fixed' : outcome.result === 'regressed' ? 'regressed' : 'no_effect';
    const at = new Date(this.now()).toISOString();
    const updated: OptimizationRecommendation = { ...rec, state: outcome.result, outcome };
    await this.save(updated, [], null, async (c, events) => {
      const nf: Finding = { ...f, status, updated_at: at };
      await this.d.store.saveFinding(c, nf);
      await c.query('UPDATE server.optimization_findings SET verifying_until = NULL WHERE fingerprint = $1', [
        f.fingerprint,
      ]);
      events.push(
        { type: 'finding.updated', clusterId: nf.cluster_id, payload: nf },
        {
          type: 'outcome.verified',
          clusterId: rec.cluster_id,
          payload: { recommendation_id: rec.recommendation_id, finding: rec.finding, goal_id: rec.goal_id, outcome },
        },
      );
      await appendAudit(c, 'optimization.outcome_verified', 'server', {
        recommendation_id: rec.recommendation_id,
        result: outcome.result,
        revert_proposal_id: outcome.revert_proposal_id,
      });
      await this.settleGoal(c, rec.goal_id);
    });
    const fmt = (v: number | null) => (v === null ? '—' : Number(v.toPrecision(4)).toString());
    await this.comment(
      updated,
      this.d.language === 'zh'
        ? `SreNautix 验证结果：**${outcome.result}**。${rec.verify.indicator} 基线 ${fmt(outcome.baseline)}，窗口内 ${fmt(outcome.observed)}，改善 ${fmt(outcome.improvement)}（预期下界 ${fmt(outcome.estimate_lower)}，噪声带 ${fmt(outcome.noise_band)}）。${outcome.revert_proposal_id ? `已提交回退提议 ${outcome.revert_proposal_id}。` : ''}`
        : `SreNautix verification result: **${outcome.result}**. ${rec.verify.indicator} baseline ${fmt(outcome.baseline)}, window ${fmt(outcome.observed)}, improvement ${fmt(outcome.improvement)} (expected lower bound ${fmt(outcome.estimate_lower)}, noise band ${fmt(outcome.noise_band)}).${outcome.revert_proposal_id ? ` Revert proposal ${outcome.revert_proposal_id} submitted.` : ''}`,
    );
  }

  /** regressed 的 ops PR：提交反转补丁的 gitops_pr 提议（标题前缀 [回退]），由人审阅合并 */
  private async revert(
    rec: OptimizationRecommendation,
    f: Finding,
    patch: string,
    base: string,
  ): Promise<string | null> {
    const d = rec.delivery!;
    const goal = await this.d.store.goal(rec.goal_id);
    if (!goal) {
      return null;
    }
    const prefix = this.d.language === 'zh' ? '[回退]' : '[Revert]';
    try {
      const r = await this.d.proposals.create(
        { source: 'rule', callerId: OPTIMIZATION_RULE },
        {
          incident_id: goal.goal_id,
          subject: { type: 'goal', id: goal.goal_id },
          binding: {
            incident_version: goal.revision,
            root_component: f.component,
            evidence_fingerprint: f.evidence_fingerprint ?? '',
          },
          action: 'gitops_pr',
          params: {
            repository: d.repository,
            base,
            title: `${prefix} ${rec.title}`.slice(0, 200),
            body:
              this.d.language === 'zh'
                ? `验证结果为 regressed：守护指标恶化超过 10%。回退 ${d.url ?? `#${d.number}`}。\n\n<!-- srenautix:revert=${rec.recommendation_id} -->`
                : `Verification regressed: a guard indicator worsened by more than 10%. Reverts ${d.url ?? `#${d.number}`}.\n\n<!-- srenautix:revert=${rec.recommendation_id} -->`,
            patch: invertPatch(patch),
            branch: `srenautix/revert-${rec.recommendation_id.slice(0, 8)}`,
          },
          research_run_id: rec.run_id,
          rule_id: OPTIMIZATION_RULE,
          hypothesis_id: null,
          evidence_refs: [],
          expected_effect: (this.d.language === 'zh'
            ? '恢复修改之前的配置'
            : 'Restore the previous configuration'
          ).slice(0, 300),
        },
      );
      return r.proposal.state === 'rejected_by_policy' ? null : r.proposal.proposal_id;
    } catch (e) {
      if (e instanceof HttpError) {
        logger.warn('回退提议被拒绝', { recommendation_id: rec.recommendation_id, error: e.message });
        return null;
      }
      throw e;
    }
  }

  /** 目标的状态：没有建议在等待或验证中时，按结果结束 */
  private async settleGoal(c: pg.PoolClient | pg.Pool, goalId: string): Promise<void> {
    const r = await c.query<{ state: string }>(
      "SELECT state FROM server.optimization_recommendations WHERE goal_id = $1 AND state NOT IN ('blocked', 'superseded', 'failed')",
      [goalId],
    );
    const states = r.rows.map((x) => x.state);
    if (states.some((s) => s === 'open' || s === 'recommended' || s === 'verifying')) {
      return;
    }
    const goal = await this.d.store.goal(goalId, c);
    if (!goal || !OPEN_GOAL_STATES.includes(goal.state)) {
      return;
    }
    const next = states.includes('improved') ? 'achieved' : 'not_achieved';
    await this.d.store.setGoalState(c, goalId, next, null);
  }

  private async goalState(c: pg.PoolClient | pg.Pool, goalId: string, state: 'verifying'): Promise<void> {
    const goal = await this.d.store.goal(goalId, c);
    if (goal && OPEN_GOAL_STATES.includes(goal.state) && goal.state !== state) {
      await this.d.store.setGoalState(c, goalId, state, null);
    }
  }

  private async save(
    rec: OptimizationRecommendation,
    extra: NewEvent[],
    error: string | null,
    more?: (c: pg.PoolClient, events: NewEvent[]) => Promise<void>,
  ): Promise<void> {
    const updated = { ...rec, updated_at: new Date(this.now()).toISOString() };
    await tx(this.d.pool, async (c) => {
      await this.d.store.saveRecommendation(c, updated);
      await c.query('UPDATE server.optimization_recommendations SET last_error = $2 WHERE recommendation_id = $1', [
        rec.recommendation_id,
        error?.slice(0, 500) ?? null,
      ]);
      const events: NewEvent[] = [
        { type: 'recommendation.updated', clusterId: rec.cluster_id, payload: updated },
        ...extra,
      ];
      await more?.(c, events);
      await appendEvents(c, 'server', 'server', EVENTS_SCHEMA_VERSION, events);
    });
  }

  /** 在 PR 或 issue 上评论（失败只记日志，不影响状态） */
  private async comment(rec: OptimizationRecommendation, body: string): Promise<void> {
    const d = rec.delivery;
    if (!this.d.github || !d?.number) {
      return;
    }
    try {
      await this.d.github.api(
        'POST',
        `/repos/${d.repository}/issues/${d.number}/comments`,
        { body: `${body}\n\n<!-- srenautix:recommendation=${rec.recommendation_id} -->` },
        'optimization_comment',
      );
    } catch (e) {
      logger.warn('在 PR 或 issue 上评论失败', { recommendation_id: rec.recommendation_id, error: e });
    }
  }
}
