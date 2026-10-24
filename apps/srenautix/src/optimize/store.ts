import type {
  Finding,
  FindingStatus,
  Goal,
  GoalRunSummary,
  GoalSpec,
  OptimizationOutput,
  OptimizationRecommendation,
  RecommendationState,
} from '@srenautix/contract';
import type pg from 'pg';
import type { Queryable } from '../store/pool.js';

// 主动优化的存储（server schema，迁移见 migrations.ts）。目标、运行、发现与建议的契约对象从行拼出；
// 列表接口按时间倒序、游标为上一页最后一行的时间与 id。

export type GoalState = Goal['state'];
export type GoalRunState = GoalRunSummary['state'];

/** 未结束的目标状态 */
export const OPEN_GOAL_STATES: readonly GoalState[] = ['queued', 'analyzing', 'recommended', 'verifying'];

interface GoalRow {
  goal_id: string;
  cluster_id: string;
  revision: number;
  spec: GoalSpec;
  state: GoalState;
  state_reason: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  run_id: string;
  goal_id: string;
  goal_revision: number;
  state: GoalRunState;
  result: GoalRunSummary['result'];
  reason: string | null;
  gap: boolean | null;
  findings: number;
  recommendations: number;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function runSummary(r: RunRow): GoalRunSummary {
  return {
    run_id: r.run_id,
    goal_id: r.goal_id,
    goal_revision: r.goal_revision,
    state: r.state,
    result: r.result,
    reason: r.reason,
    gap: r.gap,
    findings: r.findings,
    recommendations: r.recommendations,
    queued_at: r.queued_at.toISOString(),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
  };
}

function goalOf(g: GoalRow, last: RunRow | null): Goal {
  return {
    goal_id: g.goal_id,
    revision: g.revision,
    cluster_id: g.cluster_id,
    spec: g.spec,
    state: g.state,
    state_reason: g.state_reason,
    expires_at: g.expires_at.toISOString(),
    last_run: last ? runSummary(last) : null,
    created_at: g.created_at.toISOString(),
    updated_at: g.updated_at.toISOString(),
  };
}

const RUN_COLUMNS =
  'run_id, goal_id, goal_revision, state, result, reason, gap, findings, recommendations, queued_at, started_at, finished_at';

/** 列表游标：<毫秒>:<id> */
export function decodeCursor(cursor: string | undefined): { at: Date; id: string } | null {
  if (!cursor) {
    return null;
  }
  const m = /^(\d+):([0-9a-z:-]+)$/.exec(cursor);
  if (!m) {
    throw new Error('游标不合法');
  }
  return { at: new Date(Number(m[1])), id: m[2] as string };
}

export const encodeCursor = (at: Date, id: string) => `${at.getTime()}:${id}`;

export interface NewGoal {
  goalId: string;
  clusterId: string;
  spec: GoalSpec;
  principal: string | null;
  expiresAt: Date;
  runId: string;
}

export class OptimizationStore {
  constructor(private readonly pool: pg.Pool) {}

  /** 新建目标与它的第一次运行（排队） */
  async createGoal(c: Queryable, g: NewGoal): Promise<Goal> {
    const subject = g.spec.subject;
    await c.query(
      `INSERT INTO server.goals (goal_id, cluster_id, spec, state, origin_kind, principal, domain, indicator, expires_at)
       VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)`,
      [
        g.goalId,
        g.clusterId,
        JSON.stringify(g.spec),
        g.spec.origin.kind,
        g.principal,
        subject.type === 'domain' ? subject.domain : null,
        subject.type === 'indicator' ? subject.indicator : null,
        g.expiresAt,
      ],
    );
    await c.query('INSERT INTO server.goal_runs (run_id, goal_id, goal_revision, state) VALUES ($1, $2, 1, $3)', [
      g.runId,
      g.goalId,
      'queued',
    ]);
    return (await this.goal(g.goalId, c)) as Goal;
  }

