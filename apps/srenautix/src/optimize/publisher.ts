import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type {
  ConclusionLevel,
  EvidenceResult,
  Finding,
  FindingConclusion,
  Goal,
  LocalizedText,
  OptimizationOutput,
  OptimizationRecommendation,
  RecommendationAttempt,
} from '@srenautix/contract';
import {
  applicableIssues,
  applicableRemediations,
  planIssue,
  planRemediation,
  type EvidenceDataSource,
  type GoalTemplateContext,
  type PackSet,
  type RemediationContext,
} from '@srenautix/packs-sdk';
import type { IndicatorUnit } from '@srenautix/contract';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import { GitHubError, type GitHubApp } from '../github/app.js';
import type { OptimizationIssues } from '../github/optimization-issues.js';
import { logger } from '../log.js';
import type { ProposalService } from '../proposals/service.js';
import { GitHubRepoReader } from '../remediation/github-repo.js';
import { validatePlan } from '../remediation/render.js';
import type { RemediationRepository } from '../remediation/service.js';
import { appendAudit } from '../store/audit.js';
import { appendEvents, type NewEvent } from '../store/outbox.js';
import { tx, type Queryable } from '../store/pool.js';
import { parseStoredKey } from '../topology/keys.js';
import { locateCode, pathLabels, type CodeRepository, type SqlFingerprint } from './code/locate.js';
import type { RepoCodeCache } from './code/tree.js';
import { DEFAULT_GATE_LIMITS, evaluateGates, type GateInput, type GateLimits } from './gates.js';
import { goalBranch, goalPrBody, issueBody, type Lang } from './render.js';
import type { GoalRunContext } from './runner.js';
import { EVENTS_SCHEMA_VERSION } from './runner.js';
import { durationMs } from './stats.js';
import type { OptimizationStore } from './store.js';

// 建议与发布（ADR 0146 §2.5、§4）：worker 交回运行输出之后，server 为每个结论档位达到 likely 的发现选适用的模板，
// 计算预期收益与安全约束，依次经过门槛 G1–G6，通过的建议在下一轮投递：ops PR 只经 gateway 的 gitops_pr，
// 业务 issue 只经业务仓库角色的白名单。门槛不通过的只记录原因码（recommendation_attempts）。

export const OPTIMIZATION_RULE = 'srenautix/optimization-pr';
/** 档位达到这些时才评估模板 */
const RECOMMEND_LEVELS: ReadonlySet<ConclusionLevel> = new Set(['likely', 'evidence_consistent']);
/** 验证窗口的默认值（§2.6）：GUC 与资源 24 小时，延迟类（业务修复）3 个工作日 */
const DEFAULT_WITHIN = { ops_pr: '24h', business_issue: '72h' } as const;

export interface PublisherDeps {
  pool: pg.Pool;
  store: OptimizationStore;
  set: () => PackSet;
  github: GitHubApp | null;
  /** ops 仓库的布局（remediation.repositories，模板按仓库角色引用） */
  repositories: Record<string, RemediationRepository>;
  /** 业务仓库（optimization.repositories.business）；没有配置时不生成业务 issue */
  business: (CodeRepository & { default_branch: string }) | null;
  proposals: ProposalService;
  issues: OptimizationIssues | null;
  /** 模板 inputs 的指标数据源（resource-right-size 的 14 天用量等）；没有时读不到输入的模板按 input_missing 跳过 */
  dataSource?: (at: number) => Promise<EvidenceDataSource>;
  code: { cache: RepoCodeCache; fingerprint: SqlFingerprint } | null;
  language: Lang;
  consoleUrl: string;
  titlePrefix: string;
  limits?: GateLimits;
  timing?: {
    releaseInProgress(clusterId: string): Promise<boolean>;
    gatewayWriteAnomaly(clusterId: string): Promise<boolean>;
  };
  now?: () => number;
}

interface RunRow {
  run_id: string;
  goal_id: string;
  goal_revision: number;
  context: GoalRunContext;
  output: OptimizationOutput;
}

/** 投递所需的内容（optimization_recommendations.plan） */
type DeliveryPlan =
  | {
      kind: 'ops_pr';
      template: string;
      repository: string;
      context: RemediationContext;
      change: LocalizedText;
      rollback: LocalizedText;
      verifySay: LocalizedText;
    }
  | {
      kind: 'business_issue';
      template: string;
      anchors: Array<{ kind: string; value: string }>;
      suggestion: LocalizedText;
      verifySay: LocalizedText;
      labels: string[];
      title: LocalizedText;
    };

interface Attempted {
  attempt: RecommendationAttempt;
  rec: OptimizationRecommendation;
  plan: DeliveryPlan | null;
  targetKey: string | null;
}

const loc = (l: Lang) => (l === 'zh' ? 'zh-CN' : 'en');
const sayOf = (t: LocalizedText | undefined, l: Lang) => (t?.[loc(l)] ?? t?.['zh-CN'] ?? t?.en ?? '').trim();

