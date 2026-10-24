import type {
  DomainGates,
  EvidenceResult,
  Finding,
  Goal,
  OptimizationCandidate,
  OptimizationOutput,
  TopologyNode,
} from '@srenautix/contract';
import type { PackSet } from '@srenautix/packs-sdk';
import type pg from 'pg';
import { logger } from '../log.js';
import { appendEvents } from '../store/outbox.js';
import { tx, type Queryable } from '../store/pool.js';
import type { TopologySnapshot } from '../topology/store.js';
import { baselineAndGap, seriesKey, type BaselineResult, type IndicatorSeries } from './baseline.js';
import { rankCandidates, type DiagnosedEntity, type KnownFinding } from './candidates.js';
import { GoalDataUnavailable, type GoalEvidence } from './evidence.js';
import { baselineWindowMs } from './goals.js';
import type { BackendLimiter } from './limits.js';
import { findingFingerprint, HOUR_MS } from './stats.js';
import { OPEN_GOAL_STATES, type OptimizationStore } from './store.js';

// 目标运行的 server 部分（ADR 0146 §2.1、§2.2、§5.5）：准入 → 基线与差距 → 候选发现 → 为 worker 准备输入并入队。
// 这些步骤全部由代码执行；没有差距时整次运行不调用模型。hypothesize 与 conclude 在 worker（optimize/controller.ts），
// 结果交回 server 之后由 publisher.ts 计算门槛并发布。

export const EVENTS_SCHEMA_VERSION = '2.28.0';
/** 推迟之后重新准入的间隔 */
export const DEFER_MS = 10 * 60_000;
/** 每个目标每 6 小时最多 1 次运行（§5.5） */
export const RUN_INTERVAL_MS = 6 * HOUR_MS;
/** 每次运行最多计算基线的实体数 */
export const MAX_ENTITIES = 10;

export interface RunnerDeps {
  pool: pg.Pool;
  store: OptimizationStore;
  evidence: GoalEvidence;
  set: () => PackSet;
  /** 当前拓扑（一次运行只读一次，§6.3） */
  topology: (clusterId: string, at: Date) => Promise<TopologySnapshot>;
  limiter: BackendLimiter;
  /** 风暴模式（Scheduler.stormMode） */
  storm: () => boolean;
  /** 优化用途的当日预算是否用尽（worker 按用途上报） */
  budgetExhausted: () => boolean;
  /** dbstats 的两次采样（optimize/datasource.ts 的 GoalSources）；没有时不做第一次采样 */
  sampling?: { readonly hasDbstats: boolean; primed(run: string): boolean } | null;
  now?: () => number;
}

/** dbstats 两次采样的间隔（§3.3，不少于 300 秒） */
export const SAMPLE_INTERVAL_MS = 5 * 60_000 + 10_000;

interface DueRun {
  run_id: string;
  goal_id: string;
  goal_revision: number;
  queued_at: Date;
}

/** worker 读取的目标运行输入（GET /v1/research/tasks/{run_id}/goal-context） */
export interface GoalRunContext {
  goal: Goal;
  run_id: string;
  domain: string;
  baseline: OptimizationOutput['baseline'];
  gap: OptimizationOutput['gap'];
  candidates: OptimizationCandidate[];
  /** 诊断卡与份额卡（编号 card:<n>） */
  cards: EvidenceResult[];
  /** 选中的候选：发现指纹 → 份额卡的引用与份额 */
  shares: Record<string, Array<{ ref: string; share: number }>>;
  /** 区分性检查可用的查询模板（领域的 templates） */
  templates: Array<{ id: string; description: string; args: Record<string, unknown> }>;
  /** 范围内的组件与它们之间的边（当前拓扑） */
  topology: { version: number; nodes: TopologyNode[]; edges: TopologySnapshot['edges'] };
  /** 发现预示的症状类型（诊断卡的 symptoms） */
  symptoms: Record<string, string[]>;
  /** 领域的门槛（结论阶梯的 min_share） */
  gates: DomainGates;
  /** 趋势触发的目标：指标恶化的起点（趋势扫描器写入目标来源时给出，§5.4）；其余目标为 null */
  trend_onset: string | null;
  pack_lock: string;
}

type Admission = { ok: true } | { ok: false; reason: string; retryAt: number };

export class GoalRunner {
  private readonly now: () => number;

  constructor(private readonly d: RunnerDeps) {
    this.now = d.now ?? Date.now;
  }

