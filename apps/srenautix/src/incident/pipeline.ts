import type { Incident } from '@srenautix/contract';
import pg from 'pg';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import type { Scheduler, ResearchReason } from '../scheduler/admission.js';
import type { StageAService } from '../stage-a/service.js';
import { isConnectionError } from '../store/health.js';
import type { PgConfig } from '../store/pool.js';
import type { IncidentEngine } from './engine.js';
import { incidentOnsetMs, incidentOrigin } from './onset.js';
import { incidentVersion } from './read.js';
import { recordReason } from './reasons.js';
import { INGEST_CHANNEL } from '../ingest/store.js';

/** 当前版本超过这个时长没有阶段 A 报告时补跑（ADR 0173）：阶段 A 首次触发到发出的期限 */
export const STAGE_A_RETRY_AFTER_MS = 60_000;
/** 同一版本补跑失败这么多次后记 stage_a_missing，不再补跑 */
export const STAGE_A_MAX_RETRIES = 3;
/** 每轮最多补跑的事件数：补跑排在新版本之后，不挡住新版本的阶段 A */
export const STAGE_A_RETRIES_PER_ROUND = 5;
/** 已结束的事件只补跑这段时间内更新过的（与研判次数上限的窗口相同） */
export const STAGE_A_RETRY_LOOKBACK_MS = 6 * 3600_000;
/** 补跑失败的 stage_a_failed 记录的 ref */
export const STAGE_A_RETRY_REF = 'retry';

export interface PipelineHooks {
  /** 事件、报告或队列有变化后通知消息同步。 */
  changed(): void;
  /** 状态库不可用：交给降级通道。 */
  degraded(clusterId: string, e: Error): void;
  /** 状态库恢复。 */
  recovered(clusterId: string): void;
}

/**
 * 新版本相对上一版本的研判触发原因（DESIGN §2.4：唯一键 (incident_id, incident_version, reason)）。
 * reopened 是这个版本的版本原因为 reopened（从 resolved 回到 firing，ADR 0132）：与新事件一样触发研判（ADR 0135）。
 */
export function reasonFor(
  prev: Incident | null,
  next: Incident,
  fingerprintChanged: boolean,
  reopened = false,
): ResearchReason | null {
  if (!prev) {
    return 'new_incident';
  }
  if (reopened) {
    return 'reopened';
  }
  if (prev.root.component !== next.root.component) {
    return 'root_changed';
  }
  const rank = { info: 1, warning: 2, critical: 3 } as const;
  if (rank[next.severity] > rank[prev.severity]) {
    return 'severity_raised';
  }
  if (fingerprintChanged) {
    return 'fingerprint_changed';
  }
  return null;
}

/**
 * 事件流水线（单活实例）：接入写入后经 NOTIFY 唤醒，或每 15 秒一次，重算并对账事件；每个新版本立即出阶段 A，
 * 再按触发原因经准入控制进入阶段 B 队列。每个事件的阶段 A 单独执行与记录失败，当前版本超过期限没有报告的事件补跑
 * （ADR 0173）。状态库不可用时交给降级通道，恢复后继续。
 */
export class IncidentPipeline {
  private running = false;
  private again = false;
  private down = false;

  constructor(
    private readonly clusterId: string,
    private readonly engine: IncidentEngine,
    private readonly stageA: StageAService,
    private readonly scheduler: Scheduler,
    private readonly pool: pg.Pool,
    private readonly metrics: ServerMetrics,
    private readonly hooks: PipelineHooks,
  ) {
    // 带标签的 Counter 在第一次失败之前不导出：启动时按集群初始化为 0，告警能区分"0"与"缺失"（Zzhihon/SreNautix#8）
    metrics.incidentPersistErrors.inc({ cluster_id: clusterId }, 0);
  }

  /** 跑一轮；已有一轮在跑时合并为它结束后的一次。 */
  async kick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.once();
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  private async once(): Promise<void> {
    let r;
    try {
      await this.scheduler.refreshStorm(this.clusterId);
      r = await this.engine.recompute(this.clusterId);
    } catch (e) {
      if (isConnectionError(e)) {
        if (!this.down) {
          this.down = true;
          this.hooks.degraded(this.clusterId, e as Error);
        }
        return;
      }
      throw e;
    }
    if (this.down) {
      this.down = false;
      this.hooks.recovered(this.clusterId);
    }
    for (const inc of r.toReport) {
      await this.report(inc, r.reopened.has(inc.incident_id), false);
    }
    const retried = await this.retryMissing();
    const counts = await this.pool.query<{ state: string; n: number }>(
      'SELECT state, count(*)::int AS n FROM server.incidents WHERE cluster_id = $1 GROUP BY state',
      [this.clusterId],
    );
    for (const s of ['firing', 'resolved', 'merged']) {
      this.metrics.incidents.set({ state: s }, counts.rows.find((x) => x.state === s)?.n ?? 0);
    }
    if (r.changes.length || r.toReport.length || retried) {
      this.hooks.changed();
    }
  }

