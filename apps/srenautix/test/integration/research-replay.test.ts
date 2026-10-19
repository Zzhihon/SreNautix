import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validatorFor } from '@srenautix/contract';
import { runStageB } from '../../src/research/controller.js';
import { ReplayServer, type LlmFixture } from '../support/llm-fixtures.js';
import { startMetricsMcp, type MetricsMcp } from '../support/metrics-mcp.js';
import { metricsTools, MemorySink, testEnv, testLayer, testRoute } from '../support/research-env.js';
import { metricLines, researchCase } from '../support/scenario.js';
import { startVictoria, type Victoria } from '../support/victoria.js';

// 用 test/live/research.live.test.ts 在本地 llama.cpp（Qwen3 1.7B）上录制的模型响应回放完整的阶段 B：
// 模型响应按顺序回放，只读工具真实执行（真实的 MCP 服务器与 VictoriaMetrics）。
// 小模型的输出有很多问题（父子环、type 写错、工具参数缺字段、修复建议 id 不合格式、提议目标不在拓扑中），
// 这里验证代码对每一处问题的处理。

const recorded = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../fixtures/llm/research/pvc-full.json'), 'utf8'),
) as { responses: LlmFixture[] };

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

describe('录制的研判回放', () => {
  it('账本、检查、校验与结论阶梯', async () => {
    const server = new ReplayServer();
    await server.start();
    server.enqueue(...recorded.responses);
    const tools = await metricsTools(mcp.url);
    const sink = new MemorySink();
    const res = await runStageB(
      {
        runId: '7a1b2c3d-0000-4000-8000-0000000000b1',
        rc: researchCase(),
        previous: null,
        signal: new AbortController().signal,
      },
      testEnv(testLayer([testRoute(server.baseUrl)]), tools.tools, false),
      sink,
    );
    await tools.close();
    await server.stop();

    expect(server.pending).toBe(0);
    expect(res.state).toBe('completed');
    const out = res.output;
    expect(out).not.toBeNull();
    if (!out) {
      return;
    }
    // 输出符合契约
    const v = validatorFor('schemas/research-output.schema.json');
    expect(v(out), JSON.stringify(v.errors)).toBe(true);

    // 结论：postgres 的数据卷卡在范围内异常、早于症状；web 的发布假设被它自己的正常错误率卡推翻（竞争假设已检验）
    expect(out.conclusion).toMatchObject({
      level: 'evidence_consistent',
      root_component: 'StatefulSet:shop/postgres',
      consistency: {
        entity_in_scope: true,
        onset_precedes_symptom: true,
        no_contrary_normal: true,
        competitor_tested: true,
      },
    });
    const notes = out.validation_notes.join('\n');
    expect(notes).toMatch(/构成环/);
    expect(notes).toMatch(/type 写成 query，目标是只读工具，已改为 tool/);
    expect(notes).toMatch(/args_json 经 jsonrepair 修复/);
    // pod_restart 的目标 Pod:shop/data-postgres-0 不在拓扑中：删除；没有有效提议时 act 改为 escalate（critical）
    expect(notes).toMatch(/提议 pod_restart：目标 Pod:shop\/data-postgres-0 不在本次研判的拓扑中/);
    expect(out.proposals).toEqual([]);
    expect(out.disposition).toBe('escalate');
    // 修复建议的 id 不合格式，按字段挽救时整条删除
    expect(out.recommendations).toEqual([]);

    // 检查：参数缺字段的 pod_get 被 MCP 服务器按输入 schema 拒绝（失败，不计入检验过）；
    // query 真实查询 VictoriaMetrics，结果由小模型判定成卡
    expect(out.next_checks.map((c) => [c.hypothesis_id, c.template, c.outcome])).toEqual([
      ['h1', 'metrics.pod_get', 'failed'],
      ['h2', 'metrics.pod_get', 'failed'],
      ['h1', 'metrics.query', 'inconclusive'],
      ['h2', 'metrics.query', 'inconclusive'],
    ]);
    expect(out.next_checks.filter((c) => c.outcome !== 'failed').every((c) => c.result_ref !== null)).toBe(true);
    expect(
      sink.tools.filter((t) => t.tool === 'metrics.pod_get').every((t) => t.error?.includes('Input validation error')),
    ).toBe(true);
    expect(mcp.calls.filter((c) => c.tool === 'query')).toHaveLength(2);
    const judged = res.book.allCards.filter((c) => c.judgedBy === 'model');
    expect(judged.map((c) => c.result.reason.kind)).toEqual(['model_judged', 'model_judged']);

    // 状态机与调用记录
    expect(sink.steps.map((s) => s.state)).toEqual([
      'hypothesize',
      'discriminate',
      'hypothesize',
      'discriminate',
      'conclude',
    ]);
    expect(sink.llm.map((c) => [c.phase, c.outcome])).toEqual([
      ['hypothesize', 'succeeded'],
      ['hypothesize', 'succeeded'],
      ['compress', 'succeeded'],
      ['compress', 'succeeded'],
      ['conclude', 'succeeded'],
    ]);
    expect(sink.llm.at(-1)?.repairStep).toBe('field_salvage');
    expect(res.session.egress.every((e) => e.in_domain)).toBe(true);
    expect(res.ledger.input).toBe(sink.llm.reduce((a, c) => a + c.usage.input_tokens, 0));
  });
});