/** 发现的证据指纹：支持卡与份额卡的判定向量 */
export function evidenceFingerprint(conclusion: FindingConclusion, cards: readonly EvidenceResult[]): string {
  const refs = [...new Set([...conclusion.support_refs, ...conclusion.share_refs])].sort();
  const vec = refs.map((r) => {
    const c = cards.find((x) => x.ref === r);
    return [c?.card_id ?? r, c?.verdict ?? 'missing'];
  });
  return `sha256:${createHash('sha256')
    .update(canonicalize(vec) as string)
    .digest('hex')}`;
}

/**
 * 模板变量里的卡片（finding_cards）：卡片全局 id → 结论（同一张卡取最严重的）。发现自己的诊断卡与份额卡总在其中
 * （收益估算读它们的 observations，例如 pg-guc-tune 读 postgres/checks/statement-temp 的 total_bytes），
 * 再加上结论的支持卡、份额卡与相反卡
 */
export function findingCards(
  conclusion: FindingConclusion,
  cards: readonly EvidenceResult[],
  own: readonly string[] = [],
): RemediationContext['cards'] {
  const out: RemediationContext['cards'] = {};
  const rank: Record<string, number> = { abnormal: 0, undeterminable: 1, normal: 2 };
  for (const ref of [...own, ...conclusion.support_refs, ...conclusion.share_refs, ...conclusion.contrary_refs]) {
    const c = cards.find((x) => x.ref === ref);
    if (!c) {
      continue;
    }
    const cur = out[c.card_id];
    if (!cur || (rank[c.verdict] ?? 3) < (rank[cur.verdict] ?? 3)) {
      out[c.card_id] = {
        verdict: c.verdict,
        display_state: c.display_state,
        value: c.value === null || c.value === undefined ? null : String(c.value),
        ...(c.observations ? { observations: { ...c.observations } } : {}),
      };
    }
  }
  return out;
}

export class GoalPublisher {
  private readonly now: () => number;

  constructor(private readonly d: PublisherDeps) {
    this.now = d.now ?? Date.now;
  }

  private ds(): Promise<EvidenceDataSource | null> {
    return this.d.dataSource ? this.d.dataSource(this.now()) : Promise.resolve(null);
  }

  /** worker 交回运行输出（POST /v1/research/tasks/{run_id}/optimization）：校验后保存，建议在 recommendOnce 中计算 */
  async accept(c: Queryable, runId: string, output: OptimizationOutput): Promise<void> {
    const r = await c.query<{ goal_id: string; state: string; context: GoalRunContext | null }>(
      'SELECT goal_id, state, context FROM server.goal_runs WHERE run_id = $1 FOR UPDATE',
      [runId],
    );
    const row = r.rows[0];
    if (!row || !row.context) {
      throw new HttpError(404, 'not_found', '没有这次目标运行');
    }
    if (row.state !== 'running') {
      throw new HttpError(409, 'run_finished', `目标运行已经是 ${row.state}`);
    }
    if (output.run_id !== runId || output.goal_id !== row.goal_id) {
      throw new HttpError(400, 'bad_request', '运行输出的 goal_id 或 run_id 与任务不一致');
    }
    const selected = new Set(row.context.candidates.filter((x) => x.selected).map((x) => x.finding));
    const unknown = output.conclusions.filter((x) => !selected.has(x.finding));
    if (unknown.length) {
      const list = unknown.map((x) => x.finding).join('、');
      throw new HttpError(400, 'bad_request', `结论引用了没有进入分析的发现：${list}`);
    }
    await c.query('UPDATE server.goal_runs SET output = $2 WHERE run_id = $1', [runId, JSON.stringify(output)]);
  }

  /**
   * worker 没有交回输出就结束了目标运行（POST /v1/research/tasks/{run_id}/optimization-failed）：运行与目标记为 failed，
   * 原因按契约的取值归类（模型不可用、预算、期限、数据源，其余为 internal）
   */
  async failRun(runId: string, kind: string, message: string): Promise<void> {
    const reason =
      kind === 'breaker_open' || kind === 'invalid_output'
        ? 'model_unavailable'
        : ['model_unavailable', 'budget_exhausted', 'deadline', 'datasource'].includes(kind)
          ? kind
          : 'internal';
    await tx(this.d.pool, async (c) => {
      const r = await c.query<{ goal_id: string }>(
        `UPDATE server.goal_runs SET state = 'failed', reason = $2, finished_at = $3
          WHERE run_id = $1 AND state = 'running' AND output IS NULL RETURNING goal_id`,
        [runId, reason, new Date(this.now())],
      );
      const row = r.rows[0];
      if (!row) {
        return;
      }
      await this.d.store.setGoalState(c, row.goal_id, 'failed', reason);
    });
    logger.warn('目标运行失败（worker 没有交回输出）', { run_id: runId, kind, message: message.slice(0, 500) });
  }

