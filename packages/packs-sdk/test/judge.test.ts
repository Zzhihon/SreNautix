import { describe, expect, it } from 'vitest';
import { createBaseEnvironment } from '../src/cel/library.js';
import { compileCard, judgeCard } from '../src/judge/card.js';
import type { CardDefinition } from '../src/judge/types.js';
import type { RefData } from '../src/judge/data.js';

const base = createBaseEnvironment();
const entity = { cluster_id: 'c1', kind: 'Pod', namespace: 'app', name: 'web-0' };
const window = { from: 1000, to: 4600, anchor: 1600 };

const memCard: CardDefinition = {
  id: 'memory',
  title: { 'zh-CN': '内存占 limit' },
  params: { limit_ratio: 0.9 },
  refs: [
    { name: 'mem', signal: 'workload/container_memory_ratio', mode: 'range' },
    { name: 'oom', signal: 'workload/oom_events', mode: 'instant', empty_is: 'normal' },
  ],
  judge: {
    let: [
      { name: 'peak', cel: 'max(mem)' },
      { name: 'ooms', cel: 'count(oom)' },
    ],
    abnormal_if: [
      { cel: 'ooms > 0', say: { 'zh-CN': '{ooms} 个容器 OOM', en: '{ooms} containers OOM-killed' } },
      { cel: 'peak > params.limit_ratio', say: { 'zh-CN': '峰值 {peak, number, percent} 超过阈值' } },
    ],
  },
  display: {
    value: 'peak',
    unit: 'percent',
    table: {
      rows_from: 'mem',
      columns: [
        { header: { 'zh-CN': 'Pod' }, cel: 'label(row, "pod")' },
        { header: { 'zh-CN': '峰值' }, cel: 'max(row)', unit: 'percent' },
      ],
      sort_by: 'max(row)',
    },
  },
  egress: 'allow',
};

const series = (pod: string, values: Array<number | null>) => ({
  labels: { pod },
  times: values.map((_, i) => (1000 + i * 60) * 1000),
  values,
});

describe('judgeCard', () => {
  const card = compileCard(base, memCard, { where: 'test/memory' });

  it('判为异常并渲染文案与表格', () => {
    const refs: Record<string, RefData> = {
      mem: { kind: 'metrics', truncated: false, series: [series('a', [0.5, 0.95]), series('b', [0.2, null])] },
      oom: { kind: 'metrics', truncated: false, series: [] },
    };
    const out = judgeCard(card, { refs, entity, window });
    expect(out.verdict).toBe('abnormal');
    expect(out.reason.text).toBe('峰值 95% 超过阈值');
    expect(out.value).toBe('95.0%');
    expect(out.table?.rows).toEqual([
      ['a', '95.0%'],
      ['b', '20.0%'],
    ]);
  });

  it('过滤型引用为空且其余正常时判为正常', () => {
    const refs: Record<string, RefData> = {
      mem: { kind: 'metrics', truncated: false, series: [series('a', [0.5, 0.6])] },
      oom: { kind: 'metrics', truncated: false, series: [] },
    };
    expect(judgeCard(card, { refs, entity, window }).verdict).toBe('normal');
  });

  it('必需引用没有样本时永远不是正常', () => {
    const refs: Record<string, RefData> = {
      mem: { kind: 'metrics', truncated: false, series: [] },
      oom: { kind: 'metrics', truncated: false, series: [] },
    };
    const out = judgeCard(card, { refs, entity, window });
    expect(out.verdict).toBe('undeterminable');
    expect(out.reason.kind).toBe('no_data');
  });

  it('缺数据时其他证据仍可判为异常', () => {
    const refs: Record<string, RefData> = {
      mem: { kind: 'error', message: 'timeout' },
      oom: { kind: 'metrics', truncated: false, series: [series('a', [1])] },
    };
    const out = judgeCard(card, { refs, entity, window, locale: 'en' });
    expect(out.verdict).toBe('abnormal');
    expect(out.reason.text).toBe('1 containers OOM-killed');
  });

  it('数据源报错且没有命中时为无法判定', () => {
    const refs: Record<string, RefData> = {
      mem: { kind: 'error', message: 'timeout' },
      oom: { kind: 'metrics', truncated: false, series: [] },
    };
    const out = judgeCard(card, { refs, entity, window });
    expect(out.verdict).toBe('undeterminable');
    expect(out.reason.kind).toBe('source_error');
  });

  it('能力缺失单独显示', () => {
    const refs: Record<string, RefData> = {
      mem: { kind: 'capability_missing', capability: 'metrics.query_range' },
      oom: { kind: 'metrics', truncated: false, series: [] },
    };
    expect(judgeCard(card, { refs, entity, window }).display_state).toBe('capability_missing');
  });
});

describe('series library', () => {
  const mk = (cel: string, extra: Partial<CardDefinition> = {}): CardDefinition => ({
    id: 'x',
    title: { en: 'x' },
    refs: [
      { name: 'a', signal: 's/a', mode: 'range' },
      { name: 'b', signal: 's/b', mode: 'range', empty_is: 'normal' },
    ],
    judge: { abnormal_if: [{ cel, say: { en: 'hit' } }] },
    egress: 'allow',
    ...extra,
  });
  const run = (cel: string, a: RefData, b: RefData = { kind: 'metrics', truncated: false, series: [] }) =>
    judgeCard(compileCard(base, mk(cel), { where: 'lib' }), { refs: { a, b }, entity, window }).verdict;
  const m = (...s: ReturnType<typeof series>[]): RefData => ({ kind: 'metrics', truncated: false, series: s });

  it('any_point', () => {
    expect(run('any_point(a, p, p.v > 2.0)', m(series('x', [1, 3])))).toBe('abnormal');
    expect(run('any_point(a, p, p.v > 5.0)', m(series('x', [1, 3])))).toBe('normal');
  });
  it('transitions', () => {
    expect(run('size(transitions(a)) >= 2', m(series('x', [0, 1, 0])))).toBe('abnormal');
    expect(run('size(transitions(a)) >= 2', m(series('x', [0, 0, 1])))).toBe('normal');
  });
  it('top_share', () => {
    expect(run('top_share(a, 1) > 0.5', m(series('x', [9]), series('y', [1])))).toBe('abnormal');
  });
  it('ratio 与 join', () => {
    expect(run('ratio(a, b) > 0.5', m(series('x', [3])), m(series('x', [4])))).toBe('abnormal');
    expect(
      run('max(join(a, b, "/")) > 0.8', m(series('x', [3]), series('y', [1])), m(series('x', [4]), series('y', [1]))),
    ).toBe('abnormal');
  });
  it('cel.bind 局部绑定', () => {
    expect(run('cel.bind(m, max(a), m > 2.0 && m < 4.0)', m(series('x', [3])))).toBe('abnormal');
  });
  it('聚合函数在空输入上不可求值', () => {
    expect(run('max(a.filter(s, label(s, "pod") == "zz")) > 0.0', m(series('x', [3])))).toBe('undeterminable');
  });
  it('成本超限的表达式在编译时拒绝', () => {
    expect(() => compileCard(base, mk('a.exists(s, points(a).exists(p, p.v > 1.0))'), { where: 'cost' })).toThrow(
      /求值成本上界/,
    );
  });
  it('类型错误在编译时拒绝', () => {
    expect(() => compileCard(base, mk('max(a) > "x"'), { where: 'type' })).toThrow(/CEL 不合法/);
  });
});
