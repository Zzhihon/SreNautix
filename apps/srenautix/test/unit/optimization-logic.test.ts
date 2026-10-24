import type { DomainGates, EvidenceResult } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { baselineAndGap, indicatorBaseline, peakCount, type IndicatorSeries } from '../../src/optimize/baseline.js';
import { rankCandidates, type DiagnosedEntity, type KnownFinding } from '../../src/optimize/candidates.js';
import { findingFrame } from '../../src/optimize/frame.js';
import { evaluateGates, type GateInput } from '../../src/optimize/gates.js';
import { judgeFinding, ledgerPickInGroup } from '../../src/optimize/ladder.js';
import { durationMs, findingFingerprint, HOUR_MS, hourly, quantile } from '../../src/optimize/stats.js';
import { verifyOutcome } from '../../src/optimize/verify.js';
import { EvidenceBook } from '../../src/research/evidence.js';
import { Ledger } from '../../src/research/ledger.js';

// 主动优化的确定性部分（ADR 0146 §2.2–§2.6）在 T0 用夹具测试：基线与差距、候选排序、结论阶梯、门槛、验证

const T = Date.parse('2026-10-12T00:00:00Z'); // 周一 00:00
const DAY = 24 * HOUR_MS;

/** 7 天按小时的取值；load 白天高、夜里低 */
function week(value: (h: number) => number | null): Array<[number, number | null]> {
  return Array.from({ length: 168 }, (_, i) => [T + i * HOUR_MS, value(i)] as [number, number | null]);
}
const load = week((i) => (i % 24 >= 9 && i % 24 < 18 ? 1000 : 100));

function series(over: Partial<IndicatorSeries> = {}): IndicatorSeries {
  return {
    indicator: 'postgres/stmt-mean-ms',
    params: {},
    entity: 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres',
    unit: 'seconds',
    better: 'lower',
    statistic: 'p95',
    hourly: week(() => 0.08),
    load,
    ...over,
  };
}

describe('工具', () => {
  it('时长、按小时分桶、分位数与发现指纹', () => {
    expect(durationMs('7d')).toBe(7 * DAY);
    expect(durationMs('1d12h')).toBe(36 * HOUR_MS);
    expect(durationMs('2w')).toBe(14 * DAY);
    expect(() => durationMs('7days')).toThrow();
    expect(
      hourly(
        [
          [T + 60_000, 1],
          [T + 120_000, 3],
          [T + 2 * HOUR_MS + 1, 5],
        ],
        T,
        T + 3 * HOUR_MS,
      ),
    ).toEqual([
      [T, 2],
      [T + HOUR_MS, null],
      [T + 2 * HOUR_MS, 5],
    ]);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
    const fp = findingFingerprint('cchp', 'database', 'pg.statement_dominant', 'pg_statement:cchp-postgres/cchp/abc');
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(findingFingerprint('cchp', 'database', 'pg.statement_dominant', 'pg_statement:cchp-postgres/cchp/abc')).toBe(
      fp,
    );
    expect(findingFingerprint('cchp', 'database', 'pg.temp_spill', 'pg_statement:cchp-postgres/cchp/abc')).not.toBe(fp);
  });
});