  /** 一轮：处理交回了输出、还没有计算建议的运行 */
  async recommendOnce(limit = 3): Promise<number> {
    const r = await this.d.pool.query<RunRow>(
      `SELECT run_id, goal_id, goal_revision, context, output FROM server.goal_runs
        WHERE state = 'running' AND output IS NOT NULL AND result IS NULL ORDER BY started_at LIMIT $1`,
      [limit],
    );
    for (const run of r.rows) {
      try {
        await this.recommend(run);
      } catch (e) {
        logger.error('计算建议失败', { run_id: run.run_id, error: e });
        await this.d.pool.query(
          `UPDATE server.goal_runs SET state = 'failed', reason = 'internal', finished_at = now() WHERE run_id = $1`,
          [run.run_id],
        );
        await this.d.pool.query(
          `UPDATE server.goals SET state = 'failed', state_reason = 'internal', updated_at = now() WHERE goal_id = $1`,
          [run.goal_id],
        );
      }
    }
    return r.rowCount ?? 0;
  }

  private async recommend(run: RunRow): Promise<void> {
    const goal = (await this.d.store.goal(run.goal_id)) as Goal;
    const ctx = run.context;
    const out = run.output;
    const set = this.d.set();
    const domain = set.domains.get(ctx.domain);
    const cards = [...out.check_cards, ...ctx.cards.filter((x) => !out.check_cards.some((y) => y.ref === x.ref))];
    const attempts: RecommendationAttempt[] = [];
    const recs: Array<{ rec: OptimizationRecommendation; plan: DeliveryPlan | null; targetKey: string | null }> = [];
    const findings: Finding[] = [];
    let passed = 0;
    const at = new Date(this.now()).toISOString();
    for (const conclusion of out.conclusions) {
      const cand = ctx.candidates.find((x) => x.finding === conclusion.finding);
      const stored = (await this.d.store.findings([conclusion.finding])).get(conclusion.finding);
      if (!cand || !stored) {
        continue;
      }
      const finding: Finding = {
        ...stored.body,
        level: conclusion.level,
        evidence_fingerprint: evidenceFingerprint(conclusion, cards),
        last_run_id: run.run_id,
        updated_at: at,
      };
      findings.push(finding);
      if (!RECOMMEND_LEVELS.has(conclusion.level)) {
        continue;
      }
      const goalCtx: GoalTemplateContext = {
        goal: { ...goal.spec, goal_id: goal.goal_id, revision: goal.revision },
        finding: finding as unknown as Record<string, unknown>,
        finding_cards: findingCards(conclusion, cards, [cand.card_ref, ...(cand.share_ref ? [cand.share_ref] : [])]),
        gates: (domain?.gates ?? {}) as Record<string, unknown>,
      };
      const indicatorRow = out.baseline.indicators.find((b) => b.indicator === finding.indicator);
      const current = indicatorRow?.value ?? null;
      const base = { goal, run, finding, conclusion, cards, current };
      // ops PR：领域的 ops 修复模板中适用的（applies: goal）
      if (goal.spec.outputs.includes('ops_pr') && domain) {
        const p = parseStoredKey(finding.component);
        const remCtx: RemediationContext = {
          incident: {},
          root: { cluster_id: goal.cluster_id, kind: p.kind, namespace: p.namespace, name: p.name, node: null },
          research: { disposition: 'act', level: conclusion.level },
          cards: goalCtx.finding_cards as RemediationContext['cards'],
          root_cards: goalCtx.finding_cards as RemediationContext['cards'],
          alerts: [],
          goal: goalCtx,
        };
        const { applicable } = applicableRemediations(set, remCtx);
        for (const a of applicable.filter((x) => domain.optimizations.includes(x.key))) {
          const one = await this.opsAttempt(base, a, remCtx, passed);
          attempts.push(one.attempt);
          recs.push(one);
          if (one.attempt.passed) {
            passed++;
          }
        }
      }
      // 业务 issue：领域的业务 issue 模板中适用的
      if (goal.spec.outputs.includes('business_issue') && domain && this.d.business) {
        const { applicable } = applicableIssues(set.issues, goalCtx, ctx.domain);
        for (const key of applicable.filter((k) => domain.issues.includes(k))) {
          const one = await this.issueAttempt(base, key, goalCtx, passed);
          attempts.push(one.attempt);
          recs.push(one);
          if (one.attempt.passed) {
            passed++;
          }
        }
      }
    }
    const result = passed > 0 ? 'recommended' : 'report_only';
    const output: OptimizationOutput = { ...out, recommendations: attempts.slice(0, 12) };
    await tx(this.d.pool, async (c) => {
      const events: NewEvent[] = [];
      for (const f of findings) {
        await this.d.store.saveFinding(c, f);
        events.push({ type: 'finding.updated', clusterId: f.cluster_id, payload: f });
      }
      for (const { rec, plan, targetKey } of recs) {
        await this.d.store.saveRecommendation(c, rec, {
          targetKey,
          repository: rec.kind === 'business_issue' ? (this.d.business?.repo ?? null) : null,
        });
        if (plan) {
          await c.query('UPDATE server.optimization_recommendations SET plan = $2 WHERE recommendation_id = $1', [
            rec.recommendation_id,
            JSON.stringify(plan),
          ]);
        }
        events.push({ type: 'recommendation.updated', clusterId: rec.cluster_id, payload: rec });
      }
      for (const a of attempts) {
        await c.query(
          `INSERT INTO server.recommendation_attempts (run_id, finding, template, kind, passed, gate, code, gates, recommendation_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (run_id, finding, template) DO NOTHING`,
          [
            run.run_id,
            a.finding,
            a.template,
            a.kind,
            a.passed,
            a.gates.find((g) => !g.passed)?.gate ?? null,
            a.gates.find((g) => !g.passed)?.code ?? null,
            JSON.stringify(a.gates),
            a.recommendation_id,
          ],
        );
      }
      await c.query(
        `UPDATE server.goal_runs SET state = 'concluded', result = $2, gap = true, recommendations = $3, output = $4,
           finished_at = $5 WHERE run_id = $1`,
        [run.run_id, result, passed, JSON.stringify(output), new Date(this.now())],
      );
      await this.d.store.setGoalState(c, goal.goal_id, passed > 0 ? 'recommended' : 'no_action', null);
      await appendEvents(c, 'server', 'server', EVENTS_SCHEMA_VERSION, events);
      const summary = (await this.d.store.runs(goal.goal_id)).find((x) => x.run_id === run.run_id);
      if (summary) {
        await appendEvents(c, 'server', 'server', EVENTS_SCHEMA_VERSION, [
          {
            type: 'goal.run.concluded',
            clusterId: goal.cluster_id,
            payload: { goal_id: goal.goal_id, goal_revision: run.goal_revision, run_id: run.run_id, summary, output },
          },
        ]);
      }
      await appendAudit(c, 'optimization.run_concluded', 'server', {
        goal_id: goal.goal_id,
        run_id: run.run_id,
        result,
        recommendations: attempts.map((a) => ({
          finding: a.finding,
          template: a.template,
          passed: a.passed,
          code: a.gates.find((g) => !g.passed)?.code ?? null,
        })),
      });
    });
    logger.info('目标运行的建议', {
      run_id: run.run_id,
      goal_id: goal.goal_id,
      result,
      passed,
      attempts: attempts.length,
    });
  }

