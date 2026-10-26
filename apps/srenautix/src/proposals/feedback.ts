import { randomUUID } from 'node:crypto';
import type {
  Channel,
  Feedback,
  FeedbackChannel,
  FeedbackCreate,
  FeedbackReasonCode,
  Incident,
} from '@srenautix/contract';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import type { ServerMetrics } from '../metrics.js';
import { appendEvents } from '../store/outbox.js';
import { tx, type Queryable } from '../store/pool.js';
import { candidateFromFeedback } from './candidates.js';
import { SCHEMA_VERSION } from './service.js';

/** 反馈的原因码（契约 FeedbackReasonCode，ADR 0174），聊天渠道的选择按与表单按这个顺序列出 */
export const FEEDBACK_REASON_CODES = [
  'false_positive',
  'not_actionable',
  'known_issue',
  'planned_change',
  'transient_self_resolved',
  'external_upstream',
  'duplicate',
  'poor_wording',
  'wrong_fix',
  'worse_than_baseline',
  'other',
] as const satisfies readonly FeedbackReasonCode[];

export function isReasonCode(v: unknown): v is FeedbackReasonCode {
  return typeof v === 'string' && (FEEDBACK_REASON_CODES as readonly string[]).includes(v);
}

interface Row {
  feedback_id: string;
  incident_id: string;
  incident_version: number;
  research_run_id: string | null;
  verdict: Feedback['verdict'];
  root_component: string | null;
  disposition_verdict: Feedback['disposition_verdict'];
  disposition: Feedback['disposition'];
  mechanism: string | null;
  reason: string | null;
  reason_code: Feedback['reason_code'];
  principal_id: string;
  channel: FeedbackChannel;
  linked: boolean;
  implicit: Feedback['implicit'];
  created_at: Date;
  stale: boolean;
}

const SELECT = `SELECT f.*, EXISTS (
    SELECT 1 FROM server.research_runs r WHERE r.incident_id = f.incident_id AND r.state = 'completed' AND r.finished_at > f.created_at
      AND r.run_id IS DISTINCT FROM f.research_run_id) AS stale
  FROM server.feedback f`;

/** 读回一条反馈（写入后在同一事务里读） */
export async function feedbackById(c: Queryable, id: string): Promise<Feedback> {
  const r = await c.query<Row>(`${SELECT} WHERE f.feedback_id = $1`, [id]);
  return toFeedback(r.rows[0] as Row);
}

function toFeedback(r: Row): Feedback {
  return {
    feedback_id: r.feedback_id,
    incident_id: r.incident_id,
    incident_version: r.incident_version,
    research_run_id: r.research_run_id,
    verdict: r.verdict,
    root_component: r.root_component,
    disposition_verdict: r.disposition_verdict,
    disposition: r.disposition,
    mechanism: r.mechanism,
    reason: r.reason,
    reason_code: r.reason_code,
    principal_id: r.principal_id,
    channel: r.channel,
    linked: r.linked,
    implicit: r.implicit,
    stale: r.stale,
    created_at: r.created_at.toISOString(),
  };
}

export interface FeedbackActor {
  principalId: string;
  channel: Channel;
  linked: boolean;
}

/** 关闭跟踪读到的一次关闭（ADR 0174）：自愈 PR 关闭且没有合并，或事件 issue 以 not planned 关闭 */
export interface Closure {
  kind: 'pr_closed' | 'issue_not_planned';
  incidentId: string;
  researchRunId: string | null;
  /** 关闭者的 GitHub 登录名；读不到时为 null */
  closedBy: string | null;
  /** PR 关闭之前的最后一条评论；issue 为 null */
  reason: string | null;
  /** PR 或 issue 的链接，作为评测候选的来源引用 */
  url: string;
}

/**
 * 反馈（DESIGN §11，契约 1.5.0 的语义加上处置维度）：表只追加，同一事件以最新一条为准。
 * - verdict=rejected 且 root_component=null 表示只否定结论、真实根因未知；
 * - root_component 必须来自本次研判的拓扑组件（事件组件与候选根因）；
 * - reason_code 是结构化的原因（ADR 0174），只有原因码、不评价根因与处置的反馈同样合法（并行期的"比旧系统差"）；
 *   带某些原因码的反馈在同一事务里生成评测候选（ADR 0175）；
 * - 只有已绑定账号（linked=true）的反馈进入评测标准答案；未绑定的聊天账号不能反馈（由渠道拒绝）。
 * - 最新一条不算批准与两种关闭（pr_closed、issue_not_planned）：它们不是对结论的评价。
 */
