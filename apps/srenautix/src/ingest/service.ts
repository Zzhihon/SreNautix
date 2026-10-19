import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { HttpError, notFound, unauthorized } from '../api/errors.js';
import type { IngestSourceConfig } from '../config/server.js';
import { readSecretFile } from '../config/files.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { isConnectionError } from '../store/health.js';
import { tx } from '../store/pool.js';
import { resolveAlert, type ResolveDeps, type Resolved } from '../alerts/resolve.js';
import { parseAlertmanagerWebhook, parseGeneric, parseNightingale, PayloadError, type RawAlert } from './normalize.js';
import { INGEST_CHANNEL, logIngest, touchSource, upsertAlert } from './store.js';

export interface IngestOptions {
  clusterId: string;
  /** 带这个标签的告警是 SreNautix 自身的元告警，丢弃。 */
  selfLabel: string;
  watchdogAlertname: string;
}

interface Source {
  cfg: IngestSourceConfig;
  token: Buffer;
}

/** 状态库不可用时收下的告警，交给降级的阶段 A 通道，并在恢复后补写。 */
export type DegradedSink = (clusterId: string, alerts: RawAlert[]) => void;

/**
 * 接入（DESIGN §3.1）：Alertmanager、Grafana 告警、夜莺、通用 webhook。每个接入源一个 bearer token。
 * 告警写入 alert_state 与接入日志后经 NOTIFY 唤醒事件引擎；状态库不可用时告警留在内存并交给降级通道。
 */
export class IngestService {
  private readonly sources = new Map<string, Source>();
  private pending: Array<{ clusterId: string; sourceId: string; alerts: RawAlert[] }> = [];
  lastWatchdogAt: Date | null = null;

  constructor(
    private readonly pool: pg.Pool,
    sources: IngestSourceConfig[],
    private readonly opts: IngestOptions,
    private readonly resolve: ResolveDeps,
    private readonly metrics: ServerMetrics,
    private readonly degraded: DegradedSink,
  ) {
    for (const s of sources) {
      this.sources.set(s.id, {
        cfg: s,
        token: Buffer.from(readSecretFile(`ingest.sources[${s.id}].token_file`, s.token_file)),
      });
    }
  }

  registerRoutes(app: FastifyInstance): void {
    app.post('/v1/ingest/:source_id', async (req, reply) => {
      const { source_id } = req.params as { source_id: string };
      const s = this.sources.get(source_id);
      if (!s) {
        throw notFound(`没有接入源 ${source_id}`);
      }
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
      const given = Buffer.from(m?.[1] ?? '');
      if (!m || given.length !== s.token.length || !timingSafeEqual(given, s.token)) {
        throw unauthorized('接入源 token 不正确');
      }
      const r = await this.ingest(source_id, req.body);
      return reply.code(r.degraded ? 202 : 200).send(r);
    });
  }

  private parse(s: Source, body: unknown, now: Date): RawAlert[] {
    switch (s.cfg.kind) {
      case 'alertmanager':
        return parseAlertmanagerWebhook(body, 'alertmanager', now);
      case 'grafana':
        return parseAlertmanagerWebhook(body, 'grafana', now);
      case 'nightingale':
        return parseNightingale(body, now);
      case 'generic':
        return parseGeneric(body, s.cfg.mapping, now);
    }
  }

  /** 处理一次 webhook；返回接受、丢弃的数量与是否走了降级路径。 */
  async ingest(sourceId: string, body: unknown): Promise<{ accepted: number; dropped: number; degraded: boolean }> {
    const s = this.sources.get(sourceId);
    if (!s) {
      throw notFound(`没有接入源 ${sourceId}`);
    }
    const clusterId = s.cfg.cluster_id ?? this.opts.clusterId;
    const now = new Date();
    let alerts: RawAlert[];
    try {
      alerts = this.parse(s, body, now);
    } catch (e) {
      if (e instanceof PayloadError) {
        this.metrics.ingestAlerts.inc({ source: sourceId, outcome: 'invalid' });
        await tx(this.pool, (c) => logIngest(c, sourceId, clusterId, 0, 'invalid', e.message, body)).catch(
          (err: unknown) => {
            if (!isConnectionError(err)) {
              throw err;
            }
          },
        );
        throw new HttpError(400, 'bad_request', e.message);
      }
      throw e;
    }
    this.metrics.ingestLastReceived.set({ source: sourceId }, now.getTime() / 1000);
    const kept: RawAlert[] = [];
    let dropped = 0;
    for (const a of alerts) {
      if (a.labels[this.opts.selfLabel] !== undefined) {
        dropped++;
        this.metrics.ingestAlerts.inc({ source: sourceId, outcome: 'dropped_self' });
        continue;
      }
      if (a.alertname === this.opts.watchdogAlertname) {
        if (a.status === 'firing') {
          this.lastWatchdogAt = now;
        }
        dropped++;
        this.metrics.ingestAlerts.inc({ source: sourceId, outcome: 'watchdog' });
        continue;
      }
      kept.push(a);
    }
    try {
      await this.write(clusterId, sourceId, s.cfg.kind, kept, body);
    } catch (e) {
      if (!isConnectionError(e)) {
        throw e;
      }
      logger.warn('状态库不可用，告警留在内存并交给降级通道', {
        source: sourceId,
        alerts: kept.length,
        error: (e as Error).message,
      });
      this.pending.push({ clusterId, sourceId, alerts: kept });
      this.degraded(clusterId, kept);
      return { accepted: kept.length, dropped, degraded: true };
    }
    this.metrics.ingestAlerts.inc({ source: sourceId, outcome: 'accepted' }, kept.length);
    return { accepted: kept.length, dropped, degraded: false };
  }

  /** 写入一批告警（webhook 或对账），返回状态有变化的 alert_id。 */
  async write(
    clusterId: string,
    sourceId: string,
    kind: string,
    alerts: RawAlert[],
    payload: unknown,
  ): Promise<string[]> {
    const resolved: Array<{ a: RawAlert; r: Resolved }> = [];
    for (const a of alerts) {
      resolved.push({ a, r: await resolveAlert(clusterId, a, this.resolve) });
    }
    return tx(this.pool, async (c) => {
      const changed: string[] = [];
      for (const { a, r } of resolved) {
        const u = await upsertAlert(c, clusterId, a, r);
        if (u.changed) {
          changed.push(u.alertId);
        }
      }
      await logIngest(
        c,
        sourceId,
        clusterId,
        alerts.length,
        sourceId === 'reconcile' ? 'reconcile' : 'accepted',
        null,
        payload,
      );
      await touchSource(c, sourceId, kind);
      if (changed.length) {
        await c.query('SELECT pg_notify($1, $2)', [INGEST_CHANNEL, clusterId]);
      }
      return changed;
    });
  }

  /** 状态库恢复后补写降级期间收下的告警。 */
  async backfill(): Promise<number> {
    const list = this.pending;
    this.pending = [];
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i] as (typeof list)[number];
      try {
        await this.write(p.clusterId, p.sourceId, this.sources.get(p.sourceId)?.cfg.kind ?? 'unknown', p.alerts, {
          backfill: true,
        });
        n += p.alerts.length;
      } catch (e) {
        this.pending = [...list.slice(i), ...this.pending];
        throw e;
      }
    }
    return n;
  }

  get pendingCount(): number {
    return this.pending.reduce((n, p) => n + p.alerts.length, 0);
  }
}
