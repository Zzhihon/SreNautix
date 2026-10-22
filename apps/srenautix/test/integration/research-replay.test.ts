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
// 小模型的输出有很多问题（父子环、type 写错、工具参数缺字段、编造的查询语法、结论超出输出上限、
// 修复建议 id 不合格式、提议目标不在拓扑中），这里验证代码对每一处问题的处理。

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

    // 结论：数据卷卡在范围内异常、早于症状；但全部检查都失败，竞争假设（postgres 与 api）同样处于支持状态，只能是 likely
    expect(out.conclusion).toMatchObject({
      level: 'likely',
      root_component: 'PersistentVolumeClaim:shop/data-postgres-0',
      consistency: {
        entity_in_scope: true,
        onset_precedes_symptom: true,
        no_contrary_normal: true,
        competitor_tested: false,
      },
    });
    expect(res.stopReason).toBe('no_change');
    const notes = out.validation_notes.join('\n');
    expect(notes).toMatch(/构成环/);
    expect(notes).toMatch(/type 写成 query，目标是只读工具，已改为 tool/);
    expect(notes).toMatch(/args_json 经 jsonrepair 修复/);
    expect(notes).toMatch(/假设 h1 的竞争假设 h2、h3 同样处于支持状态，检查没有区分它们/);
    // pod_restart 的目标是占位符 Pod:shop/<pod-name>：删除；没有有效提议时 act 改为 escalate（critical）
    expect(notes).toMatch(/提议 pod_restart：目标 Pod:shop\/<pod-name> 不在本次研判的拓扑中/);
    expect(notes).toMatch(/处置为 act 但没有有效的提议、规则提议或适用的修复模板，改为 escalate/);
    expect(out.proposals).toEqual([]);
    expect(out.disposition).toBe('escalate');
    // 修复建议的 id 不合格式：按顺序重新编号为 r1、r2，不删除建议（ADR 0136）
    expect(out.recommendations.map((r) => [r.id, r.kind, r.action_id])).toEqual([
      ['r1', 'mitigation', 'pod_restart'],
      ['r2', 'prevention', 'workload_scale'],
    ]);
    expect(notes).toMatch(/\/recommendations\[0\]：id "[^"]+"，按顺序重新编号为 r1/);

    // 检查：参数缺字段的 pod_get 被 MCP 服务器按输入 schema 拒绝；编造的查询语法被 VictoriaMetrics 拒绝；
    // 失败的检查不产生卡，也不算检验过
    expect(out.next_checks.map((c) => [c.hypothesis_id, c.template, c.outcome])).toEqual([
      ['h1', 'metrics.pod_get', 'failed'],
      ['h2', 'metrics.pod_get', 'failed'],
      ['h3', 'metrics.pod_get', 'failed'],
      ['h1', 'metrics.query', 'failed'],
      ['h2', 'metrics.query', 'failed'],
      ['h3', 'metrics.query', 'failed'],
    ]);
    expect(out.next_checks.every((c) => c.result_ref === null)).toBe(true);
    expect(
      sink.tools.filter((t) => t.tool === 'metrics.pod_get').every((t) => t.error?.includes('Input validation error')),
    ).toBe(true);
    expect(
      sink.tools.filter((t) => t.tool === 'metrics.query').every((t) => t.error?.includes('cannot recognize')),
    ).toBe(true);
    expect(mcp.calls.filter((c) => c.tool === 'query')).toHaveLength(3);

    // 状态机与调用记录：conclude 第一次输出超出上限被截断，带上错误重新请求后成功
    expect(sink.steps.map((s) => s.state)).toEqual([
      'hypothesize',
      'discriminate',
      'hypothesize',
      'discriminate',
      'conclude',
    ]);
    expect(sink.llm.map((c) => [c.phase, c.outcome, c.repairStep])).toEqual([
      ['hypothesize', 'succeeded', 'validate'],
      ['hypothesize', 'succeeded', 'validate'],
      ['conclude', 'retried', 'parse'],
      ['conclude', 'succeeded', 'reask'],
    ]);
    expect(res.session.egress.every((e) => e.in_domain)).toBe(true);
    expect(res.ledger.input).toBe(sink.llm.reduce((a, c) => a + c.usage.input_tokens, 0));
  });

  it('研判子图没有组件：不提出假设，直接结论为 undetermined', async () => {
    const server = new ReplayServer();
    await server.start();
    // 只排队一次 conclude 的响应（录制中的最后一条，选了 h1）；hypothesize 不应被调用
    server.enqueue(recorded.responses[3] as LlmFixture);
    const base = researchCase();
    const rc = {
      ...base,
      incident: { ...base.incident, root: { ...base.incident.root, component: null, entity: null }, candidates: [] },
      subgraph: { ...base.subgraph, root: null, nodes: [], edges: [] },
    } as typeof base;
    const sink = new MemorySink();
    const res = await runStageB(
      { runId: '7a1b2c3d-0000-4000-8000-0000000000b2', rc, previous: null, signal: new AbortController().signal },
      testEnv(testLayer([testRoute(server.baseUrl)]), [], false),
      sink,
    );
    await server.stop();
    expect(server.pending).toBe(0);
    expect(res.state).toBe('completed');
    expect(res.output?.conclusion).toMatchObject({ level: 'undetermined', hypothesis_id: null, root_component: null });
    expect(res.output?.validation_notes[0]).toBe('研判子图没有组件（事件没有根因），不提出假设，直接结论');
    expect(sink.llm.map((c) => c.phase)).toEqual(['conclude']);
    expect(sink.steps.map((s) => s.state)).toEqual(['hypothesize', 'conclude']);
  });
});
