import type { Incident, StageAReport } from '@srenautix/contract';
import { isIgnorable, observeFingerprint, type FingerprintState } from '@srenautix/core';
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
    /** 当前加载的领域包的 pack.lock 摘要，写入报告（ADR 0107） */
    private readonly packLock: () => string | null = () => null,
    /** 重算前按当前解析规则重新解析成员告警并回写（IngestService.reresolve）；没有时不重新解析 */
    private readonly reresolve: ((clusterId: string, alertIds: readonly string[]) => Promise<string[]>) | null = null,
    /** 业务影响告警的标签条件（ADR 0163）：有触发中的 critical 业务影响告警并且有异常卡时，阶段 A 不给 ignore */
    private readonly impactLabels: Readonly<Record<string, readonly string[]>> = {},
  ) {}

  /**
   * 仍在触发、报告是用别的 pack.lock 算出来的事件（领域包增加、减少或升级之后），最早触发的在前；
   * 没有报告的事件不在其中（等事件引擎出报告）。
   */
  async stale(clusterId: string, limit: number): Promise<string[]> {
    const lock = this.packLock();
    if (lock === null) {
      return [];
    }
    const r = await this.pool.query<{ incident_id: string }>(
      `SELECT i.incident_id FROM server.incidents i
         JOIN server.stage_a_reports s ON s.incident_id = i.incident_id AND s.incident_version = i.version
        WHERE i.cluster_id = $1 AND i.state = 'firing' AND s.pack_lock IS DISTINCT FROM $2
        ORDER BY i.first_firing_at LIMIT $3`,
      [clusterId, lock, limit],
    );
    return r.rows.map((x) => x.incident_id);
  }

  /** 该事件版本的报告是否用当前的 pack.lock 算出；没有报告时为 false */
  async current(incidentId: string, version: number): Promise<boolean> {
    const lock = this.packLock();
    const r = await this.pool.query<{ pack_lock: string | null }>(
      'SELECT pack_lock FROM server.stage_a_reports WHERE incident_id = $1 AND incident_version = $2',
      [incidentId, version],
    );
    const row = r.rows[0];
    return row !== undefined && (lock === null || row.pack_lock === lock);
  }

  /**
   * 按当前领域包与拓扑重算阶段 A；只算阶段 A，不触发研判。默认重算事件的当前版本，给出 version 的事件时重算那个版本
   * （研判前刷新研判所用的版本）。
   */
  async recompute(
    incidentId: string,
    reason: 'manual' | 'pack_change' | 'before_research',
    version?: Incident,
  ): Promise<StageAOutcome> {
    const r = version
      ? { rows: [{ body: version }] }
      : await this.pool.query<{ body: Incident }>('SELECT body FROM server.incidents WHERE incident_id = $1', [
          incidentId,
        ]);
    const inc = r.rows[0]?.body;
    if (!inc) {
      throw new HttpError(404, 'not_found', '没有这个事件');
    }
    if (inc.state === 'merged') {
      throw new HttpError(409, 'merged', '事件已合并到其他事件，重算吸收它的事件');
    }
    // 升级前接入的告警（kind 没有归一、没有告警目录条目、组件是旧格式）先按当前的解析规则重新解析，
    // 阶段 A 读回写之后的告警；组件变化由事件流水线重算事件（ADR 0107）
    const reresolved = this.reresolve
      ? await this.reresolve(
          inc.cluster_id,
          inc.members.filter((m) => m.left_version === null).map((m) => m.alert_id),
        )
      : [];
    const out = await this.run(inc);
    this.metrics.stageARecomputes.inc({ reason });
    if (reresolved.length) {
      logger.info('重算前重新解析了成员告警', { incident_id: incidentId, alerts: reresolved.length });
    }
    logger.info('阶段 A 已重算', { incident_id: incidentId, version: inc.incident_version, reason });
    return out;
  }

  async run(inc: Incident): Promise<StageAOutcome> {
    const memberIds = inc.members.filter((m) => m.left_version === null).map((m) => m.alert_id);
    // 修复之前入库的 Watchdog、InfoInhibitor 与 severity=none 成员不参与阶段 A（事件引擎重算后它们离开事件）
    const alerts = (await alertsById(this.pool, memberIds)).filter((a) => !isIgnorable(a.labels));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('阶段 A 证据卡超过期限')), EVIDENCE_DEADLINE_MS);
    let run;
    try {
      run = await this.evidence.run(inc, alerts, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    const cards = run.cards;
    const observed = verdictFingerprint(cards);
    const st = await this.pool.query<{ fingerprint_state: FingerprintState | null }>(
      'SELECT fingerprint_state FROM server.incidents WHERE incident_id = $1',
      [inc.incident_id],
    );
    const fp = observeFingerprint(st.rows[0]?.fingerprint_state ?? null, observed);
    const excludedBy = this.rules.excluded(inc, alerts, run);
    const now = await this.pool.query<{ now: Date }>('SELECT now() AS now');
    const base = {
      incident: inc,
      alerts,
      cards,
      excludedBy,
      impactLabels: this.impactLabels,
      runbooks: run.runbooks,
      ...(run.required ? { required: run.required } : {}),
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
        // first_rendered_at 只在第一次写入时设置，重算不覆盖（ADR 0159）
        `INSERT INTO server.stage_a_reports (report_id, incident_id, incident_version, disposition, evidence_fingerprint, degraded, body, first_firing_at, rendered_at, pack_lock, first_rendered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9)
         ON CONFLICT (incident_id, incident_version) DO UPDATE SET report_id = excluded.report_id, disposition = excluded.disposition,
           evidence_fingerprint = excluded.evidence_fingerprint, degraded = excluded.degraded, body = excluded.body, rendered_at = excluded.rendered_at,
           pack_lock = excluded.pack_lock`,
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
          this.packLock(),
        ],
      );
      // 组件的可读名称（ADR 0101）：只更新求出了名称的组件，求不出时保留上一次的名称
      for (const [component, name] of Object.entries(run.names ?? {})) {
        await c.query(
          `INSERT INTO server.component_names (cluster_id, component, display_name, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (cluster_id, component) DO UPDATE SET display_name = excluded.display_name, updated_at = now()`,
          [inc.cluster_id, component, name],
        );
      }
    });
    // 规则提议绑定到刚写入的报告（事件版本、根因、证据指纹）
    const ids: string[] = [];
    let actionable = 0;
    // 提议必须绑定到一个根因组件；没有根因的事件不出规则提议
    const root = inc.root.component;
    if (!inc.suppressed && !excludedBy && root !== null) {
      for (const hit of this.rules.evaluate(inc, alerts, run)) {
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
