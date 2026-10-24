import type pg from 'pg';
import type {
  DialectProfile,
  EvidenceResult,
  OptimizationOutput,
  ResearchManifest,
  ResearchOutput,
} from '@srenautix/contract';
import { CONTRACT_VERSION } from '@srenautix/contract';
import type { Calibration } from '../llm/budget.js';
import type { LlmCallRecord } from '../llm/session.js';
import { appendEvents, type NewEvent } from '../store/outbox.js';
import { tx } from '../store/pool.js';
import type { ToolCallRecord } from '../tools/box.js';
import type { ResearchState } from './controller.js';
import type { PreviousRun } from './types.js';

// worker schema 的读写。所有写入都用 worker 的库角色；事件与状态写在同一个事务里。

export interface RunStart {
  runId: string;
  /** 目标运行（subject_type=goal）为目标 id */
  incidentId: string;
  /** 目标运行为目标 revision */
  incidentVersion: number;
  clusterId: string;
  reason: string;
  /** 目标运行为空串（目标没有阶段 A 的证据指纹） */
  evidenceFingerprint: string;
  subjectType?: 'incident' | 'goal';
}

/** 模型用量的用途（ADR 0146 §5.3）：每日用量按用途分别记账 */
export type UsagePurpose = 'research' | 'optimization' | 'eval';

/** 目标运行的结束（ADR 0146 §2.3）：输出交给 server（POST /v1/research/tasks/{run_id}/optimization），worker 不发事件 */
export interface GoalRunFinish {
  runId: string;
  state: 'completed' | 'failed';
  stopReason: string | null;
  output: OptimizationOutput | null;
  error: { kind: string; message: string } | null;
  input: number;
  output_tokens: number;
  cost: number;
  currency: string;
  steps: Array<{ state: string; started_at: string; finished_at: string | null }>;
  checkCards: Array<{ ref: string; hypothesisId: string; judgedBy: 'rule' | 'model'; result: EvidenceResult }>;
}

const USAGE_SQL = `INSERT INTO worker.daily_usage (day, tokens, cost) VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2)
         ON CONFLICT (day) DO UPDATE SET tokens = worker.daily_usage.tokens + excluded.tokens, cost = worker.daily_usage.cost + excluded.cost, updated_at = now()`;

const PURPOSE_USAGE_SQL = `INSERT INTO worker.daily_usage_purpose (day, purpose, tokens, cost)
         VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, $3)
         ON CONFLICT (day, purpose) DO UPDATE SET tokens = worker.daily_usage_purpose.tokens + excluded.tokens,
           cost = worker.daily_usage_purpose.cost + excluded.cost, updated_at = now()`;

export interface RunFinish {
  runId: string;
  clusterId: string;
  state: 'completed' | 'stage_a_only' | 'failed';
  stopReason: string | null;
  output: ResearchOutput | null;
  error: { kind: string; message: string } | null;
  stillConsistent: boolean;
  estimatedInput: number;
  input: number;
  output_tokens: number;
  cost: number;
  currency: string;
  steps: Array<{ state: string; started_at: string; finished_at: string | null }>;
  manifest: ResearchManifest | null;
  checkCards: Array<{ ref: string; hypothesisId: string; judgedBy: 'rule' | 'model'; result: EvidenceResult }>;
  events: NewEvent[];
}

export interface RouteStateRow {
  profile: DialectProfile | null;
  calibration: Calibration | null;
  fingerprint: string | null;
}

export class WorkerStore {
  constructor(readonly pool: pg.Pool) {}

