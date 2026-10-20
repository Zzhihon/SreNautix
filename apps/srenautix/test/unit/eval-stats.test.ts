import type { EvalCase } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { buildRows, evaluateGate, renderMarkdown, buildReport } from '../../src/eval/report.js';
import { scoreRun, topComponents, type RunRecord } from '../../src/eval/score.js';
import { clusteredRatio, gateThreshold, pairedDelta, quantile } from '../../src/eval/stats.js';

// 确定性的合成成绩表：每个用例的每次运行是否命中由表格给出，统计量与门禁的结果可以手算核对。

function evalCase(id: string, over: Partial<EvalCase> = {}): EvalCase {
  return {
    case_id: id,
    version: 1,
    suite: 'synthetic',
    type: 'incident',
    cluster_id: 'test',
    incident_id: null,
    label: id,
    started_at: '2026-09-01T10:00:00Z',
    as_of: '2026-09-01T10:30:00Z',
    truth: {
      root_components: ['StatefulSet:shop/postgres'],
      granularity: 'workload',
      mechanism: null,
      disposition: 'escalate',
      forbid_evidence_consistent: false,
    },
    truth_source: { kind: 'human', principal: 'alice', ref: null },
    leakage: { exclude_incident_ids: [], exclude_refs: [], learned_from_keys: [] },
    pack_timing: 'pack_before_incident',
    snapshot_id: null,
    derived_from: null,
    authored_by: null,
    created_at: '2026-09-02T00:00:00Z',
    ...over,
  };
}

function run(caseId: string, i: number, hit: boolean, over: Partial<RunRecord> = {}): RunRecord {
  return {
    caseId,
    run: i,
    routeId: 'r',
    model: 'm',
    state: 'completed',
    structuredFailure: false,
    level: hit ? 'evidence_consistent' : 'likely',
    disposition: 'escalate',
    top: [hit ? 'StatefulSet:shop/postgres' : 'Deployment:shop/web'],
    cost: 0.01,
    currency: 'USD',
    inputTokens: 1000,
    outputTokens: 100,
    missRate: 0,
    fingerprints: [],
    durationMs: 1,
    error: null,
    proposals: [],
    ...over,
  };
}

/** 表格：每行一个用例，字符 1 为命中、0 为未命中 */
function table(rows: string[], prefix = 'c'): { cases: EvalCase[]; runs: RunRecord[] } {
  const cases = rows.map((_, i) => evalCase(`${prefix}${i}`));
  const runs = rows.flatMap((row, i) => [...row].map((ch, j) => run(`${prefix}${i}`, j, ch === '1')));
  return { cases, runs };
}

describe('分位数与聚类自助法', () => {
  it('线性插值分位数', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10], 0.9)).toBe(10);
    expect(quantile([0, 10], 0.1)).toBeCloseTo(1);
  });

  it('点估计是分子之和除以分母之和；同一种子结果相同；区间包含点估计', () => {
    const clusters = [
      { numerator: 3, denominator: 3 },
      { numerator: 0, denominator: 3 },
      { numerator: 2, denominator: 3 },
      { numerator: 3, denominator: 3 },
    ];
    const a = clusteredRatio(clusters);
    expect(a).toMatchObject({ numerator: 8, denominator: 12 });
    expect(a.value).toBeCloseTo(8 / 12);
    expect(clusteredRatio(clusters)).toEqual(a);
    expect(a.ci_low as number).toBeLessThanOrEqual(a.value as number);
    expect(a.ci_high as number).toBeGreaterThanOrEqual(a.value as number);
  });

  it('独立用例：区间与正态近似一致（p=0.6，n=200，半宽约 1.645×√(p(1−p)/n)）', () => {
    const clusters = Array.from({ length: 200 }, (_, i) => ({ numerator: i % 5 < 3 ? 1 : 0, denominator: 1 }));
    const r = clusteredRatio(clusters);
    const half = 1.645 * Math.sqrt((0.6 * 0.4) / 200);
    expect(r.value).toBeCloseTo(0.6);
    expect(Math.abs((r.ci_low as number) - (0.6 - half))).toBeLessThan(0.012);
    expect(Math.abs((r.ci_high as number) - (0.6 + half))).toBeLessThan(0.012);
  });

  it('同一用例的多次运行完全相关时，聚类区间比把运行当独立样本宽', () => {
    const rows = Array.from({ length: 40 }, (_, i) => (i % 2 ? '111' : '000'));
    const clustered = clusteredRatio(
      rows.map((r) => ({ numerator: [...r].filter((x) => x === '1').length, denominator: 3 })),
    );
    const flat = clusteredRatio(
      rows.flatMap((r) => [...r].map((x) => ({ numerator: x === '1' ? 1 : 0, denominator: 1 }))),
    );
    const w = (x: typeof flat) => (x.ci_high as number) - (x.ci_low as number);
    expect(w(clustered)).toBeGreaterThan(w(flat) * 1.4);
  });

  it('分母为零时没有比例与区间', () => {
    expect(clusteredRatio([{ numerator: 0, denominator: 0 }])).toEqual({
      numerator: 0,
      denominator: 0,
      value: null,
      ci_low: null,
      ci_high: null,
    });
  });
});

