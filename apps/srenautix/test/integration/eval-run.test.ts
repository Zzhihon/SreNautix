import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validatorFor } from '@srenautix/contract';
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
  });
  await server.stop();
  return { out, server };
}

describe('录制的评测回放', () => {
  it('成绩单、可靠性表与发布门禁', async () => {
    const base = await scenarioEvalCase(vm);
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
    expect(gate).toMatchObject({ paired_cases: 2, regressed_cases: [], paired_delta: 0, passed: true });
    const md = renderMarkdown({ ...report, gate }, '场景评测');
    expect(md).toContain('结果：通过');
  });
});
