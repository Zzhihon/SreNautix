import type { AlertmanagerAlert } from '@srenautix/contract';
import { isIgnorable } from '@srenautix/core';
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
  /** 本轮之后本地触发中告警的身份指纹（快速轮询据此判断新增，ADR 0160） */
  firing: Set<string>;
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
      const r = firingRuleAlert(s.metric, new Date(Number(s.value[1]) * 1000));
      if (r && firingFps.has(r.fingerprint) && !remote.has(r.fingerprint)) {
        remote.set(r.fingerprint, r);
      }
    }
    ok.push('prometheus');
  }
  return applyRemote(pool, clusterId, remote, ok, ingest, metrics, selfLabel, watchdog);
}

/** 规则引擎报告为触发中的一个告警（ALERTS_FOR_STATE 或 reader 的规则快照）。没有告警名时为 null。 */
export function firingRuleAlert(metric: Record<string, string>, activeAt: Date): RawAlert | null {
  const labels = identityLabels(metric);
  if (!labels.alertname) {
    return null;
  }
  return {
    source: 'reconcile',
    labels,
    annotations: {},
    severity: normalizeSeverity(labels.severity),
    status: 'firing',
    suppressed: 'none',
    startsAt: activeAt,
    endsAt: null,
    generatorUrl: null,
    fingerprint: fingerprint(labels),
    alertname: labels.alertname,
  };
}

/**
 * 用告警源的完整视图修正本地状态：补写本地没有的触发中告警；complete 为非空（全部来源都读取成功且没有截断）时，
 * 结束本地触发、告警源中已经没有的告警。
 */
export async function applyRemote(
  pool: pg.Pool,
  clusterId: string,
  remote: Map<string, RawAlert>,
  complete: string[],
  ingest: IngestService,
  metrics: ServerMetrics,
  selfLabel: string,
  watchdog: string,
): Promise<ReconcileResult> {
  const ok = complete;
  // 与 webhook 接入相同：自身的告警、Watchdog、InfoInhibitor 与 severity=none 不进入事件（core isIgnorable）
  const kept = [...remote.values()].filter(
    (a) => a.labels[selfLabel] === undefined && a.alertname !== watchdog && !isIgnorable(a.labels),
  );
  const local = await firingAlertIds(pool, clusterId);
  // 本地告警按当前的身份规则重新计算指纹（ADR 0117）：之前按带 external labels 的标签存下的告警与对账得到的同一条告警
  // 指纹相同。两条本地告警的身份相同、开始时间也相同时，后者是重复的一份，在本轮结束它（合并到较早存下的那一份）
  const identity = new Map([...local].map(([id, v]) => [id, fingerprint(v.labels)]));
  const byIdentity = new Map<string, string>();
  const duplicates: string[] = [];
  for (const [id, v] of [...local].sort(
    ([a, x], [b, y]) =>
      Number(x.fingerprint !== identity.get(a)) - Number(y.fingerprint !== identity.get(b)) || a.localeCompare(b),
  )) {
    const key = `${identity.get(id)}@${Math.floor(v.startsAt.getTime() / 1000)}`;
    if (byIdentity.has(key)) {
      duplicates.push(id);
    } else {
      byIdentity.set(key, id);
    }
  }
  const localFps = new Set(identity.values());
  const missing = kept.filter((a) => !localFps.has(a.fingerprint));
  if (missing.length) {
    await ingest.write(clusterId, 'reconcile', 'reconcile', missing, { reconcile: missing.map((a) => a.labels) });
    observeIngestDelay(metrics, 'full', missing);
  }
  let resolved = 0;
  const remoteFps = new Set(remote.keys());
  const gone = ok.length ? [...local.keys()].filter((id) => !remoteFps.has(identity.get(id)!)) : [];
  const firing = new Set([...localFps, ...missing.map((a) => a.fingerprint)]);
  for (const id of gone) {
    firing.delete(identity.get(id)!);
  }
  const ending = [...new Set([...duplicates, ...gone])];
  if (ending.length) {
    await tx(pool, async (c) => {
      const t = (await c.query<{ now: Date }>('SELECT now() AS now')).rows[0] as { now: Date };
      for (const id of ending) {
        if (await resolveMissing(c, id, t.now)) {
          resolved++;
        }
      }
      if (resolved) {
        await c.query("SELECT pg_notify('srenautix_ingest', $1)", [clusterId]);
      }
    });
  }
  if (duplicates.length) {
    logger.info('合并重复存下的告警', { cluster_id: clusterId, alert_ids: duplicates });
  }
  if (ok.length) {
    // 完整读取成功：对账本身就是接入路径，计入接入与 Watchdog（只用对账的部署不会因此误报 IngestSilent、WatchdogMissing）
    await ingest.observeReconcile(
      remote.size,
      [...remote.values()].some((a) => a.alertname === watchdog),
    );
  }
  metrics.reconcileRepairs.inc({ kind: 'added' }, missing.length);
  metrics.reconcileRepairs.inc({ kind: 'resolved' }, resolved);
  return { added: missing.length, resolved, sources: ok, firing };
}

