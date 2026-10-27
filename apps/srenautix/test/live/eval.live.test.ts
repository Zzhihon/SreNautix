import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReport, renderMarkdown } from '../../src/eval/report.js';
import { runEval } from '../../src/eval/runner.js';
import { deriveAbstain } from '../../src/eval/leakage.js';
import { WorkerMetrics } from '../../src/research/metrics.js';
import { scenarioEvalCase, startVictoria } from '../support/eval-scenario.js';
import { ReplayServer } from '../support/llm-fixtures.js';
import { testLayer, testRoute } from '../support/research-env.js';
import type { Victoria } from '../support/victoria.js';

// 在本地模型服务上跑一次评测（场景用例与它的 abstain 反事实用例，各 3 次），录制模型响应，
// 供 test/integration/eval-run.test.ts 回放。只在本地运行：
//   SRENAUTIX_LIVE_LLM_BASE_URL=http://127.0.0.1:18431/v1 pnpm test:live

const BASE = process.env.SRENAUTIX_LIVE_LLM_BASE_URL;
if (!BASE) {
  throw new Error('test:live 需要 SRENAUTIX_LIVE_LLM_BASE_URL（只指向本地自己启动的模型服务）');
}

let vm: Victoria;

beforeAll(async () => {
  vm = await startVictoria();
});

afterAll(async () => {
  await vm.stop();
});

describe('真实模型上的评测', () => {
  it('场景用例与 abstain 用例各运行 3 次，录制模型响应', async () => {
    const base = await scenarioEvalCase(vm);
    const abstain = deriveAbstain(base.c, base.s, '7a1b2c3d-0000-4000-8000-0000000000e2', base.c.created_at);
    const cases = [base, ...(abstain ? [abstain] : [])];
    const proxy = new ReplayServer(BASE);
    await proxy.start();
    const out = await runEval({
      mode: 'snapshot',
      cases,
      layers: [
        { routeId: 'local', layer: testLayer([testRoute(proxy.baseUrl)], { firstTokenMs: 300_000, idleMs: 120_000 }) },
      ],
      runs: 3,
      language: 'zh',
      metrics: new WorkerMetrics('worker', false),
      query: null,
      maxTokens: 2_000_000,
      signal: new AbortController().signal,
      codeSha: 'live',
    });
    await proxy.stop();
    const dir = resolve(import.meta.dirname, '../fixtures/llm/eval');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'scenario-pvc.json'),
      `${JSON.stringify({ provenance: { provider: 'llamacpp', model: 'qwen3-1.7b', recorded_at: new Date().toISOString() }, responses: proxy.recorded }, null, 2)}\n`,
    );
    const report = buildReport(
      {
        codeSha: 'live',
        packLock: `sha256:${'0'.repeat(64)}`,
        mode: 'snapshot',
        caseSet: 'scenario',
        runsPerCase: 3,
        seed: 1,
      },
      cases.map((x) => x.c),
      out.runs,
      null,
    );
    process.stdout.write(renderMarkdown(report, '本地模型评测'));
    expect(out.runs).toHaveLength(cases.length * 3);
  });
});
