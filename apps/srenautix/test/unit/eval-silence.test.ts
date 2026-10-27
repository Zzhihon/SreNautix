import type { EvalCase, EvidenceResult } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { labelCase, type Label, type LabelFile } from '../../src/eval/labels.js';
import { opensPr } from '../../src/eval/phase2.js';
import { PushJudge, type PushSettings } from '../../src/eval/push.js';
import { buildRows, evaluateGate } from '../../src/eval/report.js';
import { scoreRun, type RunRecord } from '../../src/eval/score.js';
import { ExternalRoots, externalTypeLookup, type ImpactAlert } from '../../src/notify/external.js';
import { TEST_ENVIRONMENT } from '../support/eval-environment.js';
import { incident, stageA, stageACards } from '../support/scenario.js';

// 健康场景的沉默与三个良性度量（ADR 0175）：良性标注在重建中没有形成事件记为沉默、不按失败计；误推送、误开 issue、
// 误开 PR 只对良性标注计算；门禁的误推送上限默认不设

const base: Omit<Label, 'id' | 'type' | 'roots' | 'disposition'> = {
  title: 't',
  window: { from: '2026-09-01T09:00:00Z', to: '2026-09-01T11:00:00Z' },
  as_of: '2026-09-01T10:10:00Z',
  fault_alerts: [{ alertname: 'A', labels: {} }],
  discovery_roots: [],
  revisions: [],
  granularity: null,
  mechanism: null,
  mechanism_expect: [],
  mechanism_forbid: [],
  required_evidence: [],
  required_members: [],
  required_change_near: null,
  legacy_case: null,
  legacy_roots: [],
  learned_from: [],
  fix: null,
  noise: [],
  evidence: [{ kind: 'state', ref: 'x' }],
};
const benignLabel: Label = { ...base, id: 'healthy', type: 'benign', roots: [], disposition: 'ignore' };
const incidentLabel: Label = {
  ...base,
  id: 'outage',
  type: 'incident',
  roots: ['Deployment:shop/api'],
  disposition: 'act',
};
const file: LabelFile = { version: 1, cluster_id: 'c', labels: [benignLabel, incidentLabel] };
const benign: EvalCase = labelCase(file, benignLabel, 's', '7a1b2c3d-0000-4000-8000-0000000000b1', base.as_of);
const real: EvalCase = labelCase(file, incidentLabel, 's', '7a1b2c3d-0000-4000-8000-0000000000b2', base.as_of);

function run(caseId: string, i: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    caseId,
    run: i,
    routeId: 'r',
    model: 'm',
    environment: TEST_ENVIRONMENT,
    state: 'completed',
    structuredFailure: false,
    level: 'likely',
    disposition: 'ignore',
    top: [],
    cost: 0,
    currency: 'USD',
    inputTokens: 0,
    outputTokens: 0,
    missRate: null,
    fingerprints: [],
    durationMs: 0,
    error: null,
    proposals: [],
    ...over,
  };
}
const silent = (caseId: string, i: number) =>
  run(caseId, i, { state: 'silent', level: null, disposition: null, pushed: false, opensPr: false });

describe('单次运行的评分', () => {
  it('沉默：正确，不计处置；推送与开 PR 算作有判定、不推送、不开 PR', () => {
    const s = scoreRun(benign, silent(benign.case_id, 0));
    expect(s).toMatchObject({
      silent: true,
      correct: true,
      dispositionScored: false,
      pushScored: true,
      falsePush: false,
      issueScored: true,
      falseIssue: false,
      prScored: true,
      falsePr: false,
    });
  });

  it('形成事件的良性运行：推送、escalate、act 而没有提议、会开 PR 各自计数', () => {
    expect(scoreRun(benign, run(benign.case_id, 0, { pushed: true })).falsePush).toBe(true);
    expect(scoreRun(benign, run(benign.case_id, 0, { pushed: false })).falsePush).toBe(false);
    // 没有推送判定（评测配置没有 reconstruct 部分）的运行不计入
    expect(scoreRun(benign, run(benign.case_id, 0)).pushScored).toBe(false);
    expect(scoreRun(benign, run(benign.case_id, 0, { disposition: 'escalate' })).falseIssue).toBe(true);
    expect(scoreRun(benign, run(benign.case_id, 0, { disposition: 'act' })).falseIssue).toBe(true);
    expect(
      scoreRun(
        benign,
        run(benign.case_id, 0, { disposition: 'act', proposals: [{ action_id: 'workload_restart', params: {} }] }),
      ).falseIssue,
    ).toBe(false);
    expect(scoreRun(benign, run(benign.case_id, 0, { opensPr: true })).falsePr).toBe(true);
    expect(scoreRun(benign, run(benign.case_id, 0)).prScored).toBe(false);
    // 处置正确与否只在形成事件时计算
    const wrong = scoreRun(benign, run(benign.case_id, 0, { disposition: 'act' }));
    expect(wrong).toMatchObject({ dispositionScored: true, dispositionCorrect: false, correct: false });
  });

  it('三个度量只对良性用例计算', () => {
    const s = scoreRun(real, run(real.case_id, 0, { pushed: true, disposition: 'escalate', opensPr: true }));
    expect(s).toMatchObject({ pushScored: false, issueScored: false, prScored: false, silent: false });
  });
});

