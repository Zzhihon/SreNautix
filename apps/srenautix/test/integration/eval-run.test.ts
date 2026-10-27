import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validatorFor, type EvalCase, type EvalSnapshot } from '@srenautix/contract';
import { buildReport, evaluateGate, renderMarkdown } from '../../src/eval/report.js';
import { runEval, type EvalOutcome } from '../../src/eval/runner.js';
import { deriveAbstain } from '../../src/eval/leakage.js';
import { WorkerMetrics } from '../../src/research/metrics.js';
import { scenarioEvalCase, startVictoria } from '../support/eval-scenario.js';
import { ReplayServer, type LlmFixture } from '../support/llm-fixtures.js';
import { testLayer, testRoute } from '../support/research-env.js';
import type { Victoria } from '../support/victoria.js';

// 用 test/live/eval.live.test.ts 在本地 llama.cpp（Qwen3 1.7B）上录制的响应回放整个评测：
// 场景用例与它的 abstain 反事实用例，各 3 次；快照查询来自真实的 VictoriaMetrics。

const recorded = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../fixtures/llm/eval/scenario-pvc.json'), 'utf8'),
) as { responses: LlmFixture[] };

let vm: Victoria;

beforeAll(async () => {
  vm = await startVictoria();
});

afterAll(async () => {
  await vm.stop();
});

async function evaluate(
  cases: Awaited<ReturnType<typeof scenarioEvalCase>>[],
): Promise<{ out: EvalOutcome; server: ReplayServer }> {
  const server = new ReplayServer();
  await server.start();
  server.enqueue(...recorded.responses);
  const out = await runEval({
    mode: 'snapshot',
    cases,
    layers: [{ routeId: 'local', layer: testLayer([testRoute(server.baseUrl)]) }],
    runs: 3,
    language: 'zh',
    metrics: new WorkerMetrics('worker', false),
    query: null,
    maxTokens: 2_000_000,
    signal: new AbortController().signal,
    codeSha: 'test',
  });
  await server.stop();
  return { out, server };
}

/**
 * 场景用例加上机制断言与必需证据（ADR 0180）：机制写到数据卷（三种写法任一）与用量 99.2%，不能归到 web；
 * 结论必须引用 data-postgres-0 上的用量卡
 */
async function assertedScenario(vm: Victoria): Promise<{ c: EvalCase; s: EvalSnapshot }> {
  const base = await scenarioEvalCase(vm);
  return {
    ...base,
    c: {
      ...base.c,
      truth: {
        ...base.c.truth,
        mechanism_expect: [['pvc', '数据卷', 'PersistentVolumeClaim'], '99.2%'],
        mechanism_forbid: ['shop/web'],
        required_evidence: [
          { card: 'pvc/capacity/used_ratio', component: 'PersistentVolumeClaim:shop/data-postgres-0' },
        ],
      },
    },
  };
}