describe('配对比较', () => {
  it('平均差与单侧下界；阈值按用例数', () => {
    const same = pairedDelta(Array.from({ length: 50 }, () => ({ baseline: 1, candidate: 1 })));
    expect(same).toEqual({ n: 50, delta: 0, low: 0 });
    const worse = pairedDelta(Array.from({ length: 50 }, (_, i) => ({ baseline: 1, candidate: i < 10 ? 0 : 1 })));
    expect(worse.delta).toBeCloseTo(-0.2);
    expect(worse.low).toBeLessThan(-0.2);
    expect(gateThreshold(99)).toBe(-0.1);
    expect(gateThreshold(100)).toBe(-0.05);
  });
});

describe('评分', () => {
  it('集合命中、召回@3、弃权、处置', () => {
    const c = evalCase('x', {
      truth: {
        root_components: ['A:ns/a', 'B:ns/b'],
        granularity: 'component',
        mechanism: null,
        disposition: 'act',
        forbid_evidence_consistent: false,
      },
    });
    expect(scoreRun(c, run('x', 0, false, { top: ['B:ns/b'], disposition: 'act' }))).toMatchObject({
      top1: true,
      recall3: true,
      dispositionCorrect: true,
      correct: true,
    });
    expect(scoreRun(c, run('x', 0, false, { top: ['C:ns/c', 'A:ns/a'] }))).toMatchObject({
      top1: false,
      recall3: true,
      correct: false,
    });
    expect(scoreRun(c, run('x', 0, false, { top: ['A:ns/a'], level: 'inconclusive' }))).toMatchObject({
      top1: false,
      abstained: true,
    });
  });

  it('良性用例：ignore 且没有 evidence_consistent 为正确；abstain 用例：弃权为正确', () => {
    const benign = evalCase('b', {
      type: 'benign',
      truth: {
        root_components: [],
        granularity: null,
        mechanism: null,
        disposition: 'ignore',
        forbid_evidence_consistent: true,
      },
    });
    expect(scoreRun(benign, run('b', 0, false, { disposition: 'ignore', level: 'likely' })).correct).toBe(true);
    expect(scoreRun(benign, run('b', 0, true, { disposition: 'ignore' }))).toMatchObject({
      correct: false,
      falsePositive: true,
    });
    const abstain = evalCase('a', {
      type: 'abstain',
      truth: {
        root_components: [],
        granularity: null,
        mechanism: null,
        disposition: 'undetermined',
        forbid_evidence_consistent: true,
      },
    });
    expect(scoreRun(abstain, run('a', 0, false, { level: 'undetermined', top: [] })).correct).toBe(true);
    expect(scoreRun(abstain, run('a', 0, false, { level: 'likely' })).correct).toBe(false);
  });

  it('前 3 个根因：结论选中的在前，推翻的不算', () => {
    const top = topComponents({
      conclusion: { root_component: 'B:x/b' },
      hypotheses: [
        { root_component: 'A:x/a', status: 'refuted' },
        { root_component: 'C:x/c', status: 'inconclusive' },
        { root_component: 'D:x/d', status: 'supported' },
        { root_component: 'B:x/b', status: 'supported' },
      ],
    } as never);
    expect(top).toEqual(['B:x/b', 'D:x/d', 'C:x/c']);
  });
});