  /** 门槛的计数与新颖性（G4、G5、G6）从存储读取 */
  private async gateState(
    kind: 'ops_pr' | 'business_issue',
    finding: Finding,
    targetKey: string | null,
    clusterId: string,
    thisRun: number,
  ): Promise<Pick<GateInput, 'novelty' | 'counts' | 'timing'>> {
    const q = async (sql: string, args: unknown[]) =>
      ((await this.d.pool.query<{ n: number }>(sql, args)).rows[0]?.n ?? 0) > 0;
    const n = async (sql: string, args: unknown[]) =>
      (await this.d.pool.query<{ n: number }>(sql, args)).rows[0]?.n ?? 0;
    const active = await q(
      `SELECT count(*)::int AS n FROM server.optimization_recommendations
        WHERE finding = $1 AND state IN ('open', 'recommended', 'verifying')`,
      [finding.fingerprint],
    );
    const stored = (await this.d.store.findings([finding.fingerprint])).get(finding.fingerprint);
    const cooling =
      finding.status === 'rejected' &&
      finding.cooldown_until !== null &&
      Date.parse(finding.cooldown_until) > this.now() &&
      !(stored?.gap_at_rejection != null && finding.gap !== null && finding.gap >= stored.gap_at_rejection * 1.5);
    const recentlyMerged =
      targetKey !== null &&
      (await q(
        `SELECT count(*)::int AS n FROM server.optimization_recommendations
          WHERE target_key = $1 AND merged_at > now() - interval '7 days' AND state IN ('recommended', 'verifying')`,
        [targetKey],
      ));
    const counted = `(delivered_at IS NOT NULL OR state = 'open')`;
    const issuesToday = await n(
      `SELECT count(*)::int AS n FROM server.optimization_recommendations WHERE kind = 'business_issue' AND repository = $1
         AND ${counted} AND coalesce(delivered_at, created_at) >= date_trunc('day', now())`,
      [this.d.business?.repo ?? ''],
    );
    const prs = async (interval: string) =>
      n(
        `SELECT count(*)::int AS n FROM server.optimization_recommendations WHERE kind = 'ops_pr' AND ${counted}
           AND coalesce(delivered_at, created_at) > now() - interval '${interval}'`,
        [],
      );
    const activeIncidentInScope = await q(
      `SELECT count(*)::int AS n FROM server.incidents WHERE cluster_id = $1 AND state = 'firing' AND NOT suppressed
         AND body->'components' ? $2`,
      [clusterId, finding.component],
    );
    return {
      novelty: { active, coolingDown: cooling, recentlyMerged },
      counts: { thisRun, issuesToday, prsThisHour: await prs('1 hour'), prsThisWeek: await prs('7 days') },
      timing: {
        activeIncidentInScope,
        releaseInProgress: (await this.d.timing?.releaseInProgress(clusterId)) ?? false,
        gatewayWriteAnomaly: (await this.d.timing?.gatewayWriteAnomaly(clusterId)) ?? false,
      },
    };
  }

