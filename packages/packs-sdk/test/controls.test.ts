// 对照对象（ADR 0179）的选点与判定：entry_peers 的 top_n 与 sampled、种子复现、声明校验，
// 以及对照全异常、全正常与部分无法判定三种结果

import { describe, expect, it } from 'vitest';
import { createBaseEnvironment } from '../src/cel/library.js';
import { compileCard, type JudgeInput } from '../src/judge/card.js';
import type { RefData } from '../src/judge/data.js';
import type { CardDefinition } from '../src/judge/types.js';
import {
  compileControls,
  controlKeys,
  controlVolume,
  evaluateControls,
  refsFor,
  selectControls,
} from '../src/runtime/controls.js';

const base = createBaseEnvironment();
const entity = { cluster_id: 'c1', kind: 'Upstream', namespace: null, name: 'up-0' };
const window = { from: 1000, to: 4600, anchor: 1600 };

// 同一入口上的多个上游：requests 与 errors 按 target 标签拆分，错误率超过 params.ratio 为异常
const def: CardDefinition = {
  id: 'peer-errors',
  title: { 'zh-CN': '上游错误率' },
  params: { ratio: 0.5 },
  refs: [
    { name: 'requests', signal: 'entry/requests', mode: 'range' },
    { name: 'errors', signal: 'entry/errors', mode: 'range' },
  ],
  judge: {
    let: [
      { name: 'total', cel: 'sum(requests)' },
      { name: 'bad', cel: 'sum(errors)' },
    ],
    abnormal_if: [
      {
        cel: 'total > 0.0 && bad / total > double(params.ratio)',
        say: { 'zh-CN': '错误 {bad} 次，请求 {total} 次' },
      },
    ],
  },
  display: { value: 'bad / total', unit: 'ratio' },
  egress: 'allow',
  controls: {
    method: 'entry_peers',
    by: 'target',
    refs: ['requests', 'errors'],
    volume: 'requests',
    top_n: 2,
    sample_count: 1,
  },
};

const card = compileCard(base, def, { where: 'test/controls' });
const cc = compileControls(def.controls!, def.refs);

interface Peer {
  key: string;
  requests: number;
  errors: number | null;
}

const series = (target: string, v: number) => ({
  labels: { target },
  times: [1_000_000, 1_060_000],
  values: [v, v],
});

function refsOf(peers: Peer[]): Record<string, RefData> {
  return {
    requests: { kind: 'metrics', truncated: false, series: peers.map((p) => series(p.key, p.requests)) },
    errors: {
      kind: 'metrics',
      truncated: false,
      series: peers.filter((p) => p.errors !== null).map((p) => series(p.key, p.errors!)),
    },
  };
}

/** 故障对象 up-0 的错误率 0.9；其余五个上游请求量依次为 500、400、300、200、100，错误率为 ratio */
function fleet(ratio: number, override: Record<string, number | null> = {}): Peer[] {
  const peers = ['p1', 'p2', 'p3', 'p4', 'p5'].map((key, i): Peer => {
    const requests = 500 - i * 100;
    return { key, requests, errors: key in override ? override[key]! : requests * ratio };
  });
  return [{ key: 'up-0', requests: 50, errors: 45 }, ...peers];
}

const input = (refs: Record<string, RefData>): JudgeInput => ({ refs, entity, window });

