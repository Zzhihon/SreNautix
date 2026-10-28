import type { CardSamples, EvidenceResult } from '@srenautix/contract';
import { aggregateSamples, compileSamples, NO_REDACTION } from '@srenautix/packs-sdk';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, rawEstimate } from '../../src/llm/budget.js';
import { declaredProfile } from '../../src/llm/dialect.js';
import { PROMPTS } from '../../src/prompts/index.js';
import { repairLocally } from '../../src/llm/repair.js';
import { bindSchema, modelSchema } from '../../src/llm/schema.js';
import { trimOnce } from '../../src/llm/session.js';
import { streamingParams } from '../../src/llm/stream.js';
import type { LlmRequest, LlmTurn } from '../../src/llm/types.js';
import { segmentsText, toChatParams } from '../../src/llm/wire.js';
import { inferCheckTemplates } from '../../src/research/checks.js';
import { incidentBook } from '../../src/research/incident.js';
import { Ledger } from '../../src/research/ledger.js';
import { renumberRecommendations } from '../../src/research/validate.js';
import {
  componentChoices,
  concludeItems,
  controlsSegment,
  hypothesisCards,
  hypothesizeItems,
  MAX_COMPONENT_CHOICES,
  MAX_FULL_CARDS,
  paramsView,
  promptParts,
  selectCards,
  topologyView,
  TRIM,
} from '../../src/research/prompt.js';
import type { ResearchCase, Subgraph } from '../../src/research/types.js';
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
      sample_refs: book.sampleRefs(),
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
      {
        from: 'Deployment:shop/api',
        to: 'Node:node-b',
        relation: 'scheduled_on',
        provenance: 'structural',
        confidence: 1,
      },
    ]);
    // 有关的 Pod 保留它到 ReplicaSet 的边，ReplicaSet 已并入属主
    expect(v.edges).toContainEqual({
      from: 'Pod:shop/api-7',
      to: 'Deployment:shop/api',
      relation: 'owned_by',
      provenance: 'structural',
      confidence: 1,
    });
  });
});