  private newRec(
    base: { goal: Goal; run: RunRow; finding: Finding; conclusion: FindingConclusion },
    kind: 'ops_pr' | 'business_issue',
    template: string,
    title: string,
    estimate: OptimizationRecommendation['estimate'],
    verify: { cards: string[]; within: string | null; guards: string[] },
  ): OptimizationRecommendation {
    const at = new Date(this.now()).toISOString();
    const params = base.goal.spec.subject.type === 'indicator' ? base.goal.spec.subject.params : {};
    return {
      recommendation_id: randomUUID(),
      cluster_id: base.goal.cluster_id,
      finding: base.finding.fingerprint,
      goal_id: base.goal.goal_id,
      run_id: base.run.run_id,
      kind,
      template,
      title: title.slice(0, 200),
      level: base.conclusion.level,
      state: 'blocked',
      estimate,
      verify: {
        start: kind === 'ops_pr' ? 'merged_synced' : 'deployed',
        indicator: estimate.indicator,
        params: params as Record<string, string | number | boolean>,
        within: verify.within ?? DEFAULT_WITHIN[kind],
        cards: verify.cards,
        guards: verify.guards,
        settings: {},
        window: null,
      },
      gates: [],
      delivery: null,
      outcome: null,
      model_note: base.conclusion.note,
      created_at: at,
      updated_at: at,
    };
  }

  private async opsAttempt(
    base: {
      goal: Goal;
      run: RunRow;
      finding: Finding;
      conclusion: FindingConclusion;
      current: number | null;
    },
    a: { key: string; repository: string },
    remCtx: RemediationContext,
    thisRun: number,
  ): Promise<Attempted> {
    const repo = this.d.repositories[a.repository];
    const set = this.d.set();
    const domain = set.domains.get(base.run.context.domain);
    const titleOf = (t: LocalizedText) =>
      `${this.d.titlePrefix ? `${this.d.titlePrefix} ` : ''}${sayOf(t, this.d.language)}：${base.finding.entity.display}`;
    let estimate: GateInput['estimate'] = null;
    let guards: GateInput['guards'] = [];
    let plan: DeliveryPlan | null = null;
    let targetKey: string | null = null;
    let estimateValue: OptimizationRecommendation['estimate'] = {
      indicator: base.finding.indicator ?? '',
      unit: 'none',
      lower: 0,
      expected: null,
      basis: '没有求出预期收益',
    };
    let verify = { cards: [] as string[], within: null as string | null, guards: [] as string[] };
    let title = `${this.d.titlePrefix ? `${this.d.titlePrefix} ` : ''}${a.key}：${base.finding.entity.display}`;
    let failure: { code: string; detail: string } | null = null;
    if (!repo || !this.d.github) {
      const detail = `remediation.repositories 没有仓库角色 ${a.repository}，或没有 github_app`;
      failure = { code: 'repository_missing', detail };
    } else {
      try {
        const reader = new GitHubRepoReader(this.d.github, repo.repo, repo.base_branch);
        const p = await planRemediation(
          set,
          a.key,
          remCtx,
          { repo: reader, layout: repo.files },
          await this.ds(),
          this.now(),
        );
        if (p.kind === 'skipped') {
          if (p.code === 'guard') {
            guards = [{ id: p.guard ?? 'guard', ok: false, say: sayOf(p.reason, this.d.language) }];
          } else {
            failure = { code: p.code, detail: sayOf(p.reason, this.d.language) };
          }
        } else {
          title = titleOf(p.title);
          verify = { cards: p.verify.cards, within: p.verify.within, guards: p.verify.guards ?? [] };
          if (p.estimate) {
            estimate = { lower: p.estimate.lower, unit: p.estimate.unit as IndicatorUnit };
            estimateValue = {
              indicator: p.estimate.indicator,
              unit: p.estimate.unit as OptimizationRecommendation['estimate']['unit'],
              lower: p.estimate.lower,
              expected: p.estimate.expected,
              basis: sayOf(p.estimate.basis, this.d.language).slice(0, 600),
            };
          }
          targetKey = createHash('sha256')
            .update(canonicalize([a.key, repo.repo, p.files.map((f) => f.path).sort()]) as string)
            .digest('hex');
          plan = {
            kind: 'ops_pr',
            template: a.key,
            repository: a.repository,
            context: remCtx,
            change: p.change,
            rollback: p.rollback.say,
            verifySay: p.verify.say,
          };
        }
      } catch (e) {
        if (!(e instanceof GitHubError)) {
          throw e;
        }
        failure = { code: 'repository_unreadable', detail: e.message.slice(0, 400) };
      }
    }
    const rec = this.newRec(base, 'ops_pr', a.key, title, estimateValue, verify);
    let gates: OptimizationRecommendation['gates'];
    if (failure) {
      const code = failure.code.replace(/[^a-z0-9_-]/g, '_');
      gates = [{ gate: 'G3', passed: false, code, detail: failure.detail.slice(0, 500) }];
    } else {
      const state = await this.gateState('ops_pr', base.finding, targetKey, base.goal.cluster_id, thisRun);
      const g = evaluateGates({
        kind: 'ops_pr',
        domain: base.run.context.domain,
        level: base.conclusion.level,
        share: base.finding.share,
        gates: domain?.gates ?? {},
        // 安全约束不成立时模板没有求预期收益：G2 按约束的结果记录，G3 给出约束的原因码
        estimate: estimate ?? (guards.length ? { lower: Number.POSITIVE_INFINITY, unit: 'none' } : null),
        current: base.current,
        gap: base.finding.gap,
        guards,
        ...state,
        limits: this.d.limits ?? DEFAULT_GATE_LIMITS,
      });
      gates = g.records;
      if (!estimate && guards.length) {
        // 求不出预期收益：G2 记为没有求值
        gates = gates.map((x) => (x.gate === 'G2' ? { ...x, detail: '模板的安全约束不成立，没有求预期收益' } : x));
      }
    }
    const ok = gates.length === 6 && gates.every((x) => x.passed);
    rec.gates = gates;
    rec.state = ok ? 'open' : 'blocked';
    return {
      attempt: {
        finding: base.finding.fingerprint,
        kind: 'ops_pr',
        template: a.key,
        gates,
        passed: ok,
        recommendation_id: rec.recommendation_id,
      },
      rec,
      plan: ok ? plan : null,
      targetKey,
    };
  }