describe('成绩行', () => {
  const { cases, runs } = table(['111', '111', '110', '100', '000', '111', '011', '111', '000', '111']);

  it('top-1、pass@1、pass^3、运行一致性按表格计算', () => {
    const [row] = buildRows(cases, runs, 3, 1);
    expect(row?.top1).toMatchObject({ numerator: 20, denominator: 30 });
    expect(row?.pass_at_1).toMatchObject({ numerator: 7, denominator: 10 });
    expect(row?.pass_pow_k).toMatchObject({ numerator: 5, denominator: 10 });
    expect(row?.run_agreement).toMatchObject({ numerator: 7, denominator: 10 });
    expect(row?.coverage).toMatchObject({ numerator: 30, denominator: 30 });
    expect(row?.disposition_accuracy).toMatchObject({ numerator: 30, denominator: 30 });
    expect(row?.by_granularity.workload).toMatchObject({ numerator: 20, denominator: 30 });
  });

  it('可靠性表：evidence_consistent 的精确率；likely 档位全部未命中', () => {
    const [row] = buildRows(cases, runs, 3, 1);
    const ec = row?.reliability.find((x) => x.level === 'evidence_consistent');
    const likely = row?.reliability.find((x) => x.level === 'likely');
    expect(ec?.precision).toMatchObject({ numerator: 20, denominator: 20, value: 1 });
    expect(ec?.demoted).toBe(false);
    expect(likely?.precision).toMatchObject({ numerator: 0, denominator: 10 });
  });

  it('evidence_consistent 的精确率下界低于 85% 时降级', () => {
    const mixed = cases
      .map((c) => c.case_id)
      .flatMap((id, i) =>
        [0, 1, 2].map((j) =>
          run(id, j, false, { level: 'evidence_consistent', top: [i % 2 ? 'StatefulSet:shop/postgres' : 'X:a/b'] }),
        ),
      );
    const [row] = buildRows(cases, mixed, 3, 1);
    expect(row?.reliability.find((x) => x.level === 'evidence_consistent')?.demoted).toBe(true);
  });
});

describe('发布门禁', () => {
  it('候选与基线相同：通过', () => {
    const t = table(['111', '111', '000', '111']);
    const g = evaluateGate('00000000-0000-4000-8000-000000000000', t.cases, t.runs, t.runs, 3, [], 1);
    expect(g).toMatchObject({ paired_cases: 4, regressed_cases: [], paired_delta: 0, threshold: -0.1, passed: true });
  });

  it('之前 pass^3 通过、现在失败的用例使门禁不通过，豁免后通过', () => {
    const base = table(Array.from({ length: 30 }, () => '111'));
    const cand = table([...Array.from({ length: 29 }, () => '111'), '110']);
    const g = evaluateGate('00000000-0000-4000-8000-000000000000', base.cases, base.runs, cand.runs, 3, [], 1);
    expect(g.regressed_cases).toEqual(['c29']);
    expect(g.passed).toBe(false);
    const w = evaluateGate('00000000-0000-4000-8000-000000000000', base.cases, base.runs, cand.runs, 3, ['c29'], 1);
    expect(w).toMatchObject({ waived_cases: ['c29'], passed: true });
  });

  it('整体下降超过阈值：不通过（n<100 用 −10 个百分点）', () => {
    const base = table(Array.from({ length: 40 }, (_, i) => (i < 30 ? '111' : '000')));
    const cand = table(Array.from({ length: 40 }, (_, i) => (i < 22 ? '111' : '000')));
    const g = evaluateGate(
      '00000000-0000-4000-8000-000000000000',
      base.cases,
      base.runs,
      cand.runs,
      3,
      [...Array(40).keys()].map((i) => `c${i}`),
      1,
    );
    expect(g.paired_delta).toBeCloseTo(-0.2);
    expect(g.paired_delta_low).toBeLessThan(-0.1);
    expect(g.passed).toBe(false);
  });

  it('n≥100 时阈值为 −5 个百分点', () => {
    const base = table(Array.from({ length: 120 }, () => '111'));
    const cand = table(Array.from({ length: 120 }, (_, i) => (i < 4 ? '000' : '111')));
    const g = evaluateGate(
      '00000000-0000-4000-8000-000000000000',
      base.cases,
      base.runs,
      cand.runs,
      3,
      [0, 1, 2, 3].map((i) => `c${i}`),
      1,
    );
    expect(g.threshold).toBe(-0.05);
    expect(g.paired_delta).toBeCloseTo(-4 / 120);
    expect(g.passed).toBe(g.paired_delta_low >= -0.05);
  });
});

describe('报告', () => {
  it('Markdown 中每个比例都有分子、分母与区间', () => {
    const t = table(['111', '101']);
    const r = buildReport(
      { codeSha: 'abc', packLock: 'sha256:0', mode: 'snapshot', caseSet: 'synthetic', runsPerCase: 3, seed: 1 },
      t.cases,
      t.runs,
      null,
    );
    const md = renderMarkdown(r, '合成用例');
    expect(md).toMatch(/83\.3% \(5\/6\) \[/);
    expect(md).toContain('## 可靠性表');
  });
});
