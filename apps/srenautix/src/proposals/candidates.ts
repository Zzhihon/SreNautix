import { randomUUID } from 'node:crypto';
import type { Feedback, FeedbackReasonCode, HubComponents } from '@srenautix/contract';
import type pg from 'pg';
import { badRequest, conflict, notFound } from '../api/errors.js';
import { appendAudit } from '../store/audit.js';
import { tx, type Queryable } from '../store/pool.js';

// 评测候选（ADR 0175）：反馈、关闭的自愈 PR、以 not planned 关闭的事件 issue 与控制台"加入评测"生成候选，
// 同一事件同一来源只生成一个。管理员确认（选定类型、根因、处置）或放弃；确认的候选由命令行导出为标注。

export type EvalCandidate = HubComponents['schemas']['EvalCandidate'];
export type EvalCandidateConfirm = HubComponents['schemas']['EvalCandidateConfirm'];
export type CandidateSource = EvalCandidate['source'];
export type CandidateState = EvalCandidate['state'];

/** 生成 benign 候选的反馈原因码：事件本身不需要处理，健康场景应当沉默 */
export const BENIGN_REASON_CODES: ReadonlySet<FeedbackReasonCode> = new Set<FeedbackReasonCode>([
  'false_positive',
  'not_actionable',
  'known_issue',
  'planned_change',
  'transient_self_resolved',
  'worse_than_baseline',
]);

/**
 * 反馈生成候选的规则：benign 原因码生成 benign 候选；wrong_fix 与两种关闭（pr_closed、issue_not_planned）生成候选，
 * 类型留给人确认（关闭的 PR 可能是良性告警，也可能是真实事件的错误修复）。其余反馈不生成，返回 null
 */
export function candidateRule(
  fb: Pick<Feedback, 'reason_code' | 'implicit'>,
): { source: CandidateSource; suggested: EvalCandidate['suggested_type'] } | null {
  if (fb.implicit === 'pr_closed' || fb.implicit === 'issue_not_planned') {
    return { source: fb.implicit, suggested: null };
  }
  if (fb.reason_code === null) {
    return null;
  }
  if (BENIGN_REASON_CODES.has(fb.reason_code)) {
    return { source: 'feedback', suggested: 'benign' };
  }
  if (fb.reason_code === 'wrong_fix') {
    return { source: 'feedback', suggested: null };
  }
  return null;
}

/** 确认时选定的标准答案与标注文件相同的约束（eval/labels.ts） */
export function checkConfirm(b: EvalCandidateConfirm): void {
  if (b.type === 'incident' && !b.roots.length) {
    throw badRequest('incident 必须给出至少一个根因组件');
  }
  if (b.type === 'benign' && (b.roots.length || b.disposition !== 'ignore')) {
    throw badRequest('benign 的根因为空、处置为 ignore');
  }
  if (b.type === 'abstain' && (b.roots.length || b.disposition !== null)) {
    throw badRequest('abstain 的根因为空、处置为 null');
  }
}

interface Row {
  candidate_id: string;
  cluster_id: string;
  incident_id: string;
  incident_label: string;
  incident_version: number;
  research_run_id: string | null;
  source: CandidateSource;
  source_ref: string;
  reason_code: FeedbackReasonCode | null;
  reason: string | null;
  suggested_type: EvalCandidate['suggested_type'];
  suite: string | null;
  state: CandidateState;
  label: EvalCandidateConfirm | null;
  decided_by: string | null;
  decided_at: Date | null;
  drop_reason: string | null;
  created_at: Date;
}

const SELECT = `SELECT c.*, i.label AS incident_label FROM server.eval_candidates c
  JOIN server.incidents i ON i.incident_id = c.incident_id`;

function toCandidate(r: Row): EvalCandidate {
  return {
    candidate_id: r.candidate_id,
    cluster_id: r.cluster_id,
    incident_id: r.incident_id,
    incident_label: r.incident_label,
    incident_version: r.incident_version,
    research_run_id: r.research_run_id,
    source: r.source,
    source_ref: r.source_ref,
    reason_code: r.reason_code,
    reason: r.reason,
    suggested_type: r.suggested_type,
    suite: r.suite,
    state: r.state,
    label: r.label,
    decided_by: r.decided_by,
    decided_at: r.decided_at ? r.decided_at.toISOString() : null,
    drop_reason: r.drop_reason,
    created_at: r.created_at.toISOString(),
  };
}

export interface NewCandidate {
  clusterId: string;
  incidentId: string;
  incidentVersion: number;
  researchRunId: string | null;
  source: CandidateSource;
  sourceRef: string;
  reasonCode: FeedbackReasonCode | null;
  reason: string | null;
  suggested: EvalCandidate['suggested_type'];
  suite: string | null;
}

/** 写入一个候选；同一事件同一来源已有候选时不写，返回 null */
export async function insertCandidate(c: Queryable, n: NewCandidate): Promise<string | null> {
  const id = randomUUID();
  const r = await c.query(
    `INSERT INTO server.eval_candidates (candidate_id, cluster_id, incident_id, incident_version, research_run_id, source,
       source_ref, reason_code, reason, suggested_type, suite)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (incident_id, source) DO NOTHING`,
    [
      id,
      n.clusterId,
      n.incidentId,
      n.incidentVersion,
      n.researchRunId,
      n.source,
      n.sourceRef,
      n.reasonCode,
      n.reason,
      n.suggested,
      n.suite,
    ],
  );
  return (r.rowCount ?? 0) > 0 ? id : null;
}

/**
 * 反馈之后按规则生成候选（与反馈同一事务）。source_ref：feedback 为 feedback_id，两种关闭为 PR 或 issue 的链接（ref）
 */
