import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { RawAlert } from '../ingest/normalize.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { tx, type Queryable } from '../store/pool.js';
import type { ServerConfig } from '../config/server.js';
import { parseDuration } from '../config/files.js';
import type { HealthState, ObjectHealth } from './health.js';

// 集群状态检测器（ADR 0105）：按阈值把不健康对象合成为告警（source detector），与告警规则同样进入接入、收敛与研判。
// - 对象在某个状态持续超过阈值时发出告警，告警的开始时间是"进入状态 + 阈值"（与告警规则的 for 相同）；
// - 同一对象上已有同类告警规则在触发时不合成，已合成的恢复（去重）；
// - 状态消失（完整上报里没有它）时告警恢复。

export interface DetectorSettings {
  namespaces: readonly string[];
  excludeNamespaces: readonly string[];
  thresholdsMs: Partial<Record<HealthState, number>>;
  severity: 'critical' | 'warning' | 'info';
  /** 状态 → 视为同一问题的告警规则名（默认表加上配置） */
  equivalentAlerts: Readonly<Record<HealthState, readonly string[]>>;
}

/** server 配置的 detectors → 检测设置 */
export function detectorSettings(d: ServerConfig['detectors']): DetectorSettings {
  const ms = (k: string, v: string) => parseDuration(`detectors.${k}`, v);
  const equivalentAlerts = Object.fromEntries(
    (Object.keys(DEFAULT_EQUIVALENTS) as HealthState[]).map((st) => [
      st,
      [...new Set([...DEFAULT_EQUIVALENTS[st], ...(d.equivalent_alerts[st] ?? [])])],
    ]),
  ) as Record<HealthState, string[]>;
  return {
    namespaces: d.namespaces,
    excludeNamespaces: d.exclude_namespaces,
    thresholdsMs: {
      pod_init: ms('pod_init_after', d.pod_init_after),
      pod_pending: ms('pod_pending_after', d.pod_pending_after),
      rollout_stalled: ms('rollout_stalled_after', d.rollout_stalled_after),
      crash_loop: ms('crash_loop_after', d.crash_loop_after),
      pdb_blocking: ms('pdb_blocked_after', d.pdb_blocked_after),
      ...(d.job_failed ? { job_failed: 0 } : {}),
    },
    severity: d.severity,
    equivalentAlerts,
  };
}

/** 合成告警的告警名 */
export const DETECTOR_ALERTS: Readonly<Record<HealthState, string>> = {
  pod_pending: 'SreNautixPodPending',
  pod_init: 'SreNautixPodInitStuck',
  crash_loop: 'SreNautixCrashLoop',
  rollout_stalled: 'SreNautixRolloutStalled',
  pdb_blocking: 'SreNautixPdbBlockingEviction',
  job_failed: 'SreNautixJobFailed',
};

/** 常见告警规则（kube-prometheus 与 CCHP）里与各状态相同的告警名 */
export const DEFAULT_EQUIVALENTS: Readonly<Record<HealthState, readonly string[]>> = {
  pod_pending: ['KubePodNotReady', 'KubePodPendingTooLong', 'KubePodNotScheduled'],
  pod_init: ['KubePodInitializingTooLong', 'KubePodNotReady'],
  crash_loop: ['KubePodCrashLooping'],
  rollout_stalled: [
    'KubeDeploymentRolloutStuck',
    'KubeDeploymentReplicasMismatch',
    'KubeDeploymentReplicasUnavailable',
    'KubeDeploymentGenerationMismatch',
    'KubeStatefulSetRolloutStuck',
    'KubeStatefulSetReplicasMismatch',
    'KubeStatefulSetReplicasNotReady',
    'KubeStatefulSetUpdateNotRolledOut',
    'KubeDaemonSetRolloutStuck',
    'KubeDaemonSetPodsUnavailable',
  ],
  pdb_blocking: ['KubePdbBlockingEviction', 'KubePdbNotEnoughHealthyPods'],
  job_failed: ['KubeJobFailed', 'KubeJobFailedCritical'],
};

const SUMMARY: Readonly<Record<HealthState, string>> = {
  pod_pending: 'Pod 停在 Pending',
  pod_init: 'Pod 停在 Init',
  crash_loop: '容器反复崩溃（CrashLoopBackOff）',
  rollout_stalled: '发布停滞',
  pdb_blocking: 'PodDisruptionBudget 阻塞驱逐',
  job_failed: 'Job 失败',
};

/** 标签契约里的 entity_kind 与按标签推断用的对象标签 */
const OBJECT_LABEL: Readonly<Record<string, string>> = {
  Pod: 'pod',
  Deployment: 'deployment',
  StatefulSet: 'statefulset',
  DaemonSet: 'daemonset',
  Job: 'job_name',
  PodDisruptionBudget: 'poddisruptionbudget',
};

