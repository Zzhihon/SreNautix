import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TempoAdapter } from '../src/traces/tempo.js';
import { ClockWindowViolation } from '../src/errors.js';
import { startTempo } from '../src/testing/tempo.js';
import type { RunningProcess } from '../src/testing/process.js';
import { toIso } from '../src/clock.js';

// Tempo 按写入时间组织块，夹具链路使用当前时间附近的时间戳
const NOW = Math.floor(Date.now() / 1000) * 1000;
const TRACE = '0af7651916cd43dd8448eb211c80319c';
let tempo: RunningProcess;
beforeAll(async () => {
  tempo = await startTempo([
    {
      trace_id: TRACE,
      span_id: 'b7ad6b7169203331',
      service: 'web',
      name: 'GET /cart',
      start: NOW - 120_000,
      duration_ms: 812,
      attributes: { 'http.route': '/cart' },
    },
    {
      trace_id: TRACE,
      span_id: '00f067aa0ba902b7',
      parent_span_id: 'b7ad6b7169203331',
      service: 'pg',
      name: 'SELECT',
      start: NOW - 119_900,
      duration_ms: 700,
      error: true,
      attributes: { 'db.system': 'postgresql' },
    },
  ]);
});
afterAll(async () => {
  await tempo.stop();
});

describe('TempoAdapter', () => {
  const clock = { from: toIso(NOW - 3600_000), to: toIso(NOW + 60_000) };
  const adapter = () => new TempoAdapter({ id: 'tempo', url: tempo.url });

  it('traces.search 与 traces.trace', async () => {
    const a = adapter();
    let hits: Awaited<ReturnType<TempoAdapter['search']>>['hits'] = [];
    // 写入后要等 live-store 消费完才能查到
    for (let i = 0; i < 60 && hits.length === 0; i++) {
      hits = (
        await a.search({
          query: '{ status = error }',
          dialect: 'traceql',
          window: clock,
          limit: 5,
          clock_window: clock,
        })
      ).hits;
      if (!hits.length) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ trace_id: TRACE, root_service: 'web', root_name: 'GET /cart' });
    const t = await a.trace(TRACE, 100);
    expect(t.spans.map((s) => [s.service, s.status, s.parent_span_id])).toEqual([
      ['web', 'ok', null],
      ['pg', 'error', 'b7ad6b7169203331'],
    ]);
  });

  it('拒绝超出时钟窗口的搜索', async () => {
    await expect(
      adapter().search({
        query: '{}',
        dialect: 'traceql',
        window: { from: clock.from, to: toIso(NOW + 120_000) },
        limit: 1,
        clock_window: clock,
      }),
    ).rejects.toThrow(ClockWindowViolation);
  });
});