describe('基线与差距', () => {
  it('高峰：负载前 20% 的相邻小时算一个高峰；没有数据的小时不计', () => {
    expect(peakCount(series().hourly, load)).toEqual({ peaks: 7, peakHours: 63 });
    const twoDays = week((i) => (i < 48 ? 0.08 : null));
    expect(peakCount(twoDays, load).peaks).toBe(2);
  });

  it('覆盖率低于 90% 或少于 3 个高峰时基线不足，运行不判定差距', () => {
    const holes = series({ hourly: week((i) => (i % 5 ? 0.08 : null)) });
    const sparse = baselineAndGap({ from: T, to: T + 7 * DAY }, [holes], null, {});
    expect(sparse.baseline.sufficient).toBe(false);
    expect(sparse.baseline.missing[0]).toMatch(/覆盖率 80%/);
    expect(sparse.gap).toEqual({ exists: false, basis: 'none', detail: '基线不足，无法判定差距' });
    const noPeaks = indicatorBaseline(series({ load: week((i) => (i < 30 ? 1000 : 100)) }), null);
    expect(noPeaks.sufficient).toBe(false);
    expect(noPeaks.missing[0]).toMatch(/只有 1 个业务高峰/);
  });

  it('目标：违反目标的小时占比不低于 10% 或统计值违反目标时差距成立', () => {
    const objective = {
      comparator: 'lt' as const,
      target: 0.05,
      unit: 'seconds' as const,
      statistic: 'p95' as const,
      window: '7d',
    };
    const r = baselineAndGap({ from: T, to: T + 7 * DAY }, [series()], objective, {});
    expect(r.gap.exists).toBe(true);
    expect(r.gap.basis).toBe('objective');
    expect(r.baseline.indicators[0]).toMatchObject({ value: 0.08, violation_ratio: 1, hours: 168, covered_hours: 168 });
    expect(r.gaps.get('postgres/stmt-mean-ms@Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres')).toBeCloseTo(0.03);
    // 只有少数小时违反：比例低于 10%，统计值也不违反
    const fine = series({ hourly: week((i) => (i < 5 ? 0.09 : 0.02)) });
    const ok = baselineAndGap({ from: T, to: T + 7 * DAY }, [fine], objective, {});
    expect(ok.gap.exists).toBe(false);
    expect(ok.baseline.indicators[0]?.violation_ratio).toBeCloseTo(5 / 168);
  });

  it('领域体检：按领域门槛，统计值违反任一门槛即差距成立；没有门槛时 basis 为 none', () => {
    const gates: DomainGates = {
      thresholds: [{ indicator: 'postgres/stmt-mean-ms', comparator: 'le', value: 0.05, statistic: 'max' }],
    };
    const r = baselineAndGap({ from: T, to: T + 7 * DAY }, [series()], null, gates);
    expect(r.gap).toMatchObject({ exists: true, basis: 'gate' });
    expect(r.baseline.indicators[0]?.statistic).toBe('max');
    expect(baselineAndGap({ from: T, to: T + 7 * DAY }, [series()], null, {}).gap.basis).toBe('none');
  });
});

describe('候选发现', () => {
  const d = (finding: string, share: number | null, gap: number | null): DiagnosedEntity => ({
    finding,
    kind: 'pg.statement_dominant',
    entity: { type: 'pg_statement', key: `pg_statement:c/db/${finding}`, display: finding, labels: {} },
    component: 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres',
    diagnostic: 'database/statement-dominant',
    card_ref: 'card:1',
    share,
    share_ref: share === null ? null : 'card:2',
    gap,
  });
  it('按份额 × 差距排序取前 3；验证期内与冷却期内的发现不进入；冷却期内差距扩大 50% 重新进入', () => {
    const now = T;
    const known = new Map<string, KnownFinding>([
      ['f-fixed', { status: 'fixed', cooldownUntil: null, gapAtRejection: null, verifyingUntil: now + DAY }],
      ['f-rejected', { status: 'rejected', cooldownUntil: now + DAY, gapAtRejection: 10, verifyingUntil: null }],
      ['f-grown', { status: 'rejected', cooldownUntil: now + DAY, gapAtRejection: 2, verifyingUntil: null }],
    ]);
    const out = rankCandidates(
      [
        d('f-a', 0.5, 10),
        d('f-b', 0.1, 10),
        d('f-c', 0.9, 2),
        d('f-fixed', 0.9, 100),
        d('f-rejected', 0.9, 12),
        d('f-grown', 0.4, 3),
        d('f-e', null, 1),
      ],
      known,
      now,
    );
    expect(out.map((c) => [c.finding, c.selected, c.skipped_reason])).toEqual([
      ['f-fixed', false, 'verifying'],
      ['f-rejected', false, 'cooldown'],
      ['f-a', true, null],
      ['f-c', true, null],
      ['f-grown', true, null],
      ['f-b', false, 'rank'],
      ['f-e', false, 'rank'],
    ]);
  });
});