export async function candidateFromFeedback(
  c: Queryable,
  fb: Feedback,
  clusterId: string,
  ref: string | null = null,
): Promise<string | null> {
  const rule = candidateRule(fb);
  if (!rule) {
    return null;
  }
  if (rule.source !== 'feedback' && ref === null) {
    throw new Error(`隐式反馈 ${fb.implicit} 生成候选需要 PR 或 issue 的链接`);
  }
  return insertCandidate(c, {
    clusterId,
    incidentId: fb.incident_id,
    incidentVersion: fb.incident_version,
    researchRunId: fb.research_run_id,
    source: rule.source,
    sourceRef: rule.source === 'feedback' ? fb.feedback_id : (ref as string),
    reasonCode: fb.reason_code,
    reason: fb.reason,
    suggested: rule.suggested,
    suite: null,
  });
}

export class EvalCandidates {
  constructor(private readonly pool: pg.Pool) {}

  async list(state: CandidateState | 'all', limit: number): Promise<EvalCandidate[]> {
    const r = await this.pool.query<Row>(
      `${SELECT} WHERE ($1 = 'all' OR c.state = $1) ORDER BY c.created_at DESC, c.candidate_id LIMIT $2`,
      [state, limit],
    );
    return r.rows.map(toCandidate);
  }

  async get(id: string): Promise<EvalCandidate | null> {
    const r = await this.pool.query<Row>(`${SELECT} WHERE c.candidate_id = $1`, [id]);
    return r.rows[0] ? toCandidate(r.rows[0]) : null;
  }

  /**
   * 控制台的"加入评测"（POST /v1/runs/{run_id}/eval-case）：以研判所属事件生成来源 console 的候选。研判取 server 的
   * 研判镜像，还没有镜像（排队中或刚认领）时取研判队列。研判不存在时 404；同一事件已有控制台来源的候选时 409
   */
  async promote(
    principalId: string,
    runId: string,
    type: 'incident' | 'benign' | 'abstain',
    suite: string,
  ): Promise<{ case_id: string; snapshot_status: 'queued' }> {
    return tx(this.pool, async (c) => {
      const run = await c.query<{ incident_id: string; incident_version: number; cluster_id: string }>(
        `SELECT r.incident_id, r.incident_version, i.cluster_id
           FROM (SELECT run_id, incident_id, incident_version, 0 AS pri FROM server.research_runs
                 UNION ALL SELECT run_id, incident_id, incident_version, 1 FROM server.research_queue) r
           JOIN server.incidents i ON i.incident_id = r.incident_id WHERE r.run_id::text = $1
          ORDER BY r.pri LIMIT 1`,
        [runId],
      );
      const x = run.rows[0];
      if (!x) {
        throw notFound(`没有研判 ${runId}`);
      }
      const id = await insertCandidate(c, {
        clusterId: x.cluster_id,
        incidentId: x.incident_id,
        incidentVersion: x.incident_version,
        researchRunId: runId,
        source: 'console',
        sourceRef: runId,
        reasonCode: null,
        reason: null,
        suggested: type,
        suite,
      });
      if (!id) {
        const prev = await c.query<{ candidate_id: string; state: string }>(
          "SELECT candidate_id, state FROM server.eval_candidates WHERE incident_id = $1 AND source = 'console'",
          [x.incident_id],
        );
        const p = prev.rows[0] as { candidate_id: string; state: string };
        throw conflict('duplicate', `这个事件已经从控制台加入过评测：候选 ${p.candidate_id}（${p.state}）`);
      }
      await appendAudit(c, 'eval.candidate_promoted', principalId, {
        candidate_id: id,
        run_id: runId,
        incident_id: x.incident_id,
        case_type: type,
        suite,
      });
      return { case_id: id, snapshot_status: 'queued' as const };
    });
  }

  async confirm(principalId: string, id: string, body: EvalCandidateConfirm): Promise<EvalCandidate> {
    checkConfirm(body);
    return this.decide(id, async (c) => {
      await c.query(
        `UPDATE server.eval_candidates SET state = 'confirmed', label = $2, decided_by = $3, decided_at = now()
          WHERE candidate_id = $1`,
        [id, JSON.stringify(body), principalId],
      );
      await appendAudit(c, 'eval.candidate_confirmed', principalId, { candidate_id: id, label: body });
    });
  }

  async drop(principalId: string, id: string, reason: string | null): Promise<EvalCandidate> {
    return this.decide(id, async (c) => {
      await c.query(
        `UPDATE server.eval_candidates SET state = 'dropped', drop_reason = $2, decided_by = $3, decided_at = now()
          WHERE candidate_id = $1`,
        [id, reason, principalId],
      );
      await appendAudit(c, 'eval.candidate_dropped', principalId, { candidate_id: id, reason });
    });
  }

  /** 只有 pending 的候选可以确认或放弃：不存在时 404，已经处理过时 409 */
  private async decide(id: string, fn: (c: Queryable) => Promise<void>): Promise<EvalCandidate> {
    await tx(this.pool, async (c) => {
      const r = await c.query<{ state: CandidateState }>(
        'SELECT state FROM server.eval_candidates WHERE candidate_id = $1 FOR UPDATE',
        [id],
      );
      const row = r.rows[0];
      if (!row) {
        throw notFound(`没有评测候选 ${id}`);
      }
      if (row.state !== 'pending') {
        throw conflict('already_decided', `评测候选 ${id} 已经${row.state === 'confirmed' ? '确认' : '放弃'}`);
      }
      await fn(c);
    });
    return (await this.get(id)) as EvalCandidate;
  }
}
