import type pg from 'pg';
import { parseDuration } from '../kernel/files.js';
import type { Loops } from '../kernel/loops.js';
import type { ServerMetrics } from '../kernel/metrics.js';
import type { IngestService } from '../ingest/service.js';
import type { DetectorsConfig } from './config.js';
import { FirstSeen, objectHealth, type K8sObject } from './health.js';
import { DetectorService, detectorSettings } from './service.js';

/**
 * 集群状态检测器的装配（ADR 0105）：detectors.enabled 时创建并按 detectors.interval 运行；关闭时返回 null。
 * 单集群时由 healthObjects 给出本进程 informer 的对象状态，多集群时对象状态由各 reader 上报（DetectorService.report）
 */
export function startDetectors(d: {
  pool: pg.Pool;
  config: DetectorsConfig;
  clusterId: string;
  ingest: Pick<IngestService, 'write'>;
  metrics: ServerMetrics;
  /** 退出或失去主实例身份时不写入检测器告警（ADR 0128） */
  active: () => boolean;
  /** 本进程 informer 的对象；没有 informer 时为 null */
  healthObjects: () => unknown[] | null;
  loops: Loops;
}): DetectorService | null {
  if (!d.config.enabled) {
    return null;
  }
  const detectors = new DetectorService(
    d.pool,
    detectorSettings(d.config),
    async (clusterId, alerts) => {
      await d.ingest.write(clusterId, 'detector', 'detector', alerts, { detector: alerts.length });
    },
    d.metrics,
    d.active,
  );
  const firstSeen = new FirstSeen();
  d.loops.every(
    parseDuration('detectors.interval', d.config.interval),
    async () => {
      const objects = d.healthObjects();
      if (objects) {
        const now = Date.now();
        await detectors.report(d.clusterId, objectHealth(objects as K8sObject[], firstSeen, now), true, new Date(now));
      }
      await detectors.scan();
    },
    '集群状态检测',
  );
  return detectors;
}
