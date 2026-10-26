import { randomUUID } from 'node:crypto';
import { REASON_CODES, type Incident, type ReasonGroupCode } from '@srenautix/contract';
import type pg from 'pg';
import { writeReason } from '../incident/reasons.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { appendEvents } from '../store/outbox.js';
import { tx, type Queryable } from '../store/pool.js';

export const SCHEMA_VERSION = '2.2.0';

export type ResearchReason =
  | 'new_incident'
  | 'fingerprint_changed'
  | 'root_changed'
  | 'severity_raised'
  | 'feedback'
  | 'manual'
  | 'model_recovered'
  | 'resumed'
  | 'reopened';

/** 按新事件排队的触发原因：重开的事件（ADR 0132）与新事件同等优先，准入规则（预算、风暴、每事件上限）相同（ADR 0135） */
const NEW_INCIDENT_REASONS: ReadonlySet<ResearchReason> = new Set(['new_incident', 'reopened']);

export interface SchedulerSettings {
  slots: number;
  criticalReserved: number;
  maxRunsPerIncident: number;
  runWindowMs: number;
  stageTimeoutMs: number;
  stormActiveAlerts: number;
  stormNewIncidents: number;
  stormWindowMs: number;
  stormTopRoots: number;
  /** 每次研判最多因租约过期恢复的次数（DESIGN §15.2）。 */
  maxRecoveries: number;
}

/** 入队时跳过、只出阶段 A 的原因（server.research_queue.skip_reason），取原因码登记表的 research_skip 分组 */
export type SkipReason = ReasonGroupCode<'research_skip'>;

export type AdmissionOutcome = 'queued' | 'coalesced' | 'duplicate' | 'not_researched' | SkipReason;

const SKIP_REASONS: ReadonlySet<string> = new Set(
  REASON_CODES.filter((e) => e.groups.includes('research_skip')).map((e) => e.code),
);
const isSkip = (o: AdmissionOutcome): o is SkipReason => SKIP_REASONS.has(o);

/** worker 上报的模型路由可用情况（POST /v1/research/routes 的请求体） */
export interface RouteReport {
  worker_id: string;
  routes: Array<{ id: string; enabled: boolean; reason: string | null; message: string | null }>;
}

/** 一个 worker 上报的模型路由可用情况 */
export interface WorkerRoutes {
  workerId: string;
  at: number;
  routes: Array<{ id: string; enabled: boolean; reason: string | null; message: string | null }>;
}

/** 路由上报的有效期：worker 每分钟上报一次，超过这个时间没有上报的 worker 不再计入 */
const ROUTE_REPORT_TTL_MS = 5 * 60_000;

const SEV: Record<string, number> = { critical: 3, warning: 2, info: 1 };

/**
 * 阶段 B 的准入与队列（DESIGN §7.5、§2.4）。队列在 server 的 schema 中，worker 经 API 认领，由 server 以 SKIP LOCKED 分配。
 * - 触发唯一键 (incident_id, incident_version, reason)；同一事件排队中的旧触发被最新一次取代。
 * - 绝对上限：每个事件 6 小时内最多 3 次模型研判，在入队时执行。
 * - 风暴模式：活动告警超过 200 条，或 5 分钟内出现超过 20 个新事件；只有排名前 3 的根因进入阶段 B。
 * - 预算：当日用量 ≥80% 时 warning 只出阶段 A；≥100% 时只有 critical 进入阶段 B。
 * - 模型路由：在有效期内上报过的 worker 全部没有可用路由（出站策略禁用）时，阶段 B 不入队，只出阶段 A（ADR 0093）。
 * - 槽位：默认 4 个，其中 1 个保留给 critical；优先级为严重度 → 吸收的症状数 → 新事件优先于重研 → 等待时长。
 */
export class Scheduler {
  /** worker 上报的当日预算用量比例。 */
  budgetRatio = 0;
  /** worker 上报的主动优化用途的当日用量比例（ADR 0146 §5.3）；没有上报过时按用尽处理 */
  optimizationBudgetRatio = 1;

