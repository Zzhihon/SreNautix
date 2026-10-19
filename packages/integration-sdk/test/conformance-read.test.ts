import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toIso } from '../src/clock.js';
import { runClockConformance } from '../src/conformance/clock.js';
import { conformanceLogStreams, runLogsConformance } from '../src/conformance/logs.js';
import { conformanceMetricSeries, CONFORMANCE_T0, runMetricsConformance } from '../src/conformance/metrics.js';
import { conformanceSpans, runTracesConformance } from '../src/conformance/traces.js';
import { LokiAdapter } from '../src/logs/loki.js';
import { PrometheusApiAdapter } from '../src/metrics/prometheus-api.js';
import { startLoki } from '../src/testing/loki.js';
import type { RunningProcess } from '../src/testing/process.js';
import { startTempo } from '../src/testing/tempo.js';
import { startPrometheus, startVictoriaMetrics, type TsdbInstance } from '../src/testing/tsdb.js';
import { TempoAdapter } from '../src/traces/tempo.js';

const MIN = 60_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
let prom: TsdbInstance | undefined;
let vm: TsdbInstance | undefined;
let loki: RunningProcess | undefined;
let tempo: RunningProcess | undefined;

beforeAll(async () => {
  // 并行启动；任何一个失败时，已启动的实例保留下来由 afterAll 停止，再报告第一个错误
  const r = await Promise.allSettled([
    startPrometheus(conformanceMetricSeries()),
    startVictoriaMetrics(conformanceMetricSeries()),
    startLoki(conformanceLogStreams()),
    startTempo(conformanceSpans(NOW)),
  ]);
  prom = r[0].status === 'fulfilled' ? r[0].value : undefined;
  vm = r[1].status === 'fulfilled' ? r[1].value : undefined;
  loki = r[2].status === 'fulfilled' ? r[2].value : undefined;
  tempo = r[3].status === 'fulfilled' ? r[3].value : undefined;
  const failed = r.find((x) => x.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }
});
afterAll(async () => {
  await Promise.all([prom?.stop(), vm?.stop(), loki?.stop(), tempo?.stop()]);
});

const failures = (r: { checks: Array<{ ok: boolean }> }) => r.checks.filter((c) => !c.ok);

describe('一致性测试：读取类', () => {
  it('metrics/v1：Prometheus 与 VictoriaMetrics', async () => {
    for (const b of [prom!, vm!]) {
      const r = await runMetricsConformance(new PrometheusApiAdapter({ id: b.kind, url: b.url, dialects: ['promql'] }));
      expect(failures(r)).toEqual([]);
    }
  });

  it('logs/v1：Loki 的 logs.match', async () => {
    const a = new LokiAdapter({
      id: 'loki',
      url: loki!.url,
      labels: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
    });
    const r = await runLogsConformance({ name: 'loki', match: (req) => a.match(req) });
    expect(failures(r)).toEqual([]);
  });

  it('traces/v1：Tempo', async () => {
    const r = await runTracesConformance(new TempoAdapter({ id: 'tempo', url: tempo!.url }), NOW);
    expect(failures(r)).toEqual([]);
  });

  it('回放时钟窗口：每个读取类适配器都在发出请求之前拒绝越界', async () => {
    const dead = 'http://127.0.0.1:9';
    const clock = { from: toIso(CONFORMANCE_T0), to: toIso(CONFORMANCE_T0 + 60 * MIN) };
    const metrics = new PrometheusApiAdapter({ id: 'dead', url: dead, dialects: ['promql'] });
    const logs = new LokiAdapter({
      id: 'dead',
      url: dead,
      labels: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
    });
    const traces = new TempoAdapter({ id: 'dead', url: dead });
    const subjects = [
      {
        name: 'metrics.query_range',
        read: (window: { from: string; to: string }, c: typeof clock) =>
          metrics.queryRange({
            expr: 'up',
            dialect: 'promql',
            window,
            step_seconds: 60,
            clock_window: c,
            timeout_ms: 2000,
            max_series: 1,
          }),
        readWithLookback: (at: string, s: number, c: typeof clock) =>
          metrics.query({ expr: `rate(up[${s}s])`, dialect: 'promql', time: at, clock_window: c, timeout_ms: 2000 }),
      },
      {
        name: 'metrics.series',
        read: (window: { from: string; to: string }, c: typeof clock) =>
          metrics.series({ match: ['up'], window, limit: 1 }, c),
      },
      {
        name: 'logs.match',
        read: (window: { from: string; to: string }, c: typeof clock) =>
          logs.match({
            selector: { cluster_id: 'x', namespace: 'x', pods: [], containers: [], labels: {} },
            contains: 'x',
            regex: null,
            window,
            limit: 1,
            clock_window: c,
          }),
      },
      {
        name: 'traces.search',
        read: (window: { from: string; to: string }, c: typeof clock) =>
          traces.search({ query: '{}', dialect: 'traceql', window, limit: 1, clock_window: c }),
      },
    ];
    for (const s of subjects) {
      const r = await runClockConformance(s, clock);
      expect([s.name, failures(r)]).toEqual([s.name, []]);
    }
  });
});
