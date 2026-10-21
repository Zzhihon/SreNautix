import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmReplay } from '../../src/llm/replay.js';
import { runStageB } from '../../src/research/controller.js';
import type { ResearchCase, Subgraph } from '../../src/research/types.js';
import { MemorySink, testEnv, testLayer, testRoute } from '../support/research-env.js';
import { incident, researchCase, stageA } from '../support/scenario.js';

/**
 * kind-e2e 的模型录制经 llm-replay 走完整的阶段 B（与 deploy/kind/values/srenautix-replay.yaml 相同的路由：
 * Responses、openai-responses、流式）。事件的组件、证据卡、检查模板与动作因场景与时机而不同，
 * 录制必须在这些情况下都给出合法输出并让研判结束，而不是因为输出不合 schema 被当成模型不可用。
 */
const SCENARIOS = resolve(import.meta.dirname, '../../../../deploy/kind/scenarios');
const NAMES = [
  'release-stuck-init',
  'release-bad-image',
  'config-resource-oom',
  'alert-too-sensitive',
  'unmapped-alert',
];

/** Kind 中常见的最小事件：根因是一个 Pod，子图只有它与属主，没有证据卡、检查模板与动作 */
function bareCase(root: string): ResearchCase {
  const base = incident();
  const [kind, rest] = root.split(':') as [string, string];
  const [ns, name] = rest.split('/') as [string, string];
  const nodes: Subgraph['nodes'] = [
    { component: root, kind, namespace: ns, name, role: 'root', alerts: ['a1'], hops: 0 },
    {
      component: 'Node:kind-worker',
      kind: 'Node',
      namespace: null,
      name: 'kind-worker',
      role: 'neighbor',
      alerts: [],
      hops: 1,
    },
  ];
  return researchCase({
    incident: {
      ...base,
      root: { ...base.root, component: root, entity: { cluster_id: 'kind', kind, namespace: ns, name, uid: null } },
      candidates: [{ ...base.candidates[0]!, component: root }],
      components: [root],
    },
    stageA: { ...stageA([]), cards: [] },
    subgraph: { ...researchCase().subgraph, nodes, edges: [] },
    actions: [],
    runbooks: [],
  });
}

async function run(scenario: string, rc: ResearchCase) {
  const replay = new LlmReplay({ dir: resolve(SCENARIOS, scenario, 'llm') });
  const port = await replay.listen('127.0.0.1', 0);
  try {
    const route = testRoute(`http://127.0.0.1:${port}/v1`, {
      id: 'primary',
      api: 'responses',
      model: 'gpt-5',
      dialect_profile: 'openai-responses',
    });
    const res = await runStageB(
      { runId: '7a1b2c3d-0000-4000-8000-0000000000c1', rc, previous: null, signal: new AbortController().signal },
      testEnv(testLayer([route]), [], false),
      new MemorySink(),
    );
    return { res, served: replay.served, missing: replay.missing };
  } finally {
    await replay.close();
  }
}

describe.each(NAMES)('%s 的录制经 llm-replay 走完阶段 B', (scenario) => {
  it('完整的事件：研判结束，没有缺失的录制（结论等级由证据决定，录制的根因不在事件里时可以无法判定）', async () => {
    const r = await run(scenario, researchCase());
    expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
    expect(r.res.state).toBe('completed');
    expect(r.res.output?.hypotheses.length).toBeGreaterThan(0);
    expect(r.missing).toEqual([]);
  }, 60_000);

  it('最小的事件（根因是不在录制预期里的 Pod、没有卡与检查）：根因退回事件的根因，研判照样结束', async () => {
    const r = await run(scenario, bareCase('Pod:shop/unexpected-7d9f8-a'));
    expect(r.res.error, JSON.stringify(r.res.error)).toBeNull();
    expect(r.res.state).toBe('completed');
    expect(r.res.output?.hypotheses[0]?.root_component).toBe('Pod:shop/unexpected-7d9f8-a');
  }, 60_000);
});