  async goal(goalId: string, c: Queryable = this.pool): Promise<Goal | null> {
    const r = await c.query<GoalRow>('SELECT * FROM server.goals WHERE goal_id = $1', [goalId]);
    const g = r.rows[0];
    if (!g) {
      return null;
    }
    const last = await c.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM server.goal_runs WHERE goal_id = $1 ORDER BY queued_at DESC LIMIT 1`,
      [goalId],
    );
    return goalOf(g, last.rows[0] ?? null);
  }

  async listGoals(f: {
    clusterId: string | null;
    state: GoalState | null;
    open: boolean;
    domain: string | null;
    cursor: { at: Date; id: string } | null;
    limit: number;
  }): Promise<{ items: Goal[]; next: string | null }> {
    const r = await this.pool.query<GoalRow & { last: RunRow | null }>(
      `SELECT g.*, (SELECT row_to_json(x) FROM (SELECT ${RUN_COLUMNS} FROM server.goal_runs WHERE goal_id = g.goal_id
                ORDER BY queued_at DESC LIMIT 1) x) AS last
         FROM server.goals g
        WHERE ($1::text IS NULL OR g.cluster_id = $1) AND ($2::text IS NULL OR g.state = $2)
          AND (NOT $3 OR g.state = ANY($4)) AND ($5::text IS NULL OR g.domain = $5)
          AND ($6::timestamptz IS NULL OR (g.created_at, g.goal_id) < ($6, $7::uuid))
        ORDER BY g.created_at DESC, g.goal_id DESC LIMIT $8`,
      [
        f.clusterId,
        f.state,
        f.open,
        OPEN_GOAL_STATES,
        f.domain,
        f.cursor?.at ?? null,
        f.cursor?.id ?? null,
        f.limit + 1,
      ],
    );
    const rows = r.rows.slice(0, f.limit);
    const items = rows.map((g) => goalOf(g, g.last ? reviveRun(g.last) : null));
    const last = rows[rows.length - 1];
    return { items, next: r.rows.length > f.limit && last ? encodeCursor(last.created_at, last.goal_id) : null };
  }

  /** 主体当天（UTC）下达的目标数 */
  async goalsToday(principal: string, c: Queryable = this.pool): Promise<number> {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM server.goals WHERE principal = $1
         AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [principal],
    );
    return r.rows[0]?.n ?? 0;
  }

  async openGoals(clusterId: string, c: Queryable = this.pool): Promise<number> {
    const r = await c.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM server.goals WHERE cluster_id = $1 AND state = ANY($2)',
      [clusterId, OPEN_GOAL_STATES],
    );
    return r.rows[0]?.n ?? 0;
  }

  async setGoalState(c: Queryable, goalId: string, state: GoalState, reason: string | null): Promise<void> {
    await c.query('UPDATE server.goals SET state = $2, state_reason = $3, updated_at = now() WHERE goal_id = $1', [
      goalId,
      state,
      reason,
    ]);
  }

  async runs(goalId: string): Promise<GoalRunSummary[]> {
    const r = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM server.goal_runs WHERE goal_id = $1 ORDER BY queued_at DESC`,
      [goalId],
    );
    return r.rows.map(runSummary);
  }

  async run(
    goalId: string,
    runId: string,
  ): Promise<{ summary: GoalRunSummary; output: OptimizationOutput | null } | null> {
    const r = await this.pool.query<RunRow & { output: OptimizationOutput | null }>(
      `SELECT ${RUN_COLUMNS}, output FROM server.goal_runs WHERE goal_id = $1 AND run_id = $2`,
      [goalId, runId],
    );
    const row = r.rows[0];
    return row ? { summary: runSummary(row), output: row.output } : null;
  }

  /** 发现：按 last_seen 倒序 */
  async listFindings(f: {
    clusterId: string | null;
    domain: string | null;
    status: FindingStatus | null;
    goalId: string | null;
    component: string | null;
    cursor: { at: Date; id: string } | null;
    limit: number;
  }): Promise<{ items: Finding[]; next: string | null }> {
    const r = await this.pool.query<{ body: Finding; last_seen: Date; fingerprint: string }>(
      `SELECT body, last_seen, fingerprint FROM server.optimization_findings
        WHERE ($1::text IS NULL OR cluster_id = $1) AND ($2::text IS NULL OR domain = $2) AND ($3::text IS NULL OR status = $3)
          AND ($4::text IS NULL OR body->>'last_goal_id' = $4) AND ($5::text IS NULL OR component = $5)
          AND ($6::timestamptz IS NULL OR (last_seen, fingerprint) < ($6, $7))
        ORDER BY last_seen DESC, fingerprint DESC LIMIT $8`,
      [f.clusterId, f.domain, f.status, f.goalId, f.component, f.cursor?.at ?? null, f.cursor?.id ?? null, f.limit + 1],
    );
    const rows = r.rows.slice(0, f.limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map((x) => x.body),
      next: r.rows.length > f.limit && last ? encodeCursor(last.last_seen, last.fingerprint) : null,
    };
  }