  private async issueAttempt(
    base: {
      goal: Goal;
      run: RunRow;
      finding: Finding;
      conclusion: FindingConclusion;
      current: number | null;
    },
    key: string,
    goalCtx: GoalTemplateContext,
    thisRun: number,
  ): Promise<Attempted> {
    const set = this.d.set();
    const domain = set.domains.get(base.run.context.domain);
    const p = planIssue(set.issues, key, goalCtx);
    let rec: OptimizationRecommendation;
    let plan: DeliveryPlan | null = null;
    let gates: OptimizationRecommendation['gates'];
    if (p.kind === 'skipped') {
      rec = this.newRec(
        base,
        'business_issue',
        key,
        `${this.d.titlePrefix} ${key}：${base.finding.entity.display}`,
        { indicator: base.finding.indicator ?? '', unit: 'none', lower: 0, expected: null, basis: '没有求出预期收益' },
        { cards: [], within: null, guards: [] },
      );
      gates = [{ gate: 'G2', passed: false, code: p.code, detail: sayOf(p.reason, this.d.language).slice(0, 500) }];
    } else {
      const title = `${this.d.titlePrefix ? `${this.d.titlePrefix} ` : ''}${sayOf(p.title, this.d.language)}：${base.finding.entity.display}`;
      rec = this.newRec(
        base,
        'business_issue',
        key,
        title,
        {
          indicator: p.estimate.indicator,
          unit: p.estimate.unit as OptimizationRecommendation['estimate']['unit'],
          lower: p.estimate.lower,
          expected: p.estimate.expected,
          basis: sayOf(p.estimate.basis, this.d.language).slice(0, 600),
        },
        p.verify,
      );
      const state = await this.gateState('business_issue', base.finding, null, base.goal.cluster_id, thisRun);
      gates = evaluateGates({
        kind: 'business_issue',
        domain: base.run.context.domain,
        level: base.conclusion.level,
        share: base.finding.share,
        gates: domain?.gates ?? {},
        estimate: { lower: p.estimate.lower, unit: p.estimate.unit as never },
        current: base.current,
        gap: base.finding.gap,
        guards: [],
        ...state,
        limits: this.d.limits ?? DEFAULT_GATE_LIMITS,
      }).records;
      plan = {
        kind: 'business_issue',
        template: key,
        anchors: p.anchors,
        suggestion: p.suggestion,
        verifySay: p.verify.say,
        labels: p.labels,
        title: p.title,
      };
    }
    const ok = gates.length === 6 && gates.every((x) => x.passed);
    rec.gates = gates;
    rec.state = ok ? 'open' : 'blocked';
    return {
      attempt: {
        finding: base.finding.fingerprint,
        kind: 'business_issue',
        template: key,
        gates,
        passed: ok,
        recommendation_id: rec.recommendation_id,
      },
      rec,
      plan: ok ? plan : null,
      targetKey: null,
    };
  }

  /** 一轮：投递通过门槛的建议（open） */
  async deliverOnce(limit = 5): Promise<number> {
    const r = await this.d.pool.query<{ recommendation_id: string }>(
      `SELECT recommendation_id FROM server.optimization_recommendations
        WHERE state = 'open' AND next_attempt_at <= now() ORDER BY created_at LIMIT $1`,
      [limit],
    );
    let n = 0;
    for (const { recommendation_id } of r.rows) {
      try {
        if (await this.deliver(recommendation_id)) {
          n++;
        }
      } catch (e) {
        logger.error('投递建议失败', { recommendation_id, error: e });
        await this.d.pool.query(
          `UPDATE server.optimization_recommendations SET attempts = attempts + 1, last_error = $2,
             next_attempt_at = now() + interval '10 minutes' WHERE recommendation_id = $1`,
          [recommendation_id, String((e as Error).message ?? e).slice(0, 500)],
        );
      }
    }
    return n;
  }