describe('成绩行', () => {
  it('沉默的运行不计入覆盖率、无法判定与结构化输出失败；三个度量的分母是良性运行', () => {
    const runs = [
      silent(benign.case_id, 0),
      silent(benign.case_id, 1),
      run(benign.case_id, 2, { pushed: true, disposition: 'escalate', opensPr: false }),
      run(real.case_id, 0, { top: ['Deployment:shop/api'], disposition: 'act' }),
      run(real.case_id, 1, { top: ['Deployment:shop/api'], disposition: 'act', level: 'undetermined' }),
      run(real.case_id, 2, { top: ['Deployment:shop/api'], disposition: 'act' }),
    ];
    const [row] = buildRows([benign, real], runs, 3, 1);
    expect(row!.false_push).toMatchObject({ numerator: 1, denominator: 3 });
    expect(row!.false_issue).toMatchObject({ numerator: 1, denominator: 3 });
    expect(row!.false_pr).toMatchObject({ numerator: 0, denominator: 3 });
    // 覆盖率：形成事件的 4 次运行中 3 次没有弃权
    expect(row!.coverage).toMatchObject({ numerator: 3, denominator: 4 });
    expect(row!.undetermined_ratio).toMatchObject({ numerator: 1, denominator: 4 });
    expect(row!.structured_output_failure).toMatchObject({ numerator: 0, denominator: 4 });
    // 处置：良性用例只计形成事件的那一次（escalate，错误），真实事件 3 次都对
    expect(row!.disposition_accuracy).toMatchObject({ numerator: 3, denominator: 4 });
    // pass@1：良性用例第一次运行沉默，算作正确
    expect(row!.pass_at_1).toMatchObject({ numerator: 2, denominator: 2 });
  });

  it('全部沉默的良性用例 pass^k 通过', () => {
    const [row] = buildRows(
      [benign],
      [0, 1, 2].map((i) => silent(benign.case_id, i)),
      3,
      1,
    );
    expect(row!.pass_pow_k).toMatchObject({ numerator: 1, denominator: 1 });
    expect(row!.false_push).toMatchObject({ numerator: 0, denominator: 3 });
  });
});

describe('发布门禁的误推送上限', () => {
  const baseline = [0, 1].map((i) => silent(benign.case_id, i));
  const candidate = (pushed: boolean[]) => pushed.map((p, i) => run(benign.case_id, i, { pushed: p }));

  it('默认不设上限', () => {
    const g = evaluateGate(
      '7a1b2c3d-0000-4000-8000-0000000000c1',
      [benign],
      baseline,
      candidate([true, true]),
      2,
      [],
      1,
    );
    expect(g.false_push).toBeNull();
    expect(g.false_push_max).toBeNull();
  });

  it('候选的误推送超过上限时不通过，不超过时通过', () => {
    const over = evaluateGate(
      '7a1b2c3d-0000-4000-8000-0000000000c1',
      [benign],
      baseline,
      candidate([true, false]),
      2,
      [],
      1,
      0.25,
    );
    expect(over.false_push).toMatchObject({ numerator: 1, denominator: 2 });
    expect(over.passed).toBe(false);
    const under = evaluateGate(
      '7a1b2c3d-0000-4000-8000-0000000000c1',
      [benign],
      baseline,
      candidate([false, false]),
      2,
      [],
      1,
      0.25,
    );
    expect(under.false_push).toMatchObject({ numerator: 0, denominator: 2 });
    expect(under.passed).toBe(true);
  });

  it('设了上限却没有带推送判定的良性运行时抛出', () => {
    expect(() =>
      evaluateGate(
        '7a1b2c3d-0000-4000-8000-0000000000c1',
        [benign],
        baseline,
        [run(benign.case_id, 0), run(benign.case_id, 1)],
        2,
        [],
        1,
        0.1,
      ),
    ).toThrow(/误推送上限/);
  });
});

describe('会不会开 PR', () => {
  const tpl = (category: string) => ({ key: `gitops/${category}`, category });

  it('结论低于 likely 不开；被运行级准入挡下的模板不算', () => {
    expect(opensPr({ level: 'inconclusive', admission: null }, [tpl('config_resource')], null)).toBe(false);
    expect(opensPr({ level: 'likely', admission: null }, [tpl('config_resource')], null)).toBe(true);
    expect(
      opensPr(
        { level: 'likely', admission: { general: { code: 'cause_scope', reason: 'x' }, alertRule: null } },
        [tpl('config_resource')],
        null,
      ),
    ).toBe(false);
    expect(opensPr({ level: 'evidence_consistent', admission: null }, [], null)).toBe(false);
  });

  it('标注的标准修复是 alert_rule 时 alert_rule 类的模板不算，其他类别照算', () => {
    expect(opensPr({ level: 'likely', admission: null }, [tpl('alert_rule')], 'alert_rule')).toBe(false);
    expect(opensPr({ level: 'likely', admission: null }, [tpl('alert_rule')], null)).toBe(true);
    expect(
      opensPr({ level: 'likely', admission: null }, [tpl('alert_rule'), tpl('release_rollback')], 'alert_rule'),
    ).toBe(true);
  });
});