describe('优化结论阶梯', () => {
  const CL = 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres';
  const A = { fingerprint: 'sha256:' + 'a'.repeat(64), entity: 'pg_statement:cchp-postgres/cchp/aaa', component: CL };
  const B = { fingerprint: 'sha256:' + 'b'.repeat(64), entity: 'pg_statement:cchp-postgres/cchp/bbb', component: CL };
  const entity = {
    cluster_id: 'cchp',
    kind: 'Cluster.postgresql.cnpg.io',
    namespace: 'cchp-data',
    name: 'cchp-postgres',
    uid: null,
  };
  function card(n: number, id: string, verdict: EvidenceResult['verdict'], at: string | null = null): EvidenceResult {
    return {
      ref: `card:${n}`,
      card_id: id,
      title: { 'zh-CN': id, en: id },
      threshold: null,
      series: [],
      entity,
      window: { from: new Date(T).toISOString(), to: new Date(T + DAY).toISOString() },
      verdict,
      display_state: verdict,
      reason: { kind: 'rule', text: id },
      value: null,
      table: null,
      queries: [],
      egress: 'allow',
      anomaly_started_at: at,
      evaluated_at: new Date(T + DAY).toISOString(),
    };
  }
  const hyp = (id: string, f: typeof A, mechanism: string, supporting: string[], refuting: string[]) => ({
    id,
    parent_id: null,
    root_component: f.entity,
    mechanism,
    supporting,
    refuting,
    group: f.fingerprint,
  });
  function setup(cards: EvidenceResult[]) {
    const book = new EvidenceBook({ cards, alerts: [], changes: [], relatedChanges: [] });
    const ledger = new Ledger(book, findingFrame([A, B], null));
    const notes: string[] = [];
    ledger.merge(
      [
        hyp('h1', A, '缺少索引导致顺序扫描', ['card:1'], []),
        hyp('h2', A, 'work_mem 不足导致临时文件', [], ['card:2']),
        hyp('h3', B, '高频轮询', ['card:3'], []),
      ],
      notes,
    );
    ledger.evaluate();
    return ledger;
  }
  const input = (ledger: Ledger, over: Partial<Parameters<typeof judgeFinding>[1]> = {}) => ({
    finding: A.fingerprint,
    gapHolds: true,
    shareCards: [{ ref: 'card:4', share: 0.45 }],
    minShare: 0.2,
    trendOnset: null,
    chosen: ledger.entries.get('h1') ?? null,
    chosenBy: 'model' as const,
    hasHypotheses: true,
    note: null,
    undeterminedReason: null,
    ...over,
  });

  it('不同发现的假设互不影响：h3 不是 h1 的竞争假设；同一发现上被推翻的 h2 算检验过的竞争假设', () => {
    const ledger = setup([
      card(1, 'postgres/statements/seq-scan-ratio', 'abnormal', new Date(T).toISOString()),
      card(2, 'postgres/statements/temp-blocks', 'normal'),
      card(3, 'postgres/statements/calls-per-second', 'abnormal'),
      card(4, 'postgres/contribution/db-time-share', 'abnormal'),
    ]);
    const h1 = ledger.entries.get('h1')!;
    expect(ledger.competitors(h1).map((e) => e.id)).toEqual(['h2']);
    expect(ledger.entries.get('h2')?.status).toBe('refuted');
    const r = judgeFinding(ledger, input(ledger));
    expect(r.conclusion).toMatchObject({
      level: 'evidence_consistent',
      consistency: {
        gap_holds: true,
        share_holds: true,
        trend_onset: null,
        no_contrary_normal: true,
        competitor_tested: true,
      },
      share_refs: ['card:4'],
    });
    expect(ledgerPickInGroup(ledger, A.fingerprint)?.id).toBe('h1');
  });

  it('份额不足、差距不成立、模型弃权时最高为 likely；没有假设为 undetermined', () => {
    const ledger = setup([
      card(1, 'postgres/statements/seq-scan-ratio', 'abnormal'),
      card(2, 'postgres/statements/temp-blocks', 'normal'),
      card(3, 'postgres/statements/calls-per-second', 'abnormal'),
    ]);
    const level = (over: Partial<Parameters<typeof judgeFinding>[1]>) =>
      judgeFinding(ledger, input(ledger, over)).conclusion.level;
    expect(level({ shareCards: [{ ref: 'card:4', share: 0.1 }] })).toBe('likely');
    expect(level({ gapHolds: false })).toBe('likely');
    expect(level({ chosenBy: 'ledger' })).toBe('likely');
    const none = judgeFinding(ledger, input(ledger, { chosen: null, hasHypotheses: false }));
    expect(none.conclusion.level).toBe('undetermined');
    expect(judgeFinding(ledger, input(ledger, { chosen: null })).conclusion.level).toBe('inconclusive');
  });

  it('趋势触发的目标：机制的变化起点晚于指标恶化起点加 1 小时时不满足 evidence_consistent', () => {
    const ledger = setup([
      card(1, 'postgres/statements/seq-scan-ratio', 'abnormal', new Date(T + 3 * HOUR_MS).toISOString()),
      card(2, 'postgres/statements/temp-blocks', 'normal'),
    ]);
    const late = judgeFinding(ledger, input(ledger, { trendOnset: T }));
    expect(late.conclusion.consistency.trend_onset).toBe(false);
    expect(late.conclusion.level).toBe('likely');
    const onTime = judgeFinding(ledger, input(ledger, { trendOnset: T + 2 * HOUR_MS }));
    expect(onTime.conclusion.level).toBe('evidence_consistent');
  });
});