  private async deliver(id: string): Promise<boolean> {
    const row = (
      await this.d.pool.query<{ body: OptimizationRecommendation; plan: DeliveryPlan | null }>(
        'SELECT body, plan FROM server.optimization_recommendations WHERE recommendation_id = $1',
        [id],
      )
    ).rows[0];
    if (!row || !row.plan) {
      return false;
    }
    const rec = row.body;
    const goal = await this.d.store.goal(rec.goal_id);
    const finding = (await this.d.store.findings([rec.finding])).get(rec.finding)?.body;
    const run = await this.d.store.run(rec.goal_id, rec.run_id);
    const ctx = (
      await this.d.pool.query<{ context: GoalRunContext }>('SELECT context FROM server.goal_runs WHERE run_id = $1', [
        rec.run_id,
      ])
    ).rows[0]?.context;
    if (!goal || !finding || !run?.output || !ctx) {
      await this.setState(rec, 'failed', null, '目标、发现或运行不存在');
      return false;
    }
    const conclusion = run.output.conclusions.find((x) => x.finding === rec.finding) as FindingConclusion;
    const cards = run.output.check_cards;
    return row.plan.kind === 'ops_pr'
      ? this.deliverPr(rec, row.plan, goal, finding, conclusion, cards)
      : this.deliverIssue(rec, row.plan, goal, finding, conclusion, cards, run.output);
  }

