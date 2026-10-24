import type { EvidenceResult } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, rawEstimate } from '../../src/llm/budget.js';
import { repairLocally } from '../../src/llm/repair.js';
import { bindSchema, modelSchema } from '../../src/llm/schema.js';
import type { LlmTurn } from '../../src/llm/types.js';
import { segmentsText } from '../../src/llm/wire.js';
import { inferCheckTemplates } from '../../src/research/checks.js';
import { incidentBook } from '../../src/research/incident.js';
import { Ledger } from '../../src/research/ledger.js';
import { renumberRecommendations } from '../../src/research/validate.js';
import {
  componentChoices,
  concludeItems,
  hypothesisCards,
  hypothesizeItems,
  MAX_COMPONENT_CHOICES,
  MAX_FULL_CARDS,
  promptParts,
  selectCards,
  topologyView,
} from '../../src/research/prompt.js';
import type { Subgraph } from '../../src/research/types.js';
import { researchCase, stageA, stageACards, subgraph } from '../support/scenario.js';

// 研判上下文按预算裁剪（ADR 0127）：卡多的事件只完整放入结论相关的卡，其余写成摘要；根因组件的枚举不含由控制器
// 拥有的对象；next_checks 缺少 template 时按检查 id 补全。

const PG = 'StatefulSet:shop/postgres';

/** CCHP 2026-10-20 发布事故的规模：133 张卡，66 张异常、54 张正常、13 张无法判定，分布在 20 个 Pod 上 */
function manyCards(): EvidenceResult[] {
  const base = stageACards()[0]!;
  const verdicts: EvidenceResult['verdict'][] = [
    ...Array<EvidenceResult['verdict']>(66).fill('abnormal'),
    ...Array<EvidenceResult['verdict']>(54).fill('normal'),
    ...Array<EvidenceResult['verdict']>(13).fill('undeterminable'),
  ];
  return verdicts.map((verdict, i) => ({
    ...base,
    ref: `card:${i + 1}`,
    card_id: `workload/chain-${i % 9}/card-${i}`,
    entity: { cluster_id: 'test', kind: 'Pod', namespace: 'shop', name: `api-${i % 20}`, uid: null },
    verdict,
    display_state: verdict,
    reason: { kind: 'rule', text: `第 ${i} 张卡的判定说明，${'细节'.repeat(40)}` },
    table: {
      head: ['pod', 'container', 'value'],
      rows: Array.from({ length: 8 }, (_, r) => [`api-${i % 20}-${r}`, 'http', `${r * 7}%`]),
    },
  }));
}

/** 带 20 个 Pod（经 ReplicaSet 归 api 所有）的子图 */
function podSubgraph(extraPods = 20): Subgraph {
  const g = subgraph();
  const node = (component: string) => {
    const [kind, rest] = component.split(':') as [string, string];
    const [ns, name] = rest.split('/') as [string, string];
    return { component, kind, namespace: ns, name, role: 'neighbor' as const, alerts: [], hops: 2 };
  };
  const rs = 'ReplicaSet:shop/api-1';
  const pods = Array.from({ length: extraPods }, (_, i) => `Pod:shop/api-${i}`);
  return {
    ...g,
    nodes: [...g.nodes, node(rs), ...pods.map(node)],
    edges: [
      ...g.edges,
      {
        from: rs,
        to: 'Deployment:shop/api',
        relation: 'owned_by',
        provenance: 'structural',
        confidence: 1,
        scope: 'instance',
      },
      ...pods.map((p) => ({
        from: p,
        to: rs,
        relation: 'owned_by',
        provenance: 'structural' as const,
        confidence: 1,
        scope: 'instance' as const,
      })),
    ],
  };
}

const text = (items: ReturnType<typeof hypothesizeItems>) =>
  items.map((i) => (i.type === 'user' || i.type === 'system' ? segmentsText(i.segments) : '')).join('\n');

