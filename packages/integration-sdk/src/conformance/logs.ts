// logs/v1 一致性测试。每个日志集成都必须实现 logs.match（DESIGN §6.2）。
// 被测后端事先装入 conformanceLogStreams() 的数据，套件检查子串与正则匹配、Pod 与容器过滤、
// 新的在前、limit 与截断、窗口边界、结果的契约形状。

import { validatorFor, type LogsMatchRequest } from '@srenautix/contract';
import { toIso } from '../clock.js';
import type { FixtureLogStream } from '../testing/loki.js';
import { Checks, expectEq, type ConformanceReport } from './report.js';
import { CONFORMANCE_T0 } from './metrics.js';

const MIN = 60_000;

export function conformanceLogStreams(): FixtureLogStream[] {
  return [
    {
      labels: { namespace: 'conf', pod: 'api-0', container: 'api' },
      lines: [
        { t: CONFORMANCE_T0 + 1 * MIN, line: 'GET /healthz 200' },
        { t: CONFORMANCE_T0 + 2 * MIN, line: 'ERROR connect to db: connection refused' },
        { t: CONFORMANCE_T0 + 3 * MIN, line: 'ERROR connect to db: timeout' },
        { t: CONFORMANCE_T0 + 4 * MIN, line: 'WARN slow query 2.3s' },
      ],
    },
    {
      labels: { namespace: 'conf', pod: 'api-0', container: 'proxy' },
      lines: [{ t: CONFORMANCE_T0 + 2 * MIN, line: 'upstream connect error' }],
    },
    {
      labels: { namespace: 'conf', pod: 'worker-0', container: 'worker' },
      lines: [{ t: CONFORMANCE_T0 + 5 * MIN, line: 'ERROR job failed: out of memory' }],
    },
    {
      labels: { namespace: 'other', pod: 'api-0', container: 'api' },
      lines: [{ t: CONFORMANCE_T0 + 2 * MIN, line: 'ERROR in another namespace' }],
    },
  ];
}

export interface LogsSubject {
  name: string;
  match(
    req: LogsMatchRequest,
  ): Promise<{
    lines: Array<{ time: string; labels: Record<string, string | undefined>; line: string }>;
    truncated: boolean;
  }>;
}

export async function runLogsConformance(s: LogsSubject): Promise<ConformanceReport> {
  const c = new Checks('logs/v1', s.name);
  const clock = { from: toIso(CONFORMANCE_T0), to: toIso(CONFORMANCE_T0 + 10 * MIN) };
  const valid = validatorFor('integrations/logs/v1/logs.schema.json#/$defs/Result');
  const base = (over: Partial<LogsMatchRequest>): LogsMatchRequest => ({
    selector: { cluster_id: 'conf', namespace: 'conf', pods: [], containers: [], labels: {} },
    contains: null,
    regex: null,
    window: clock,
    limit: 50,
    clock_window: clock,
    ...over,
  });

  await c.run('contains', '子串匹配，只在指定命名空间内，新的在前', async () => {
    const r = await s.match(base({ contains: 'ERROR' }));
    if (!valid(r)) {
      throw new Error(`结果不符合契约：${JSON.stringify(valid.errors)}`);
    }
    expectEq(
      '行',
      r.lines.map((l) => l.line),
      ['ERROR job failed: out of memory', 'ERROR connect to db: timeout', 'ERROR connect to db: connection refused'],
    );
    return '3 行';
  });
  await c.run('regex', 'RE2 正则匹配', async () => {
    const r = await s.match(base({ regex: 'connect (to db|error)' }));
    expectEq('行数', r.lines.length, 3);
    return '3 行';
  });
  await c.run('pod-filter', '按 Pod 过滤', async () => {
    const r = await s.match(
      base({
        contains: 'ERROR',
        selector: { cluster_id: 'conf', namespace: 'conf', pods: ['worker-0'], containers: [], labels: {} },
      }),
    );
    expectEq(
      '行',
      r.lines.map((l) => l.line),
      ['ERROR job failed: out of memory'],
    );
    return '1 行';
  });
  await c.run('container-filter', '按容器过滤', async () => {
    const r = await s.match(
      base({
        contains: 'connect',
        selector: { cluster_id: 'conf', namespace: 'conf', pods: ['api-0'], containers: ['proxy'], labels: {} },
      }),
    );
    expectEq(
      '行',
      r.lines.map((l) => l.line),
      ['upstream connect error'],
    );
    return '1 行';
  });
  await c.run('limit', '超过 limit 时截断并标记，保留最新的', async () => {
    const r = await s.match(base({ contains: 'ERROR', limit: 1 }));
    expectEq(
      '行',
      r.lines.map((l) => l.line),
      ['ERROR job failed: out of memory'],
    );
    expectEq('truncated', r.truncated, true);
    return '截断为 1 行';
  });
  await c.run('window', '只返回窗口内的行（含终点）', async () => {
    const r = await s.match(
      base({
        contains: 'ERROR',
        window: { from: toIso(CONFORMANCE_T0 + 2 * MIN + 1), to: toIso(CONFORMANCE_T0 + 3 * MIN) },
      }),
    );
    expectEq(
      '行',
      r.lines.map((l) => l.line),
      ['ERROR connect to db: timeout'],
    );
    return '1 行';
  });
  await c.run('no-match', '没有匹配时返回空', async () => {
    const r = await s.match(base({ contains: 'no-such-text' }));
    expectEq('行数', r.lines.length, 0);
    expectEq('truncated', r.truncated, false);
    return '空';
  });
  return c.report();
}
