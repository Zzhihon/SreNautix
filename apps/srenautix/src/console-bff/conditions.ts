import type { Condition } from '@srenautix/contract';
import type pg from 'pg';
import { logger } from '../log.js';
import type { BaseMetrics } from '../metrics.js';
import { appendEvents } from '../store/outbox.js';
import { tx } from '../store/pool.js';

export const SCHEMA_VERSION = '2.4.0';

export interface Observed {
  type: Condition['type'];
  subject: string | null;
  active: boolean;
  reason: string;
  message: string;
}

const key = (o: { type: string; subject: string | null }) => `${o.type}\0${o.subject ?? ''}`;

/**
 * 带类型的状态条件（DESIGN §12.4）：每个角色发布自己观察到的条件。状态变化时写入 server.conditions、
 * 发布 condition.changed，并在 condition_spans 中开一段或关闭（收件箱的盲区色带）。
 */
export class ConditionPublisher {
  private last = new Map<string, Observed>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly role: Condition['role'],
    private readonly clusterId: string,
    private readonly metrics: BaseMetrics,
  ) {}

  /** 一轮观察的全部条件；本轮没有列出、上一轮成立的条件视为已恢复。 */
  async publish(observed: Observed[]): Promise<void> {
    const now = new Map(observed.map((o) => [key(o), o]));
    for (const [k, prev] of this.last) {
      if (!now.has(k) && prev.active) {
        now.set(k, { ...prev, active: false, reason: 'Resolved', message: '' });
      }
    }
    const changed = [...now.values()].filter((o) => {
      const p = this.last.get(key(o));
      return !p || p.active !== o.active || p.reason !== o.reason;
    });
    for (const o of now.values()) {
      this.metrics.condition.set(
        { role: this.role, type: o.type },
        [...now.values()].some((x) => x.type === o.type && x.active) ? 1 : 0,
      );
    }
    if (!changed.length) {
      this.last = now;
      return;
    }
    await tx(this.pool, async (c) => {
      for (const o of changed) {
        const r = await c.query<{ since: Date }>(
          `INSERT INTO server.conditions (role, cluster_id, type, subject, status, reason, message, since, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
           ON CONFLICT (role, cluster_id, type, subject) DO UPDATE SET status = excluded.status, reason = excluded.reason,
             message = excluded.message, updated_at = now(),
             since = CASE WHEN server.conditions.status = excluded.status THEN server.conditions.since ELSE now() END
           RETURNING since`,
          [this.role, this.clusterId, o.type, o.subject ?? '', o.active ? 'true' : 'false', o.reason, o.message],
        );
        const since = (r.rows[0] as { since: Date }).since;
        if (o.active) {
          await c.query(
            `INSERT INTO server.condition_spans (role, cluster_id, type, subject, reason, started_at)
             SELECT $1, $2, $3, $4, $5, $6 WHERE NOT EXISTS (
               SELECT 1 FROM server.condition_spans WHERE role = $1 AND cluster_id = $2 AND type = $3 AND subject = $4 AND ended_at IS NULL)`,
            [this.role, this.clusterId, o.type, o.subject ?? '', o.reason, since],
          );
        } else {
          await c.query(
            'UPDATE server.condition_spans SET ended_at = now() WHERE role = $1 AND cluster_id = $2 AND type = $3 AND subject = $4 AND ended_at IS NULL',
            [this.role, this.clusterId, o.type, o.subject ?? ''],
          );
        }
        const payload: Condition = {
          type: o.type,
          status: o.active ? 'true' : 'false',
          role: this.role,
          cluster_id: this.clusterId,
          subject: o.subject,
          reason: o.reason,
          message: o.message,
          since: since.toISOString(),
        };
        await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
          { type: 'condition.changed', clusterId: this.clusterId, payload },
        ]);
      }
    });
    for (const o of changed) {
      logger.info(o.active ? '状态条件成立' : '状态条件恢复', { type: o.type, subject: o.subject, reason: o.reason });
    }
    this.last = now;
  }
}

export interface ServerObservations {
  ingestSources: Array<{ id: string; lastReceivedAt: Date | null }>;
  silenceThresholdMs: number;
  lastWatchdogAt: Date | null;
  startedAt: Date;
  reconcileOk: boolean | null;
  /** 证据卡指标数据源最近一次标签档案探测的错误；可达时为 null。 */
  evidenceDatasourceError: string | null;
  /** 校验不通过（或 pack.lock 不一致）没有加载的包。 */
  packFailures: Array<{ name: string; error: string }>;
  /** 必须的能力缺失或依赖的包被禁用而禁用的包。 */
  packsDisabled: Array<{ name: string; reason: string }>;
  degraded: boolean;
  storm: boolean;
  budgetRatio: number;
  audit: { sink: 's3' | 'pg'; lagSeconds: number; thresholdSeconds: number };
  channelFailures: Array<{ channel: string; error: string }>;
  restoredAt: Date | null;
  frozenClusters: string[];
  now: Date;
}