describe('推送判定', () => {
  const settings = (over: Partial<PushSettings['external']> = {}): PushSettings => ({
    severities: ['critical', 'warning'],
    external: {
      enabled: true,
      periodMs: 3_600_000,
      components: ['Deployment:shop/web'],
      alertLabels: {},
      impact: { alerts: [], impactCards: true, withinMs: 30 * 60_000, topologyHops: 0, ...over.impact },
      ...over,
    },
  });
  const judge = (
    s: PushSettings,
    o: {
      severity?: 'critical' | 'warning' | 'info';
      suppressed?: boolean;
      reason?: string;
      cards?: EvidenceResult[];
    } = {},
    alerts: ImpactAlert[] = [],
  ) =>
    new PushJudge(
      s,
      {
        incident: { ...incident(), severity: o.severity ?? 'critical', suppressed: o.suppressed ?? false },
        stageA: {
          ...stageA(o.cards ?? stageACards()),
          disposition_reason: (o.reason ?? 'default') as ReturnType<typeof stageA>['disposition_reason'],
        },
        alerts: [],
      },
      'zh',
      new ExternalRoots(
        async () => alerts,
        s.external,
        externalTypeLookup(
          () => [],
          async () => null,
        ),
        async () => null,
        () => 0,
      ),
      async () => [],
    );

  it('严重度不在推送范围、被抑制、计划内退役时不推送', async () => {
    expect(await judge(settings(), { severity: 'info' }).pushed({ state: 'completed', root: null })).toBe(false);
    expect(await judge(settings(), { suppressed: true }).pushed({ state: 'completed', root: null })).toBe(false);
    expect(await judge(settings(), { reason: 'planned_retirement' }).pushed({ state: 'completed', root: null })).toBe(
      false,
    );
    expect(await judge(settings()).pushed({ state: 'completed', root: null })).toBe(true);
  });

  it('外部上游按这次运行的研判根因分类：没有业务影响时进入周期汇总，不推送', async () => {
    const quiet = stageACards().map((c) => ({ ...c, verdict: 'normal' as const, impact: false }));
    const j = judge(settings(), { cards: quiet });
    // 研判完成、结论选中的根因是配置列出的外部组件
    expect(await j.pushed({ state: 'completed', root: 'Deployment:shop/web' })).toBe(false);
    // 研判没有完成时取事件根因（postgres），不是外部上游
    expect(await j.pushed({ state: 'failed', root: 'Deployment:shop/web' })).toBe(true);
    expect(await j.pushed({ state: 'completed', root: null })).toBe(true);
  });

  it('外部上游有业务影响（本事件异常的影响卡、时间窗内开始的业务影响告警）时即时推送', async () => {
    const quiet = stageACards().map((c) => ({ ...c, verdict: 'normal' as const, impact: false }));
    const withCard = [...quiet.slice(1), { ...quiet[0]!, verdict: 'abnormal' as const, impact: true }];
    expect(
      await judge(settings(), { cards: withCard }).pushed({ state: 'completed', root: 'Deployment:shop/web' }),
    ).toBe(true);
    const inc = incident();
    const alert: ImpactAlert = {
      cluster_id: inc.cluster_id,
      alertname: 'CheckoutErrors',
      component: null,
      starts_at: new Date(Date.parse(inc.first_firing_at) + 60_000).toISOString(),
      ends_at: null,
    };
    // 业务影响告警的来源已经按条件过滤（server 读状态库，评测读重建包），这里只需要条件不为空
    const s = settings({
      impact: {
        alerts: [{ labels: { layer: ['L0'] }, exclude_labels: {} }],
        impactCards: false,
        withinMs: 30 * 60_000,
        topologyHops: 0,
      },
    });
    expect(await judge(s, { cards: quiet }, [alert]).pushed({ state: 'completed', root: 'Deployment:shop/web' })).toBe(
      true,
    );
    expect(await judge(s, { cards: quiet }, []).pushed({ state: 'completed', root: 'Deployment:shop/web' })).toBe(
      false,
    );
  });

  it('外部上游汇总没有启用时照常推送', async () => {
    const s = settings({ enabled: false });
    const j = new PushJudge(s, { incident: incident(), stageA: stageA(), alerts: [] }, 'zh', null, async () => []);
    expect(await j.pushed({ state: 'completed', root: 'Deployment:shop/web' })).toBe(true);
  });
});
