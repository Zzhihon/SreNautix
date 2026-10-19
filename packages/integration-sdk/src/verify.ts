// 每项能力的 verify() 探测（DESIGN §10.1）：对真实后端发出最小的只读请求，结果决定能力是否可用。
// 探测在当前时刻进行，时钟窗口取最近 1 小时。

import { toIso } from './clock.js';
import type { LokiAdapter } from './logs/loki.js';
import type { PrometheusApiAdapter } from './metrics/prometheus-api.js';
import type { TempoAdapter } from './traces/tempo.js';

export type VerifyResult = Record<string, { ok: boolean; detail: string }>;

async function probe(name: string, out: VerifyResult, f: () => Promise<string>): Promise<void> {
  try {
    out[name] = { ok: true, detail: await f() };
  } catch (err) {
    out[name] = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function recentClock(now: number) {
  return { from: toIso(now - 3600_000), to: toIso(now) };
}

export async function verifyMetrics(a: PrometheusApiAdapter, now = Date.now()): Promise<VerifyResult> {
  const out: VerifyResult = {};
  const clock = recentClock(now);
  const at = clock.to;
  await probe('metrics.query', out, async () => {
    const r = await a.query({ expr: 'vector(1)', dialect: 'promql', time: at, clock_window: clock, timeout_ms: 5000 });
    if (r.series[0]?.values[0] !== 1) {
      throw new Error('vector(1) 没有返回 1');
    }
    return 'vector(1) = 1';
  });
  await probe('metrics.query_range', out, async () => {
    const r = await a.queryRange({
      expr: 'vector(1)',
      dialect: 'promql',
      window: { from: toIso(now - 300_000), to: at },
      step_seconds: 60,
      clock_window: clock,
      timeout_ms: 5000,
      max_series: 1,
    });
    return `${r.series[0]?.values.length ?? 0} 个点`;
  });
  await probe('metrics.series', out, async () => {
    const r = await a.series({ match: ['up'], window: { from: toIso(now - 600_000), to: at }, limit: 1 }, clock);
    return `up 序列 ${r.series.length}${r.truncated ? '+' : ''}`;
  });
  await probe('metrics.rules', out, async () => `${(await a.rules()).rules.length} 条告警规则`);
  await probe('metrics.label_profile', out, async () => {
    const names = await a.labelNames({ from: toIso(now - 3600_000), to: at }, clock);
    if (!names.length) {
      throw new Error('最近 1 小时没有任何标签');
    }
    return `${names.length} 个标签名`;
  });
  return out;
}

export async function verifyLogs(a: LokiAdapter, namespace: string, now = Date.now()): Promise<VerifyResult> {
  const out: VerifyResult = {};
  const clock = recentClock(now);
  await probe('logs.match', out, async () => {
    const r = await a.match({
      selector: { cluster_id: 'verify', namespace, pods: [], containers: [], labels: {} },
      contains: '',
      regex: null,
      window: clock,
      limit: 1,
      clock_window: clock,
    });
    return `${r.lines.length} 行`;
  });
  await probe('logs.query', out, async () => {
    const names = await a.labelNames(clock, clock);
    return `${names.length} 个标签名`;
  });
  return out;
}

export async function verifyTraces(a: TempoAdapter, now = Date.now()): Promise<VerifyResult> {
  const out: VerifyResult = {};
  const clock = recentClock(now);
  await probe('traces.search', out, async () => {
    const r = await a.search({ query: '{}', dialect: 'traceql', window: clock, limit: 1, clock_window: clock });
    return `${r.hits.length} 条`;
  });
  return out;
}
