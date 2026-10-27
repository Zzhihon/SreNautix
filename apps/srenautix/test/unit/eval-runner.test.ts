import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalCase, EvalSnapshot } from '@srenautix/contract';
import { importSeed } from '../../src/eval/import-seed.js';
import { runEval, type EvalPlan } from '../../src/eval/runner.js';
import { CaseStore } from '../../src/eval/store.js';
import type { ModelLayer } from '../../src/llm/session.js';
import type * as Controller from '../../src/research/controller.js';
import type { ResearchRunResult } from '../../src/research/controller.js';
import { WorkerMetrics } from '../../src/research/metrics.js';
import { writeSeedFixture } from '../support/seed-fixture.js';

// 评测框架的兜底：阶段 B 抛出没有被归类的异常（例如 SDK 的 SyntaxError: malformed server-sent event JSON）时，
// 只记这一次运行失败（model_unavailable），不让整个评测进程退出；评测被中止时照常抛出

const stageB = vi.hoisted(() => ({ impl: null as null | ((n: number) => Promise<unknown>), calls: 0 }));
vi.mock('../../src/research/controller.js', async (importOriginal) => {
  const real = await importOriginal<typeof Controller>();
  return { ...real, runStageB: async () => stageB.impl!(stageB.calls++) };
});

const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `eval-runner-${process.pid}`);
let cases: Array<{ c: EvalCase; s: EvalSnapshot }>;

const completed = {
  state: 'completed',
  stopReason: null,
  output: null,
  error: null,
  checks: [],
  session: { routeUses: [] },
  ledger: { input: 10, output: 5, cost: 0 },
} as unknown as ResearchRunResult;

const layer = {
  route: () => ({ route: { model: 'm', price: { currency: 'USD' } }, profile: { id: 'openai-chat' } }),
} as unknown as ModelLayer;

const plan = (runs: number, signal = new AbortController().signal): EvalPlan => ({
  mode: 'reconstructed',
  cases,
  layers: [{ routeId: 'a', layer }],
  runs,
  language: 'zh',
  metrics: new WorkerMetrics('worker', false),
  query: null,
  maxTokens: 1_000_000,
  signal,
  codeSha: 'test',
});

beforeAll(async () => {
  mkdirSync(ROOT, { recursive: true });
  writeSeedFixture(join(ROOT, 'seed'));
  const store = new CaseStore(join(ROOT, 'cases'));
  await importSeed({ dir: join(ROOT, 'seed'), suite: 'reference', clusterId: 'ref', store });
  cases = store.cases('reference').map((c) => ({ c, s: store.snapshot(c.snapshot_id as string) }));
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  stageB.calls = 0;
});

describe('评测运行的兜底', () => {
  it('单次运行抛出未分类的异常：这一次记为 failed（model_unavailable），其余运行照常', async () => {
    stageB.impl = async (n) => {
      if (n === 0) {
        throw new SyntaxError('Error reading response: malformed server-sent event JSON.');
      }
      return completed;
    };
    const out = await runEval(plan(20));
    expect(out.runs).toHaveLength(20);
    expect(out.runs[0]).toMatchObject({
      state: 'failed',
      level: null,
      error: expect.stringMatching(/^model_unavailable: .*SyntaxError: Error reading response: malformed server-sent/),
    });
    expect(out.runs.slice(1).every((r) => r.state === 'completed' && r.error === null)).toBe(true);
    expect(out.tokens).toBe(19 * 15);
  });

  it('评测被中止：照常抛出中止原因', async () => {
    const ac = new AbortController();
    const reason = new Error('eval aborted');
    stageB.impl = async () => {
      ac.abort(reason);
      throw reason;
    };
    await expect(runEval(plan(3, ac.signal))).rejects.toBe(reason);
  });
});
