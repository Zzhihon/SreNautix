import { randomUUID } from 'node:crypto';
import type { Channel, Feedback, FeedbackCreate, Incident } from '@srenautix/contract';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import type { ServerMetrics } from '../metrics.js';
import { appendEvents } from '../store/outbox.js';
import { tx, type Queryable } from '../store/pool.js';
import { SCHEMA_VERSION } from './service.js';

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
  principal_id: string;
  channel: Channel;
  linked: boolean;
  implicit: Feedback['implicit'];
  created_at: Date;
  stale: boolean;
}

const SELECT = `SELECT f.*, EXISTS (
    SELECT 1 FROM server.research_runs r WHERE r.incident_id = f.incident_id AND r.state = 'completed' AND r.finished_at > f.created_at
      AND r.run_id IS DISTINCT FROM f.research_run_id) AS stale
  FROM server.feedback f`;

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

/**
 * 反馈（DESIGN §11，契约 1.5.0 的语义加上处置维度）：表只追加，同一事件以最新一条为准。
 * - verdict=rejected 且 root_component=null 表示只否定结论、真实根因未知；
 * - root_component 必须来自本次研判的拓扑组件（事件组件与候选根因）；
 * - 只有已绑定账号（linked=true）的反馈进入评测标准答案；未绑定的聊天账号不能反馈（由渠道拒绝）。
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
         SELECT DISTINCT ON (incident_id) feedback_id FROM server.feedback WHERE incident_id = ANY($1::uuid[]) AND implicit IS DISTINCT FROM 'approved'
          ORDER BY incident_id, created_at DESC, feedback_id)`,
      [incidentIds],
    );
    return new Map(r.rows.map((x) => [x.incident_id, toFeedback(x)]));
  }

  async create(actor: FeedbackActor, incident: Incident, body: FeedbackCreate): Promise<Feedback> {
    if (body.verdict === null && body.disposition_verdict === null) {
      throw new HttpError(400, 'bad_request', 'verdict 与 disposition_verdict 至少填一个');
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
           disposition, mechanism, reason, principal_id, channel, linked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
          actor.principalId,
          actor.channel,
          actor.linked,
        ],
      );
      const r = await c.query<Row>(`${SELECT} WHERE f.feedback_id = $1`, [id]);
      const fb = toFeedback(r.rows[0] as Row);
      await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
        { type: 'feedback.recorded', clusterId: incident.cluster_id, payload: fb },
      ]);
      this.metrics.feedback.inc({ linked: String(actor.linked), channel: actor.channel, implicit: 'none' });
      return fb;
    });
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
      const r = await c.query<Row>(`${SELECT} WHERE f.feedback_id = $1`, [id]);
      const fb = toFeedback(r.rows[0] as Row);
      await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
        { type: 'feedback.recorded', clusterId: incident.cluster_id, payload: fb },
      ]);
      this.metrics.feedback.inc({ linked: String(actor.linked), channel: actor.channel, implicit: 'resolved_confirm' });
      return fb;
    });
  }
}