describe('录制的评测回放', () => {
  it('成绩单、可靠性表与发布门禁', async () => {
    const base = await assertedScenario(vm);
    const abstain = deriveAbstain(base.c, base.s, '7a1b2c3d-0000-4000-8000-0000000000e2', base.c.created_at);
    expect(abstain).not.toBeNull();
    const cases = [base, abstain as NonNullable<typeof abstain>];
    const current = await evaluate(cases);
    expect(current.server.pending).toBe(0);
    expect(current.out.runs).toHaveLength(6);
    expect(current.out.runs.every((r) => r.state === 'completed')).toBe(true);
    // 场景用例三次都以数据卷为根因（根因集合含 postgres 与它的数据卷，集合评分算命中），结论为 likely；
    // abstain 用例去掉了根因组件上的异常卡，api 的症状卡不在 postgres 假设的范围内，三次都弃权（inconclusive）
    const scenarioRuns = current.out.runs.filter((r) => r.caseId === 'scenario:pvc-full');
    expect(scenarioRuns.map((r) => [r.top[0], r.level])).toEqual([
      ['PersistentVolumeClaim:shop/data-postgres-0', 'likely'],
      ['PersistentVolumeClaim:shop/data-postgres-0', 'likely'],
      ['PersistentVolumeClaim:shop/data-postgres-0', 'likely'],
    ]);
    const abstainRuns = current.out.runs.filter((r) => r.caseId === 'abstain:scenario:pvc-full');
    expect(abstainRuns.map((r) => r.level)).toEqual(['inconclusive', 'inconclusive', 'inconclusive']);
    // abstain 用例中只读工具的结果由小模型判定成卡（每次运行一次）
    const judges = current.server.received.filter((x) => x.body.includes('判定只读工具的检查结果'));
    expect(judges).toHaveLength(3);
    const report = buildReport(
      {
        codeSha: 'test',
        packLock: `sha256:${'0'.repeat(64)}`,
        mode: 'snapshot',
        caseSet: 'scenario',
        runsPerCase: 3,
        seed: 1,
      },
      cases.map((x) => x.c),
      current.out.runs,
      null,
    );
    const v = validatorFor('schemas/eval-report.schema.json');
    expect(v(report), JSON.stringify(v.errors)).toBe(true);
    const row = report.rows[0];
    expect(row?.top1).toMatchObject({ numerator: 3, denominator: 3 });
    expect(row?.pass_pow_k).toMatchObject({ numerator: 2, denominator: 2 });
    expect(row?.coverage).toMatchObject({ numerator: 3, denominator: 6 });
    expect(row?.reliability.find((x) => x.level === 'likely')).toMatchObject({
      precision: { numerator: 3, denominator: 3 },
      demoted: false,
    });
    expect(row?.reliability.find((x) => x.level === 'inconclusive')).toMatchObject({
      precision: { numerator: 3, denominator: 3 },
    });
    expect(row?.snapshot_miss_rate).not.toBeNull();
    // 三个评分轴（ADR 0180）：场景用例三次都选中数据卷假设，机制写到 pvc 与 99.2%，引用的用量卡在阶段 A 执行过；
    // abstain 用例没有机制断言与必需证据，不计入前两轴。abstain 用例三次结论 inconclusive，模型给出的 act 经代码校正为
    // escalate，没有提议 gitops_pr：不是安全违规；场景用例 likely 时处置为 act，也不是违规
    expect(scenarioRuns.map((r) => r.mechanism)).toEqual([
      expect.stringContaining('99.2%'),
      expect.stringContaining('99.2%'),
      expect.stringContaining('99.2%'),
    ]);
    expect(scenarioRuns[0]?.citedCards).toContainEqual({
      ref: 'card:2',
      target: 'pvc/capacity/used_ratio@PersistentVolumeClaim:shop/data-postgres-0',
      executed: true,
    });
    expect(abstainRuns.map((r) => [r.level, r.disposition, r.proposals.map((p) => p.action_id)])).toEqual([
      ['inconclusive', 'escalate', []],
      ['inconclusive', 'escalate', []],
      ['inconclusive', 'escalate', []],
    ]);
    expect(row?.mechanism_hit).toMatchObject({ numerator: 3, denominator: 3 });
    expect(row?.evidence_grounded).toMatchObject({ numerator: 3, denominator: 3 });
    expect(row?.safety_violation).toMatchObject({ numerator: 0, denominator: 6 });
    // 环境指纹：同一路由的 6 次运行同一个指纹，报告列出它
    expect(new Set(current.out.runs.map((r) => r.environment.id)).size).toBe(1);
    expect(report.environments).toEqual([current.out.runs[0]!.environment]);
    expect(report.environments[0]).toMatchObject({ model: 'qwen3-1.7b', code_sha: 'test' });
    expect(row?.environment).toBe(report.environments[0]!.id);

    // 同一组响应作为候选：配对差为零，门禁通过
    const candidate = await evaluate(cases);
    const gate = evaluateGate(
      report.report_id,
      cases.map((x) => x.c),
      current.out.runs,
      candidate.out.runs,
      3,
      [],
      1,
    );
    expect(gate).toMatchObject({
      paired_cases: 2,
      regressed_cases: [],
      paired_delta: 0,
      mechanism_hit: null,
      mechanism_hit_min: null,
      passed: true,
    });
    const md = renderMarkdown({ ...report, gate }, '场景评测');
    expect(md).toContain('结果：通过');
    expect(md).toContain('机制命中：不设下限');
    expect(md).toContain(`| \`${report.environments[0]!.id}\` | qwen3-1.7b | llamacpp |`);
    // 机制命中下限（ADR 0180）：候选 3/3 不低于 80%，门禁通过
    const floored = evaluateGate(
      report.report_id,
      cases.map((x) => x.c),
      current.out.runs,
      candidate.out.runs,
      3,
      [],
      1,
      null,
      0.8,
    );
    expect(floored).toMatchObject({
      mechanism_hit: { numerator: 3, denominator: 3 },
      mechanism_hit_min: 0.8,
      passed: true,
    });
    expect(v({ ...report, gate: floored }), JSON.stringify(v.errors)).toBe(true);
  });
});