  async findings(fingerprints: readonly string[], c: Queryable = this.pool): Promise<Map<string, FindingRow>> {
    if (!fingerprints.length) {
      return new Map();
    }
    const r = await c.query<FindingRow>(
      `SELECT fingerprint, status, body, gap_at_rejection, verifying_until FROM server.optimization_findings
        WHERE fingerprint = ANY($1)`,
      [fingerprints],
    );
    return new Map(r.rows.map((x) => [x.fingerprint, x]));
  }

  /** 保存发现（按指纹插入或更新） */
  async saveFinding(c: Queryable, f: Finding, extra: { gapAtRejection?: number | null } = {}): Promise<void> {
    await c.query(
      `INSERT INTO server.optimization_findings (fingerprint, cluster_id, domain, kind, entity_key, component, status, body,
         gap_at_rejection, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (fingerprint) DO UPDATE SET status = excluded.status, body = excluded.body, component = excluded.component,
         gap_at_rejection = coalesce(excluded.gap_at_rejection, server.optimization_findings.gap_at_rejection),
         last_seen = excluded.last_seen, updated_at = now()`,
      [
        f.fingerprint,
        f.cluster_id,
        f.domain,
        f.kind,
        f.entity.key,
        f.component,
        f.status,
        JSON.stringify(f),
        extra.gapAtRejection ?? null,
        f.last_seen,
      ],
    );
  }

  async listRecommendations(f: {
    goalId: string | null;
    finding: string | null;
    kind: string | null;
    state: RecommendationState | null;
    cursor: { at: Date; id: string } | null;
    limit: number;
  }): Promise<{ items: OptimizationRecommendation[]; next: string | null }> {
    const r = await this.pool.query<{ body: OptimizationRecommendation; created_at: Date; recommendation_id: string }>(
      `SELECT body, created_at, recommendation_id FROM server.optimization_recommendations
        WHERE ($1::uuid IS NULL OR goal_id = $1) AND ($2::text IS NULL OR finding = $2) AND ($3::text IS NULL OR kind = $3)
          AND ($4::text IS NULL OR state = $4)
          AND ($5::timestamptz IS NULL OR (created_at, recommendation_id) < ($5, $6::uuid))
        ORDER BY created_at DESC, recommendation_id DESC LIMIT $7`,
      [f.goalId, f.finding, f.kind, f.state, f.cursor?.at ?? null, f.cursor?.id ?? null, f.limit + 1],
    );
    const rows = r.rows.slice(0, f.limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map((x) => x.body),
      next: r.rows.length > f.limit && last ? encodeCursor(last.created_at, last.recommendation_id) : null,
    };
  }

  async recommendation(id: string, c: Queryable = this.pool): Promise<OptimizationRecommendation | null> {
    const r = await c.query<{ body: OptimizationRecommendation }>(
      'SELECT body FROM server.optimization_recommendations WHERE recommendation_id = $1',
      [id],
    );
    return r.rows[0]?.body ?? null;
  }

  async saveRecommendation(
    c: Queryable,
    rec: OptimizationRecommendation,
    extra: { targetKey?: string | null; repository?: string | null } = {},
  ): Promise<void> {
    await c.query(
      `INSERT INTO server.optimization_recommendations (recommendation_id, cluster_id, finding, goal_id, run_id, kind, template,
         state, target_key, repository, body, delivered_at, merged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (recommendation_id) DO UPDATE SET state = excluded.state, body = excluded.body,
         target_key = coalesce(excluded.target_key, server.optimization_recommendations.target_key),
         repository = coalesce(excluded.repository, server.optimization_recommendations.repository),
         delivered_at = coalesce(excluded.delivered_at, server.optimization_recommendations.delivered_at),
         merged_at = coalesce(excluded.merged_at, server.optimization_recommendations.merged_at), updated_at = now()`,
      [
        rec.recommendation_id,
        rec.cluster_id,
        rec.finding,
        rec.goal_id,
        rec.run_id,
        rec.kind,
        rec.template,
        rec.state,
        extra.targetKey ?? null,
        extra.repository ?? rec.delivery?.repository ?? null,
        JSON.stringify(rec),
        rec.delivery?.number || rec.delivery?.proposal_id ? new Date() : null,
        rec.delivery?.merged_at ? new Date(rec.delivery.merged_at) : null,
      ],
    );
  }
}

export interface FindingRow {
  fingerprint: string;
  status: FindingStatus;
  body: Finding;
  gap_at_rejection: number | null;
  verifying_until: Date | null;
}

/** row_to_json 得到的运行行：时间是字符串 */
function reviveRun(x: RunRow): RunRow {
  const d = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string));
  return {
    ...x,
    queued_at: d(x.queued_at) as Date,
    started_at: d(x.started_at),
    finished_at: d(x.finished_at),
  };
}