describe('卡多的事件', () => {
  const rc = researchCase({ stageA: stageA(manyCards()), subgraph: podSubgraph() });
  const book = incidentBook(rc);

  it('只完整放入结论相关的卡（按相关性取前 40 张），其余结论相关的卡只列判定，无关的卡写成按证据链计数的摘要', () => {
    const { included, listed, summarized } = selectCards(book, rc, 400_000);
    expect(included).toHaveLength(MAX_FULL_CARDS);
    expect(included.every((x) => x.result.verdict === 'abnormal')).toBe(true);
    expect(listed).toHaveLength(66 - MAX_FULL_CARDS);
    expect(summarized).toHaveLength(67);
    const t = text(hypothesizeItems('zh', promptParts('zh', rc, book, 400_000, null), null, book));
    expect(t).toContain('## 其余证据卡（只列判定）');
    expect(t).toContain('## 与结论无关的证据卡（摘要');
    expect(t).toContain('"verdicts":{"normal":54,"undeterminable":13}');
    // 无关卡的说明文字不进入提示词
    expect(t).not.toContain('第 70 张卡的判定说明');
  });

  it('hypothesize 的提示词（含输出 schema）在单次输入上限之内', () => {
    const parts = promptParts('zh', rc, book, 400_000, null);
    const enums = {
      components: componentChoices(rc),
      evidence_refs: book.refs(),
      check_templates: [],
      runbooks: rc.runbooks,
      actions: rc.actions.map((a) => a.id),
    };
    const schema = bindSchema(modelSchema('hypothesize'), enums).portable;
    const body = JSON.stringify({ input: text(hypothesizeItems('zh', parts, null, book)), schema });
    expect(rawEstimate(body, 'tiktoken_o200k')).toBeLessThan(DEFAULT_BUDGET.stages.hypothesize.inputTokens / 2);
  });

  it('卡不多时全部完整放入', () => {
    const small = researchCase();
    const s = selectCards(incidentBook(small), small, 400_000);
    expect(s.listed).toEqual([]);
    expect(s.summarized).toEqual([]);
    expect(s.included).toHaveLength(small.stageA.cards.length);
  });

  it('假设引用或落在假设范围内、上文没有完整放入的卡，进入账本片段', () => {
    const ledger = new Ledger(book, rc.subgraph);
    // card:100 是一张正常卡（只在摘要里），h1 以它为相反证据；h1 的根因是 api，范围包括它的 Pod
    ledger.merge(
      [
        {
          id: 'h1',
          parent_id: null,
          root_component: 'Deployment:shop/api',
          mechanism: '新版本崩溃',
          supporting: [],
          refuting: ['card:100'],
        },
      ],
      [],
    );
    const parts = promptParts('zh', rc, book, 400_000, null);
    const extra = hypothesisCards(ledger, book, rc, parts.fullRefs);
    expect(extra[0]!.ref).toBe('card:100');
    expect(extra.length).toBeLessThanOrEqual(16);
    expect(extra.every((x) => !parts.fullRefs.has(x.ref))).toBe(true);
    const t = text(concludeItems('zh', parts, ledger, book));
    expect(t).toContain('## 假设相关的证据卡（阶段 A，上文未完整列出');
    expect(t).toContain('第 99 张卡的判定说明');
  });
});

describe('提示词里的拓扑（ADR 0129）', () => {
  it('与事件无关的 Pod、ReplicaSet 按 kind 计入属主的 owns，它们的边改记在属主上；有关的 Pod 照常列出', () => {
    const g = podSubgraph();
    const withNode = {
      ...g,
      nodes: [...g.nodes, { ...g.nodes[4]!, component: 'Node:node-b', name: 'node-b' }],
      edges: [
        ...g.edges,
        ...['Pod:shop/api-0', 'Pod:shop/api-1'].map((from) => ({
          from,
          to: 'Node:node-b',
          relation: 'scheduled_on',
          provenance: 'structural' as const,
          confidence: 1,
          scope: 'instance' as const,
        })),
      ],
    };
    const rc = researchCase({ subgraph: withNode });
    const v = topologyView(rc, withNode.nodes, withNode.edges, new Set(['Pod:shop/api-7']));
    const keys = v.nodes.map((n) => n.component);
    expect(keys).toContain('Pod:shop/api-7');
    expect(keys.filter((k) => String(k).startsWith('Pod:'))).toEqual(['Pod:shop/api-7']);
    expect(keys).not.toContain('ReplicaSet:shop/api-1');
    expect(v.nodes.find((n) => n.component === 'Deployment:shop/api')).toMatchObject({
      owns: { ReplicaSet: 1, Pod: 19 },
    });
    // 两个 Pod 所在的节点：改记为属主一条边
    expect(v.edges.filter((e) => e.to === 'Node:node-b')).toEqual([
      { from: 'Deployment:shop/api', to: 'Node:node-b', relation: 'scheduled_on', confidence: 1 },
    ]);
    // 有关的 Pod 保留它到 ReplicaSet 的边，ReplicaSet 已并入属主
    expect(v.edges).toContainEqual({
      from: 'Pod:shop/api-7',
      to: 'Deployment:shop/api',
      relation: 'owned_by',
      confidence: 1,
    });
  });
});

