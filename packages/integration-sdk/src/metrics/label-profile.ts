// 标签档案探测（DESIGN §6.2）：每个逻辑字段在该数据源中对应的标签名、外部标签 cluster、
// 抓取间隔与租户。领域包的查询模板一律用规范名书写（namespace、pod、container、node），
// 执行前按档案改写。

import type { LabelProfile, TimeWindow } from '@srenautix/contract';
import { toIso, toMillis } from '../clock.js';
import { DatasourceError } from '../errors.js';
import type { PrometheusApiAdapter } from './prometheus-api.js';

/** 各逻辑字段的候选标签名，按优先级 */
export const LABEL_CANDIDATES = {
  namespace: ['namespace', 'kubernetes_namespace', 'k8s_namespace_name', 'exported_namespace'],
  pod: ['pod', 'kubernetes_pod_name', 'k8s_pod_name', 'pod_name'],
  container: ['container', 'k8s_container_name', 'container_name'],
  node: ['node', 'kubernetes_node', 'k8s_node_name'],
} as const;

/** 带 Kubernetes 对象标签的常见指标：kube-state-metrics、cAdvisor、OTel k8s 接收器 */
const K8S_METRICS =
  '{__name__=~"kube_pod_info|kube_pod_container_info|kube_node_info|container_cpu_usage_seconds_total|k8s_pod_cpu_usage|k8s_pod_phase|k8s_container_restarts|k8s_node_condition_ready"}';

export interface LabelProfileOptions {
  /** 外部标签 cluster 的名字；不填时探测 up 上是否有 cluster 标签 */
  cluster_label?: string | null;
  tenant?: string | null;
}

export async function detectLabelProfile(
  adapter: PrometheusApiAdapter,
  at: string,
  clock: TimeWindow,
  opts: LabelProfileOptions = {},
): Promise<LabelProfile> {
  const end = toMillis(at);
  const window = { from: toIso(Math.max(end - 3600_000, toMillis(clock.from))), to: at };
  const names = new Set(await adapter.labelNames(window, clock, [K8S_METRICS]));
  const pick = (field: keyof typeof LABEL_CANDIDATES): string => {
    const hit = LABEL_CANDIDATES[field].find((c) => names.has(c));
    if (!hit) {
      throw new DatasourceError(
        adapter.config.id,
        `探测标签档案失败：${window.from}–${window.to} 内 Kubernetes 指标上没有 ${field} 对应的标签（候选 ${LABEL_CANDIDATES[field].join('、')}）`,
      );
    }
    return hit;
  };

  let cluster: string | null = opts.cluster_label ?? null;
  if (cluster === null) {
    const upLabels = new Set(await adapter.labelNames(window, clock, ['up']));
    cluster = upLabels.has('cluster') ? 'cluster' : null;
  }

  // 10 分钟内每条 up 序列的样本数换算抓取间隔，取中位数
  const r = await adapter.query({
    expr: 'quantile(0.5, 600 / count_over_time(up[10m]))',
    dialect: 'promql',
    time: at,
    clock_window: clock,
    timeout_ms: 15_000,
  });
  const v = r.series[0]?.values[0];
  if (v === undefined || v === null || !Number.isFinite(v)) {
    throw new DatasourceError(adapter.config.id, `探测抓取间隔失败：${at} 前 10 分钟没有 up 样本`);
  }

  return {
    namespace: pick('namespace'),
    pod: pick('pod'),
    container: pick('container'),
    node: pick('node'),
    cluster,
    scrape_interval_seconds: Math.max(1, Math.round(v)),
    tenant: opts.tenant ?? null,
  };
}

/** 规范名 → 档案中的标签名（只含不同的项） */
export function renameMap(p: LabelProfile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['namespace', 'pod', 'container', 'node'] as const) {
    if (p[k] !== k) {
      out[k] = p[k];
    }
  }
  return out;
}

/** 由抓取间隔推导的 $rate_window：至少 4 个抓取间隔，且不小于 1 分钟 */
export function rateWindow(p: LabelProfile): string {
  const s = Math.max(60, 4 * p.scrape_interval_seconds);
  return s % 60 === 0 ? `${s / 60}m` : `${s}s`;
}
