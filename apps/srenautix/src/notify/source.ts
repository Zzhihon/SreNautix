import type { Feedback, Incident, Proposal, StageAReport } from '@srenautix/contract';
import type pg from 'pg';
import { alertsById } from '../ingest/store.js';
import type { FeedbackService } from '../proposals/feedback.js';
import type { ProposalService } from '../proposals/service.js';
import { composeMessage, laneOf, type ResearchMirror } from './compose.js';
import type { DesiredIncidentMessage, MessageSource } from './ports.js';
import { withComponentNames } from '../incident/names.js';

export interface SourceSettings {
  prefix: string;
  consoleUrl: string;
  severities: string[];
  resolvedRetentionMs: number;
}

/**
 * 期望消息的来源：已有阶段 A 报告、严重度在推送范围内、没有被 SreNautix 抑制的事件；恢复或合并后在保留期内继续编辑。
 */
export class PgMessageSource implements MessageSource {
  constructor(
    private readonly pool: pg.Pool,
    private readonly s: SourceSettings,
    private readonly proposals: ProposalService,
    private readonly feedback: FeedbackService,
  ) {}

  async desired(language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]> {
    const r = await this.pool.query<{ body: Incident; report: StageAReport }>(
      `SELECT i.body, s.body AS report FROM server.incidents i
         JOIN LATERAL (SELECT body FROM server.stage_a_reports WHERE incident_id = i.incident_id ORDER BY incident_version DESC LIMIT 1) s ON true
        WHERE i.severity = ANY($1::text[]) AND NOT i.suppressed
          AND (i.state = 'firing' OR i.updated_at > now() - make_interval(secs => $2))
        ORDER BY i.first_firing_at`,
      [this.s.severities, this.s.resolvedRetentionMs / 1000],
    );
    if (!r.rows.length) {
      return [];
    }
    const ids = r.rows.map((x) => x.body.incident_id);
    const props = await this.pool.query<{ incident_id: string; body: Proposal }>(
      'SELECT incident_id, body FROM server.proposals WHERE incident_id = ANY($1::uuid[])',
      [ids],
    );
    const runs = await this.pool.query<ResearchMirror & { incident_id: string }>(
      `SELECT DISTINCT ON (incident_id) incident_id, run_id, state, disposition, conclusion_level, root_component, output, error
         FROM server.research_runs WHERE incident_id = ANY($1::uuid[]) ORDER BY incident_id, started_at DESC`,
      [ids],
    );
    const queue = await this.pool.query<{ incident_id: string; state: string; skip_reason: string | null }>(
      `SELECT DISTINCT ON (incident_id) incident_id, state, skip_reason FROM server.research_queue
        WHERE incident_id = ANY($1::uuid[]) ORDER BY incident_id, enqueued_at DESC`,
      [ids],
    );
    const fbs: Map<string, Feedback> = await this.feedback.latest(this.pool, ids);
    const byInc = <T extends { incident_id: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of rows) {
        m.set(x.incident_id, [...(m.get(x.incident_id) ?? []), x]);
      }
      return m;
    };
    const propMap = byInc(props.rows);
    const runMap = new Map(runs.rows.map((x) => [x.incident_id, x]));
    const queueMap = new Map(queue.rows.map((x) => [x.incident_id, x]));
    const out: DesiredIncidentMessage[] = [];
    for (const { body: raw, report } of r.rows) {
      // 组件的可读名称（ADR 0101）：标题与正文优先显示名称
      const inc = await withComponentNames(this.pool, raw);
      const ps = (propMap.get(inc.incident_id) ?? []).map((x) => x.body);
      const q = queueMap.get(inc.incident_id);
      const run = runMap.get(inc.incident_id) ?? null;
      const alerts = await alertsById(
        this.pool,
        inc.members.filter((m) => m.left_version === null).map((m) => m.alert_id),
      );
      const { message, targets } = composeMessage({
        incident: inc,
        stageA: report,
        alerts,
        research: run,
        researchPending: q?.state === 'queued' || q?.state === 'leased',
        stageAOnlyReason: q?.state === 'skipped' ? q.skip_reason : null,
        proposals: ps,
        feedback: fbs.get(inc.incident_id) ?? null,
        prefix: this.s.prefix,
        consoleUrl: this.s.consoleUrl,
        language,
      });
      out.push({
        incidentId: inc.incident_id,
        clusterId: inc.cluster_id,
        label: inc.label,
        severity: inc.severity,
        state: inc.state,
        firstFiringAt: new Date(inc.first_firing_at),
        endedAt: inc.ended_at ? new Date(inc.ended_at) : null,
        lane: laneOf(inc, ps),
        message,
        targets,
        language,
      });
    }
    return out;
  }

  async delivered(_incidentId: string, proposalIds: string[], at: Date): Promise<void> {
    await this.proposals.delivered(proposalIds, at);
  }
}
