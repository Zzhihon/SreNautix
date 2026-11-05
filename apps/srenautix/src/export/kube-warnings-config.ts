// server 配置 → collectKubeWarnings 的依赖（ADR 0185）：Loki 事件日志来自 datasources.loki 与它的 kube_events，
// 指标来自调用方传入的 Prometheus 适配器与标签档案（证据数据源探测出的档案），拓扑历史来自 TopologyStore。
import type { LabelProfile, MetricsQueryRangeRequest, MetricsQueryResult } from '@srenautix/contract';
import { LokiAdapter } from '@srenautix/integration-sdk';
import { parseDuration } from '../config/files.js';
import type { ServerConfig } from '../config/server.js';
import { kubeEventsSource } from './kube-events.js';
import { DEFAULT_GROUPING, type KubeWarningsDeps, type PlacementSource } from './kube-warnings.js';

/** kube-state-metrics 区间查询的超时与序列数上限 */
const METRICS_TIMEOUT_MS = 60_000;
const METRICS_MAX_SERIES = 5000;

export function kubeWarningsDeps(
  c: ServerConfig,
  ports: {
    metrics: {
      adapter: { queryRange(req: MetricsQueryRangeRequest): Promise<MetricsQueryResult> };
      profile: LabelProfile;
    };
    placements: PlacementSource;
    now?: () => number;
  },
): KubeWarningsDeps {
  const loki = c.datasources.loki;
  return {
    events: loki
      ? {
          adapter: new LokiAdapter({
            id: 'loki',
            url: loki.url,
            labels: loki.labels,
            bearer_token_file: loki.bearer_token_file ?? null,
            ca_file: loki.ca_file ?? null,
            tenant: loki.tenant ?? null,
          }),
          source: kubeEventsSource(loki.kube_events, loki.labels.cluster),
          maxSeries: loki.kube_events.max_series,
          timeoutMs: parseDuration('datasources.loki.kube_events.timeout', loki.kube_events.timeout),
        }
      : null,
    metrics: {
      adapter: ports.metrics.adapter,
      dialect: c.datasources.prometheus.dialect,
      profile: ports.metrics.profile,
      maxSeries: METRICS_MAX_SERIES,
      timeoutMs: METRICS_TIMEOUT_MS,
    },
    placements: ports.placements,
    grouping: DEFAULT_GROUPING,
    now: ports.now ?? Date.now,
  };
}
