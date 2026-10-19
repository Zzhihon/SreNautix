import type { Alert } from '@srenautix/contract';
import type pg from 'pg';
import type { Resolved } from '../alerts/resolve.js';
import type { Queryable } from '../store/pool.js';
import { alertId, type RawAlert } from './normalize.js';

/** 接入写入后唤醒事件引擎（单活实例）的频道。 */
export const INGEST_CHANNEL = 'srenautix_ingest';

export interface Upserted {
  alertId: string;
  changed: boolean;
}

/**
 * 写入一个告警实例的当前状态。同一指纹出现更晚的触发时，较早仍在触发的那次以新的开始时间结束
 * （告警源不会同时有同一标签集的两次触发）。返回状态是否有变化。
 */
export async function upsertAlert(c: Queryable, clusterId: string, a: RawAlert, r: Resolved): Promise<Upserted> {
  const id = alertId(a.fingerprint, a.startsAt);
  const prev = await c.query<{
    status: string;
    suppressed: string;
    severity: string;
    ends_at: Date | null;
    component: string | null;
  }>('SELECT status, suppressed, severity, ends_at, component FROM server.alert_state WHERE alert_id = $1 FOR UPDATE', [
    id,
  ]);
  const p = prev.rows[0];
  if (p && p.status === 'resolved' && a.status === 'firing' && a.source === 'reconcile') {
    // 对账看到的旧快照不能让已恢复的告警重新触发
    return { alertId: id, changed: false };
  }
  await c.query(
    `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status,
       suppressed, starts_at, ends_at, generator_url, classification, entity, entity_resolution, component, received_at,
       last_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now(), now(), now())
     ON CONFLICT (alert_id) DO UPDATE SET
       annotations = excluded.annotations, severity = excluded.severity, status = excluded.status,
       suppressed = excluded.suppressed, ends_at = excluded.ends_at, generator_url = COALESCE(excluded.generator_url, server.alert_state.generator_url),
       classification = excluded.classification, entity = excluded.entity, entity_resolution = excluded.entity_resolution,
       component = excluded.component, last_seen_at = now(),
       updated_at = CASE WHEN server.alert_state.status IS DISTINCT FROM excluded.status
                           OR server.alert_state.suppressed IS DISTINCT FROM excluded.suppressed
                           OR server.alert_state.severity IS DISTINCT FROM excluded.severity
                           OR server.alert_state.component IS DISTINCT FROM excluded.component
                         THEN now() ELSE server.alert_state.updated_at END`,
    [
      id,
      clusterId,
      a.fingerprint,
      a.source,
      a.alertname,
      JSON.stringify(a.labels),
      JSON.stringify(a.annotations),
      a.severity,
      a.status,
      a.suppressed,
      a.startsAt,
      a.endsAt,
      a.generatorUrl,
      JSON.stringify(r.classification),
      r.entity ? JSON.stringify(r.entity) : null,
      r.entityResolution,
      r.component,
    ],
  );
  if (a.status === 'firing') {
    await c.query(
      `UPDATE server.alert_state SET status = 'resolved', ends_at = $3, updated_at = now()
        WHERE cluster_id = $1 AND fingerprint = $2 AND status = 'firing' AND starts_at < $3`,
      [clusterId, a.fingerprint, a.startsAt],
    );
  }
  const changed =
    !p ||
    p.status !== a.status ||
    p.suppressed !== a.suppressed ||
    p.severity !== a.severity ||
    p.component !== r.component;
  return { alertId: id, changed };
}

/** 对账确认某告警已不在告警源中：以 endsAt 结束。 */
export async function resolveMissing(c: Queryable, alertIdValue: string, endsAt: Date): Promise<boolean> {
  const r = await c.query(
    "UPDATE server.alert_state SET status = 'resolved', ends_at = $2, updated_at = now() WHERE alert_id = $1 AND status = 'firing'",
    [alertIdValue, endsAt],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function logIngest(
  c: Queryable,
  sourceId: string,
  clusterId: string,
  count: number,
  outcome: 'accepted' | 'invalid' | 'reconcile',
  error: string | null,
  payload: unknown,
): Promise<void> {
  await c.query(
    'INSERT INTO server.ingest_log (source_id, cluster_id, alert_count, outcome, error, payload) VALUES ($1, $2, $3, $4, $5, $6)',
    [sourceId, clusterId, count, outcome, error, JSON.stringify(payload ?? null)],
  );
}

export async function touchSource(c: Queryable, sourceId: string, kind: string): Promise<void> {
  await c.query(
    `INSERT INTO server.ingest_sources (source_id, kind, last_received_at) VALUES ($1, $2, now())
     ON CONFLICT (source_id) DO UPDATE SET last_received_at = now(), kind = excluded.kind`,
    [sourceId, kind],
  );
}

interface AlertRow {
  alert_id: string;
  cluster_id: string;
  fingerprint: string;
  source: Alert['source'];
  alertname: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  severity: Alert['severity'];
  status: Alert['status'];
  suppressed: Alert['suppressed'];
  starts_at: Date;
  ends_at: Date | null;
  generator_url: string | null;
  classification: Alert['classification'];
  entity: Alert['entity'];
  entity_resolution: Alert['entity_resolution'];
  component: string | null;
  received_at: Date;
}

export function rowToAlert(r: AlertRow): Alert {
  return {
    alert_id: r.alert_id,
    cluster_id: r.cluster_id,
    source: r.source,
    fingerprint: r.fingerprint,
    alertname: r.alertname,
    labels: r.labels,
    annotations: r.annotations,
    severity: r.severity,
    status: r.status,
    suppressed: r.suppressed,
    starts_at: r.starts_at.toISOString(),
    ends_at: r.ends_at ? r.ends_at.toISOString() : null,
    generator_url: r.generator_url,
    classification: r.classification,
    entity: r.entity,
    entity_resolution: r.entity_resolution,
    component: r.component,
    received_at: r.received_at.toISOString(),
  };
}

/** 事件引擎的输入：触发中的告警，以及 lookbackMs 内恢复的告警。 */
export async function activeAlerts(pool: pg.Pool | Queryable, clusterId: string, lookbackMs: number): Promise<Alert[]> {
  const r = await pool.query<AlertRow>(
    `SELECT * FROM server.alert_state
      WHERE cluster_id = $1 AND (status = 'firing' OR ends_at > now() - make_interval(secs => $2))
      ORDER BY starts_at, alert_id`,
    [clusterId, lookbackMs / 1000],
  );
  return r.rows.map(rowToAlert);
}

export async function alertsById(pool: pg.Pool | Queryable, ids: readonly string[]): Promise<Alert[]> {
  if (!ids.length) {
    return [];
  }
  const r = await pool.query<AlertRow>(
    'SELECT * FROM server.alert_state WHERE alert_id = ANY($1::text[]) ORDER BY starts_at, alert_id',
    [ids],
  );
  return r.rows.map(rowToAlert);
}

export async function firingAlertIds(
  pool: pg.Pool | Queryable,
  clusterId: string,
): Promise<Map<string, { fingerprint: string; startsAt: Date }>> {
  const r = await pool.query<{ alert_id: string; fingerprint: string; starts_at: Date }>(
    "SELECT alert_id, fingerprint, starts_at FROM server.alert_state WHERE cluster_id = $1 AND status = 'firing'",
    [clusterId],
  );
  return new Map(r.rows.map((x) => [x.alert_id, { fingerprint: x.fingerprint, startsAt: x.starts_at }]));
}
