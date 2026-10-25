import type { HubComponents } from '@srenautix/contract';
import { isIdentityLabel, isIgnorable } from '@srenautix/core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { badRequest } from '../api/errors.js';
import type { Auth } from '../identity/auth.js';
import type { RoleBinding } from '../identity/bindings.js';
import { resolveIncidentRef } from '../incident/read.js';
import { fingerprint, identityLabels } from '../ingest/normalize.js';
import { componentTarget, incidentTarget, visible } from './routes-incidents.js';

export type AlertLookup = HubComponents['schemas']['AlertLookup'];

/** 告警标签在查询串里的前缀：`l.<标签名>=<标签值>`（ADR 0154） */
export const LABEL_PARAM_PREFIX = 'l.';

const CLUSTER_ID = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export interface AlertLookupQuery {
  labels: Record<string, string>;
  clusterId: string | null;
}

/**
 * 读出查询串中的告警标签与 cluster_id。直接解析原始查询串：同一个标签出现两次、出现其他参数、缺少 alertname 时报错，
 * 标签值按原文保留（`+` 与 `%20` 都是空格，与 Alertmanager 模板的 urlquery 和 html/template 的转义一致）。
 */
export function parseLookupQuery(rawQuery: string): AlertLookupQuery {
  const labels: Record<string, string> = {};
  let clusterId: string | null = null;
  for (const [k, v] of new URLSearchParams(rawQuery)) {
    if (k.startsWith(LABEL_PARAM_PREFIX) && k.length > LABEL_PARAM_PREFIX.length) {
      const name = k.slice(LABEL_PARAM_PREFIX.length);
      if (Object.hasOwn(labels, name)) {
        throw badRequest(`标签 ${name} 出现了两次`);
      }
      labels[name] = v;
    } else if (k === 'cluster_id' && clusterId === null) {
      if (!CLUSTER_ID.test(v)) {
        throw badRequest(`cluster_id 不合法：${v}`);
      }
      clusterId = v;
    } else {
      throw badRequest(`不认识的参数 ${k}：标签写作 ${LABEL_PARAM_PREFIX}<标签名>=<标签值>`);
    }
  }
  if (!labels.alertname) {
    throw badRequest(`缺少 ${LABEL_PARAM_PREFIX}alertname`);
  }
  return { labels, clusterId };
}

export interface AlertLookupOptions {
  /** ingest.self_label：带这个标签的是 SreNautix 自身的元告警，接入时丢弃 */
  selfLabel: string;
  /** ingest.watchdog_alertname */
  watchdogAlertname: string;
}

/**
 * 按告警的完整标签集找到它所属的事件：与接入相同的身份标签与指纹，取这个指纹开始时间最晚的一条告警，
 * 经事件成员关系与别名链解析到事件（合并过的事件解析到吸收它的事件）。
 */
export async function lookupAlert(
  pool: pg.Pool,
  scopes: RoleBinding[] | 'all',
  q: AlertLookupQuery,
  opts: AlertLookupOptions,
): Promise<AlertLookup> {
  const identity = identityLabels(q.labels);
  const base = {
    fingerprint: fingerprint(q.labels),
    identity_labels: identity,
    excluded_labels: Object.keys(q.labels)
      .filter((k) => !isIdentityLabel(k))
      .sort(),
    alert: null,
    incident: null,
  };
  // 接入时丢弃的告警（IngestService.ingest）：不会存下，直接说明原因
  if (identity[opts.selfLabel] !== undefined) {
    return { ...base, outcome: 'self_alert' };
  }
  if (identity.alertname === opts.watchdogAlertname || isIgnorable(identity)) {
    return { ...base, outcome: 'ignored' };
  }
  const a = await pool.query<{
    alert_id: string;
    cluster_id: string;
    status: 'firing' | 'resolved';
    starts_at: Date;
    ends_at: Date | null;
    received_at: Date;
    component: string | null;
  }>(
    `SELECT alert_id, cluster_id, status, starts_at, ends_at, received_at, component FROM server.alert_state
      WHERE fingerprint = $1 AND ($2::text IS NULL OR cluster_id = $2)
      ORDER BY starts_at DESC, alert_id DESC LIMIT 1`,
    [base.fingerprint, q.clusterId],
  );
  const row = a.rows[0];
  if (!row) {
    return { ...base, outcome: 'not_received' };
  }
  const alert = {
    alert_id: row.alert_id,
    cluster_id: row.cluster_id,
    status: row.status,
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at?.toISOString() ?? null,
    received_at: row.received_at.toISOString(),
  };
  // 仍是成员的关系优先（部分索引 incident_members_alert_idx）；告警离开过事件（拆分）时取最近更新的那个事件
  const member = async (active: boolean) =>
    (
      await pool.query<{ incident_id: string }>(
        `SELECT m.incident_id FROM server.incident_members m JOIN server.incidents i USING (incident_id)
          WHERE m.alert_id = $1 AND ${active ? 'm.left_version IS NULL' : 'm.left_version IS NOT NULL'}
          ORDER BY (i.state <> 'merged') DESC, i.updated_at DESC LIMIT 1`,
        [row.alert_id],
      )
    ).rows[0]?.incident_id ?? null;
  const incidentId = (await member(true)) ?? (await member(false));
  const inc = incidentId ? await resolveIncidentRef(pool, incidentId) : null;
  if (!inc || inc.state === 'merged') {
    if (!visible(scopes, componentTarget(row.cluster_id, row.component))) {
      return { ...base, outcome: 'not_visible' };
    }
    return { ...base, outcome: 'not_grouped', alert };
  }
  if (!visible(scopes, incidentTarget(inc.body))) {
    return { ...base, outcome: 'not_visible' };
  }
  return {
    ...base,
    outcome: 'incident',
    alert,
    incident: { incident_id: inc.incident_id, label: inc.label, state: inc.state },
  };
}

export interface AlertRouteDeps extends AlertLookupOptions {
  pool: pg.Pool;
  auth: Auth;
}

/** 告警标签集 → 所属事件（contract/openapi.yaml 的 lookupAlert）。 */
export function registerAlertRoutes(app: FastifyInstance, d: AlertRouteDeps): void {
  app.get('/v1/alerts/lookup', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const i = req.url.indexOf('?');
    return lookupAlert(d.pool, scopes, parseLookupQuery(i < 0 ? '' : req.url.slice(i + 1)), d);
  });
}