describe('根因组件的枚举', () => {
  it('不含由控制器拥有的 Pod 与 ReplicaSet；根因与候选总在其中', () => {
    const rc = researchCase({ subgraph: podSubgraph() });
    const choices = componentChoices(rc);
    expect(choices).toContain(PG);
    expect(choices).toContain('Deployment:shop/web');
    expect(choices.some((c) => c.startsWith('Pod:') || c.startsWith('ReplicaSet:'))).toBe(false);
  });

  it('超过上限时按角色与跳数取前面的', () => {
    const g = subgraph();
    const many = Array.from({ length: 400 }, (_, i) => ({
      component: `ConfigMap:shop/cm-${i}`,
      kind: 'ConfigMap',
      namespace: 'shop',
      name: `cm-${i}`,
      role: 'neighbor' as const,
      alerts: [],
      hops: 2,
    }));
    const rc = researchCase({ subgraph: { ...g, nodes: [...many, ...g.nodes] } });
    const choices = componentChoices(rc);
    expect(choices).toHaveLength(MAX_COMPONENT_CHOICES);
    expect(choices).toEqual(expect.arrayContaining(g.nodes.map((n) => n.component)));
  });
});

describe('next_checks 缺少 template', () => {
  const templates = [
    'cardcheck:workload/pod-pending/pdb@PodDisruptionBudget:prod/gateway',
    'cardcheck:workload/pod-restarts/memory@StatefulSet:prod/gateway',
    'cardcheck:workload/pod-restarts/memory@Deployment:prod/worker',
    'kube_workload_pods',
  ];
  const out = (checks: unknown[]) => ({
    hypotheses: [
      { id: 'h1', root_component: 'StatefulSet:prod/gateway' },
      { id: 'h2', root_component: 'Deployment:prod/worker' },
    ],
    next_checks: checks,
  });
  const check = (o: Record<string, unknown>) => ({
    hypothesis_id: 'h1',
    type: 'query',
    args_json: '{}',
    refutes_if: 'x',
    purpose: 'y',
    ...o,
  });

  it('检查 id 写在别的字段里：完全相同的直接补上', () => {
    const notes: string[] = [];
    const v = inferCheckTemplates(
      out([check({ id: 'cardcheck:workload/pod-pending/pdb@PodDisruptionBudget:prod/gateway' })]),
      templates,
      notes,
    ) as { next_checks: Array<{ template: string }> };
    expect(v.next_checks[0]!.template).toBe(templates[0]);
    expect(notes).toEqual([
      '/next_checks[0]：template 缺失，按检查 id cardcheck:workload/pod-pending/pdb@PodDisruptionBudget:prod/gateway 补为 cardcheck:workload/pod-pending/pdb@PodDisruptionBudget:prod/gateway',
    ]);
  });

  it('组件不在列表中或没有写组件：取同一张卡在假设根因上的检查', () => {
    const notes: string[] = [];
    const v = inferCheckTemplates(
      out([
        check({ purpose: '用 cardcheck:workload/pod-restarts/memory@Pod:prod/gateway-4 看 OOM' }),
        check({ hypothesis_id: 'h2', template: 'cardcheck:workload/pod-restarts/memory' }),
      ]),
      templates,
      notes,
    ) as { next_checks: Array<{ template: string; type: string }> };
    expect(v.next_checks.map((c) => c.template)).toEqual([templates[1], templates[2]]);
    expect(notes[1]).toContain('template "cardcheck:workload/pod-restarts/memory" 不可用');
  });

  it('只读工具名写在别的字段、type 缺失：补 template 并把 type 补为 query', () => {
    const v = inferCheckTemplates(
      out([{ hypothesis_id: 'h1', check: 'kube_workload_pods', args_json: '{}', refutes_if: 'x', purpose: 'y' }]),
      templates,
      [],
    ) as { next_checks: Array<{ template: string; type: string }> };
    expect(v.next_checks[0]).toMatchObject({ template: 'kube_workload_pods', type: 'query' });
  });

  it('修复阶梯：补全之后通过校验，推断不出的条目只删除它自己', () => {
    const schema = bindSchema(modelSchema('hypothesize'), {
      components: ['StatefulSet:prod/gateway', 'Deployment:prod/worker'],
      evidence_refs: [],
      check_templates: templates,
      runbooks: [],
      actions: [],
    }).full;
    const hyp = (id: string, root: string) => ({
      id,
      parent_id: null,
      root_component: root,
      mechanism: 'm',
      supporting: [],
      refuting: [],
    });
    const turn: LlmTurn = {
      text: JSON.stringify({
        hypotheses: [hyp('h1', 'StatefulSet:prod/gateway'), hyp('h2', 'Deployment:prod/worker')],
        next_checks: [
          check({ check_id: 'cardcheck:workload/pod-pending/pdb@PodDisruptionBudget:prod/gateway' }),
          check({ hypothesis_id: 'h2', purpose: '没有任何检查 id' }),
        ],
      }),
      reasoningChars: 0,
      refusal: null,
      toolCalls: [],
      incomplete: null,
      usage: { input: 1, cachedInput: 0, output: 1, reasoning: 0 },
      responseModel: null,
      systemFingerprint: null,
    };
    const r = repairLocally(turn, schema, (v, n) => inferCheckTemplates(v, templates, n));
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.step).toBe('field_salvage');
    const value = r.value as { next_checks: Array<{ template: string }> };
    expect(value.next_checks.map((c) => c.template)).toEqual([templates[0]]);
    expect(r.notes.join('\n')).toContain('/next_checks[1]：条目不合格，已删除');
    expect(r.notes.join('\n')).toContain('/next_checks[0]：template 缺失');
  });
});