  /** 一轮：到期的目标标为 expired；到期的排队与推迟运行逐个处理 */
  async runOnce(signal: AbortSignal, limit = 3): Promise<number> {
    await this.expire();
    await this.reap();
    const r = await this.d.pool.query<DueRun>(
      `SELECT r.run_id, r.goal_id, r.goal_revision, r.queued_at FROM server.goal_runs r
         JOIN server.goals g ON g.goal_id = r.goal_id
        WHERE r.state IN ('queued', 'deferred') AND r.next_attempt_at <= $1 AND g.state = ANY($2)
        ORDER BY r.queued_at LIMIT $3`,
      [new Date(this.now()), OPEN_GOAL_STATES, limit],
    );
    let n = 0;
    for (const run of r.rows) {
      if (signal.aborted) {
        break;
      }
      try {
        await this.process(run, signal);
        n++;
      } catch (e) {
        logger.error('目标运行失败', { run_id: run.run_id, goal_id: run.goal_id, error: e });
        await this.fail(run, 'internal', null);
      }
    }
    return n;
  }

  /**
   * 交给 worker 之后没有结果的运行：研判队列中的任务已经结束（租约多次过期、worker 失败而没有回报），运行还是 running
   * 并且没有输出时，记为 failed（internal），目标随之 failed
   */
  private async reap(): Promise<void> {
    const r = await this.d.pool.query<{ run_id: string; goal_id: string; skip_reason: string | null }>(
      `SELECT g.run_id, g.goal_id, q.skip_reason FROM server.goal_runs g
         JOIN server.research_queue q ON q.run_id = g.run_id AND q.subject_type = 'goal'
        WHERE g.state = 'running' AND g.output IS NULL AND q.state = 'done' AND q.finished_at < $1`,
      [new Date(this.now() - 5 * 60_000)],
    );
    for (const row of r.rows) {
      await tx(this.d.pool, async (c) => {
        await c.query(
          `UPDATE server.goal_runs SET state = 'failed', reason = 'internal', finished_at = $2
            WHERE run_id = $1 AND state = 'running' AND output IS NULL`,
          [row.run_id, new Date(this.now())],
        );
        await this.d.store.setGoalState(c, row.goal_id, 'failed', 'internal');
      });
      logger.warn('目标运行在 worker 上没有结果，记为失败', { run_id: row.run_id, skip_reason: row.skip_reason });
    }
  }

  private async expire(): Promise<void> {
    const r = await this.d.pool.query<{ goal_id: string }>(
      `UPDATE server.goals SET state = 'expired', state_reason = 'expired', updated_at = now()
        WHERE state = ANY($1) AND expires_at <= $2 RETURNING goal_id`,
      [OPEN_GOAL_STATES, new Date(this.now())],
    );
    if (r.rowCount) {
      await this.d.pool.query(
        `UPDATE server.goal_runs SET state = 'cancelled', reason = 'expired', finished_at = now()
          WHERE goal_id = ANY($1::uuid[]) AND state IN ('queued', 'deferred')`,
        [r.rows.map((x) => x.goal_id)],
      );
    }
  }

