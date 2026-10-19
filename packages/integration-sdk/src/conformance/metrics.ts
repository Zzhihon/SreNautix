// metrics/v1 一致性测试。被测后端事先装入 conformanceMetricSeries() 的数据（时间零点 2026-01-01T00:00:00Z），
// 套件按已知数据检查 query、query_range、series、标签名、截断、错误映射、方言与结果的契约形状。

import { validatorFor } from '@srenautix/contract';
import { toIso } from '../clock.js';
import type { PrometheusApiAdapter } from '../metrics/prometheus-api.js';
import type { FixtureMetricSeries } from '../testing/tsdb.js';
import { Checks, expectEq, expectReject, type ConformanceReport } from './report.js';

export const CONFORMANCE_T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;

/** 3 个 Pod 的计数器，每分钟各加 1、2、3；共 61 个点（0–60 分钟） */
export function conformanceMetricSeries(): FixtureMetricSeries[] {
  return [1, 2, 3].map((k) => ({
    labels: { __name__: 'conformance_requests_total', namespace: 'conf', pod: `p-${k}`, job: 'conf' },
    points: Array.from({ length: 61 }, (_, i) => ({ t: CONFORMANCE_T0 + i * MIN, v: i * k })),
  }));
}

export async function runMetricsConformance(a: PrometheusApiAdapter): Promise<ConformanceReport> {
  const c = new Checks('metrics/v1', a.config.id);
  const clock = { from: toIso(CONFORMANCE_T0), to: toIso(CONFORMANCE_T0 + 60 * MIN) };
  const at = toIso(CONFORMANCE_T0 + 30 * MIN);
  const validResult = validatorFor('integrations/metrics/v1/metrics.schema.json#/$defs/QueryResult');

  await c.run('query-instant', '瞬时查询按标签返回已知值', async () => {
    const r = await a.query({
      expr: 'sum by (pod) (conformance_requests_total)',
      dialect: 'promql',
      time: at,
      clock_window: clock,
      timeout_ms: 10_000,
    });
    if (!validResult(r)) {
      throw new Error(`结果不符合契约：${JSON.stringify(validResult.errors)}`);
    }
    const got = Object.fromEntries(r.series.map((s) => [s.labels['pod'], s.values[0]]));
    expectEq('各 Pod 的值', got, { 'p-1': 30, 'p-2': 60, 'p-3': 90 });
    expectEq('时间戳', r.series[0]!.times[0], CONFORMANCE_T0 + 30 * MIN);
    return '30、60、90';
  });
  await c.run('query-rate', 'rate 按秒计算', async () => {
    const r = await a.query({
      expr: 'sum(rate(conformance_requests_total[5m]))',
      dialect: 'promql',
      time: at,
      clock_window: clock,
      timeout_ms: 10_000,
    });
    const v = r.series[0]!.values[0]!;
    if (Math.abs(v - 0.1) > 1e-9) {
      throw new Error(`期望 0.1/s，实际 ${v}`);
    }
    return '0.1/s';
  });
  await c.run('query-range', '区间查询按步长返回点，时间为 unix 毫秒', async () => {
    const r = await a.queryRange({
      expr: 'sum(conformance_requests_total)',
      dialect: 'promql',
      window: { from: toIso(CONFORMANCE_T0 + 10 * MIN), to: toIso(CONFORMANCE_T0 + 20 * MIN) },
      step_seconds: 300,
      clock_window: clock,
      timeout_ms: 10_000,
      max_series: 10,
    });
    if (!validResult(r)) {
      throw new Error(`结果不符合契约：${JSON.stringify(validResult.errors)}`);
    }
    expectEq(
      '时间',
      r.series[0]!.times,
      [10, 15, 20].map((m) => CONFORMANCE_T0 + m * MIN),
    );
    expectEq('值', r.series[0]!.values, [60, 90, 120]);
    return '3 个点';
  });
  await c.run('range-truncation', '序列数超过 max_series 时截断并标记', async () => {
    const r = await a.queryRange({
      expr: 'conformance_requests_total',
      dialect: 'promql',
      window: { from: toIso(CONFORMANCE_T0 + 10 * MIN), to: toIso(CONFORMANCE_T0 + 11 * MIN) },
      step_seconds: 60,
      clock_window: clock,
      timeout_ms: 10_000,
      max_series: 2,
    });
    expectEq('序列数', r.series.length, 2);
    expectEq('truncated', r.truncated, true);
    return '3 条截断为 2 条';
  });
  await c.run('series', 'series 返回标签集，limit 截断', async () => {
    const r = await a.series({ match: ['conformance_requests_total'], window: clock, limit: 2 }, clock);
    expectEq('条数', r.series.length, 2);
    expectEq('truncated', r.truncated, true);
    return '截断为 2 条';
  });
  await c.run('label-values', '标签值', async () => {
    expectEq('pod', await a.labelValues('pod', clock, clock, ['conformance_requests_total']), ['p-1', 'p-2', 'p-3']);
    return 'p-1、p-2、p-3';
  });
  await c.run('empty-result', '没有匹配的序列时返回空结果', async () => {
    const r = await a.query({
      expr: 'conformance_requests_total{pod="none"}',
      dialect: 'promql',
      time: at,
      clock_window: clock,
      timeout_ms: 10_000,
    });
    expectEq('序列数', r.series.length, 0);
    return '空';
  });
  await c.run('syntax-error', '语法错误在本地拒绝', () =>
    expectReject(
      '语法错误',
      () => a.query({ expr: 'sum(', dialect: 'promql', time: at, clock_window: clock, timeout_ms: 10_000 }),
      'QuerySyntaxError',
    ),
  );
  await c.run('backend-error', '后端执行错误映射为 DatasourceError', () =>
    // 按 job 匹配时两侧各有 3 条序列（多对多）：语法合法，执行时报错
    expectReject(
      '执行错误',
      () =>
        a.query({
          expr: 'conformance_requests_total + on (job) conformance_requests_total',
          dialect: 'promql',
          time: at,
          clock_window: clock,
          timeout_ms: 10_000,
        }),
      'DatasourceError',
    ),
  );
  return c.report();
}