describe('conclude 的 recommendations id 不合规（Zzhihon/SreNautix#9）', () => {
  const rec = (id: unknown, kind = 'mitigation') => ({
    ...(id === undefined ? {} : { id }),
    kind,
    title: 't',
    rationale: 'r',
    steps: ['kubectl get pdb -n data'],
    owner: 'platform',
    risk: 'low',
    risk_note: null,
    runbook_ref: null,
    action_id: null,
    hypothesis_id: 'h1',
    evidence_refs: [],
  });
  const concludeOut = (recommendations: unknown[]) => ({
    disposition: 'escalate',
    hypothesis_id: 'h1',
    undetermined_reason: null,
    situation: 's',
    summary: 'm',
    recommendations,
    proposals: [],
  });
  const turnOf = (value: unknown): LlmTurn => ({
    text: JSON.stringify(value),
    reasoningChars: 0,
    refusal: null,
    toolCalls: [],
    incomplete: null,
    usage: { input: 1, cachedInput: 0, output: 1, reasoning: 0 },
    responseModel: null,
    systemFingerprint: null,
  });
  const schema = bindSchema(modelSchema('conclude'), {
    components: [],
    evidence_refs: [],
    check_templates: [],
    runbooks: [],
    actions: [],
  }).full;

  it('修复阶梯：不合规的 id 按顺序重新编号为 r1、r2……，建议一条都不删', () => {
    const value = concludeOut([rec('rec-1'), rec('r2', 'root_fix'), rec(undefined, 'investigation')]);
    // 修复前：按字段挽救把 id 不合规的两条整条删掉
    const before = repairLocally(turnOf(value), schema);
    expect(before.ok && (before.value as { recommendations: unknown[] }).recommendations).toHaveLength(1);

    const r = repairLocally(turnOf(value), schema, renumberRecommendations);
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.step).toBe('field_salvage');
    const out = r.value as { recommendations: Array<{ id: string; kind: string }> };
    expect(out.recommendations.map((x) => [x.id, x.kind])).toEqual([
      ['r1', 'mitigation'],
      ['r2', 'root_fix'],
      ['r3', 'investigation'],
    ]);
    expect(r.notes).toEqual([
      '/recommendations[0]：id "rec-1"，按顺序重新编号为 r1',
      '/recommendations[2]：id 缺失，按顺序重新编号为 r3',
    ]);
  });

  it('id 重复也重新编号；id 都合规且不重复时原样保留', () => {
    const notes: string[] = [];
    const dup = renumberRecommendations(concludeOut([rec('r1'), rec('r1'), rec('r7')]), notes) as {
      recommendations: Array<{ id: string }>;
    };
    expect(dup.recommendations.map((x) => x.id)).toEqual(['r1', 'r2', 'r3']);
    expect(notes).toEqual([
      '/recommendations[1]：id "r1"，按顺序重新编号为 r2',
      '/recommendations[2]：id "r7"，按顺序重新编号为 r3',
    ]);

    const ok = concludeOut([rec('r3'), rec('r1')]);
    const kept: string[] = [];
    expect(renumberRecommendations(ok, kept)).toBe(ok);
    expect(kept).toEqual([]);
    expect(repairLocally(turnOf(ok), schema, renumberRecommendations)).toMatchObject({ ok: true, step: 'validate' });
  });
});