  private async deliverPr(
    rec: OptimizationRecommendation,
    plan: Extract<DeliveryPlan, { kind: 'ops_pr' }>,
    goal: Goal,
    finding: Finding,
    conclusion: FindingConclusion,
    cards: EvidenceResult[],
  ): Promise<boolean> {
    const repo = this.d.repositories[plan.repository];
    if (!repo || !this.d.github || !finding.evidence_fingerprint) {
      await this.setState(rec, 'failed', null, `仓库角色 ${plan.repository} 不可用，或发现没有证据指纹`);
      return false;
    }
    const reader = new GitHubRepoReader(this.d.github, repo.repo, repo.base_branch);
    const input = { repo: reader, layout: repo.files };
    const p = await planRemediation(this.d.set(), plan.template, plan.context, input, await this.ds(), this.now());
    if (p.kind === 'skipped') {
      await this.setState(rec, 'failed', null, `重新计划时模板不再适用：${sayOf(p.reason, this.d.language)}`);
      return false;
    }
    const problems = await validatePlan(p, repo.files, (path) => reader.read(path));
    if (problems.length) {
      await this.setState(rec, 'failed', null, problems.map((x) => `${x.path ?? '补丁'}：${x.message}`).join('；'));
      return false;
    }
    const digest = createHash('sha256').update(p.patch).digest('hex');
    const branch = goalBranch(goal.goal_id, plan.template, digest);
    const issue = await this.d.pool.query<{ repository: string; number: string | null }>(
      `SELECT repository, body->'delivery'->>'number' AS number FROM server.optimization_recommendations
        WHERE finding = $1 AND kind = 'business_issue' AND state IN ('recommended', 'verifying') LIMIT 1`,
      [finding.fingerprint],
    );
    const ir = issue.rows[0];
    const body = goalPrBody({
      lang: this.d.language,
      goal,
      runId: rec.run_id,
      finding,
      conclusion,
      cards,
      rec,
      change: sayOf(p.change, this.d.language),
      files: p.files.map((f) => f.path),
      verifySay: sayOf(p.verify.say, this.d.language),
      rollback: sayOf(p.rollback.say, this.d.language),
      consoleUrl: this.d.consoleUrl,
      issueRef: ir?.number ? `${ir.repository}#${ir.number}` : null,
    });
    try {
      const r = await this.d.proposals.create(
        { source: 'rule', callerId: OPTIMIZATION_RULE },
        {
          incident_id: goal.goal_id,
          subject: { type: 'goal', id: goal.goal_id },
          binding: {
            incident_version: goal.revision,
            root_component: finding.component,
            evidence_fingerprint: finding.evidence_fingerprint,
          },
          action: 'gitops_pr',
          params: { repository: repo.repo, base: repo.base_branch, title: rec.title, body, patch: p.patch, branch },
          research_run_id: rec.run_id,
          rule_id: OPTIMIZATION_RULE,
          hypothesis_id: conclusion.hypothesis_id,
          evidence_refs: conclusion.support_refs.slice(0, 12),
          expected_effect: sayOf(p.verify.say, this.d.language).slice(0, 300),
        },
      );
      const prop = r.proposal;
      if (prop.state === 'rejected_by_policy') {
        await this.setState(
          rec,
          'failed',
          null,
          prop.policy_checks
            .filter((x) => !x.passed)
            .map((x) => `${x.name}：${x.detail}`)
            .join('；'),
        );
        return false;
      }
      // 投递的补丁与文件：验证循环按文件找管理它们的 Argo 应用，regressed 时按补丁提交 revert（§2.6）
      await this.d.pool.query(
        `UPDATE server.optimization_recommendations
            SET plan = plan || jsonb_build_object('patch', $2::text, 'files', $3::jsonb, 'base', $4::text)
          WHERE recommendation_id = $1`,
        [rec.recommendation_id, p.patch, JSON.stringify(p.files.map((f) => f.path)), repo.base_branch],
      );
      await this.setState(rec, 'recommended', {
        repository_role: 'ops',
        repository: repo.repo,
        proposal_id: prop.proposal_id,
        number: null,
        url: null,
        branch,
        merged_at: null,
        merge_commit: null,
        closed_reason: null,
      });
      return true;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        await this.setState(rec, 'failed', null, `提议被拒绝：${e.code} ${e.message}`);
        return false;
      }
      throw e;
    }
  }

  private async deliverIssue(
    rec: OptimizationRecommendation,
    plan: Extract<DeliveryPlan, { kind: 'business_issue' }>,
    goal: Goal,
    finding: Finding,
    conclusion: FindingConclusion,
    cards: EvidenceResult[],
    output: OptimizationOutput,
  ): Promise<boolean> {
    const business = this.d.business;
    if (!business || !this.d.issues) {
      await this.setState(rec, 'failed', null, '没有配置业务仓库或 github_app');
      return false;
    }
    const issues = this.d.issues;
    const res = await issues.deliver(rec.recommendation_id, async () => {
      // 代码定位按运行中的提交（版本规则 default_branch 时为默认分支的头）
      let locations: Awaited<ReturnType<typeof locateCode>>['locations'] = [];
      if (this.d.code && plan.anchors.length) {
        const commit = await this.commitOf(business);
        const budget = goal.spec.budget;
        const r = await locateCode(business, commit, plan.anchors as Parameters<typeof locateCode>[2], this.d.code, {
          maxFiles: budget.code_files,
          maxBytes: budget.code_bytes,
        });
        locations = r.locations;
      }
      const labels = [
        'srenautix',
        `srenautix:${finding.domain}`,
        ...plan.labels,
        ...pathLabels(
          business.code,
          locations.map((l) => l.path),
        ),
      ];
      return {
        title: rec.title,
        body: issueBody({
          lang: this.d.language,
          goal,
          runId: rec.run_id,
          finding,
          conclusion,
          baseline: output.baseline,
          cards,
          locations,
          rec,
          suggestion: sayOf(plan.suggestion, this.d.language),
          verifySay: sayOf(plan.verifySay, this.d.language),
          consoleUrl: this.d.consoleUrl,
        }),
        labels: [...new Set(labels)],
      };
    });
    if (res.kind === 'retry') {
      return false;
    }
    if (res.kind === 'failed') {
      await this.setState(rec, 'failed', null, res.error);
      return false;
    }
    await this.setState(rec, 'recommended', {
      repository_role: 'business',
      repository: business.repo,
      proposal_id: null,
      number: res.number,
      url: res.url,
      branch: null,
      merged_at: null,
      merge_commit: null,
      closed_reason: null,
    });
    return true;
  }

  /** 业务仓库默认分支的头（compare 的 base 即为它；业务仓库角色不能读引用） */
  private async commitOf(b: CodeRepository & { default_branch: string }): Promise<string> {
    const gh = this.d.github as GitHubApp;
    const branch = encodeURIComponent(b.default_branch);
    const r = await gh.api<{ base_commit: { sha: string } }>(
      'GET',
      `/repos/${b.repo}/compare/${branch}...${branch}`,
      undefined,
      'business_head',
    );
    return r.base_commit.sha;
  }

  private async setState(
    rec: OptimizationRecommendation,
    state: OptimizationRecommendation['state'],
    delivery: OptimizationRecommendation['delivery'],
    error: string | null = null,
  ): Promise<void> {
    const updated: OptimizationRecommendation = {
      ...rec,
      state,
      delivery: delivery ?? rec.delivery,
      updated_at: new Date(this.now()).toISOString(),
    };
    await tx(this.d.pool, async (c) => {
      await this.d.store.saveRecommendation(c, updated);
      await c.query('UPDATE server.optimization_recommendations SET last_error = $2 WHERE recommendation_id = $1', [
        rec.recommendation_id,
        error?.slice(0, 500) ?? null,
      ]);
      const events: NewEvent[] = [{ type: 'recommendation.updated', clusterId: rec.cluster_id, payload: updated }];
      if (state === 'recommended') {
        const f = (await this.d.store.findings([rec.finding], c)).get(rec.finding)?.body;
        if (f && f.status === 'open') {
          const nf = { ...f, status: 'recommended' as const, updated_at: updated.updated_at };
          await this.d.store.saveFinding(c, nf);
          events.push({ type: 'finding.updated', clusterId: nf.cluster_id, payload: nf });
        }
      }
      await appendEvents(c, 'server', 'server', EVENTS_SCHEMA_VERSION, events);
      await appendAudit(c, 'optimization.recommendation_delivered', 'server', {
        recommendation_id: rec.recommendation_id,
        kind: rec.kind,
        state,
        delivery,
        error,
      });
    });
  }
}

export { durationMs };
