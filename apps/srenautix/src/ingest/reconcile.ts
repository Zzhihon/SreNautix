import type { AlertmanagerAlert } from '@srenautix/contract';
import type pg from 'pg';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { tx } from '../store/pool.js';
import { fingerprint, fromAlertmanager, identityLabels, normalizeSeverity, type RawAlert } from './normalize.js';
import type { IngestService } from './service.js';
import { firingAlertIds, resolveMissing } from './store.js';

export interface ReconcileSources {
  alertmanagerUrl: string | null;
  prometheusUrl: string | null;
  bearerToken: string | null;
  timeoutMs: number;
}

export interface ReconcileResult {
  added: number;
  resolved: number;
  sources: string[];
}

async function getJson(url: string, token: string | null, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

interface PromVector {
  status: string;
  data: { resultType: string; result: Array<{ metric: Record<string, string>; value: [number, string] }> };
}

/**
 * 60 秒对账（DESIGN §3.1）：对比 Alertmanager v2 `GET /api/v2/alerts` 与 `ALERTS_FOR_STATE`（只取 alertstate=firing 的序列）。
 * - 告警源中触发、本地没有的：补写（source=reconcile）；PG 恢复后活动告警也由此重建。
 * - 本地触发、两个告警源都已没有该指纹的：以 PG 的 now() 结束。
 * 两个来源都不可达时本轮不做任何结束判断，避免把告警源的故障当成告警恢复。
 */
export async function reconcileOnce(
  pool: pg.Pool,
  clusterId: string,
  src: ReconcileSources,
  ingest: IngestService,
  metrics: ServerMetrics,
  selfLabel: string,
  watchdog: string,
): Promise<ReconcileResult> {
  const now = new Date();
  const remote = new Map<string, RawAlert>();
  const ok: string[] = [];
  if (src.alertmanagerUrl) {
    const list = (await getJson(
      `${src.alertmanagerUrl}/api/v2/alerts?active=true&silenced=true&inhibited=true&unprocessed=true`,
      src.bearerToken,
      src.timeoutMs,
    )) as AlertmanagerAlert[];
    for (const a of list) {
      const r = fromAlertmanager(a, 'reconcile', now);
      if (r.status === 'firing') {
        remote.set(r.fingerprint, r);
      }
    }
    ok.push('alertmanager');
  }
  if (src.prometheusUrl) {
    const q = encodeURIComponent('ALERTS_FOR_STATE');
    const firingQ = encodeURIComponent('ALERTS{alertstate="firing"}');
    const forState = (await getJson(
      `${src.prometheusUrl}/api/v1/query?query=${q}`,
      src.bearerToken,
      src.timeoutMs,
    )) as PromVector;
    const firing = (await getJson(
      `${src.prometheusUrl}/api/v1/query?query=${firingQ}`,
      src.bearerToken,
      src.timeoutMs,
    )) as PromVector;
    const firingFps = new Set(firing.data.result.map((s) => fingerprint(identityLabels(s.metric))));
    for (const s of forState.data.result) {
      const labels = identityLabels(s.metric);
      const fp = fingerprint(labels);
      if (!firingFps.has(fp) || remote.has(fp) || !labels.alertname) {
        continue;
      }
      const activeAt = Number(s.value[1]);
      remote.set(fp, {
        source: 'reconcile',
        labels,
        annotations: {},
        severity: normalizeSeverity(labels.severity),
        status: 'firing',
        suppressed: 'none',
        startsAt: new Date(activeAt * 1000),
        endsAt: null,
        generatorUrl: null,
        fingerprint: fp,
        alertname: labels.alertname,
      });
    }
    ok.push('prometheus');
  }
  const kept = [...remote.values()].filter((a) => a.labels[selfLabel] === undefined && a.alertname !== watchdog);
  const local = await firingAlertIds(pool, clusterId);
  const localFps = new Set([...local.values()].map((v) => v.fingerprint));
  const missing = kept.filter((a) => !localFps.has(a.fingerprint));
  if (missing.length) {
    await ingest.write(clusterId, 'reconcile', 'reconcile', missing, { reconcile: missing.map((a) => a.labels) });
  }
  let resolved = 0;
  if (ok.length) {
    const remoteFps = new Set(remote.keys());
    const gone = [...local.entries()].filter(([, v]) => !remoteFps.has(v.fingerprint));
    if (gone.length) {
      await tx(pool, async (c) => {
        const t = (await c.query<{ now: Date }>('SELECT now() AS now')).rows[0] as { now: Date };
        for (const [id] of gone) {
          if (await resolveMissing(c, id, t.now)) {
            resolved++;
          }
        }
        if (resolved) {
          await c.query("SELECT pg_notify('srenautix_ingest', $1)", [clusterId]);
        }
      });
    }
  }
  metrics.reconcileRepairs.inc({ kind: 'added' }, missing.length);
  metrics.reconcileRepairs.inc({ kind: 'resolved' }, resolved);
  return { added: missing.length, resolved, sources: ok };
}

export function startReconcileLoop(
  intervalMs: number,
  signal: AbortSignal,
  run: () => Promise<ReconcileResult>,
  metrics: ServerMetrics,
  onResult: (ok: boolean) => void,
): void {
  const tick = async () => {
    try {
      const r = await run();
      metrics.reconcileRuns.inc({ outcome: 'ok' });
      if (r.added || r.resolved) {
        logger.info('告警对账修正', { added: r.added, resolved: r.resolved, sources: r.sources });
      }
      onResult(true);
    } catch (e) {
      metrics.reconcileRuns.inc({ outcome: 'error' });
      logger.warn('告警对账失败，下一轮重试', { error: e });
      onResult(false);
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  void tick();
}