/** server 角色观察到的条件。 */
export function serverConditions(o: ServerObservations): Observed[] {
  const out: Observed[] = [];
  for (const s of o.ingestSources) {
    const since = s.lastReceivedAt ?? o.startedAt;
    const silent = o.now.getTime() - since.getTime() > o.silenceThresholdMs;
    out.push({
      type: 'IngestSilent',
      subject: s.id,
      active: silent,
      reason: silent ? 'NoPayload' : 'Receiving',
      message: silent ? `接入源 ${s.id} 自 ${since.toISOString()} 起没有收到告警` : '',
    });
  }
  const wd = o.lastWatchdogAt ?? o.startedAt;
  const wdMissing = o.ingestSources.length > 0 && o.now.getTime() - wd.getTime() > o.silenceThresholdMs;
  out.push({
    type: 'WatchdogMissing',
    subject: null,
    active: wdMissing,
    reason: wdMissing ? 'NoWatchdog' : 'Present',
    message: wdMissing ? `Watchdog 告警自 ${wd.toISOString()} 起缺失` : '',
  });
  if (o.reconcileOk !== null) {
    out.push({
      type: 'DatasourceUnavailable',
      subject: 'alert-reconcile',
      active: !o.reconcileOk,
      reason: o.reconcileOk ? 'Reachable' : 'ReconcileFailed',
      message: o.reconcileOk ? '' : '告警对账读取 Alertmanager 或 Prometheus 失败',
    });
  }
  out.push({
    type: 'DatasourceUnavailable',
    subject: 'evidence-metrics',
    active: o.evidenceDatasourceError !== null,
    reason: o.evidenceDatasourceError !== null ? 'ProbeFailed' : 'Reachable',
    message: o.evidenceDatasourceError !== null ? `证据卡的指标数据源不可用：${o.evidenceDatasourceError}` : '',
  });
  for (const f of o.packFailures) {
    out.push({ type: 'PackLoadFailed', subject: f.name, active: true, reason: 'LintFailed', message: f.error });
  }
  for (const d of o.packsDisabled) {
    out.push({ type: 'PackLoadFailed', subject: d.name, active: true, reason: 'Disabled', message: d.reason });
  }
  out.push({
    type: 'StateStoreDegraded',
    subject: null,
    active: o.degraded,
    reason: o.degraded ? 'PostgresUnavailable' : 'Available',
    message: o.degraded ? '状态库不可用，阶段 A 在内存中归并并直接发送' : '',
  });
  out.push({
    type: 'StormMode',
    subject: null,
    active: o.storm,
    reason: o.storm ? 'Storm' : 'Normal',
    message: o.storm ? '风暴模式：只有排名前几的根因进入阶段 B' : '',
  });
  const budget = o.budgetRatio >= 0.8;
  out.push({
    type: 'BudgetCutoffHigh',
    subject: null,
    active: budget,
    reason: budget ? (o.budgetRatio >= 1 ? 'Exhausted' : 'Above80Percent') : 'Normal',
    message: budget ? `当日模型预算已用 ${(o.budgetRatio * 100).toFixed(0)}%` : '',
  });
  const pgSink = o.audit.sink === 'pg';
  const lag = o.audit.lagSeconds > o.audit.thresholdSeconds;
  out.push({
    type: 'AuditExportLagging',
    subject: 'governance',
    active: pgSink || lag,
    reason: pgSink ? 'NoObjectStore' : lag ? 'Lagging' : 'Exported',
    message: pgSink
      ? '治理审计只写在 PostgreSQL 中，没有导出到对象存储'
      : lag
        ? `治理审计导出延迟 ${o.audit.lagSeconds.toFixed(0)} 秒`
        : '',
  });
  const byChannel = new Map<string, string>();
  for (const f of o.channelFailures) {
    byChannel.set(f.channel, f.error);
  }
  for (const ch of ['telegram', 'feishu']) {
    const err = byChannel.get(ch);
    out.push({
      type: 'ChannelDeliveryFailed',
      subject: ch,
      active: err !== undefined,
      reason: err ? 'DeliveryFailed' : 'Delivering',
      message: err ?? '',
    });
  }
  const restored = o.restoredAt !== null;
  out.push({
    type: 'Restored',
    subject: null,
    active: restored,
    reason: restored ? 'RestoredFromBackup' : 'Normal',
    message: restored ? `状态库于 ${o.restoredAt?.toISOString()} 从备份恢复` : '',
  });
  for (const c of o.frozenClusters) {
    out.push({
      type: 'Frozen',
      subject: c,
      active: true,
      reason: 'FreezeConfigMap',
      message: `集群 ${c} 的 srenautix-freeze 处于冻结`,
    });
  }
  return out;
}
