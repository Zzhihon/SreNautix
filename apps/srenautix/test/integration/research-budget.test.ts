import { resolve } from 'node:path';
import type { EvidenceResult, IncidentMember } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET } from '../../src/llm/budget.js';
import { Egress } from '../../src/llm/egress.js';
import { LlmReplay } from '../../src/llm/replay.js';
import { buildRuntimes } from '../../src/llm/routes.js';
import { ModelLayer } from '../../src/llm/session.js';
import { resolveTimeouts } from '../../src/llm/timeouts.js';
import { DEFAULT_LIMITS, runStageB } from '../../src/research/controller.js';
import { WorkerMetrics } from '../../src/research/metrics.js';
import type { ResearchCase, Subgraph } from '../../src/research/types.js';
import { MemorySink, testEnv, testRoute } from '../support/research-env.js';
import { incident, researchCase, stageA, stageACards, subgraph } from '../support/scenario.js';

/**
 * 单次研判的输入预算（ADR 0129），用 CCHP 2026-10-20 发布事故的规模：133 张卡（66 异常、54 正常、13 无法判定）、
 * 880 个节点的研判子图（800 个 Pod）、23 条成员告警、20 项卡片检查。模型是录制回放，路由按 primary 的写法
 * （Responses、400k 上下文、o200k 分词）与默认预算；检查的执行方不可用，研判走满三轮 hypothesize 再结论，
 * 是输入最多的路径。
 */
const RECORDINGS = resolve(import.meta.dirname, '../fixtures/llm/card-checks');

let model: LlmReplay;
let url: string;

beforeAll(async () => {
  model = new LlmReplay({ dir: RECORDINGS });
  url = `http://127.0.0.1:${await model.listen('127.0.0.1', 0)}/v1`;
});

afterAll(async () => {
  await model?.close();
});

function largeCase(): ResearchCase {
  const base = stageACards()[0]!;
  const verdicts: EvidenceResult['verdict'][] = [
    ...Array<EvidenceResult['verdict']>(66).fill('abnormal'),
    ...Array<EvidenceResult['verdict']>(54).fill('normal'),
    ...Array<EvidenceResult['verdict']>(13).fill('undeterminable'),
  ];
  const cards: EvidenceResult[] = verdicts.map((verdict, i) => ({
    ...base,
    ref: `card:${i + 1}`,
    card_id: `workload/chain-${i % 9}/card-${i}`,
    entity: { cluster_id: 'test', kind: 'Pod', namespace: 'shop', name: `app-${i % 20}-0`, uid: null },
    verdict,
    display_state: verdict,
    reason: { kind: 'rule', text: `第 ${i} 张卡：${'窗口内的取值与阈值比较，'.repeat(8)}` },
    table: {
      head: ['pod', 'container', 'value'],
      rows: Array.from({ length: 8 }, (_, r) => [`app-${i % 20}-${r}`, 'http', `${r * 7}%`]),
    },
  }));
  const g = subgraph();
  const node = (component: string, role: Subgraph['nodes'][number]['role'], hops: number) => {
    const [kind, rest] = component.split(':') as [string, string];
    const [ns, name] = rest.split('/') as [string, string];
    return { component, kind, namespace: ns, name, role, alerts: [], hops };
  };
  const deployments = Array.from({ length: 20 }, (_, d) => `Deployment:shop/app-${d}`);
  const replicaSets = Array.from({ length: 60 }, (_, r) => `ReplicaSet:shop/app-${r % 20}-${r}`);
  const pods = Array.from({ length: 800 }, (_, p) => `Pod:shop/app-${p % 20}-${p}`);
  const owned = (from: string, to: string) => ({
    from,
    to,
    relation: 'owned_by',
    provenance: 'structural' as const,
    confidence: 1,
    scope: 'instance' as const,
  });
  const inc = incident();
  const member = (i: number): IncidentMember => ({
    ...inc.members[1]!,
    alert_id: `00000000000001${String(i).padStart(2, '0')}@1788257160`,
    alertname: `AppAlert${i}`,
    component: deployments[i % 20]!,
  });
  return researchCase({
    incident: { ...inc, members: [...inc.members, ...Array.from({ length: 21 }, (_, i) => member(i))] },
    stageA: stageA(cards),
    subgraph: {
      ...g,
      nodes: [
        ...g.nodes,
        ...deployments.map((k) => node(k, 'member', 1)),
        ...replicaSets.map((k) => node(k, 'neighbor', 2)),
        ...pods.map((k) => node(k, 'neighbor', 2)),
      ],
      edges: [
        ...g.edges,
        ...replicaSets.map((r, i) => owned(r, deployments[i % 20]!)),
        ...pods.map((p, i) => owned(p, replicaSets[i % 60]!)),
      ],
    },
    templates: deployments.map((d) => ({
      id: `cardcheck:workload/pod-restarts/memory@${d}`,
      description: `内存占 limit 与 OOM，在 ${d} 上：容器内存工作集占 limit 的峰值与 OOMKilled`,
      args: {
        type: 'object',
        additionalProperties: false,
        properties: {
          window_before: { type: 'string', description: '相对事件首次触发的时长，例如 2h' },
          window_after: { type: 'string', description: '相对事件首次触发的时长，例如 30m' },
          limit_ratio: { type: 'number', minimum: 0.5, maximum: 1, description: '工作集占 limit 超过它时判为异常' },
        },
      },
    })),
  });
}

