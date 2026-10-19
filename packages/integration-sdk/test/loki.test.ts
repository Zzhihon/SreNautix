import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LokiAdapter } from '../src/logs/loki.js';
import { ClockWindowViolation } from '../src/errors.js';
import { startLoki } from '../src/testing/loki.js';
import type { RunningProcess } from '../src/testing/process.js';
import { toIso } from '../src/clock.js';

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
let loki: RunningProcess;
beforeAll(async () => {
  loki = await startLoki([
    {
      labels: { namespace: 'shop', pod: 'pg-1', container: 'postgres' },
      lines: [
        { t: T0 + 1 * MIN, line: 'LOG: checkpoint starting' },
        { t: T0 + 2 * MIN, line: 'FATAL: could not write to file: No space left on device' },
        { t: T0 + 3 * MIN, line: 'PANIC: could not write to file "pg_wal/xlogtemp": No space left on device' },
      ],
    },
    {
      labels: { namespace: 'shop', pod: 'web-0', container: 'web' },
      lines: [{ t: T0 + 2 * MIN, line: 'No space left on device' }],
    },
  ]);
});
afterAll(async () => {
  await loki.stop();
});

describe('LokiAdapter', () => {
  const clock = { from: toIso(T0), to: toIso(T0 + 60 * MIN) };
  const adapter = () =>
    new LokiAdapter({
      id: 'loki',
      url: loki.url,
      labels: { namespace: 'namespace', pod: 'pod', container: 'container', cluster: null },
    });
  const selector = { cluster_id: 'c1', namespace: 'shop', pods: ['pg-1'], containers: [], labels: {} };

  it('logs.match 按子串与正则匹配', async () => {
    const a = adapter();
    const sub = await a.match({
      selector,
      contains: 'No space left',
      regex: null,
      window: clock,
      limit: 10,
      clock_window: clock,
    });
    expect(sub.lines.map((l) => l.line)).toEqual([
      'PANIC: could not write to file "pg_wal/xlogtemp": No space left on device',
      'FATAL: could not write to file: No space left on device',
    ]);
    const re = await a.match({
      selector,
      contains: null,
      regex: '^(FATAL|PANIC)',
      window: clock,
      limit: 1,
      clock_window: clock,
    });
    expect(re.lines).toHaveLength(1);
    expect(re.truncated).toBe(true);
    expect(a.matchQuery({ selector, contains: 'x"y', regex: null, window: clock, limit: 1, clock_window: clock })).toBe(
      '{namespace="shop", pod=~"pg-1"} |= "x\\"y"',
    );
  });

  it('logs.query 与时钟窗口', async () => {
    const a = adapter();
    const r = await a.query({
      query: '{namespace="shop"} |= "space"',
      dialect: 'logql',
      window: clock,
      limit: 10,
      clock_window: clock,
    });
    expect(r.lines).toHaveLength(3);
    await expect(
      a.query({
        query: '{namespace="shop"}',
        dialect: 'logql',
        window: { from: clock.from, to: toIso(T0 + 61 * MIN) },
        limit: 10,
        clock_window: clock,
      }),
    ).rejects.toThrow(ClockWindowViolation);
    expect(await a.labelNames(clock, clock)).toEqual(expect.arrayContaining(['namespace', 'pod', 'container']));
  });
});