  /** 准入（§5.5）：预算（用途记账）→ 风暴 → 范围内的 critical 事件 → 负载保护 → 每个目标每 6 小时最多 1 次运行 */
  async admit(goal: Goal, run: DueRun, signal: AbortSignal): Promise<Admission> {
    const now = this.now();
    if (this.d.budgetExhausted()) {
      return { ok: false, reason: 'budget', retryAt: now + DEFER_MS };
    }
    if (this.d.storm()) {
      return { ok: false, reason: 'storm', retryAt: now + DEFER_MS };
    }
    const scope = goal.spec.subject.scope;
    const inc = await this.d.pool.query(
      `SELECT 1 FROM server.incidents
        WHERE cluster_id = $1 AND state = 'firing' AND NOT suppressed AND severity = 'critical'
          AND ((cardinality($2::text[]) = 0 AND cardinality($3::text[]) = 0)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(body->'components') c
                        WHERE c = ANY($2) OR split_part(split_part(c, ':', 2), '/', 1) = ANY($3)))
        LIMIT 1`,
      [goal.cluster_id, scope.components, scope.namespaces],
    );
    if (inc.rowCount) {
      return { ok: false, reason: 'incident', retryAt: now + DEFER_MS };
    }
    const guard = await this.d.limiter.guardState('metrics', signal);
    if (guard) {
      return { ok: false, reason: 'load_guard', retryAt: now + DEFER_MS };
    }
    const last = await this.d.pool.query<{ started_at: Date }>(
      `SELECT started_at FROM server.goal_runs WHERE goal_id = $1 AND run_id <> $2 AND started_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
      [goal.goal_id, run.run_id],
    );
    const prev = last.rows[0]?.started_at.getTime();
    if (prev !== undefined && now - prev < RUN_INTERVAL_MS) {
      return { ok: false, reason: 'rate_limit', retryAt: prev + RUN_INTERVAL_MS };
    }
    return { ok: true };
  }

  private async process(run: DueRun, signal: AbortSignal): Promise<void> {
    const goal = await this.d.store.goal(run.goal_id);
    if (!goal || !OPEN_GOAL_STATES.includes(goal.state)) {
      return;
    }
    const adm = await this.admit(goal, run, signal);
    if (!adm.ok) {
      await this.d.pool.query(
        `UPDATE server.goal_runs SET state = 'deferred', reason = $2, next_attempt_at = $3 WHERE run_id = $1`,
        [run.run_id, adm.reason, new Date(adm.retryAt)],
      );
      logger.info('目标运行推迟', { run_id: run.run_id, goal_id: goal.goal_id, reason: adm.reason });
      return;
    }
    await tx(this.d.pool, async (c) => {
      await c.query(`UPDATE server.goal_runs SET state = 'running', reason = NULL, started_at = $2 WHERE run_id = $1`, [
        run.run_id,
        new Date(this.now()),
      ]);
      await this.d.store.setGoalState(c, goal.goal_id, 'analyzing', null);
    });
    const set = this.d.set();
    const now = this.now();
    const window = { from: now - baselineWindowMs(goal.spec), to: now };
    const snapshot = await this.d.topology(goal.cluster_id, new Date(now));
    const plan = this.plan(goal, set, snapshot);
    // 两次采样（§3.3）：领域的诊断卡或份额卡读 dbstats 时，先执行一遍取得第一次采样，推迟 SAMPLE_INTERVAL_MS 之后
    // 再计算基线与候选；server 重启丢失采样时重新开始
    const sampling = this.d.sampling;
    if (sampling?.hasDbstats && !sampling.primed(run.run_id) && this.dbstatsCards(set, plan).length) {
      await this.prime(goal, plan, set, now, signal, run.run_id);
      await this.d.pool.query(
        `UPDATE server.goal_runs SET state = 'deferred', reason = 'sampling', next_attempt_at = $2 WHERE run_id = $1`,
        [run.run_id, new Date(now + SAMPLE_INTERVAL_MS)],
      );
      logger.info('目标运行取得 dbstats 的第一次采样，推迟后计算', { run_id: run.run_id, goal_id: goal.goal_id });
      return;
    }
    const base = await this.baseline(goal, set, plan, window, signal);
    const output: OptimizationOutput = {
      goal_id: goal.goal_id,
      goal_revision: run.goal_revision,
      run_id: run.run_id,
      baseline: base.baseline,
      gap: base.gap,
      candidates: [],
      hypotheses: [],
      next_checks: [],
      conclusions: [],
      recommendations: [],
      summary: '',
      stop_reason: null,
      check_cards: [],
      evidence_index: [],
      validation_notes: [],
    };
    if (!base.baseline.sufficient) {
      output.summary = `基线不足：${base.baseline.missing.join('；')}`.slice(0, 600);
      await this.conclude(goal, run, output, { state: 'failed', result: null, reason: 'baseline_insufficient' });
      return;
    }
    if (!base.gap.exists) {
      output.summary = `没有差距：${base.gap.detail}`.slice(0, 600);
      await this.conclude(goal, run, output, { state: 'concluded', result: 'no_gap', reason: null });
      return;
    }
    const found = await this.candidates(goal, set, plan, base, now, signal, run.run_id);
    output.candidates = found.candidates;
    output.check_cards = found.cards.map((x) => ({ ...x, series: [] }));
    output.evidence_index = found.cards.map((x) => ({ ref: x.ref, target: `${x.card_id}@${entityKeyOf(x)}` }));
    const selected = found.candidates.filter((x) => x.selected);
    if (!selected.length) {
      output.summary = found.candidates.length
        ? '有差距，候选发现都在验证期或冷却期内，没有进入分析'
        : '有差距，诊断卡在范围内没有发现候选';
      await this.conclude(goal, run, output, { state: 'concluded', result: 'report_only', reason: null });
      return;
    }
    const context: GoalRunContext = {
      goal,
      run_id: run.run_id,
      domain: plan.domain,
      baseline: base.baseline,
      gap: base.gap,
      candidates: found.candidates,
      cards: found.cards,
      shares: found.shares,
      templates: (set.domains.get(plan.domain)?.templates ?? []).flatMap((id) => {
        const t = set.templates.find((x) => x.id === id);
        return t ? [{ id: t.id, description: t.description, args: t.args }] : [];
      }),
      topology: subTopology(snapshot, plan.components),
      symptoms: found.symptoms,
      gates: plan.gates,
      trend_onset: null,
      pack_lock: set.lockDigest,
    };
    await tx(this.d.pool, async (c) => {
      await c.query('UPDATE server.goal_runs SET context = $2, findings = $3 WHERE run_id = $1', [
        run.run_id,
        JSON.stringify(context),
        found.candidates.length,
      ]);
      // 研判队列（§5.5）：主体为目标，优先级低于全部事件原因；incident_id 取目标 id、incident_version 取 revision
      await c.query(
        `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, absorbed, is_new, state,
           subject_type)
         VALUES ($1, $2, $3, $4, 'info', 0, false, 'queued', 'goal') ON CONFLICT DO NOTHING`,
        [run.run_id, goal.goal_id, run.goal_revision, `goal:${run.run_id}`],
      );
    });
    logger.info('目标运行进入分析', {
      run_id: run.run_id,
      goal_id: goal.goal_id,
      candidates: found.candidates.length,
      selected: selected.length,
    });
  }

  /** 领域中读 dbstats 的诊断卡与份额卡 */
  private dbstatsCards(set: PackSet, plan: ReturnType<GoalRunner['plan']>): Array<{ id: string; card: string }> {
    const d = set.domains.get(plan.domain);
    if (!d) {
      return [];
    }
    const seen = new Set<string>();
    return [...d.contribution, ...d.diagnostics].filter((x) => {
      const key = `${x.id}|${x.card}`;
      if (seen.has(key) || !this.d.evidence.usesDbstats(x.card)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /** 第一次采样：在范围内的组件上执行一遍读 dbstats 的卡，结果丢弃 */
  private async prime(
    goal: Goal,
    plan: ReturnType<GoalRunner['plan']>,
    set: PackSet,
    now: number,
    signal: AbortSignal,
    runId: string,
  ): Promise<void> {
    for (const n of plan.components) {
      const entity = {
        cluster_id: goal.cluster_id,
        kind: n.kind,
        namespace: n.namespace,
        name: n.name,
        node: n.kind === 'Node' ? n.name : null,
        uid: n.uid,
      };
      for (const item of this.dbstatsCards(set, plan)) {
        try {
          await this.d.evidence.domainCard(plan.domain, item, entity, now, signal, runId);
        } catch (e) {
          if (!(e instanceof GoalDataUnavailable)) {
            throw e;
          }
        }
      }
    }
  }

  /** 运行的对象：领域与它的指标、范围内适用的组件 */
  plan(
    goal: Goal,
    set: PackSet,
    snapshot: TopologySnapshot,
  ): { domain: string; indicators: string[]; components: TopologyNode[]; gates: DomainGates } {
    const s = goal.spec.subject;
    let domain: string;
    let indicators: string[];
    if (s.type === 'domain') {
      domain = s.domain;
      indicators = [...(set.domains.get(domain)?.indicators ?? [])];
    } else {
      // 指标目标：指标所在的领域（领域的 indicators 或诊断卡引用了它）
      const d = [...set.domains.values()].find(
        (x) => x.indicators.includes(s.indicator) || x.diagnostics.some((g) => g.indicator === s.indicator),
      );
      domain = d?.id ?? '';
      indicators = [s.indicator];
    }
    const d = set.domains.get(domain);
    const kinds = new Set([
      ...(d?.applies_to ?? []),
      ...indicators.map((i) => set.indicators.get(i)?.def.entity).filter((x): x is string => !!x),
    ]);
    const scope = s.scope;
    const components = snapshot.nodes
      .filter((n) => kinds.has(n.kind) || (n.component_type !== null && kinds.has(n.component_type)))
      .filter((n) =>
        scope.components.length
          ? scope.components.includes(n.key)
          : !scope.namespaces.length || (n.namespace !== null && scope.namespaces.includes(n.namespace)),
      )
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, MAX_ENTITIES);
    return { domain, indicators, components, gates: d?.gates ?? {} };
  }

  private async baseline(
    goal: Goal,
    set: PackSet,
    plan: ReturnType<GoalRunner['plan']>,
    window: { from: number; to: number },
    signal: AbortSignal,
  ): Promise<BaselineResult> {
    const s = goal.spec.subject;
    const params: Record<string, number | string | boolean> = {};
    for (const [k, v] of Object.entries(s.type === 'indicator' ? s.params : {})) {
      if (v !== undefined) {
        params[k] = v;
      }
    }
    const series: IndicatorSeries[] = [];
    const missing: string[] = [];
    for (const indicator of plan.indicators) {
      const ind = set.indicators.get(indicator);
      if (!ind) {
        missing.push(`领域包中没有指标 ${indicator}`);
        continue;
      }
      const entities = plan.components.filter((n) => n.kind === ind.def.entity || n.component_type === ind.def.entity);
      if (!entities.length) {
        missing.push(`范围内没有指标 ${indicator} 的实体（${ind.def.entity}）`);
      }
      for (const n of entities) {
        const entity = { cluster_id: goal.cluster_id, kind: n.kind, namespace: n.namespace, name: n.name };
        try {
          const values = await this.d.evidence.indicatorHourly(indicator, entity, params, window, signal);
          const loadKey = ind.def.load_indicator;
          const load = loadKey ? await this.d.evidence.indicatorHourly(loadKey, entity, {}, window, signal) : null;
          series.push({
            indicator,
            params,
            entity: n.key,
            unit: ind.def.unit,
            better: ind.def.better,
            statistic: goal.spec.objective?.statistic ?? ind.def.statistic,
            hourly: values,
            load,
          });
        } catch (e) {
          if (!(e instanceof GoalDataUnavailable)) {
            throw e;
          }
          missing.push(`${indicator}@${n.key}：${e.message}`);
        }
      }
    }
    const r = baselineAndGap(window, series, goal.spec.objective, plan.gates);
    if (missing.length) {
      r.baseline.missing = [...missing, ...r.baseline.missing];
      if (!series.length) {
        r.baseline.sufficient = false;
        r.gap = { exists: false, basis: 'none', detail: '基线不足，无法判定差距' };
      }
    }
    return r;
  }

  private async candidates(
    goal: Goal,
    set: PackSet,
    plan: ReturnType<GoalRunner['plan']>,
    base: BaselineResult,
    now: number,
    signal: AbortSignal,
    runId: string,
  ): Promise<{
    candidates: OptimizationCandidate[];
    cards: EvidenceResult[];
    shares: Record<string, Array<{ ref: string; share: number }>>;
    symptoms: Record<string, string[]>;
  }> {
    const d = set.domains.get(plan.domain);
    const cards: EvidenceResult[] = [];
    const diagnosed: DiagnosedEntity[] = [];
    const shares: Record<string, Array<{ ref: string; share: number }>> = {};
    const symptoms: Record<string, string[]> = {};
    if (!d) {
      return { candidates: [], cards, shares, symptoms };
    }
    const targetIndicator = goal.spec.subject.type === 'indicator' ? goal.spec.subject.indicator : null;
    const diagnostics = d.diagnostics.filter((x) => targetIndicator === null || x.indicator === targetIndicator);
    for (const n of plan.components) {
      const entity = {
        cluster_id: goal.cluster_id,
        kind: n.kind,
        namespace: n.namespace,
        name: n.name,
        node: n.kind === 'Node' ? n.name : null,
        uid: n.uid,
      };
      const runs = new Map<string, { ref: string; rows: Awaited<ReturnType<GoalEvidence['domainCard']>>['rows'] }>();
      const run = async (item: { id: string; card: string }) => {
        const key = `${item.id}|${item.card}`;
        const hit = runs.get(key);
        if (hit) {
          return hit;
        }
        try {
          const r = await this.d.evidence.domainCard(plan.domain, item, entity, now, signal, runId);
          const ref = `card:${cards.length + 1}`;
          cards.push({ ...r.result, ref });
          const out = { ref, rows: r.rows };
          runs.set(key, out);
          return out;
        } catch (e) {
          if (!(e instanceof GoalDataUnavailable)) {
            throw e;
          }
          logger.warn('领域的卡片没有执行', { domain: plan.domain, card: item.card, entity: n.key, error: e.message });
          return null;
        }
      };
      // 份额：同一类型与键的实体 → 份额与份额卡
      const shareOf = new Map<string, { share: number; ref: string }>();
      for (const c of d.contribution) {
        const r = await run(c);
        if (!r) {
          continue;
        }
        if (r.rows.share !== null) {
          shareOf.set(`${n.kind}:${n.key}`, { share: r.rows.share, ref: r.ref });
        }
        for (const row of r.rows.rows) {
          if (row.share !== null) {
            shareOf.set(`${row.type}:${row.key}`, { share: row.share, ref: r.ref });
          }
        }
      }
      for (const g of diagnostics) {
        const r = await run(g);
        if (!r) {
          continue;
        }
        const card = cards.find((x) => x.ref === r.ref) as EvidenceResult;
        const gap = g.indicator ? (base.gaps.get(seriesKey(g.indicator, n.key)) ?? null) : null;
        const hits: Array<{ entityKey: string; type: string; display: string; labels: Record<string, string> }> = [];
        if (g.entities) {
          for (const row of r.rows.rows.filter((x) => x.hit === true)) {
            hits.push({
              entityKey: `${row.type}:${n.name}/${row.key}`,
              type: row.type,
              display: (row.display ?? row.key).slice(0, 200),
              labels: { ...row.labels, row_key: row.key },
            });
          }
        } else if (card.verdict === 'abnormal') {
          hits.push({ entityKey: n.key, type: n.kind, display: n.name.slice(0, 200), labels: {} });
        }
        for (const h of hits) {
          const fp = findingFingerprint(goal.cluster_id, plan.domain, g.finding, h.entityKey);
          const rowKey = h.labels.row_key;
          const sh = rowKey !== undefined ? shareOf.get(`${h.type}:${rowKey}`) : shareOf.get(`${n.kind}:${n.key}`);
          diagnosed.push({
            finding: fp,
            kind: g.finding,
            entity: { type: h.type, key: h.entityKey, display: h.display, labels: withoutRowKey(h.labels) },
            component: n.key,
            diagnostic: `${plan.domain}/${g.id}`,
            card_ref: r.ref,
            share: sh?.share ?? null,
            share_ref: sh?.ref ?? null,
            gap,
          });
          if (sh) {
            shares[fp] = [{ ref: sh.ref, share: sh.share }];
          }
          symptoms[fp] = g.symptoms;
        }
      }
    }
    const known = await this.d.store.findings(diagnosed.map((x) => x.finding));
    const knownState = new Map<string, KnownFinding>(
      [...known.entries()].map(([k, v]) => [
        k,
        {
          status: v.status,
          cooldownUntil: v.body.cooldown_until ? Date.parse(v.body.cooldown_until) : null,
          gapAtRejection: v.gap_at_rejection,
          verifyingUntil: v.verifying_until ? v.verifying_until.getTime() : null,
        },
      ]),
    );
    const candidates = rankCandidates(diagnosed, knownState, now);
    // 进入分析的语句类发现：按 queryid 经 dbstats statements.text 取规范化语句，写进 entity.labels.statement
    // （业务 issue slow-statement 的 sql 锚点；取不到时模板按 no_anchor 跳过）
    const byComponent = new Map<string, OptimizationCandidate[]>();
    for (const cand of candidates.filter((x) => x.selected && x.entity.labels.queryid !== undefined)) {
      byComponent.set(cand.component, [...(byComponent.get(cand.component) ?? []), cand]);
    }
    for (const [key, list] of byComponent) {
      const n = plan.components.find((x) => x.key === key);
      if (!n) {
        continue;
      }
      const texts = await this.d.evidence.statementTexts(
        { cluster_id: goal.cluster_id, kind: n.kind, namespace: n.namespace, name: n.name, node: null },
        list.map((x) => x.entity.labels.queryid as string),
        now,
        signal,
      );
      for (const cand of list) {
        const text = texts.get(cand.entity.labels.queryid as string);
        if (text) {
          cand.entity.labels.statement = text;
        }
      }
    }
    await tx(this.d.pool, async (c) => {
      const at = new Date(now).toISOString();
      for (const cand of candidates) {
        const prev = known.get(cand.finding)?.body;
        const f: Finding = {
          fingerprint: cand.finding,
          cluster_id: goal.cluster_id,
          domain: plan.domain,
          kind: cand.kind,
          entity: cand.entity,
          component: cand.component,
          indicator: d.diagnostics.find((x) => `${plan.domain}/${x.id}` === cand.diagnostic)?.indicator ?? null,
          gap: cand.gap,
          share: cand.share,
          level: prev?.level ?? null,
          evidence_fingerprint: prev?.evidence_fingerprint ?? null,
          status: prev?.status ?? 'open',
          cooldown_until: prev?.cooldown_until ?? null,
          last_goal_id: goal.goal_id,
          last_run_id: null,
          first_seen: prev?.first_seen ?? at,
          last_seen: at,
          updated_at: at,
        };
        await this.d.store.saveFinding(c, f);
        await appendEvents(c, 'server', 'server', EVENTS_SCHEMA_VERSION, [
          { type: 'finding.updated', clusterId: f.cluster_id, payload: f },
        ]);
      }
    });
    return { candidates, cards, shares, symptoms };
  }

  /** 不需要 worker 的结束：基线不足、没有差距、没有可分析的候选 */
  private async conclude(
    goal: Goal,
    run: DueRun,
    output: OptimizationOutput,
    r: { state: 'concluded' | 'failed'; result: 'no_gap' | 'report_only' | null; reason: string | null },
  ): Promise<void> {
    const goalState =
      r.state === 'failed'
        ? 'failed'
        : r.result === 'no_gap' && goal.spec.objective !== null
          ? 'achieved'
          : 'no_action';
    await tx(this.d.pool, async (c) => {
      await c.query(
        `UPDATE server.goal_runs SET state = $2, result = $3, reason = $4, gap = $5, output = $6, findings = $7,
           finished_at = $8 WHERE run_id = $1`,
        [
          run.run_id,
          r.state,
          r.result,
          r.reason,
          output.baseline.sufficient ? output.gap.exists : null,
          JSON.stringify(output),
          output.candidates.length,
          new Date(this.now()),
        ],
      );
      await this.d.store.setGoalState(c, goal.goal_id, goalState, r.reason);
      await this.concludedEvent(c, goal, run.run_id, output);
    });
    logger.info('目标运行结束（不需要模型）', {
      run_id: run.run_id,
      goal_id: goal.goal_id,
      state: r.state,
      result: r.result,
      reason: r.reason,
    });
  }

  async concludedEvent(c: Queryable, goal: Goal, runId: string, output: OptimizationOutput | null): Promise<void> {
    const runs = await c.query<{ goal_id: string }>('SELECT goal_id FROM server.goal_runs WHERE run_id = $1', [runId]);
    if (!runs.rowCount) {
      return;
    }
    const summary = (await this.d.store.runs(goal.goal_id)).find((x) => x.run_id === runId);
    if (!summary) {
      return;
    }
    await appendEvents(c, 'server', 'server', EVENTS_SCHEMA_VERSION, [
      {
        type: 'goal.run.concluded',
        clusterId: goal.cluster_id,
        payload: { goal_id: goal.goal_id, goal_revision: summary.goal_revision, run_id: runId, summary, output },
      },
    ]);
  }

  private async fail(run: DueRun, reason: string, output: OptimizationOutput | null): Promise<void> {
    await tx(this.d.pool, async (c) => {
      await c.query(
        `UPDATE server.goal_runs SET state = 'failed', reason = $2, output = coalesce($3, output), finished_at = now()
          WHERE run_id = $1`,
        [run.run_id, reason, output ? JSON.stringify(output) : null],
      );
      await this.d.store.setGoalState(c, run.goal_id, 'failed', reason);
    });
  }
}

function withoutRowKey(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).filter(([k]) => k !== 'row_key'));
}

function entityKeyOf(r: EvidenceResult): string {
  const e = r.entity;
  if (!e) {
    return '';
  }
  return e.namespace ? `${e.kind}:${e.namespace}/${e.name}` : `${e.kind}:${e.name}`;
}

/** 范围内的组件、它们的一跳邻居与之间的边 */
function subTopology(s: TopologySnapshot, components: readonly TopologyNode[]): GoalRunContext['topology'] {
  const keys = new Set(components.map((n) => n.key));
  const edges = s.edges.filter((e) => keys.has(e.from) || keys.has(e.to));
  const near = new Set([...keys, ...edges.flatMap((e) => [e.from, e.to])]);
  return { version: s.version, nodes: s.nodes.filter((n) => near.has(n.key)), edges };
}