function primaryLayer(): ModelLayer {
  const egress = new Egress({ allowCrossBorder: false, honeytokens: [] }, () => undefined);
  const route = testRoute(url, {
    id: 'primary',
    api: 'responses',
    model: 'gpt-5',
    dialect_profile: 'openai-responses',
  });
  const t = resolveTimeouts(route, {});
  return new ModelLayer({
    routes: buildRuntimes(
      [
        {
          route,
          apiKey: 'local',
          state: { profile: null, calibration: null, fingerprint: null },
          timeouts: t,
        },
      ],
      egress,
    ),
    egress,
    budget: DEFAULT_BUDGET,
    metrics: new WorkerMetrics('worker', false),
    language: 'zh',
    onCalibration: async () => undefined,
    onDrift: async () => undefined,
  });
}

describe('大事件的研判预算', () => {
  it('133 张卡、880 个节点的事件：每次调用不用裁剪就在阶段单次上限之内，最多轮数时整次研判也在 15 万之内', async () => {
    const sink = new MemorySink();
    const res = await runStageB(
      {
        runId: '7a1b2c3d-0000-4000-8000-0000000000e1',
        rc: largeCase(),
        previous: null,
        signal: AbortSignal.timeout(60_000),
      },
      testEnv(primaryLayer(), [], true),
      sink,
    );
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    expect(res.state).toBe('completed');
    expect(res.stopReason).not.toBe('budget');
    const calls = sink.llm.map((c) => ({ phase: c.phase, estimated: c.estimatedInput, note: c.note }));
    expect(calls.filter((c) => c.phase === 'hypothesize').length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c.phase === 'conclude')).toBe(true);
    for (const c of calls) {
      expect(c.estimated, JSON.stringify(c)).toBeLessThanOrEqual(DEFAULT_BUDGET.stages[c.phase].inputTokens);
      // 不需要裁剪就放得下
      expect(c.note ?? '').not.toContain('裁掉了');
    }
    const total = calls.reduce((n, c) => n + c.estimated, 0);
    if (process.env.SHOW_BUDGET) {
      console.log(JSON.stringify({ calls, total }));
    }
    // 输入最多的路径：hypothesize 走满 maxSteps 轮再结论，每次按最大的一次算，仍在研判上限之内
    const largest = Math.max(...calls.map((c) => c.estimated));
    expect(largest * (DEFAULT_LIMITS.maxSteps + 1)).toBeLessThan(DEFAULT_BUDGET.perResearchInputTokens);
  });
});
