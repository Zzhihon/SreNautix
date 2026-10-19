import type { Incident, StageAReport } from '@srenautix/contract';
import { observeFingerprint, type FingerprintState } from '@srenautix/core';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import { alertsById } from '../ingest/store.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import type { ProposalService } from '../proposals/service.js';
import { appendEvents } from '../store/outbox.js';
import { tx } from '../store/pool.js';
import type { EvidenceRunner, RuleProposer } from './ports.js';
import { buildReport, verdictFingerprint } from './report.js';

export const SCHEMA_VERSION = '2.2.0';

/** 阶段 A 的证据卡整体期限：首次触发到发出 p95 ≤60 秒，留出接入与投递的时间。 */
export const EVIDENCE_DEADLINE_MS = 40_000;

export interface StageAOutcome {
  report: StageAReport;
  /** 证据指纹（带迟滞）在本次报告中发生了变化。 */
  fingerprintChanged: boolean;
}

/**
 * 阶段 A 独立通道（DESIGN §7.1）：不调用模型，不经过 worker 的队列。事件创建或版本变化后立即执行证据卡、
 * 评估规则提议、做确定性的处置判断，写入报告并发布 stage_a.reported。
 */
export class StageAService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly evidence: EvidenceRunner,
    private readonly rules: RuleProposer,
    private readonly proposals: ProposalService,
    private readonly metrics: ServerMetrics,
  ) {}

  async run(inc: Incident): Promise<StageAOutcome> {
    const memberIds = inc.members.filter((m) => m.left_version === null).map((m) => m.alert_id);
    const alerts = await alertsById(this.pool, memberIds);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('阶段 A 证据卡超过期限')), EVIDENCE_DEADLINE_MS);
    let cards;
    try {
      cards = await this.evidence.run(inc, alerts, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    const observed = verdictFingerprint(cards);
    const st = await this.pool.query<{ fingerprint_state: FingerprintState | null }>(
      'SELECT fingerprint_state FROM server.incidents WHERE incident_id = $1',
      [inc.incident_id],
    );
    const fp = observeFingerprint(st.rows[0]?.fingerprint_state ?? null, observed);
    const excludedBy = this.rules.excluded(inc, alerts);
    const now = await this.pool.query<{ now: Date }>('SELECT now() AS now');
    const base = {
      incident: inc,
      alerts,
      cards,
      excludedBy,
      runbooks: this.evidence.runbooks(inc),
      degraded: false,
      fingerprint: fp.state.current,
      now: (now.rows[0] as { now: Date }).now,
    };
    let report = buildReport({ ...base, ruleActions: 0, ruleProposalIds: [] });
    await tx(this.pool, async (c) => {
      await c.query('UPDATE server.incidents SET fingerprint_state = $2 WHERE incident_id = $1', [
        inc.incident_id,
        JSON.stringify(fp.state),
      ]);
      await c.query(
        `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body, first_firing_at, rendered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (incident_id, incident_version) DO UPDATE SET report_id = excluded.report_id, disposition = excluded.disposition,
           evidence_fingerprint = excluded.evidence_fingerprint, degraded = excluded.degraded, body = excluded.body, rendered_at = excluded.rendered_at`,
        [
          report.report_id,
          inc.incident_id,
          inc.incident_version,
          report.disposition,
          report.evidence_fingerprint,
          false,
          JSON.stringify(report),
          inc.first_firing_at,
          report.rendered_at,
        ],
      );
    });
    // 规则提议绑定到刚写入的报告（事件版本、根因、证据指纹）
    const ids: string[] = [];
    let actionable = 0;
    // 提议必须绑定到一个根因组件；没有根因的事件不出规则提议
    const root = inc.root.component;
    if (!inc.suppressed && !excludedBy && root !== null) {
      for (const hit of this.rules.evaluate(inc, cards)) {
        try {
          const r = await this.proposals.create(
            { source: 'rule', callerId: `${hit.pack}/${hit.ruleId}` },
            {
              incident_id: inc.incident_id,
              binding: {
                incident_version: inc.incident_version,
                root_component: root,
                evidence_fingerprint: report.evidence_fingerprint,
              },
              action: hit.action,
              params: hit.params,
              research_run_id: null,
              rule_id: `${hit.pack}/${hit.ruleId}`,
              hypothesis_id: null,
              evidence_refs: [],
              expected_effect: (hit.expectedEffect?.['zh-CN'] ?? hit.title['zh-CN'] ?? hit.title.en ?? '').slice(
                0,
                300,
              ),
            },
          );
          ids.push(r.proposal.proposal_id);
          if (r.proposal.state === 'awaiting_approval' || r.proposal.state === 'approved') {
            actionable++;
          }
        } catch (e) {
          if (e instanceof HttpError && e.status === 409) {
            // 事件在报告写入后又变了版本：下一次报告重新评估
            logger.info('规则提议的绑定已过期', { incident_id: inc.incident_id, rule: hit.ruleId });
            continue;
          }
          throw e;
        }
      }
    }
    report = {
      ...buildReport({ ...base, ruleActions: actionable, ruleProposalIds: ids }),
      report_id: report.report_id,
    };
    await tx(this.pool, async (c) => {
      await c.query('UPDATE server.stage_a_reports SET disposition = $2, body = $3 WHERE report_id = $1', [
        report.report_id,
        report.disposition,
        JSON.stringify(report),
      ]);
      await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
        {
          type: 'stage_a.reported',
          clusterId: inc.cluster_id,
          payload: {
            incident_id: inc.incident_id,
            incident_version: inc.incident_version,
            report_id: report.report_id,
            disposition: report.disposition,
            evidence_fingerprint: report.evidence_fingerprint,
            degraded: false,
          },
        },
      ]);
    });
    this.metrics.stageARuns.inc({ disposition: report.disposition, degraded: 'false' });
    return { report, fingerprintChanged: fp.changed };
  }
}