  async startRun(s: RunStart): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker.research_runs (run_id, incident_id, incident_version, cluster_id, reason, state, evidence_fingerprint,
         subject_type, started_at)
       VALUES ($1, $2, $3, $4, $5, 'hypothesize', $6, $7, now())
       ON CONFLICT (run_id) DO UPDATE SET state = 'hypothesize', started_at = now(), finished_at = NULL, output = NULL, error = NULL`,
      [
        s.runId,
        s.incidentId,
        s.incidentVersion,
        s.clusterId,
        s.reason,
        s.evidenceFingerprint,
        s.subjectType ?? 'incident',
      ],
    );
    // 同一个任务的重试（租约过期后重新认领）从头开始：清掉上一次尝试的调用记录
    await this.pool.query('DELETE FROM worker.llm_calls WHERE run_id = $1', [s.runId]);
    await this.pool.query('DELETE FROM worker.tool_calls WHERE run_id = $1', [s.runId]);
    await this.pool.query('DELETE FROM worker.evidence_snapshots WHERE run_id = $1', [s.runId]);
    await this.pool.query('DELETE FROM worker.research_manifests WHERE run_id = $1', [s.runId]);
  }

  async step(runId: string, state: ResearchState): Promise<void> {
    await this.pool.query('UPDATE worker.research_runs SET state = $2 WHERE run_id = $1', [runId, state]);
  }

  async llmCall(r: LlmCallRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker.llm_calls (run_id, seq, phase, route_id, model, prompt_hash, outcome, repair_step, error_kind, http_status,
         input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, estimated_input_tokens, cost, duration_ms, bytes,
         redaction_hits, categories, fingerprint, request_redacted, response_redacted, note, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        r.runId,
        r.seq,
        r.phase,
        r.routeId,
        r.model,
        r.promptHash,
        r.outcome,
        r.repairStep,
        r.errorKind,
        r.httpStatus,
        r.usage.input_tokens,
        r.usage.cached_input_tokens,
        r.usage.output_tokens,
        r.usage.reasoning_tokens,
        r.estimatedInput,
        r.cost,
        r.durationMs,
        r.bytes,
        JSON.stringify(r.redactionHits),
        r.categories,
        r.fingerprint,
        r.request,
        r.response,
        r.note,
        r.at,
      ],
    );
  }

  async toolCall(runId: string, r: ToolCallRecord): Promise<void> {
    await this.pool.query(
      'INSERT INTO worker.tool_calls (run_id, seq, record) VALUES ($1, $2, $3) ON CONFLICT (run_id, seq) DO UPDATE SET record = excluded.record',
      [runId, r.seq, JSON.stringify(r)],
    );
  }

  /** 结束一次研判：结果、检查卡、清单、每日用量与 outbox 事件在同一个事务里 */
  async finishRun(f: RunFinish): Promise<void> {
    await tx(this.pool, async (c) => {
      await c.query(
        `UPDATE worker.research_runs SET state = $2, stop_reason = $3, output = $4, error = $5, still_consistent = $6,
           disposition = $7, conclusion_level = $8, root_component = $9, summary = $10,
           estimated_input_tokens = $11, input_tokens = $12, output_tokens = $13, cost = $14, currency = $15, steps = $16, finished_at = now()
         WHERE run_id = $1`,
        [
          f.runId,
          f.state,
          f.stopReason,
          f.output ? JSON.stringify(f.output) : null,
          f.error ? JSON.stringify(f.error) : null,
          f.stillConsistent,
          f.output?.disposition ?? null,
          f.output?.conclusion.level ?? null,
          f.output?.conclusion.root_component ?? null,
          f.output?.summary ?? null,
          f.estimatedInput,
          f.input,
          f.output_tokens,
          f.cost,
          f.currency,
          JSON.stringify(f.steps),
        ],
      );
      for (const k of f.checkCards) {
        await c.query(
          'INSERT INTO worker.evidence_snapshots (run_id, ref, hypothesis_id, judged_by, result) VALUES ($1, $2, $3, $4, $5)',
          [f.runId, k.ref, k.hypothesisId, k.judgedBy, JSON.stringify(k.result)],
        );
      }
      if (f.manifest) {
        await c.query('INSERT INTO worker.research_manifests (run_id, manifest) VALUES ($1, $2)', [
          f.runId,
          JSON.stringify(f.manifest),
        ]);
      }
      await c.query(USAGE_SQL, [f.input + f.output_tokens, f.cost]);
      await c.query(PURPOSE_USAGE_SQL, ['research', f.input + f.output_tokens, f.cost]);
      await appendEvents(c, 'worker', 'worker', CONTRACT_VERSION, f.events);
    });
  }

  /** 结束一次目标运行：结果、检查卡与每日用量（合计与 optimization 用途）在同一个事务里 */
  async finishGoalRun(f: GoalRunFinish): Promise<void> {
    await tx(this.pool, async (c) => {
      await c.query(
        `UPDATE worker.research_runs SET state = $2, stop_reason = $3, output = $4, error = $5, summary = $6,
           input_tokens = $7, output_tokens = $8, cost = $9, currency = $10, steps = $11, finished_at = now()
         WHERE run_id = $1`,
        [
          f.runId,
          f.state,
          f.stopReason,
          f.output ? JSON.stringify(f.output) : null,
          f.error ? JSON.stringify(f.error) : null,
          f.output?.summary ?? null,
          f.input,
          f.output_tokens,
          f.cost,
          f.currency,
          JSON.stringify(f.steps),
        ],
      );
      for (const k of f.checkCards) {
        await c.query(
          'INSERT INTO worker.evidence_snapshots (run_id, ref, hypothesis_id, judged_by, result) VALUES ($1, $2, $3, $4, $5)',
          [f.runId, k.ref, k.hypothesisId, k.judgedBy, JSON.stringify(k.result)],
        );
      }
      await c.query(USAGE_SQL, [f.input + f.output_tokens, f.cost]);
      await c.query(PURPOSE_USAGE_SQL, ['optimization', f.input + f.output_tokens, f.cost]);
    });
  }

  /** 当日（UTC）的 token 用量：不给出用途时为全部用途的合计 */
  async dailyTokens(purpose?: UsagePurpose): Promise<number> {
    const r = purpose
      ? await this.pool.query<{ tokens: number }>(
          "SELECT tokens FROM worker.daily_usage_purpose WHERE day = (now() AT TIME ZONE 'UTC')::date AND purpose = $1",
          [purpose],
        )
      : await this.pool.query<{ tokens: number }>(
          "SELECT tokens FROM worker.daily_usage WHERE day = (now() AT TIME ZONE 'UTC')::date",
        );
    return Number(r.rows[0]?.tokens ?? 0);
  }

  /** 同一事件最近一次完成的研判（指纹门控与增量研判） */
  async previous(incidentId: string): Promise<PreviousRun | null> {
    const r = await this.pool.query<{
      run_id: string;
      evidence_fingerprint: string;
      incident_version: number;
      finished_at: Date;
      output: ResearchOutput;
    }>(
      `SELECT run_id, evidence_fingerprint, incident_version, finished_at, output FROM worker.research_runs
        WHERE incident_id = $1 AND subject_type = 'incident' AND state = 'completed' AND output IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`,
      [incidentId],
    );
    const row = r.rows[0];
    if (!row) {
      return null;
    }
    const cards = await this.pool.query<{ result: EvidenceResult }>(
      'SELECT result FROM worker.evidence_snapshots WHERE run_id = $1 ORDER BY ref',
      [row.run_id],
    );
    return {
      runId: row.run_id,
      evidenceFingerprint: row.evidence_fingerprint,
      incidentVersion: row.incident_version,
      finishedAt: row.finished_at.toISOString(),
      output: row.output,
      checkCards: cards.rows.map((x) => x.result),
    };
  }

  async routeStates(): Promise<Map<string, RouteStateRow>> {
    const r = await this.pool.query<{
      route_id: string;
      profile: DialectProfile | null;
      calibration: Calibration | null;
      fingerprint: string | null;
    }>('SELECT route_id, profile, calibration, fingerprint FROM worker.route_state');
    return new Map(
      r.rows.map((x) => [x.route_id, { profile: x.profile, calibration: x.calibration, fingerprint: x.fingerprint }]),
    );
  }

  async saveCalibration(c: Calibration): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker.route_state (route_id, calibration) VALUES ($1, $2)
       ON CONFLICT (route_id) DO UPDATE SET calibration = excluded.calibration, updated_at = now()`,
      [c.routeId, JSON.stringify(c)],
    );
  }

  async saveFingerprint(routeId: string, fingerprint: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker.route_state (route_id, fingerprint, fingerprint_changed_at) VALUES ($1, $2, now())
       ON CONFLICT (route_id) DO UPDATE SET fingerprint = excluded.fingerprint, fingerprint_changed_at = now(), updated_at = now()`,
      [routeId, fingerprint],
    );
  }

  async saveProbe(routeId: string, profile: DialectProfile, probe: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO worker.route_state (route_id, profile, probe) VALUES ($1, $2, $3)
       ON CONFLICT (route_id) DO UPDATE SET profile = excluded.profile, probe = excluded.probe, updated_at = now()`,
      [routeId, JSON.stringify(profile), JSON.stringify(probe)],
    );
  }

  /** 研判运行明细（契约 ResearchRun，证据卡中阶段 A 的部分由 server 合并） */
  async runDetail(runId: string): Promise<Record<string, unknown> | null> {
    const r = await this.pool.query<{
      run_id: string;
      incident_id: string;
      incident_version: number;
      reason: string;
      state: string;
      disposition: string | null;
      conclusion_level: string | null;
      root_component: string | null;
      summary: string | null;
      started_at: Date;
      finished_at: Date | null;
      stop_reason: string | null;
      steps: unknown[];
      output: ResearchOutput | null;
      error: { kind: string; message: string } | null;
      estimated_input_tokens: number;
      input_tokens: number;
      output_tokens: number;
      cost: number;
      currency: string;
    }>('SELECT * FROM worker.research_runs WHERE run_id = $1', [runId]);
    const row = r.rows[0];
    if (!row) {
      return null;
    }
    const calls = await this.pool.query<{
      seq: number;
      phase: string;
      route_id: string;
      model: string;
      prompt_hash: string;
      outcome: string;
      repair_step: string | null;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      cost: number;
      duration_ms: number;
      redaction_hits: Record<string, number>;
      at: Date;
    }>('SELECT * FROM worker.llm_calls WHERE run_id = $1 ORDER BY seq', [runId]);
    const tools = await this.pool.query<{ record: ToolCallRecord }>(
      'SELECT record FROM worker.tool_calls WHERE run_id = $1 ORDER BY seq',
      [runId],
    );
    const cards = await this.pool.query<{ result: EvidenceResult }>(
      'SELECT result FROM worker.evidence_snapshots WHERE run_id = $1 ORDER BY ref',
      [runId],
    );
    return {
      run_id: row.run_id,
      incident_id: row.incident_id,
      incident_version: row.incident_version,
      reason: row.reason,
      state: row.state,
      disposition: row.disposition,
      conclusion_level: row.conclusion_level,
      root_component: row.root_component,
      summary: row.summary,
      started_at: row.started_at.toISOString(),
      finished_at: row.finished_at?.toISOString() ?? null,
      stop_reason: row.stop_reason,
      steps: row.steps,
      evidence: cards.rows.map((x) => x.result),
      output: row.output,
      llm_calls: calls.rows.map((c) => ({
        seq: c.seq,
        phase: c.phase,
        route_id: c.route_id,
        model: c.model,
        prompt_hash: c.prompt_hash,
        outcome: c.outcome,
        repair_step: c.repair_step,
        usage: {
          input_tokens: c.input_tokens,
          cached_input_tokens: c.cached_input_tokens,
          output_tokens: c.output_tokens,
          reasoning_tokens: c.reasoning_tokens,
        },
        cost: c.cost,
        duration_ms: c.duration_ms,
        redaction_hits: Object.values(c.redaction_hits).reduce((a, b) => a + b, 0),
        at: c.at.toISOString(),
      })),
      tool_calls: tools.rows.map((t) => t.record),
      budget: {
        estimated_input_tokens: row.estimated_input_tokens,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cost: row.cost,
        currency: row.currency,
      },
      error: row.error,
    };
  }

  async manifest(runId: string): Promise<ResearchManifest | null> {
    const r = await this.pool.query<{ manifest: ResearchManifest }>(
      'SELECT manifest FROM worker.research_manifests WHERE run_id = $1',
      [runId],
    );
    return r.rows[0]?.manifest ?? null;
  }

  /** 最近 7 天的 P0 研判指标：结论中仍有未检验竞争假设的比例、零检查比例 */
  async weeklyRatios(): Promise<{ untested: number | null; zeroTool: number | null }> {
    const r = await this.pool.query<{ total: number; untested: number; zero: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE (output->'conclusion'->'consistency'->>'competitor_tested') = 'false'
                                 AND output->'conclusion'->>'hypothesis_id' IS NOT NULL
                                 AND jsonb_array_length(output->'hypotheses') > 1)::int AS untested,
              count(*) FILTER (WHERE jsonb_array_length(output->'next_checks') = 0)::int AS zero
         FROM worker.research_runs WHERE subject_type = 'incident' AND state = 'completed' AND output IS NOT NULL
          AND NOT still_consistent
          AND finished_at > now() - interval '7 days'`,
    );
    const row = r.rows[0] as { total: number; untested: number; zero: number };
    return row.total
      ? { untested: row.untested / row.total, zeroTool: row.zero / row.total }
      : { untested: null, zeroTool: null };
  }
}