describe('门槛 G1–G6', () => {
  const base = (over: Partial<GateInput> = {}): GateInput => ({
    kind: 'ops_pr',
    domain: 'database',
    level: 'evidence_consistent',
    share: 0.4,
    gates: { min_share: 0.2, min_gain_ratio: 0.1, min_gain_gap_ratio: 0.5 },
    estimate: { lower: 0.02, unit: 'seconds' },
    current: 0.08,
    gap: 0.03,
    guards: [{ id: 'guc-context', ok: true, say: '' }],
    novelty: { active: false, coolingDown: false, recentlyMerged: false },
    counts: { thisRun: 0, issuesToday: 0, prsThisHour: 0, prsThisWeek: 0 },
    timing: { activeIncidentInScope: false, releaseInProgress: false, gatewayWriteAnomaly: false },
    ...over,
  });
  const first = (i: GateInput) => {
    const r = evaluateGates(i);
    const f = r.records.find((x) => !x.passed);
    return f ? `${f.gate}:${f.code}` : 'passed';
  };

  it('全部通过时依次记录 6 道门槛', () => {
    const r = evaluateGates(base());
    expect(r.passed).toBe(true);
    expect(r.records.map((x) => x.gate)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
  });

  it('遇到第一道不通过即停止，记录原因码', () => {
    expect(first(base({ level: 'likely' }))).toBe('G1:level_too_low');
    expect(first(base({ kind: 'business_issue', level: 'likely', share: 0.1 }))).toBe('G1:share_too_low');
    expect(first(base({ kind: 'business_issue', level: 'likely' }))).toBe('passed');
    // 门槛取当前值的 10%（0.008）与差距的 50%（0.015）中较小者
    expect(first(base({ estimate: { lower: 0.007, unit: 'seconds' } }))).toBe('G2:gain_below_threshold');
    expect(first(base({ estimate: { lower: 0.009, unit: 'seconds' } }))).toBe('passed');
    expect(first(base({ estimate: null }))).toBe('G2:estimate_unavailable');
    expect(
      first(
        base({
          domain: 'compute',
          gates: { min_cpu_cores: 0.2 },
          estimate: { lower: 0.15, unit: 'cores' },
          current: 1,
          gap: null,
        }),
      ),
    ).toBe('G2:gain_below_threshold');
    expect(first(base({ guards: [{ id: 'restart-required', ok: false, say: 'shared_buffers 需要重启' }] }))).toBe(
      'G3:restart-required',
    );
    const novelty = (over: Partial<GateInput['novelty']>) =>
      first(base({ novelty: { active: false, coolingDown: false, recentlyMerged: false, ...over } }));
    expect(novelty({ active: true })).toBe('G4:duplicate_active');
    expect(novelty({ coolingDown: true })).toBe('G4:cooldown');
    expect(novelty({ recentlyMerged: true })).toBe('G4:recently_merged');
    const counts = (over: Partial<GateInput['counts']>, kind: GateInput['kind'] = 'ops_pr') =>
      first(base({ kind, counts: { thisRun: 0, issuesToday: 0, prsThisHour: 0, prsThisWeek: 0, ...over } }));
    expect(counts({ thisRun: 2 })).toBe('G5:run_limit');
    expect(counts({ prsThisHour: 1 })).toBe('G5:hourly_pr_limit');
    expect(counts({ prsThisWeek: 5 })).toBe('G5:weekly_pr_limit');
    expect(counts({ issuesToday: 3, prsThisHour: 9, prsThisWeek: 9 }, 'business_issue')).toBe('G5:daily_issue_limit');
    expect(
      first(base({ timing: { activeIncidentInScope: true, releaseInProgress: false, gatewayWriteAnomaly: false } })),
    ).toBe('G6:active_incident');
    expect(
      first(base({ timing: { activeIncidentInScope: false, releaseInProgress: true, gatewayWriteAnomaly: false } })),
    ).toBe('G6:release_in_progress');
  });
});

describe('验证', () => {
  const baseline = week((i) => (i % 24 >= 9 && i % 24 < 18 ? 0.1 + (i % 3) * 0.002 : 0.05));
  // 合并之后的一天（周一），与基线的周一同时段比较
  const day = (v: (h: number) => number) =>
    Array.from({ length: 24 }, (_, h) => [T + 7 * DAY + h * HOUR_MS, v(h)] as [number, number]);
  const run = (window: Array<[number, number]>, guards: Parameters<typeof verifyOutcome>[0]['guards'] = []) =>
    verifyOutcome({
      better: 'lower',
      statistic: 'p95',
      baseline,
      window,
      windowRange: { from: new Date(T + 7 * DAY).toISOString(), to: new Date(T + 8 * DAY).toISOString() },
      estimateLower: 0.03,
      guards,
      cards: [],
      verifiedAt: new Date(T + 8 * DAY).toISOString(),
    });

  it('改善不低于下界的 50% 且超出噪声带为 improved；不够为 no_effect', () => {
    const better = run(day((h) => (h >= 9 && h < 18 ? 0.06 : 0.04)));
    expect(better.result).toBe('improved');
    expect(better.improvement).toBeGreaterThan(0.015);
    expect(run(day((h) => (h >= 9 && h < 18 ? 0.095 : 0.05))).result).toBe('no_effect');
  });

  it('守护指标恶化超过 10% 时为 regressed，优先于改善', () => {
    const errors = week(() => 0.01);
    const guard = {
      indicator: 'cchp/error-ratio',
      better: 'lower' as const,
      statistic: 'p95' as const,
      baseline: errors,
      window: day(() => 0.012),
    };
    const r = run(
      day((h) => (h >= 9 && h < 18 ? 0.06 : 0.04)),
      [guard],
    );
    expect(r.result).toBe('regressed');
    expect(r.guards[0]).toMatchObject({ indicator: 'cchp/error-ratio', regressed: true });
    expect(r.guards[0]?.change_ratio).toBeCloseTo(0.2);
  });
});
