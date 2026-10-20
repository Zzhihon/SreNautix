import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStageB } from '../../src/research/controller.js';
import { ReplayServer } from '../support/llm-fixtures.js';
import { startMetricsMcp, type MetricsMcp } from '../support/metrics-mcp.js';
import { metricsTools, MemorySink, testEnv, testLayer, testRoute } from '../support/research-env.js';
import { metricLines, researchCase } from '../support/scenario.js';
import { startVictoria, type Victoria } from '../support/victoria.js';

// 对真实的本地模型服务（例如 llama.cpp 的 llama-server）运行完整的阶段 B，并录制模型响应作为
// test/integration/research.test.ts 的夹具。只在本地运行：
//   SRENAUTIX_LIVE_LLM_BASE_URL=http://127.0.0.1:18431/v1 pnpm test:live

const BASE = process.env.SRENAUTIX_LIVE_LLM_BASE_URL;
if (!BASE) {
  throw new Error('test:live 需要 SRENAUTIX_LIVE_LLM_BASE_URL（只指向本地自己启动的模型服务）');
}
const OUT = resolve(import.meta.dirname, '../fixtures/llm/research');

let vm: Victoria;
let mcp: MetricsMcp;

beforeAll(async () => {
  vm = await startVictoria();
  await vm.importLines(metricLines());
  mcp = await startMetricsMcp(vm.url);
});

afterAll(async () => {
  await mcp.stop();
  await vm.stop();
});

describe('真实模型上的阶段 B', () => {
  it('数据卷写满场景：录制模型响应', async () => {
    const proxy = new ReplayServer(BASE);
    await proxy.start();
    const tools = await metricsTools(mcp.url);
    const sink = new MemorySink();
    const res = await runStageB(
      {
        runId: '7a1b2c3d-0000-4000-8000-0000000000b1',
        rc: researchCase(),
        previous: null,
        signal: new AbortController().signal,
      },
      testEnv(testLayer([testRoute(proxy.baseUrl)], { firstTokenMs: 300_000, idleMs: 120_000 }), tools.tools, false),
      sink,
    );
    await tools.close();
    await proxy.stop();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      join(OUT, 'pvc-full.json'),
      `${JSON.stringify({ provenance: { provider: 'llamacpp', model: 'qwen3-1.7b', recorded_at: new Date().toISOString(), scenario: 'pvc-full' }, responses: proxy.recorded }, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ state: res.state, stop: res.stopReason, error: res.error, conclusion: res.output?.conclusion, checks: res.output?.next_checks, notes: res.output?.validation_notes, calls: sink.llm.map((c) => [c.phase, c.outcome, c.repairStep, c.usage.input_tokens, c.usage.output_tokens]) }, null, 2)}\n`,
    );
    expect(proxy.recorded.length).toBeGreaterThan(0);
  });
});