  /**
   * 一个事件版本的阶段 A 与阶段 B 准入。阶段 A 抛错时写一条 stage_a_failed（带错误摘要）并计数，返回 false，
   * 调用方照常处理其余事件；状态库连接错误照常抛出，由降级通道处理。retry 为补跑
   */
  private async report(inc: Incident, reopened: boolean, retry: boolean): Promise<boolean> {
    const prev =
      inc.incident_version > 1 ? await incidentVersion(this.pool, inc.incident_id, inc.incident_version - 1) : null;
    let out;
    try {
      out = await this.stageA.run(inc);
    } catch (e) {
      if (isConnectionError(e)) {
        throw e;
      }
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await recordReason(this.pool, this.metrics, {
        incidentId: inc.incident_id,
        incidentVersion: inc.incident_version,
        stage: 'stage_a',
        code: 'stage_a_failed',
        detail,
        ref: retry ? STAGE_A_RETRY_REF : null,
      });
      logger.error(retry ? '阶段 A 补跑失败' : '阶段 A 失败，其余事件照常执行，超过期限后补跑', {
        incident_id: inc.incident_id,
        version: inc.incident_version,
        error: e,
      });
      return false;
    }
    if (inc.incident_version === 1) {
      this.metrics.stageALatency.observe(
        { origin: incidentOrigin(inc) },
        Math.max(0, (Date.now() - incidentOnsetMs(inc)) / 1000),
      );
    }
    const reason = reasonFor(prev, inc, out.fingerprintChanged, reopened);
    if (reason) {
      const a = await this.scheduler.admit(inc, reason);
      logger.info('阶段 B 准入', {
        incident_id: inc.incident_id,
        version: inc.incident_version,
        reason,
        outcome: a.outcome,
        run_id: a.runId,
      });
    }
    return true;
  }

  /**
   * 补跑（ADR 0173）：当前版本超过 STAGE_A_RETRY_AFTER_MS 没有阶段 A 报告的事件（不含 merged；已结束的只看
   * STAGE_A_RETRY_LOOKBACK_MS 内更新的），critical 在前，每轮最多 STAGE_A_RETRIES_PER_ROUND 个，新版本的阶段 A
   * 不被补跑挡住。同一版本补跑失败 STAGE_A_MAX_RETRIES 次后记 stage_a_missing，不再补跑。返回本轮补跑的事件数
   */
  private async retryMissing(): Promise<number> {
    const due = await this.pool.query<{ body: Incident; reopened: boolean; retries: number }>(
      `SELECT i.body, coalesce(v.reason = 'reopened', false) AS reopened, f.retries
         FROM server.incidents i
         LEFT JOIN server.incident_versions v ON v.incident_id = i.incident_id AND v.version = i.version
         CROSS JOIN LATERAL (SELECT count(*)::int AS retries FROM server.incident_reasons x
                              WHERE x.incident_id = i.incident_id AND x.incident_version = i.version AND x.stage = 'stage_a'
                                AND x.code = 'stage_a_failed' AND x.ref = $5) f
        WHERE i.cluster_id = $1 AND i.state <> 'merged'
          AND (i.state = 'firing' OR i.updated_at > now() - make_interval(secs => $2))
          AND i.updated_at < now() - make_interval(secs => $3)
          AND NOT EXISTS (SELECT 1 FROM server.stage_a_reports s WHERE s.incident_id = i.incident_id AND s.incident_version = i.version)
          AND f.retries < $4
        ORDER BY (i.severity = 'critical') DESC, i.updated_at
        LIMIT $6`,
      [
        this.clusterId,
        STAGE_A_RETRY_LOOKBACK_MS / 1000,
        STAGE_A_RETRY_AFTER_MS / 1000,
        STAGE_A_MAX_RETRIES,
        STAGE_A_RETRY_REF,
        STAGE_A_RETRIES_PER_ROUND,
      ],
    );
    for (const row of due.rows) {
      const inc = row.body;
      if (await this.report(inc, row.reopened, true)) {
        logger.info('阶段 A 补跑成功', {
          incident_id: inc.incident_id,
          version: inc.incident_version,
          retries: row.retries,
        });
        continue;
      }
      if (row.retries + 1 >= STAGE_A_MAX_RETRIES) {
        await recordReason(this.pool, this.metrics, {
          incidentId: inc.incident_id,
          incidentVersion: inc.incident_version,
          stage: 'stage_a',
          code: 'stage_a_missing',
          detail: `补跑 ${STAGE_A_MAX_RETRIES} 次仍然失败`,
          once: `v${inc.incident_version}`,
        });
        logger.error('阶段 A 补跑次数用完，当前版本没有报告', {
          incident_id: inc.incident_id,
          version: inc.incident_version,
        });
      }
    }
    return due.rows.length;
  }
}

/** 监听接入频道：有告警变化时唤醒流水线；连接断开时 2 秒后重连。 */
export function listenIngest(cfg: PgConfig, onWake: (clusterId: string) => void, signal: AbortSignal): void {
  const connect = async (): Promise<void> => {
    if (signal.aborted) {
      return;
    }
    const c = new pg.Client({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl:
        cfg.sslMode === 'disable'
          ? false
          : cfg.sslMode === 'require'
            ? { rejectUnauthorized: false }
            : { rejectUnauthorized: true, ca: cfg.caCert ?? undefined, servername: cfg.host },
      application_name: 'srenautix-ingest-listen',
      connectionTimeoutMillis: 5_000,
    });
    let retried = false;
    const retry = () => {
      if (retried) {
        return;
      }
      retried = true;
      void c.end().catch(() => undefined);
      if (!signal.aborted) {
        setTimeout(() => void connect(), 2_000).unref();
      }
    };
    c.on('notification', (n) => onWake(n.payload ?? ''));
    c.on('error', retry);
    c.on('end', retry);
    try {
      await c.connect();
      await c.query(`LISTEN ${INGEST_CHANNEL}`);
    } catch {
      retry();
      return;
    }
    signal.addEventListener('abort', () => void c.end().catch(() => undefined), { once: true });
  };
  void connect();
}