  /**
   * 主动优化的预算准入（ADR 0146 §5.3）：优化用途用尽，或研判用量（全部用途的合计）达到当日上限的 60% 时推迟
   */
  optimizationBudgetExhausted(): boolean {
    return this.optimizationBudgetRatio >= 1 || this.budgetRatio >= 0.6;
  }
  private storm = false;
  private routeReports = new Map<string, WorkerRoutes>();
  /** server 判定研判结束（租约过期）后调用：通知消息同步，群消息出现研判失败的说明 */
  onEnded: () => void = () => undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly s: SchedulerSettings,
    private readonly metrics: ServerMetrics,
  ) {}

  get stormMode(): boolean {
    return this.storm;
  }

  /** 记录 worker 上报的路由可用情况 */
  reportRoutes(r: WorkerRoutes): void {
    this.routeReports.set(r.workerId, r);
  }

  /** 有效期内的上报：被禁用的路由（按 id 去重）与是否有 worker 持有可用路由；没有上报时 usable 为 null（未知） */
  modelRoutes(now = Date.now()): {
    usable: boolean | null;
    disabled: Array<{ id: string; reason: string; message: string }>;
  } {
    const fresh = [...this.routeReports.values()].filter((r) => now - r.at <= ROUTE_REPORT_TTL_MS);
    if (!fresh.length) {
      return { usable: null, disabled: [] };
    }
    const disabled = new Map<string, { id: string; reason: string; message: string }>();
    for (const w of fresh) {
      for (const r of w.routes) {
        if (!r.enabled && !disabled.has(r.id)) {
          disabled.set(r.id, { id: r.id, reason: r.reason ?? 'disabled', message: r.message ?? '' });
        }
      }
    }
    return { usable: fresh.some((w) => w.routes.some((r) => r.enabled)), disabled: [...disabled.values()] };
  }

  /** 风暴判定（中心恢复后补推的积压不计入：只数 created_at 在窗口内、首次触发也在窗口内的事件）。 */
  async refreshStorm(clusterId: string): Promise<boolean> {
    const r = await this.pool.query<{ alerts: number; fresh: number }>(
      `SELECT (SELECT count(*)::int FROM server.alert_state WHERE cluster_id = $1 AND status = 'firing') AS alerts,
              (SELECT count(*)::int FROM server.incidents WHERE cluster_id = $1 AND created_at > now() - make_interval(secs => $2)
                 AND first_firing_at > now() - make_interval(secs => $2)) AS fresh`,
      [clusterId, this.s.stormWindowMs / 1000],
    );
    const row = r.rows[0] as { alerts: number; fresh: number };
    this.storm = row.alerts > this.s.stormActiveAlerts || row.fresh > this.s.stormNewIncidents;
    return this.storm;
  }

  /**
   * 入队；返回准入结果与 run_id（排队或合并时）。跳过、被取代与不进入阶段 B 是研判的终态（ADR 0172）：提交后按原因码计数，
   * 不进入阶段 B 的版本另写一条记录（同一版本一次）
   */
  async admit(inc: Incident, reason: ResearchReason): Promise<{ outcome: AdmissionOutcome; runId: string | null }> {
    const out = await tx(this.pool, async (c) => this.admitIn(c, inc, reason));
    this.metrics.researchAdmissions.inc({ outcome: out.outcome });
    if (isSkip(out.outcome)) {
      this.metrics.terminal('research', out.outcome);
    }
    if (out.superseded) {
      this.metrics.terminal('research', 'superseded', out.superseded);
    }
    if (out.recorded) {
      this.metrics.terminal('research', 'not_researched');
    }
    return { outcome: out.outcome, runId: out.runId };
  }

  private async admitIn(
    c: Queryable,
    inc: Incident,
    reason: ResearchReason,
  ): Promise<{ outcome: AdmissionOutcome; runId: string | null; superseded?: number; recorded?: boolean }> {
    if ((inc.severity !== 'critical' && inc.severity !== 'warning') || inc.suppressed || inc.state === 'merged') {
      const recorded = await writeReason(c, {
        incidentId: inc.incident_id,
        incidentVersion: inc.incident_version,
        stage: 'research',
        code: 'not_researched',
        detail:
          inc.state === 'merged'
            ? '事件已合并'
            : inc.suppressed
              ? '事件被抑制'
              : `严重度为 ${inc.severity}，只研判 critical 与 warning`,
        once: `v${inc.incident_version}`,
      });
      return { outcome: 'not_researched', runId: null, recorded };
    }
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`research:${inc.incident_id}`]);
    const dup = await c.query<{ run_id: string }>(
      'SELECT run_id FROM server.research_queue WHERE incident_id = $1 AND incident_version = $2 AND reason = $3',
      [inc.incident_id, inc.incident_version, reason],
    );
    if (dup.rows[0]) {
      return { outcome: 'duplicate', runId: dup.rows[0].run_id };
    }
    const isNew = NEW_INCIDENT_REASONS.has(reason);
    const skip = async (why: SkipReason) => {
      await c.query(
        `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, is_new, state, skip_reason, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'skipped', $7, now())`,
        [randomUUID(), inc.incident_id, inc.incident_version, reason, inc.severity, isNew, why],
      );
      return { outcome: why, runId: null };
    };
    // 没有可用的模型路由时，手动触发同样无法研判
    if (this.modelRoutes().usable === false) {
      return skip('no_model_route');
    }
    if (reason !== 'manual') {
      if (this.budgetRatio >= 1 && inc.severity !== 'critical') {
        return skip('budget');
      }
      if (this.budgetRatio >= 0.8 && inc.severity === 'warning') {
        return skip('budget');
      }
      if (this.storm && !(await this.topRoot(c, inc))) {
        return skip('storm');
      }
    }
    const used = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM server.research_queue WHERE incident_id = $1 AND state IN ('leased', 'done')
         AND enqueued_at > now() - make_interval(secs => $2)`,
      [inc.incident_id, this.s.runWindowMs / 1000],
    );
    if ((used.rows[0]?.n ?? 0) >= this.s.maxRunsPerIncident) {
      return skip('capped');
    }
    const superseded = await c.query(
      "UPDATE server.research_queue SET state = 'superseded', finished_at = now() WHERE incident_id = $1 AND state = 'queued'",
      [inc.incident_id],
    );
    const runId = randomUUID();
    const absorbed = inc.members.filter((m) => m.left_version === null && m.role === 'symptom').length;
    await c.query(
      `INSERT INTO server.research_queue (run_id, incident_id, incident_version, reason, severity, absorbed, is_new, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
      [runId, inc.incident_id, inc.incident_version, reason, inc.severity, absorbed, isNew],
    );
    await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
      {
        type: 'research.queued',
        clusterId: inc.cluster_id,
        payload: { incident_id: inc.incident_id, incident_version: inc.incident_version, reason, run_id: runId },
      },
    ]);
    const n = superseded.rowCount ?? 0;
    return { outcome: n > 0 ? 'coalesced' : 'queued', runId, superseded: n };
  }

  /** 风暴模式下只有排名前 N 的根因进入阶段 B：按严重度、吸收的症状数排名。 */
  private async topRoot(c: Queryable, inc: Incident): Promise<boolean> {
    const r = await c.query<{ incident_id: string }>(
      `SELECT incident_id FROM server.incidents WHERE cluster_id = $1 AND state = 'firing' AND NOT suppressed
        ORDER BY CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
                 jsonb_array_length(body->'members') DESC, first_firing_at
        LIMIT $2`,
      [inc.cluster_id, this.s.stormTopRoots],
    );
    return r.rows.some((x) => x.incident_id === inc.incident_id);
  }

  /**
   * worker 认领：按优先级取一个就绪任务，critical 之外的任务不能占用保留槽位。
   * 目标运行（subject_type=goal，ADR 0146 §5.5）排在全部事件任务之后，同时最多 1 个，并且只有空闲槽位不少于 2 个时才认领。
   */
  async claim(workerId: string): Promise<{
    run_id: string;
    subject_type: 'incident' | 'goal';
    incident_id: string;
    incident_version: number;
    reason: string;
    priority: number;
    lease_expires_at: string;
    deadline_at: string;
  } | null> {
    let expired = 0;
    const claimed = await tx(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['srenautix.research.claim']);
      expired = await this.reclaimExpired(c);
      const busy = await c.query<{ total: number; noncrit: number; goals: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE severity <> 'critical')::int AS noncrit,
                count(*) FILTER (WHERE subject_type = 'goal')::int AS goals
           FROM server.research_queue WHERE state = 'leased'`,
      );
      const b = busy.rows[0] as { total: number; noncrit: number; goals: number };
      if (b.total >= this.s.slots) {
        return null;
      }
      const allowNonCritical = b.noncrit < this.s.slots - this.s.criticalReserved;
      const allowGoal = allowNonCritical && b.goals === 0 && this.s.slots - b.total >= 2;
      const r = await c.query<{
        run_id: string;
        subject_type: 'incident' | 'goal';
        incident_id: string;
        incident_version: number;
        reason: string;
        severity: string;
        absorbed: number;
        is_new: boolean;
      }>(
        `SELECT run_id, subject_type, incident_id, incident_version, reason, severity, absorbed, is_new FROM server.research_queue
          WHERE state = 'queued' AND ($1 OR severity = 'critical') AND (subject_type = 'incident' OR $2)
          ORDER BY (subject_type = 'goal'), CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
            absorbed DESC, is_new DESC, enqueued_at
          LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [allowNonCritical, allowGoal],
      );
      const t = r.rows[0];
      if (!t) {
        return null;
      }
      const u = await c.query<{ lease_expires_at: Date; deadline_at: Date }>(
        `UPDATE server.research_queue SET state = 'leased', worker_id = $2, attempts = attempts + 1,
           lease_expires_at = now() + make_interval(secs => $3), deadline_at = now() + make_interval(secs => $4)
         WHERE run_id = $1 RETURNING lease_expires_at, deadline_at`,
        [t.run_id, workerId, (this.s.stageTimeoutMs * 2) / 1000, this.s.stageTimeoutMs / 1000],
      );
      const lease = u.rows[0] as { lease_expires_at: Date; deadline_at: Date };
      return {
        run_id: t.run_id,
        subject_type: t.subject_type,
        incident_id: t.incident_id,
        incident_version: t.incident_version,
        reason: t.reason,
        priority: (SEV[t.severity] ?? 0) * 1000 + t.absorbed,
        lease_expires_at: lease.lease_expires_at.toISOString(),
        deadline_at: lease.deadline_at.toISOString(),
      };
    });
    if (expired) {
      this.metrics.terminal('research', 'lease_expired', expired);
      this.onEnded();
    }
    return claimed;
  }

  /**
   * 租约过期的任务回到队列；超过恢复次数的记为结束（失败），事件任务同时更新 server 的研判镜像（state failed，
   * error.kind lease_expired，ADR 0172），群消息与时间线据此说明。返回这样结束的事件任务数
   */
  private async reclaimExpired(c: Queryable): Promise<number> {
    const r = await c.query<{
      run_id: string;
      subject_type: string;
      incident_id: string;
      incident_version: number;
      reason: string;
      enqueued_at: Date;
      attempts: number;
    }>(
      `UPDATE server.research_queue SET state = CASE WHEN attempts > $1 THEN 'done' ELSE 'queued' END,
         skip_reason = CASE WHEN attempts > $1 THEN 'lease_expired' ELSE skip_reason END,
         finished_at = CASE WHEN attempts > $1 THEN now() ELSE NULL END, worker_id = NULL, lease_expires_at = NULL
       WHERE state = 'leased' AND lease_expires_at < now()
       RETURNING run_id, subject_type, incident_id, incident_version, reason, enqueued_at, attempts`,
      [this.s.maxRecoveries],
    );
    const ended = r.rows.filter((x) => x.attempts > this.s.maxRecoveries && x.subject_type === 'incident');
    for (const x of ended) {
      const message = `租约过期 ${x.attempts} 次，超过恢复次数上限 ${this.s.maxRecoveries}`;
      // worker 之后仍发出结束事件时（例如租约过期后才完成），镜像按 worker 的结果覆盖
      await c.query(
        `INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, error, started_at, finished_at, updated_at)
         VALUES ($1, $2, $3, $4, 'failed', $5, $6, now(), now())
         ON CONFLICT (run_id) DO UPDATE SET state = 'failed', error = excluded.error, finished_at = excluded.finished_at,
           updated_at = now()
         WHERE server.research_runs.state NOT IN ('completed', 'stage_a_only', 'failed')`,
        [
          x.run_id,
          x.incident_id,
          x.incident_version,
          x.reason,
          JSON.stringify({ kind: 'lease_expired', message }),
          x.enqueued_at,
        ],
      );
      logger.error('研判任务的租约过期次数超过上限，记为失败', {
        run_id: x.run_id,
        incident_id: x.incident_id,
        attempts: x.attempts,
      });
    }
    return ended.length;
  }

  async heartbeat(runId: string, workerId: string): Promise<string> {
    const r = await this.pool.query<{ lease_expires_at: Date }>(
      `UPDATE server.research_queue SET lease_expires_at = least(deadline_at + make_interval(secs => $3), now() + make_interval(secs => $3))
        WHERE run_id = $1 AND worker_id = $2 AND state = 'leased' RETURNING lease_expires_at`,
      [runId, workerId, (this.s.stageTimeoutMs * 2) / 1000],
    );
    const row = r.rows[0];
    if (!row) {
      throw new LeaseLost(runId);
    }
    return row.lease_expires_at.toISOString();
  }

  async finish(runId: string, workerId: string, state: 'completed' | 'stage_a_only' | 'failed'): Promise<void> {
    const r = await this.pool.query(
      "UPDATE server.research_queue SET state = 'done', skip_reason = $3, finished_at = now() WHERE run_id = $1 AND worker_id = $2 AND state = 'leased'",
      [runId, workerId, state === 'completed' ? null : state],
    );
    if (!r.rowCount) {
      throw new LeaseLost(runId);
    }
  }

  async queueDepth(): Promise<Record<string, number>> {
    const r = await this.pool.query<{ state: string; n: number }>(
      "SELECT state, count(*)::int AS n FROM server.research_queue WHERE state IN ('queued', 'leased') GROUP BY state",
    );
    const out: Record<string, number> = { queued: 0, leased: 0 };
    for (const x of r.rows) {
      out[x.state] = x.n;
    }
    return out;
  }
}

export class LeaseLost extends Error {
  constructor(runId: string) {
    super(`研判 ${runId} 的租约已不属于这个 worker`);
  }
}