export class FeedbackService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly metrics: ServerMetrics,
  ) {}

  async list(incidentId: string): Promise<Feedback[]> {
    const r = await this.pool.query<Row>(
      `${SELECT} WHERE f.incident_id = $1 ORDER BY f.created_at DESC, f.feedback_id`,
      [incidentId],
    );
    return r.rows.map(toFeedback);
  }

  async latest(db: pg.Pool | Queryable, incidentIds: string[]): Promise<Map<string, Feedback>> {
    if (!incidentIds.length) {
      return new Map();
    }
    const r = await db.query<Row>(
      `${SELECT} WHERE f.feedback_id IN (
         SELECT DISTINCT ON (incident_id) feedback_id FROM server.feedback WHERE incident_id = ANY($1::uuid[])
            AND (implicit IS NULL OR implicit NOT IN ('approved', 'pr_closed', 'issue_not_planned'))
          ORDER BY incident_id, created_at DESC, feedback_id)`,
      [incidentIds],
    );
    return new Map(r.rows.map((x) => [x.incident_id, toFeedback(x)]));
  }

  async create(actor: FeedbackActor, incident: Incident, body: FeedbackCreate): Promise<Feedback> {
    const reasonCode = body.reason_code ?? null;
    if (body.verdict === null && body.disposition_verdict === null && reasonCode === null) {
      throw new HttpError(400, 'bad_request', 'verdict、disposition_verdict 与 reason_code 至少填一个');
    }
    if (
      body.verdict === 'confirmed' &&
      body.root_component !== null &&
      body.root_component !== incident.root.component
    ) {
      throw new HttpError(400, 'bad_request', 'verdict=confirmed 时 root_component 必须为空或等于结论的根因');
    }
    if (body.root_component !== null) {
      const allowed = new Set([...incident.components, ...incident.candidates.map((c) => c.component)]);
      if (body.research_run_id) {
        const run = await this.pool.query<{ output: { hypotheses?: Array<{ root_component: string }> } | null }>(
          'SELECT output FROM server.research_runs WHERE run_id = $1 AND incident_id = $2',
          [body.research_run_id, incident.incident_id],
        );
        if (!run.rows[0]) {
          throw new HttpError(400, 'bad_request', `研判 ${body.research_run_id} 不属于这个事件`);
        }
        for (const h of run.rows[0].output?.hypotheses ?? []) {
          allowed.add(h.root_component);
        }
      }
      if (!allowed.has(body.root_component)) {
        throw new HttpError(400, 'bad_request', `根因组件 ${body.root_component} 不在本次研判的拓扑组件中`);
      }
    }
    if (body.disposition_verdict === 'rejected' && body.disposition === null) {
      throw new HttpError(400, 'bad_request', 'disposition_verdict=rejected 时必须给出正确的处置判断');
    }
    return tx(this.pool, async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO server.feedback (feedback_id, incident_id, incident_version, research_run_id, verdict, root_component, disposition_verdict,
           disposition, mechanism, reason, reason_code, principal_id, channel, linked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          id,
          incident.incident_id,
          incident.incident_version,
          body.research_run_id,
          body.verdict,
          body.root_component,
          body.disposition_verdict,
          body.disposition,
          body.mechanism,
          body.reason,
          reasonCode,
          actor.principalId,
          actor.channel,
          actor.linked,
        ],
      );
      const fb = await feedbackById(c, id);
      await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
        { type: 'feedback.recorded', clusterId: incident.cluster_id, payload: fb },
      ]);
      await candidateFromFeedback(c, fb, incident.cluster_id);
      this.metrics.feedback.inc({ linked: String(actor.linked), channel: actor.channel, implicit: 'none' });
      if (reasonCode !== null) {
        // 反馈的原因码按登记表的级别计入 srenautix_terminal_states_total{stage="feedback"}
        this.metrics.terminal('feedback', reasonCode);
      }
      return fb;
    });
  }

  /**
   * 关闭跟踪读到的关闭写成隐式反馈（channel=github、linked=false），并按规则生成评测候选（ADR 0174、0175）。
   * 事件版本取当前版本；事件不存在时抛出
   */
  async recordClosure(c: Queryable, x: Closure): Promise<Feedback> {
    const inc = await c.query<{ version: number; cluster_id: string }>(
      'SELECT version, cluster_id FROM server.incidents WHERE incident_id = $1',
      [x.incidentId],
    );
    const row = inc.rows[0];
    if (!row) {
      throw new Error(`关闭的 ${x.kind} ${x.url} 关联的事件 ${x.incidentId} 不存在`);
    }
    const id = randomUUID();
    await c.query(
      `INSERT INTO server.feedback (feedback_id, incident_id, incident_version, research_run_id, reason, principal_id, channel, linked, implicit)
       VALUES ($1, $2, $3, $4, $5, $6, 'github', false, $7)`,
      [
        id,
        x.incidentId,
        row.version,
        x.researchRunId,
        x.reason === null ? null : Array.from(x.reason).slice(0, 500).join(''),
        x.closedBy ? `github:${x.closedBy}` : 'github',
        x.kind,
      ],
    );
    const fb = await feedbackById(c, id);
    await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
      { type: 'feedback.recorded', clusterId: row.cluster_id, payload: fb },
    ]);
    await candidateFromFeedback(c, fb, row.cluster_id, x.url);
    this.metrics.feedback.inc({ linked: 'false', channel: 'github', implicit: x.kind });
    return fb;
  }

  /** 事件恢复时消息上的一键确认（隐式反馈 resolved_confirm）。 */
  async resolvedConfirm(actor: FeedbackActor, incident: Incident): Promise<Feedback> {
    return tx(this.pool, async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO server.feedback (feedback_id, incident_id, incident_version, principal_id, channel, linked, implicit)
         VALUES ($1, $2, $3, $4, $5, $6, 'resolved_confirm')`,
        [id, incident.incident_id, incident.incident_version, actor.principalId, actor.channel, actor.linked],
      );
      const fb = await feedbackById(c, id);
      await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
        { type: 'feedback.recorded', clusterId: incident.cluster_id, payload: fb },
      ]);
      this.metrics.feedback.inc({ linked: String(actor.linked), channel: actor.channel, implicit: 'resolved_confirm' });
      return fb;
    });
  }
}
