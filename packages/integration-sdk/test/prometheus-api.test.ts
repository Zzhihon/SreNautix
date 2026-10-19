import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrometheusApiAdapter } from '../src/metrics/prometheus-api.js';
import { ClockWindowViolation, DatasourceError } from '../src/errors.js';
import { startPrometheus, startVictoriaMetrics, type FixtureMetricSeries, type TsdbInstance } from '../src/testing/tsdb.js';
import { toIso } from '../src/clock.js';

// 2026-01-01T00:00:00Z 起每分钟一个点，共 60 分钟
const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const fixtures: FixtureMetricSeries[] = [
  {
    labels: { __name__: 'kube_pod_container_status_restarts_total', namespace: 'app', pod: 'web-0', container: 'web' },
    points: Array.from({ length: 61 }, (_, i) => ({ t: T0 + i * MIN, v: i < 30 ? 0 : i - 29 })),
  },
  {
    labels: { __name__: 'kube_pod_container_status_restarts_total', namespace: 'app', pod: 'web-1', container: 'web' },
    points: Array.from({ length: 61 }, (_, i) => ({ t: T0 + i * MIN, v: 0 })),
  },
];
const clock = { from: toIso(T0), to: toIso(T0 + 60 * MIN) };

const backends: TsdbInstance[] = [];
beforeAll(async () => {
  backends.push(await startPrometheus(fixtures), await startVictoriaMetrics(fixtures));
});
afterAll(async () => {
  await Promise.all(backends.map((b) => b.stop()));
});

describe.each(['prometheus', 'victoria-metrics'] as const)('Prometheus API 适配器（%s）', (kind) => {
  const adapter = () => {
    const b = backends.find((x) => x.kind === kind)!;
    return new PrometheusApiAdapter({ id: kind, url: b.url, dialects: kind === 'prometheus' ? ['promql'] : ['promql', 'metricsql'] });
  };

  it('query 与 query_range 返回同样的数据', async () => {
    const a = adapter();
    const inst = await a.query({
      expr: 'sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace="app"}[30m]))',
      dialect: 'promql',
      time: toIso(T0 + 60 * MIN),
      clock_window: clock,
      timeout_ms: 10_000,
    });
    const byPod = Object.fromEntries(inst.series.map((s) => [s.labels['pod'], Math.round(s.values[0]!)]));
    expect(byPod).toEqual({ 'web-0': 30, 'web-1': 0 });

    const range = await a.queryRange({
      expr: 'max(kube_pod_container_status_restarts_total{namespace="app"})',
      dialect: 'promql',
      window: { from: toIso(T0 + 10 * MIN), to: toIso(T0 + 60 * MIN) },
      step_seconds: 600,
      clock_window: clock,
      timeout_ms: 10_000,
      max_series: 10,
    });
    expect(range.series).toHaveLength(1);
    expect(range.series[0]!.values).toEqual([0, 0, 1, 11, 21, 31]);
  });

  it('series 与 label 值', async () => {
    const a = adapter();
    const s = await a.series({ match: ['kube_pod_container_status_restarts_total'], window: clock, limit: 1 }, clock);
    expect(s.truncated).toBe(true);
    expect(await a.labelValues('pod', clock, clock)).toEqual(['web-0', 'web-1']);
  });

  it('拒绝超出时钟窗口的请求', async () => {
    const a = adapter();
    await expect(
      a.query({ expr: 'up', dialect: 'promql', time: toIso(T0 + 61 * MIN), clock_window: clock, timeout_ms: 1000 }),
    ).rejects.toThrow(ClockWindowViolation);
    // 区间 [1h] 回看到时钟窗口之前
    await expect(
      a.query({ expr: 'rate(up[1h])', dialect: 'promql', time: toIso(T0 + 30 * MIN), clock_window: clock, timeout_ms: 1000 }),
    ).rejects.toThrow(ClockWindowViolation);
    await expect(
      a.query({ expr: 'up offset -10m', dialect: 'promql', time: toIso(T0 + 55 * MIN), clock_window: clock, timeout_ms: 1000 }),
    ).rejects.toThrow(ClockWindowViolation);
    await expect(
      a.query({ expr: 'up @ 1767225600', dialect: 'promql', time: toIso(T0 + 55 * MIN), clock_window: clock, timeout_ms: 1000 }),
    ).rejects.toThrow(ClockWindowViolation);
  });

  it('方言不匹配时报错', async () => {
    if (kind === 'prometheus') {
      await expect(
        adapter().query({ expr: 'rate(up)', dialect: 'metricsql', time: toIso(T0 + 30 * MIN), clock_window: clock, timeout_ms: 1000 }),
      ).rejects.toThrow(DatasourceError);
    } else {
      const r = await adapter().query({
        expr: 'max(rate(kube_pod_container_status_restarts_total))',
        dialect: 'metricsql',
        time: toIso(T0 + 50 * MIN),
        clock_window: clock,
        timeout_ms: 1000,
      });
      expect(r.series).toHaveLength(1);
    }
  });
});