export function fingerprintOf(clusterId: string, h: Pick<ObjectHealth, 'key' | 'state'>): string {
  return createHash('sha256').update(`srenautix-detector|${clusterId}|${h.state}|${h.key}`).digest('hex').slice(0, 16);
}

function namespaceAllowed(ns: string | null, s: DetectorSettings): boolean {
  if (ns !== null && s.excludeNamespaces.includes(ns)) {
    return false;
  }
  return s.namespaces.includes('*') || (ns !== null && s.namespaces.includes(ns));
}

/** 不健康对象 → 合成告警（只包含超过阈值、命名空间允许的对象） */
export function findingAlert(clusterId: string, h: ObjectHealth, s: DetectorSettings, now: number): RawAlert | null {
  const threshold = s.thresholdsMs[h.state];
  if (threshold === undefined || !namespaceAllowed(h.namespace, s)) {
    return null;
  }
  const start = Date.parse(h.since) + threshold;
  if (start > now) {
    return null;
  }
  const labels: Record<string, string> = {
    alertname: DETECTOR_ALERTS[h.state],
    severity: s.severity,
    role: 'cause',
    srenautix_detector: h.state,
    entity: h.name,
    entity_kind: h.kind,
  };
  if (h.namespace) {
    labels.namespace = h.namespace;
  }
  const objectLabel = OBJECT_LABEL[h.kind];
  if (objectLabel) {
    labels[objectLabel] = h.name;
  }
  const detail = Object.entries(h.details ?? {})
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return {
    source: 'detector',
    labels,
    annotations: {
      summary: `${SUMMARY[h.state]}：${h.namespace ? `${h.namespace}/` : ''}${h.name}（${h.reason}）`,
      description: [
        h.message,
        detail,
        h.owner ? `owner=${h.owner}` : '',
        h.targets?.length ? `targets=${h.targets.join(',')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 2000),
    },
    severity: s.severity,
    status: 'firing',
    suppressed: 'none',
    startsAt: new Date(start),
    endsAt: null,
    generatorUrl: null,
    fingerprint: fingerprintOf(clusterId, h),
    alertname: DETECTOR_ALERTS[h.state],
  };
}

export interface ScanResult {
  firing: RawAlert[];
  resolved: RawAlert[];
}

/** 写入合成告警（IngestService.write）：同一接入路径，解析实体、写 alert_state 并唤醒事件引擎 */
export type AlertWriter = (clusterId: string, alerts: RawAlert[]) => Promise<void>;

export class DetectorService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly settings: DetectorSettings,
    private readonly write: AlertWriter,
    private readonly metrics: ServerMetrics,
  ) {}

  /**
   * 记录一次上报。complete 为 true 时这是该集群全部不健康对象，替换之前的列表；为 false 时只增改，不删除
   * （reader 列表超过上限或 informer 尚未同步）。
   */
  async report(
    clusterId: string,
    objects: readonly ObjectHealth[],
    complete: boolean,
    observedAt: Date,
  ): Promise<void> {
    await tx(this.pool, async (c) => {
      if (complete) {
        await c.query('DELETE FROM server.object_health WHERE cluster_id = $1', [clusterId]);
      }
      for (const o of objects) {
        await c.query(
          `INSERT INTO server.object_health (cluster_id, key, state, since, body, observed_at) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (cluster_id, key, state) DO UPDATE SET since = excluded.since, body = excluded.body, observed_at = excluded.observed_at`,
          [clusterId, o.key, o.state, o.since, JSON.stringify(o), observedAt],
        );
      }
      await c.query(
        `INSERT INTO server.object_health_reports (cluster_id, observed_at, complete, received_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (cluster_id) DO UPDATE SET observed_at = excluded.observed_at, complete = excluded.complete, received_at = now()`,
        [clusterId, observedAt, complete],
      );
    });
    if (complete) {
      this.metrics.detectorLastScan.set({ cluster_id: clusterId }, observedAt.getTime() / 1000);
    }
    const counts = new Map<string, number>();
    for (const o of objects) {
      counts.set(o.state, (counts.get(o.state) ?? 0) + 1);
    }
    for (const state of Object.keys(DETECTOR_ALERTS)) {
      this.metrics.detectorFindings.set({ cluster_id: clusterId, kind: state }, counts.get(state) ?? 0);
    }
  }

  /** 一轮检测：每个有上报的集群，按阈值合成告警、恢复不再成立或改由告警规则覆盖的告警 */
  async scan(now = Date.now()): Promise<Record<string, ScanResult>> {
    const out: Record<string, ScanResult> = {};
    const clusters = await this.pool.query<{ cluster_id: string; complete: boolean }>(
      'SELECT cluster_id, complete FROM server.object_health_reports',
    );
    for (const { cluster_id: clusterId, complete } of clusters.rows) {
      try {
        out[clusterId] = await this.scanCluster(clusterId, complete, now);
      } catch (e) {
        this.metrics.detectorScanErrors.inc({ cluster_id: clusterId });
        logger.warn('集群状态检测失败，下一轮重试', { cluster_id: clusterId, error: e });
      }
    }
    return out;
  }

  private async scanCluster(clusterId: string, complete: boolean, now: number): Promise<ScanResult> {
    const rows = await this.pool.query<{ body: ObjectHealth }>(
      'SELECT body FROM server.object_health WHERE cluster_id = $1',
      [clusterId],
    );
    const covered = await coveredByRules(this.pool, clusterId, this.settings);
    const desired = new Map<string, { h: ObjectHealth; alert: RawAlert }>();
    for (const { body: h } of rows.rows) {
      const alert = findingAlert(clusterId, h, this.settings, now);
      if (!alert) {
        continue;
      }
      if (covered(h)) {
        continue;
      }
      desired.set(`${h.key}|${h.state}`, { h, alert });
    }
    const current = await this.pool.query<{ key: string; state: string; alert: RawAlert & { startsAt: string } }>(
      'SELECT key, state, alert FROM server.detector_findings WHERE cluster_id = $1',
      [clusterId],
    );
    const firing: RawAlert[] = [];
    const resolved: RawAlert[] = [];
    const known = new Set<string>();
    for (const r of current.rows) {
      const id = `${r.key}|${r.state}`;
      known.add(id);
      const stillThere = rows.rows.some((x) => x.body.key === r.key && x.body.state === r.state);
      // 不完整的上报里没有它，不算恢复；完整上报里没有，或者改由告警规则覆盖、命名空间不再允许，才恢复
      if (!desired.has(id) && (complete || stillThere)) {
        const a = r.alert;
        resolved.push({ ...a, startsAt: new Date(a.startsAt), status: 'resolved', endsAt: new Date(now) });
      }
    }
    for (const [id, d] of desired) {
      if (!known.has(id)) {
        firing.push(d.alert);
      }
    }
    if (firing.length || resolved.length) {
      await this.write(clusterId, [...firing, ...resolved]);
      await tx(this.pool, async (c) => {
        for (const a of resolved) {
          const k = keyOfAlert(a);
          await c.query('DELETE FROM server.detector_findings WHERE cluster_id = $1 AND key = $2 AND state = $3', [
            clusterId,
            k.key,
            k.state,
          ]);
        }
        for (const [, d] of desired) {
          if (firing.includes(d.alert)) {
            await c.query(
              `INSERT INTO server.detector_findings (cluster_id, key, state, fingerprint, starts_at, alert) VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (cluster_id, key, state) DO NOTHING`,
              [
                clusterId,
                d.h.key,
                d.h.state,
                d.alert.fingerprint,
                d.alert.startsAt,
                JSON.stringify({ ...d.alert, key: d.h.key }),
              ],
            );
          }
        }
      });
      for (const a of firing) {
        this.metrics.detectorAlerts.inc({ cluster_id: clusterId, kind: a.labels.srenautix_detector ?? '' });
      }
    }
    return { firing, resolved };
  }
}

function keyOfAlert(a: RawAlert): { key: string; state: string } {
  return { key: (a as unknown as { key: string }).key, state: a.labels.srenautix_detector ?? '' };
}

/**
 * 同一对象上同类的告警规则正在触发时，检测器不合成（去重）。对象相同指：告警的实体就是这个对象，或者告警的组件就是
 * 这个对象（工作负载级的规则）；Pod 的状态也接受落在它属主工作负载上的同类规则。
 */
async function coveredByRules(
  q: Queryable,
  clusterId: string,
  s: DetectorSettings,
): Promise<(h: ObjectHealth) => boolean> {
  const names = [...new Set(Object.values(s.equivalentAlerts).flat())];
  if (!names.length) {
    return () => false;
  }
  const r = await q.query<{ alertname: string; entity_key: string | null; component: string | null }>(
    `SELECT alertname, CASE WHEN entity IS NULL THEN NULL
              ELSE (entity->>'kind') || ':' || coalesce((entity->>'namespace') || '/', '') || (entity->>'name') END AS entity_key,
            component
       FROM server.alert_state
      WHERE cluster_id = $1 AND status = 'firing' AND source <> 'detector' AND alertname = ANY($2::text[])`,
    [clusterId, names],
  );
  return (h) => {
    const eq = new Set(s.equivalentAlerts[h.state] ?? []);
    return r.rows.some(
      (a) =>
        eq.has(a.alertname) &&
        (a.entity_key === h.key ||
          a.component === h.key ||
          (h.owner !== null && h.state !== 'crash_loop' && (a.component === h.owner || a.entity_key === h.owner))),
    );
  };
}