function observeIngestDelay(metrics: ServerMetrics, path: 'full' | 'fast', alerts: readonly RawAlert[]): void {
  const now = Date.now();
  for (const a of alerts) {
    metrics.ingestDelay.observe({ path }, Math.max(0, (now - a.startsAt.getTime()) / 1000));
  }
}

/**
 * Alertmanager 新增告警的快速轮询（ADR 0160）：两轮完整对账之间，每 additions_interval 读一次 Alertmanager v2 的活动告警，
 * 只补写本地还没有的触发中告警，不结束任何告警，不读状态库与规则引擎。本地已有哪些告警取最近一轮完整对账的结果
 * （加上快速轮询自己补写的）；完整对账成功之前不轮询。结束告警与 ALERTS_FOR_STATE 的补写仍由完整对账负责。
 */
export class AlertmanagerAdditions {
  private known: Set<string> | null = null;

  constructor(
    private readonly clusterId: string,
    private readonly alertmanagerUrl: string,
    private readonly bearerToken: string | null,
    private readonly timeoutMs: number,
    private readonly ingest: IngestService,
    private readonly metrics: ServerMetrics,
    private readonly selfLabel: string,
    private readonly watchdog: string,
  ) {}

  /** 完整对账成功后更新本地触发中告警的身份指纹 */
  update(firing: ReadonlySet<string>): void {
    this.known = new Set(firing);
  }

  /** 不再知道本地有哪些告警（失去主实例）：下一轮完整对账成功之前不轮询 */
  reset(): void {
    this.known = null;
  }

  /** 一轮快速轮询；返回补写的告警数 */
  async pollOnce(): Promise<number> {
    const known = this.known;
    if (known === null) {
      return 0;
    }
    const now = new Date();
    const list = (await getJson(
      `${this.alertmanagerUrl}/api/v2/alerts?active=true&silenced=true&inhibited=true&unprocessed=true`,
      this.bearerToken,
      this.timeoutMs,
    )) as AlertmanagerAlert[];
    const fresh = new Map<string, RawAlert>();
    for (const a of list) {
      const r = fromAlertmanager(a, 'reconcile', now);
      if (
        r.status === 'firing' &&
        !known.has(r.fingerprint) &&
        r.labels[this.selfLabel] === undefined &&
        r.alertname !== this.watchdog &&
        !isIgnorable(r.labels)
      ) {
        fresh.set(r.fingerprint, r);
      }
    }
    if (!fresh.size) {
      return 0;
    }
    const added = [...fresh.values()];
    await this.ingest.write(this.clusterId, 'reconcile', 'reconcile', added, {
      reconcile: added.map((a) => a.labels),
    });
    observeIngestDelay(this.metrics, 'fast', added);
    for (const fp of fresh.keys()) {
      known.add(fp);
    }
    this.metrics.reconcileRepairs.inc({ kind: 'added_fast' }, added.length);
    return added.length;
  }
}

/** reader 推送的告警对账快照（协议 AlertReconcileSnapshot）。 */
export interface ReaderAlertSnapshot {
  taken_at: string;
  alertmanager: { status: 'ok' | 'error'; truncated: boolean; items: unknown[] } | null;
  rules: {
    status: 'ok' | 'error';
    truncated: boolean;
    items: Array<{ labels: Record<string, string>; state: 'pending' | 'firing'; active_at: string | null }>;
  } | null;
}

/**
 * 多集群：分支 reader 每 60 秒推送本集群 Alertmanager 与规则引擎的快照，按同样的规则对账。
 * 只有全部部分都读取成功且没有截断时，才据此结束告警源中已经没有的告警。
 */
export async function reconcileFromReader(
  pool: pg.Pool,
  clusterId: string,
  snap: ReaderAlertSnapshot,
  ingest: IngestService,
  metrics: ServerMetrics,
  selfLabel: string,
  watchdog: string,
): Promise<ReconcileResult> {
  const now = new Date(snap.taken_at);
  const remote = new Map<string, RawAlert>();
  for (const a of snap.alertmanager?.status === 'ok' ? snap.alertmanager.items : []) {
    const r = fromAlertmanager(a as AlertmanagerAlert, 'reconcile', now);
    if (r.status === 'firing') {
      remote.set(r.fingerprint, r);
    }
  }
  for (const s of snap.rules?.status === 'ok' ? snap.rules.items : []) {
    if (s.state !== 'firing' || !s.active_at) {
      continue;
    }
    const r = firingRuleAlert(s.labels, new Date(s.active_at));
    if (r && !remote.has(r.fingerprint)) {
      remote.set(r.fingerprint, r);
    }
  }
  const parts = [snap.alertmanager, snap.rules].filter((p) => p !== null);
  const complete = parts.length > 0 && parts.every((p) => p?.status === 'ok' && !p.truncated);
  return applyRemote(pool, clusterId, remote, complete ? ['reader'] : [], ingest, metrics, selfLabel, watchdog);
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