describe('entry_peers 的选点', () => {
  const data = refsOf(fleet(0));

  it('排除故障对象；按请求量取前 top_n 个，再随机取 sample_count 个', () => {
    const sel = selectControls(cc, data, 'up-0', 'inc-1');
    expect(sel.candidates).toBe(5);
    expect(sel.picks).toHaveLength(3);
    expect(sel.picks.slice(0, 2)).toEqual([
      { subject: 'p1', picked_by: 'top_n', volume: 1000 },
      { subject: 'p2', picked_by: 'top_n', volume: 800 },
    ]);
    const sampled = sel.picks[2]!;
    expect(sampled.picked_by).toBe('sampled');
    expect(['p3', 'p4', 'p5']).toContain(sampled.subject);
    expect(sel.picks.map((p) => p.subject)).not.toContain('up-0');
  });

  it('同一个种子与同一批对象得到同一个结果，不同的种子能取到不同的对象', () => {
    expect(selectControls(cc, data, 'up-0', 'inc-1')).toEqual(selectControls(cc, data, 'up-0', 'inc-1'));
    const sampled = new Set(
      Array.from({ length: 20 }, (_, i) => selectControls(cc, data, 'up-0', `inc-${i}`).picks[2]!.subject),
    );
    expect(sampled.size).toBeGreaterThan(1);
  });

  it('请求量相同按键排序；top_n 与 sample_count 为 0 时不选；对象不够时有多少选多少', () => {
    const tie = refsOf([
      { key: 'up-0', requests: 10, errors: 1 },
      { key: 'b', requests: 100, errors: 1 },
      { key: 'a', requests: 100, errors: 1 },
    ]);
    expect(selectControls(cc, tie, 'up-0', 's').picks.map((p) => p.subject)).toEqual(['a', 'b']);
    const none = compileControls({ ...def.controls!, top_n: 0, sample_count: 0 }, def.refs);
    expect(selectControls(none, data, 'up-0', 's').picks).toEqual([]);
    const wide = compileControls({ ...def.controls!, top_n: 10, sample_count: 3 }, def.refs);
    const all = selectControls(wide, data, 'up-0', 's');
    expect(all.picks.map((p) => p.subject)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(all.picks.every((p) => p.picked_by === 'top_n')).toBe(true);
  });

  it('对象键取自 by 标签，没有数据点的序列不算；没有序列的对象没有请求量', () => {
    expect(controlKeys(cc, data)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'up-0']);
    expect(controlVolume(cc, data, 'p3')).toBe(600);
    expect(controlVolume(cc, data, 'missing')).toBeNull();
    const empty = refsOf([{ key: 'x', requests: 1, errors: 1 }]);
    (empty.requests as { series: Array<{ values: Array<number | null> }> }).series[0]!.values = [null, null];
    expect(controlKeys(cc, empty)).toEqual(['x']);
  });

  it('refsFor 只保留 by 标签等于这个对象的序列', () => {
    const mine = refsFor(cc, data, 'p1');
    for (const name of ['requests', 'errors']) {
      const d = mine[name]!;
      expect(d.kind === 'metrics' && d.series.map((s) => s.labels.target)).toEqual(['p1']);
    }
  });
});

describe('对照结果的判定', () => {
  it('对照全部异常：结果列出每个对照对象的判定，故障对象不在其中', () => {
    const out = evaluateControls(cc, card, input(refsOf(fleet(0.9))), 'up-0', 'inc-1');
    expect(out).toMatchObject({ method: 'entry_peers', by: 'target', subject: 'up-0', candidates: 5 });
    expect(out.results.map((r) => [r.picked_by, r.verdict])).toEqual([
      ['top_n', 'abnormal'],
      ['top_n', 'abnormal'],
      ['sampled', 'abnormal'],
    ]);
    expect(out.results.map((r) => r.subject)).not.toContain('up-0');
    expect(out.results[0]!.value_number).toBeCloseTo(0.9);
    expect(out.results[0]!.volume).toBe(1000);
  });

  it('对照全部正常', () => {
    const out = evaluateControls(cc, card, input(refsOf(fleet(0.01))), 'up-0', 'inc-1');
    expect(out.results.map((r) => r.verdict)).toEqual(['normal', 'normal', 'normal']);
    expect(out.results.every((r) => r.display_state === 'normal')).toBe(true);
  });

  it('对照对象没有错误序列时无法判定，不会是正常', () => {
    const out = evaluateControls(cc, card, input(refsOf(fleet(0.9, { p2: null }))), 'up-0', 'inc-1');
    const byKey = Object.fromEntries(out.results.map((r) => [r.subject, r.verdict]));
    expect(byKey.p1).toBe('abnormal');
    expect(byKey.p2).toBe('undeterminable');
    expect(out.results.find((r) => r.subject === 'p2')!.value_number).toBeNull();
  });

  it('同一个种子重复判定得到同一份结果', () => {
    const a = evaluateControls(cc, card, input(refsOf(fleet(0.9))), 'up-0', 'inc-7');
    const b = evaluateControls(cc, card, input(refsOf(fleet(0.9))), 'up-0', 'inc-7');
    expect(a).toEqual(b);
  });
});

describe('声明校验', () => {
  it('refs 必须是卡片中 mode 为 range 或 instant 的引用，不重复，volume 在 refs 中', () => {
    const spec = def.controls!;
    expect(() => compileControls({ ...spec, refs: ['requests', 'nope'] }, def.refs)).toThrow(/不是卡片中的引用/);
    expect(() => compileControls({ ...spec, refs: ['requests'] }, [{ name: 'requests', mode: 'logs' }])).toThrow(
      /必须是 range 或 instant/,
    );
    expect(() => compileControls({ ...spec, refs: ['requests', 'requests'] }, def.refs)).toThrow(/重复/);
    expect(() => compileControls({ ...spec, refs: ['errors'] }, def.refs)).toThrow(/volume requests 必须在 refs 中/);
  });
});