describe('上下文 16k 的路由上的 conclude', () => {
  // 本地部署的模型常见 16k 上下文：输入只能用上下文减去 conclude 输出上限的部分。估算的是整个请求体，固定指令、
  // 可移植 schema、目录与账本都不裁剪；json_object 的方言把 schema 写进系统提示，是同一份提示词最大的请求形态
  /** 六个假设的账本上的 conclude 请求，可裁剪的片段全部裁掉之后的请求体与它的上限 */
  function trimmedConclude(rc: ResearchCase, mechanismRefs: string[] = []) {
    const book = incidentBook(rc);
    const ledger = new Ledger(book, rc.subgraph);
    const hyp = (id: string, root: string, mechanism: string, parent: string | null = null) => ({
      id,
      parent_id: parent,
      root_component: root,
      mechanism,
      mechanism_refs: mechanismRefs,
      supporting: ['card:1', 'alert:1'],
      refuting: [],
    });
    ledger.merge(
      [
        hyp(
          'h1',
          PG,
          'postgres 的数据卷写满，写入失败，api 的查询报错并返回 5xx；预示数据卷用量接近 100%、写入错误与 api 的 5xx',
        ),
        hyp(
          'h2',
          'PersistentVolumeClaim:shop/data-postgres-0',
          '数据卷容量配置过小，WAL 增长后写满，postgres 停止接受写入',
        ),
        hyp('h3', 'Deployment:shop/api', 'api 的新版本查询方式改变，连接数耗尽；预示连接数升高、等待连接的请求超时'),
        hyp('h4', 'Deployment:shop/web', 'web 的发布让请求量上升，api 与 postgres 过载；预示请求量与延迟同时升高'),
        hyp('h5', 'Node:node-a', '节点磁盘压力导致 postgres 所在的 Pod 写入变慢；预示节点的磁盘压力条件与 IO 等待升高'),
        hyp('h6', PG, '归档失败使 WAL 无法回收，数据卷持续增长；预示归档失败计数与 WAL 目录大小持续增长', 'h1'),
      ],
      [],
    );
    expect(ledger.list()).toHaveLength(6);
    const context = 16_384;
    const maxOutputTokens = DEFAULT_BUDGET.stages.conclude.outputTokens;
    const profile = { ...declaredProfile('openai-compatible'), context_tokens: context };
    const output = {
      name: 'conclude',
      schema: bindSchema(modelSchema('conclude'), {
        components: componentChoices(rc),
        evidence_refs: book.refs(),
        check_templates: [],
        runbooks: rc.runbooks,
        actions: rc.actions.map((a) => a.id),
      }).portable,
    };
    let req: LlmRequest = {
      items: concludeItems('zh', promptParts('zh', rc, book, context, null), ledger, book),
      output,
      maxOutputTokens,
      temperature: 0,
    };
    const trimmed: string[] = [];
    for (let t = trimOnce(req); t; t = trimOnce(req)) {
      req = t.request;
      trimmed.push(t.label);
    }
    const body = JSON.stringify(
      streamingParams('chat_completions', toChatParams(req, { model: 'local-model', profile, language: 'zh' })),
    );
    return { body, trimmed, estimate: rawEstimate(body, profile.tokenizer), limit: context - maxOutputTokens };
  }

  it('六个假设的账本：可裁剪的片段全部裁掉之后，按字节估算的输入放得进上下文减去输出上限的部分', () => {
    const r = trimmedConclude(researchCase());
    expect(r.body).toContain('只输出一个 JSON 对象');
    expect(r.estimate).toBeLessThanOrEqual(r.limit);
  });

  it('错误样例（ADR 0177）属于可裁剪的部分：三张满载的错误样例卡、每个假设都引用它们时，不可裁剪的部分与没有样例时相同', () => {
    // 每张卡 16 个类别、每类 10 条 2000 字符的样例
    const spec: CardSamples = {
      ref: 'errors',
      dimensions: [{ name: 'status', label: 'status' }],
      classes: Array.from({ length: 16 }, (_, k) => ({
        id: `c${k}`,
        title: { 'zh-CN': `类别 ${k}` },
        match: [{ dimension: 'status', regex: `^s${k}$` }],
      })),
      per_class: 10,
      max_chars: 2000,
    };
    const c = compileSamples(spec, [{ name: 'errors', mode: 'logs' }], 'redact');
    const lines = Array.from({ length: 16 * 10 }, (_, i) => ({
      time: Date.parse('2026-09-01T10:00:00Z') + i * 1000,
      labels: { status: `s${i % 16}` },
      line: `request ${i} failed: ${'upstream error detail '.repeat(100)}`,
    }));
    const samples = aggregateSamples(c, { kind: 'logs', lines, truncated: true }, NO_REDACTION);
    const base = stageACards();
    const cards: EvidenceResult[] = [
      ...base,
      ...[6, 7, 8].map((n) => ({ ...base[0]!, ref: `card:${n}`, card_id: `gw/errors/samples-${n}`, samples })),
    ];
    const withSamples = trimmedConclude(researchCase({ stageA: stageA(cards) }), ['card:6', 'card:7', 'card:8']);
    const without = trimmedConclude(researchCase());
    expect(withSamples.trimmed).toEqual(
      expect.arrayContaining([
        '错误样例 3 张卡（每个类别只保留一条样例）',
        '错误样例 3 张卡的样例原文（只保留计数）',
        '错误样例 3 张卡',
      ]),
    );
    expect(withSamples.body).not.toContain('upstream error detail');
    expect(withSamples.estimate).toBeLessThanOrEqual(withSamples.limit);
    // 裁剪之后剩下的只有不可裁剪的部分：样例卡只多出它们在动态枚举 evidence_refs 里的三个编号
    expect(withSamples.estimate - without.estimate).toBeLessThan(20);
  });

  it('固定指令与任务说明的字节数不大于加入对照约束之前（ADR 0179）', () => {
    const base = { zh: [4391, 2056, 3386], en: [5005, 2346, 3834] };
    for (const l of ['zh', 'en'] as const) {
      [PROMPTS[l].system, PROMPTS[l].hypothesize, PROMPTS[l].conclude].forEach((s, i) => {
        expect(Buffer.byteLength(s)).toBeLessThanOrEqual(base[l][i]!);
      });
    }
  });

  it('拓扑片段带因果性说明、拓扑版本、快照时刻与边的来源（ADR 0179）', () => {
    const rc = researchCase();
    const book = incidentBook(rc);
    const t = text(hypothesizeItems('zh', promptParts('zh', rc, book, 400_000, null), null, book));
    expect(t).toContain('拓扑关系的说明');
    expect(t).toContain('没有证明因果');
    expect(t).toContain('"provenance":"structural"');
    expect(t).toContain('"as_of"');
    expect(t).toContain(`"topology_version":${rc.subgraph.topology_version}`);
  });

  it('对照结果属于可裁剪的部分：裁剪之后请求体不含对照结果，不可裁剪的部分与没有对照结果时相同（ADR 0179）', () => {
    const r = (
      subject: string,
      verdict: 'normal' | 'abnormal' | 'undeterminable',
      pickedBy: 'top_n' | 'sampled' = 'top_n',
    ) => ({
      subject,
      picked_by: pickedBy,
      volume: 100,
      verdict,
      display_state: verdict,
      reason: { kind: 'rule' as const, text: 'x' },
      value: '0.9',
      value_number: 0.9,
      anomaly_started_at: null,
    });
    const base = stageACards();
    const cards: EvidenceResult[] = [
      {
        ...base[0]!,
        controls: {
          method: 'entry_peers',
          by: 'target',
          subject: 'api',
          candidates: 3,
          results: [r('p1', 'abnormal'), r('p2', 'normal'), r('p3', 'undeterminable', 'sampled')],
        },
      },
      ...base.slice(1),
    ];
    const rc = researchCase({ stageA: stageA(cards) });
    const seg = controlsSegment(incidentBook(rc).promptCards(), 't');
    expect(seg?.text).toContain('"picked_by":"top_n"');
    expect(seg?.trim?.rank).toBe(TRIM.controls);
    expect(TRIM.controls).toBeLessThan(TRIM.relevantCards);
    const withControls = trimmedConclude(rc);
    const without = trimmedConclude(researchCase());
    expect(withControls.trimmed).toContain('对照结果 1 张卡');
    expect(withControls.body).not.toContain('picked_by');
    expect(withControls.estimate).toBeLessThanOrEqual(withControls.limit);
    expect(withControls.estimate).toBeLessThanOrEqual(without.estimate);
  });

  it('动作目录的参数 schema 去掉字符串的长度上下限，枚举、数值范围、格式与说明照写；同名的参数不受影响', () => {
    const params = {
      type: 'object',
      additionalProperties: false,
      required: ['namespace', 'kind', 'replicas', 'maxLength'],
      properties: {
        namespace: { type: 'string', minLength: 1, maxLength: 63 },
        kind: { type: 'string', enum: ['Deployment', 'StatefulSet'] },
        replicas: { type: 'integer', minimum: 0, maximum: 1000 },
        revision: { type: 'string', pattern: '^[0-9a-f]{40}$', description: '提交' },
        reviewers: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, pattern: '^[a-z]+$' } },
        maxLength: { type: 'integer', minimum: 1 },
      },
    };
    expect(paramsView(params)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['namespace', 'kind', 'replicas', 'maxLength'],
      properties: {
        namespace: { type: 'string' },
        kind: { type: 'string', enum: ['Deployment', 'StatefulSet'] },
        replicas: { type: 'integer', minimum: 0, maximum: 1000 },
        revision: { type: 'string', pattern: '^[0-9a-f]{40}$', description: '提交' },
        reviewers: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^[a-z]+$' } },
        maxLength: { type: 'integer', minimum: 1 },
      },
    });
    const rc = researchCase();
    const book = incidentBook(rc);
    const t = text(concludeItems('zh', promptParts('zh', rc, book, 16_384, null), new Ledger(book, rc.subgraph), book));
    expect(t).toContain('"id":"workload_scale"');
    expect(t).toContain('"replicas":{"type":"integer","minimum":0,"maximum":1000}');
    expect(t).not.toContain('minLength');
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
      sample_refs: [],
      check_templates: templates,
      runbooks: [],
      actions: [],
    }).full;
    const hyp = (id: string, root: string) => ({
      id,
      parent_id: null,
      root_component: root,
      mechanism: 'm',
      mechanism_refs: [],
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
    cause_scope: 'unknown',
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
