import type { Incident } from '@srenautix/contract';
import pg from 'pg';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import type { Scheduler, ResearchReason } from '../scheduler/admission.js';
import type { StageAService } from '../stage-a/service.js';
import { isConnectionError } from '../store/health.js';
import type { PgConfig } from '../store/pool.js';
import type { IncidentEngine } from './engine.js';
import { incidentVersion } from './read.js';
import { INGEST_CHANNEL } from '../ingest/store.js';

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
 * 再按触发原因经准入控制进入阶段 B 队列。状态库不可用时交给降级通道，恢复后继续。
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
      const prev =
        inc.incident_version > 1 ? await incidentVersion(this.pool, inc.incident_id, inc.incident_version - 1) : null;
      const out = await this.stageA.run(inc);
      const firstMs = new Date(inc.first_firing_at).getTime();
      if (inc.incident_version === 1) {
        this.metrics.stageALatency.observe((Date.now() - firstMs) / 1000);
      }
      const reason = reasonFor(prev, inc, out.fingerprintChanged, r.reopened.has(inc.incident_id));
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
    }
    const counts = await this.pool.query<{ state: string; n: number }>(
      'SELECT state, count(*)::int AS n FROM server.incidents WHERE cluster_id = $1 GROUP BY state',
      [this.clusterId],
    );
    for (const s of ['firing', 'resolved', 'merged']) {
      this.metrics.incidents.set({ state: s }, counts.rows.find((x) => x.state === s)?.n ?? 0);
    }
    if (r.changes.length || r.toReport.length) {
      this.hooks.changed();
    }
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
