import { createHash } from 'node:crypto';
import type { AlertClassification, Incident, IncidentCategory, IncidentMember, Labels } from '@srenautix/contract';
import { incidentCategories, UNCLASSIFIED, type AlertCatalog } from '@srenautix/core';
import canonicalize from 'canonicalize';
import type pg from 'pg';
import type { Leader } from '../api/leader.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { tx, type Queryable } from '../store/pool.js';

/** 每批重新分类的事件数；每批一个事务 */
export const RECATEGORIZE_BATCH = 500;

/** 重新分类出错或失去主实例之后再次检查的间隔 */
export const RECATEGORIZE_RETRY_MS = 30_000;

/** 类别解析输入（AlertCatalog.categoryInputs）的指纹：规范化 JSON 的 sha256 */
export function categoryInputsFingerprint(catalog: AlertCatalog): string {
  const json = canonicalize(catalog.categoryInputs());
  if (json === undefined) {
    throw new Error('类别解析的输入无法规范化');
  }
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

/** 成员告警在 alert_state 中的标签与分类；已经清理掉的告警不在结果里 */
export async function alertRows(
  c: Queryable,
  alertIds: readonly string[],
): Promise<Map<string, { labels: Labels; classification: AlertClassification }>> {
  const rows = await c.query<{ alert_id: string; labels: Labels; classification: AlertClassification }>(
    'SELECT alert_id, labels, classification FROM server.alert_state WHERE alert_id = ANY($1::text[])',
    [alertIds],
  );
  return new Map(rows.rows.map((r) => [r.alert_id, { labels: r.labels, classification: r.classification }]));
}

/**
 * 按当前的告警目录与 ingest.category_rules 求成员的类别：告警还在 alert_state 时用它的完整标签，已经不在时只按告警名
 * 查目录（命中没有 match_labels 的条目），按标签匹配的规则不生效
 */
export function memberCategory(catalog: AlertCatalog, m: IncidentMember, labels: Labels | undefined): IncidentCategory {
  return catalog.category(labels ?? { alertname: m.alertname }).category;
}

export interface RecategorizeResult {
  fingerprint: string;
  /** 上次记录的指纹；没有记录时为 null */
  previous: string | null;
  /** unchanged：指纹与上次记录相同，没有重新分类；completed：全部批次完成并记录；interrupted：中途停下，没有记录 */
  outcome: 'unchanged' | 'completed' | 'interrupted';
  /** 改写了类别的事件数 */
  incidents: number;
  /** 回写了分类的 alert_state 行数 */
  alerts: number;
}

/**
 * 类别解析输入变化后的重新分类（ADR 0183 §4）。指纹与 server.incident_recategorizations 最近一行相同时不做事；
 * 不同时逐个集群、按 incident_id 分批扫描有 unclassified 成员的事件，按 memberCategory 重算这些成员，已有类别的成员不改
 * （当时的标签覆盖与判断保留）。成员有变化的事件改写成员的 category、body 的 categories 与 primary_category 和两列，
 * 不改事件版本、updated_at 与 incident_versions；告警还在 alert_state、存储的类别为 unclassified 而重算出类别的，
 * 同时回写分类的 category 与 category_source，事件引擎之后重算这些事件时求出同样的类别。
 * 每批一个事务，先取事件引擎的同一把集群咨询锁，与事件引擎的写入串行，引擎每次最多等一批。
 * active 返回 false 时在批次之间停下，不记录指纹，下一次检查从头扫描（重算的结果与已经改写的行一致，重复执行不改变结果）
 */
export async function recategorizeIncidents(
  pool: pg.Pool,
  catalog: AlertCatalog,
  o: { holder: string; active: () => boolean; batch?: number },
): Promise<RecategorizeResult> {
  const fingerprint = categoryInputsFingerprint(catalog);
  const last = await pool.query<{ fingerprint: string }>(
    'SELECT fingerprint FROM server.incident_recategorizations ORDER BY id DESC LIMIT 1',
  );
  const previous = last.rows[0]?.fingerprint ?? null;
  const out: RecategorizeResult = { fingerprint, previous, outcome: 'unchanged', incidents: 0, alerts: 0 };
  if (previous === fingerprint) {
    return out;
  }
  const startedAt = new Date();
  const size = o.batch ?? RECATEGORIZE_BATCH;
  const clusters = await pool.query<{ cluster_id: string }>(
    'SELECT DISTINCT cluster_id FROM server.incidents ORDER BY cluster_id',
  );
  for (const { cluster_id: clusterId } of clusters.rows) {
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      if (!o.active()) {
        return { ...out, outcome: 'interrupted' };
      }
      const r = await tx(pool, async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`srenautix.incident-engine.${clusterId}`]);
        return recategorizeBatch(c, catalog, clusterId, after, size);
      });
      out.incidents += r.incidents;
      out.alerts += r.alerts;
      if (r.last === null) {
        break;
      }
      after = r.last;
    }
  }
  await pool.query(
    `INSERT INTO server.incident_recategorizations (fingerprint, holder, incidents, alerts, started_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [fingerprint, o.holder, out.incidents, out.alerts, startedAt],
  );
  return { ...out, outcome: 'completed' };
}

/** 一批：incident_id 大于 after 的有 unclassified 成员的事件；last 为本批最后一个事件，不满一批时为 null */
async function recategorizeBatch(
  c: pg.PoolClient,
  catalog: AlertCatalog,
  clusterId: string,
  after: string,
  size: number,
): Promise<{ incidents: number; alerts: number; last: string | null }> {
  const batch = await c.query<{ incident_id: string; body: Incident }>(
    `SELECT incident_id, body FROM server.incidents
      WHERE cluster_id = $1 AND incident_id > $2::uuid AND body @? '$.members[*] ? (@.category == "unclassified")'
      ORDER BY incident_id LIMIT $3`,
    [clusterId, after, size],
  );
  const unclassified = (m: IncidentMember) => (m.category ?? UNCLASSIFIED) === UNCLASSIFIED;
  const ids = [...new Set(batch.rows.flatMap((r) => r.body.members.filter(unclassified).map((m) => m.alert_id)))];
  const alerts = await alertRows(c, ids);
  let incidents = 0;
  for (const r of batch.rows) {
    let changed = false;
    const members = r.body.members.map((m) => {
      if (!unclassified(m)) {
        return m;
      }
      const category = memberCategory(catalog, m, alerts.get(m.alert_id)?.labels);
      if (category === UNCLASSIFIED) {
        return m;
      }
      changed = true;
      return { ...m, category };
    });
    if (!changed) {
      continue;
    }
    const cats = incidentCategories(members, r.body.root.component);
    const body: Incident = { ...r.body, members, ...cats };
    await c.query(
      'UPDATE server.incidents SET categories = $2, primary_category = $3, body = $4 WHERE incident_id = $1',
      [r.incident_id, cats.categories, cats.primary_category, JSON.stringify(body)],
    );
    incidents++;
  }
  let written = 0;
  for (const [alertId, a] of alerts) {
    if ((a.classification.category ?? UNCLASSIFIED) !== UNCLASSIFIED) {
      continue;
    }
    const cat = catalog.category(a.labels);
    if (cat.category === UNCLASSIFIED) {
      continue;
    }
    // 只改两个键：接入同时回写的分类其余部分保留
    const u = await c.query(
      `UPDATE server.alert_state SET classification = classification || jsonb_build_object('category', $2::text, 'category_source', $3::text)
        WHERE alert_id = $1 AND coalesce(classification->>'category', 'unclassified') = 'unclassified'`,
      [alertId, cat.category, cat.source],
    );
    written += u.rowCount ?? 0;
  }
  return {
    incidents,
    alerts: written,
    last: batch.rows.length < size ? null : batch.rows[batch.rows.length - 1]!.incident_id,
  };
}

/**
 * 取得主实例之后（数据修正完成之后）检查一次类别解析输入，后台执行，不阻塞其他单活工作。失去主实例或出错时停下，
 * 之后每 RECATEGORIZE_RETRY_MS 检查一次，再次是主实例时从头执行；完成或指纹未变后结束
 */
export function startRecategorize(o: {
  pool: pg.Pool;
  catalog: AlertCatalog;
  leader: Leader;
  holder: string;
  metrics: ServerMetrics;
  signal: AbortSignal;
  retryMs?: number;
}): Promise<void> {
  const retryMs = o.retryMs ?? RECATEGORIZE_RETRY_MS;
  const active = () => o.leader.isLeader() && !o.signal.aborted;
  const run = async (): Promise<void> => {
    await o.leader.acquired();
    while (!o.signal.aborted) {
      if (active()) {
        try {
          const r = await recategorizeIncidents(o.pool, o.catalog, { holder: o.holder, active });
          o.metrics.recategorizeRuns.inc({ outcome: r.outcome });
          o.metrics.incidentsRecategorized.inc(r.incidents);
          if (r.outcome !== 'unchanged') {
            logger.info('类别解析的输入有变化，已重新分类 unclassified 成员', {
              fingerprint: r.fingerprint,
              previous: r.previous,
              outcome: r.outcome,
              incidents: r.incidents,
              alerts: r.alerts,
              holder: o.holder,
            });
          }
          if (r.outcome !== 'interrupted') {
            return;
          }
        } catch (e) {
          o.metrics.recategorizeRuns.inc({ outcome: 'failed' });
          logger.error('重新分类失败，稍后重试', { error: e });
        }
      }
      await new Promise((r) => setTimeout(r, retryMs).unref());
    }
  };
  return run();
}
