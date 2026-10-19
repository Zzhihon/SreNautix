// traces/v1 一致性测试。链路后端按写入时间组织数据，夹具以测试开始时刻为基准生成（conformanceSpans(now)）。

import { validatorFor, type TimeWindow } from '@srenautix/contract';
import { toIso } from '../clock.js';
import type { TempoAdapter } from '../traces/tempo.js';
import type { FixtureSpan } from '../testing/tempo.js';
import { Checks, expectEq, type ConformanceReport } from './report.js';

export const CONFORMANCE_TRACE = '00f1c3d5e7a9b2c4d6e8fa1b3c5d7e9f';

export function conformanceSpans(now: number): FixtureSpan[] {
  return [
    {
      trace_id: CONFORMANCE_TRACE,
      span_id: '1111111111111111',
      service: 'gateway',
      name: 'POST /orders',
      start: now - 120_000,
      duration_ms: 950,
    },
    {
      trace_id: CONFORMANCE_TRACE,
      span_id: '2222222222222222',
      parent_span_id: '1111111111111111',
      service: 'orders',
      name: 'INSERT orders',
      start: now - 119_900,
      duration_ms: 900,
      error: true,
      attributes: { 'db.system': 'postgresql' },
    },
    {
      trace_id: 'aa' + CONFORMANCE_TRACE.slice(2),
      span_id: '3333333333333333',
      service: 'gateway',
      name: 'GET /healthz',
      start: now - 60_000,
      duration_ms: 1,
    },
  ];
}

export async function runTracesConformance(a: TempoAdapter, now: number): Promise<ConformanceReport> {
  const c = new Checks('traces/v1', a.config.id);
  const clock: TimeWindow = { from: toIso(now - 3600_000), to: toIso(now + 60_000) };
  const valid = validatorFor('integrations/traces/v1/traces.schema.json#/$defs/SearchResult');
  const search = async (query: string, limit = 10) => {
    // 后端写入后要等数据可查询
    for (let i = 0; i < 60; i++) {
      const r = await a.search({ query, dialect: 'traceql', window: clock, limit, clock_window: clock });
      if (r.hits.length) {
        return r;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    return a.search({ query, dialect: 'traceql', window: clock, limit, clock_window: clock });
  };

  await c.run('search-error', '按状态搜索', async () => {
    const r = await search('{ status = error }');
    if (!valid(r)) {
      throw new Error(`结果不符合契约：${JSON.stringify(valid.errors)}`);
    }
    expectEq(
      'trace',
      r.hits.map((h) => [h.trace_id, h.root_service, h.root_name]),
      [[CONFORMANCE_TRACE, 'gateway', 'POST /orders']],
    );
    return '1 条';
  });
  await c.run('search-attribute', '按属性搜索，命中的 span 属性返回', async () => {
    const r = await search('{ span.db.system = "postgresql" }');
    expectEq('属性', r.hits[0]?.attributes['db.system'], 'postgresql');
    return 'db.system=postgresql';
  });
  await c.run('trace', '按 trace id 读取完整链路，父子关系与状态正确', async () => {
    const t = await a.trace(CONFORMANCE_TRACE, 100);
    expectEq(
      'span',
      t.spans.map((s) => [s.service, s.name, s.status, s.parent_span_id]),
      [
        ['gateway', 'POST /orders', 'ok', null],
        ['orders', 'INSERT orders', 'error', '1111111111111111'],
      ],
    );
    return '2 个 span';
  });
  await c.run('limit', 'limit 截断并标记', async () => {
    const r = await search('{ resource.service.name = "gateway" }', 1);
    expectEq('条数', r.hits.length, 1);
    expectEq('truncated', r.truncated, true);
    return '截断为 1 条';
  });
  return c.report();
}
