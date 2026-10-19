// 信号备选的探测（DESIGN §6.2）：加载时按优先级逐个探测，按数据源记录最终选中的一个。
// 指标备选：渲染出的查询中每个指标名在探测窗口内都有序列，并且（声明了 probe 时）probe 查询返回非空。
// 日志与链路备选：数据源具备对应能力与方言即选中。

import type { Signal, SignalAlternative, TimeWindow } from '@srenautix/contract';
import { DatasourceError, toIso, toMillis, type PromqlEngine } from '@srenautix/integration-sdk';
import type { Capability, EvidenceDataSource } from '../runtime/datasource.js';
import { renderMetrics, type RenderContext } from './render.js';

/**
 * 备选未被选中的原因：capability 数据源没有所需能力；dialect 方言不被接受；missing_metric 指标在探测窗口内不存在；
 * probe probe 查询没有结果；error 探测时数据源报错
 */
export type RejectCause = 'capability' | 'dialect' | 'missing_metric' | 'probe' | 'error';

export interface SignalResolution {
  /** <pack>/<signal id> */
  signal: string;
  kind: Signal['kind'];
  /** 选中的备选序号；没有可用备选时为 null */
  index: number | null;
  alternative: SignalAlternative | null;
  /** 每个备选未被选中的原因 */
  rejected: Array<{ index: number; cause: RejectCause; reason: string; capability?: Capability }>;
}

/** 备选需要的数据源能力 */
export function alternativeCapability(kind: Signal['kind'], alt: SignalAlternative): Capability {
  const d = alt.dialect ?? 'promql';
  if (kind === 'metrics') {
    return 'metrics.query';
  }
  if (kind === 'logs') {
    return d === 'logs_match' ? 'logs.match' : 'logs.query';
  }
  return 'traces.search';
}

export async function resolveSignal(
  key: string,
  signal: Signal,
  ds: EvidenceDataSource,
  engine: PromqlEngine,
  at: string,
  clock: TimeWindow,
  probeWindowSeconds = 3600,
): Promise<SignalResolution> {
  const rejected: SignalResolution['rejected'] = [];
  for (const [i, alt] of signal.alternatives.entries()) {
    const cap = alternativeCapability(signal.kind, alt);
    if (!ds.capabilities.has(cap)) {
      rejected.push({ index: i, cause: 'capability', reason: `数据源没有能力 ${cap}`, capability: cap });
      continue;
    }
    if (signal.kind !== 'metrics') {
      const d = alt.dialect;
      const okDialect =
        signal.kind === 'logs' ? d === 'logs_match' || (d === 'logql' && ds.ids.logs !== null) : d === 'traceql';
      if (!okDialect) {
        rejected.push({ index: i, cause: 'dialect', reason: `数据源不接受方言 ${d ?? '未声明'}` });
        continue;
      }
      return { signal: key, kind: signal.kind, index: i, alternative: alt, rejected };
    }
    const dialect = alt.dialect ?? 'promql';
    if (dialect !== 'promql' && dialect !== 'metricsql') {
      rejected.push({ index: i, cause: 'dialect', reason: `指标信号不支持方言 ${dialect}` });
      continue;
    }
    if (!ds.metricsDialects.has(dialect)) {
      rejected.push({ index: i, cause: 'dialect', reason: `数据源不接受 ${dialect}` });
      continue;
    }
    if (!ds.labelProfile) {
      throw new Error('指标数据源没有标签档案');
    }
    // 探测只关心指标名：实体用占位值，集群范围的选择器，不注入集群标签，参数取占位值 1
    const ctx: RenderContext = {
      entity: {
        cluster_id: '',
        kind: 'cluster',
        namespace: 'srenautix-probe',
        name: 'srenautix-probe',
        node: 'srenautix-probe',
      },
      params: Object.fromEntries([...alt.expr.matchAll(/\$params\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => [m[1]!, 1])),
      windowSeconds: probeWindowSeconds,
      profile: { ...ds.labelProfile, cluster: null },
    };
    const window = { from: toIso(Math.max(toMillis(at) - probeWindowSeconds * 1000, toMillis(clock.from))), to: at };
    const names = [
      ...new Set(
        engine
          .analyze(renderMetrics(engine, alt, ctx), dialect)
          .selectors.map((s) => s.metric)
          .filter(Boolean),
      ),
    ];
    try {
      const missing: string[] = [];
      for (const n of names) {
        if (!(await ds.metricExists(n, window, clock))) {
          missing.push(n);
        }
      }
      if (missing.length) {
        rejected.push({ index: i, cause: 'missing_metric', reason: `指标不存在：${missing.join('、')}` });
        continue;
      }
      if (alt.probe) {
        const probe = renderMetrics(engine, { ...alt, expr: alt.probe }, ctx);
        const r = await ds.query({ expr: probe, dialect, time: at, clock_window: clock, timeout_ms: 10_000 });
        if (!r.series.length) {
          rejected.push({ index: i, cause: 'probe', reason: `probe 没有结果：${probe}` });
          continue;
        }
      }
    } catch (err) {
      if (err instanceof DatasourceError) {
        rejected.push({ index: i, cause: 'error', reason: `探测失败：${err.message}` });
        continue;
      }
      throw err;
    }
    return { signal: key, kind: signal.kind, index: i, alternative: alt, rejected };
  }
  return { signal: key, kind: signal.kind, index: null, alternative: null, rejected };
}
