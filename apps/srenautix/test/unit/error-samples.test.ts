import type { CardSamples, EvidenceResult } from '@srenautix/contract';
import { aggregateSamples, compileSamples, samplesTable, type LogLine } from '@srenautix/packs-sdk';
import { describe, expect, it } from 'vitest';
import { Egress } from '../../src/llm/egress.js';
import { trimOnce } from '../../src/llm/session.js';
import type { LlmRequest, Segment } from '../../src/llm/types.js';
import { composeMessage } from '../../src/notify/compose.js';
import { incidentBook, incidentCorpus } from '../../src/research/incident.js';
import { Ledger } from '../../src/research/ledger.js';
import { concludeItems, hypothesizeItems, promptParts, TRIM } from '../../src/research/prompt.js';
import { auditModelText } from '../../src/research/validate.js';
import { redactSamples } from '../../src/stage-a/pack-evidence.js';
import { releaseRolloutInput } from '../support/report-fixture.js';
import { researchCase, stageA, stageACards } from '../support/scenario.js';

// 错误样例（ADR 0177）在研判与消息里的用法：提示词里单独的 logs 片段与裁剪顺序、机制引用的校验、
// 样例的脱敏（与出站模块相同的规则）、数值审计认可样例里的数字，以及群消息关键问题里的样例计数

const API = 'Deployment:shop/api';
const T = Date.parse('2026-09-01T10:00:00Z');

const SPEC: CardSamples = {
  ref: 'errors',
  dimensions: [
    { name: 'upstream', label: 'upstream' },
    { name: 'status', label: 'status' },
  ],
  classes: [
    {
      id: 'quota_exhausted',
      title: { 'zh-CN': '配额耗尽', en: 'Quota exhausted' },
      match: [{ dimension: 'status', regex: '^429$' }],
    },
  ],
  per_class: 3,
  max_chars: 300,
};

const line = (min: number, status: string, text: string): LogLine => ({
  time: T + min * 60_000,
  labels: { upstream: 'provider-a', status },
  line: text,
});

/** 一张 api 上的错误样例卡：日志行经真实的聚合与出站模块的脱敏规则 */
function samplesCard(ref: string, lines: LogLine[], spec: CardSamples = SPEC): EvidenceResult {
  const c = compileSamples(spec, [{ name: 'errors', mode: 'logs' }], 'redact');
  const samples = aggregateSamples(c, { kind: 'logs', lines, truncated: false }, redactSamples);
  const base = stageACards()[0]!;
  return {
    ...base,
    ref,
    card_id: 'llm-gateway/gateway-errors/samples',
    title: { 'zh-CN': '上游错误样例', en: 'Upstream error samples' },
    entity: { cluster_id: 'test', kind: 'Deployment', namespace: 'shop', name: 'api', uid: null },
    verdict: 'abnormal',
    display_state: 'abnormal',
    reason: { kind: 'rule', text: `窗口内有 ${samples.lines} 行错误日志` },
    value: String(samples.lines),
    table: samplesTable(c, samples, 'zh-CN'),
    egress: 'redact',
    samples,
  };
}

const QUOTA = (secret: string) => [
  ...Array.from({ length: 12 }, (_, i) =>
    line(i, '429', `upstream returned 429: weekly quota exhausted, resets in 3d${i === 11 ? ` ${secret}` : ''}`),
  ),
  line(13, '500', 'upstream returned 500: internal error'),
];

// 凭证样本按片段拼接，避免仓库的密钥扫描把夹具当成泄露
const API_KEY = ['sk', 'proj', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6'].join('-');

const textOf = (items: LlmRequest['items']) =>
  items
    .map((i) => (i.type === 'user' || i.type === 'system' ? i.segments.map((s) => s.text).join('\n') : ''))
    .join('\n');

describe('提示词里的错误样例', () => {
  const rc = researchCase({ stageA: stageA([...stageACards(), samplesCard('card:6', QUOTA(`api_key=${API_KEY}`))]) });
  const book = incidentBook(rc);

  it('单独一段：数据类别 logs、出站前脱敏；维度组合、类别计数与样例都在其中，卡片本身不重复表格', () => {
    const parts = promptParts('zh', rc, book, 400_000, null);
    const seg = parts.incident.find((s) => s.text.startsWith('## 错误样例')) as Segment;
    expect(seg.categories).toEqual(['logs']);
    expect(seg.egress).toBe('redact');
    expect(seg.text).toContain('"class":"quota_exhausted","title":"配额耗尽","count":12');
    expect(seg.text).toContain('"dims":{"upstream":"provider-a","status":"429"}');
    expect(seg.text).toContain('upstream returned 429: weekly quota exhausted');
    // 样例在写进报告之前已按出站模块的规则脱敏
    expect(seg.text).not.toContain(API_KEY);
    expect(seg.text).toContain('[REDACTED:');
    const cards = parts.incident.find((s) => s.text.startsWith('## 证据卡（阶段 A）'))!.text;
    expect(cards).toContain('"ref":"card:6"');
    expect(cards).not.toContain('错误类别');
    expect(book.sampleRefs()).toEqual(['card:6']);
  });

  it('hypothesize 的任务说明要求机制引用错误样例；conclude 的固定指令不变', () => {
    const parts = promptParts('zh', rc, book, 400_000, null);
    expect(textOf(hypothesizeItems('zh', parts, null, book))).toContain('mechanism_refs');
    expect(textOf(concludeItems('zh', parts, new Ledger(book, rc.subgraph), book))).not.toContain('mechanism_refs');
  });

  it('不允许 logs 出境时出站模块删除这一段，删除计入 logs', () => {
    const parts = promptParts('zh', rc, book, 400_000, null);
    const egress = new Egress(
      { allowCrossBorder: false, honeytokens: [], categories: ['metrics', 'alerts', 'topology', 'changes'] },
      () => undefined,
    );
    const prepared = egress.prepare({
      items: hypothesizeItems('zh', parts, null, book),
      maxOutputTokens: 1000,
      temperature: 0,
    });
    expect(textOf(prepared.request.items)).not.toContain('## 错误样例');
    expect(prepared.dropped.logs).toBeGreaterThan(0);
  });

  it('裁剪顺序：先每个类别只留一条样例，再在结论相关卡减半之前只留计数，最后整段去掉', () => {
    const parts = promptParts('zh', rc, book, 400_000, null);
    let req: LlmRequest = {
      items: hypothesizeItems('zh', parts, null, book),
      maxOutputTokens: 1000,
      temperature: 0,
    };
    const labels: string[] = [];
    const states: string[] = [];
    for (let t = trimOnce(req); t; t = trimOnce(req)) {
      labels.push(t.label);
      req = t.request;
      states.push(textOf(req.items));
    }
    const at = (p: string) => labels.findIndex((l) => l.includes(p));
    const texts = at('每个类别只保留一条样例');
    const counts = at('只保留计数');
    const drop = labels.indexOf('错误样例 1 张卡');
    const topology = at('拓扑子图');
    const relevant = at('结论相关证据卡');
    expect([texts, counts, drop, topology, relevant].every((i) => i >= 0)).toBe(true);
    expect(texts).toBeLessThan(topology);
    expect(counts).toBeGreaterThan(topology);
    expect(counts).toBeLessThan(relevant);
    expect(drop).toBeGreaterThan(relevant);
    // 只留一条样例：12 行配额耗尽只剩一条原文；只留计数：没有样例原文，计数仍在
    expect(states[texts]!.match(/weekly quota exhausted/g)).toHaveLength(1);
    expect(states[counts]).not.toContain('weekly quota exhausted');
    expect(states[counts]).toContain('"count":12');
    expect(states[drop]).not.toContain('## 错误样例');
    expect(TRIM.sampleTexts).toBeLessThan(TRIM.topologyReduce);
    expect(TRIM.sampleCounts).toBeLessThan(TRIM.relevantCards);
  });
});

describe('机制引用', () => {
  const noLines = samplesCard('card:7', []);
  const rc = researchCase({
    stageA: stageA([...stageACards(), samplesCard('card:6', QUOTA('')), noLines]),
  });
  const book = incidentBook(rc);

  it('只保留取得了日志行的错误样例卡，其余引用删除并写备注；没有机制引用时输出不带这个字段', () => {
    const ledger = new Ledger(book, rc.subgraph);
    const notes: string[] = [];
    ledger.merge(
      [
        {
          id: 'h1',
          parent_id: null,
          root_component: API,
          mechanism: '上游 provider-a 配额耗尽，持续返回 429',
          mechanism_refs: ['card:6', 'card:1', 'card:7', 'card:99'],
          supporting: ['card:6'],
          refuting: [],
        },
        {
          id: 'h2',
          parent_id: null,
          root_component: 'StatefulSet:shop/postgres',
          mechanism: '数据卷写满',
          supporting: ['card:2'],
          refuting: [],
        },
      ],
      notes,
    );
    expect(ledger.entries.get('h1')!.mechanismRefs).toEqual(['card:6']);
    expect(notes).toContain('假设 h1 的机制引用不是取得了日志行的错误样例卡，已删除：card:1、card:7、card:99');
    const out = ledger.toContract();
    expect(out.find((h) => h.id === 'h1')!.mechanism_refs).toEqual(['card:6']);
    expect(out.find((h) => h.id === 'h2')).not.toHaveProperty('mechanism_refs');
  });

  it('数值审计认可样例里的状态码与计数：机制里的 429 与 12 不被删除', () => {
    const ledger = new Ledger(book, rc.subgraph);
    ledger.merge(
      [
        {
          id: 'h1',
          parent_id: null,
          root_component: API,
          mechanism: '上游 provider-a 配额耗尽，12 次请求持续返回 429（weekly quota exhausted）',
          mechanism_refs: ['card:6'],
          supporting: ['card:6'],
          refuting: [],
        },
      ],
      [],
    );
    const draft = {
      disposition: 'escalate' as const,
      conclusion: {
        level: 'likely' as const,
        hypothesis_id: 'h1',
        root_component: API,
        undetermined_reason: null,
        consistency: {
          entity_in_scope: true,
          onset_precedes_symptom: true,
          no_contrary_normal: true,
          competitor_tested: false,
        },
        cause_scope: 'upstream' as const,
      },
      hypotheses: ledger.toContract(),
      next_checks: [],
      situation: 's',
      summary: 'm',
      recommendations: [],
      proposals: [],
      validation_notes: [],
    };
    const audited = auditModelText(draft, incidentCorpus(rc, book));
    expect(audited.notes).toEqual([]);
    expect(audited.output.hypotheses[0]!.mechanism).toContain('12 次请求持续返回 429');
  });
});

describe('群消息关键问题里的样例计数', () => {
  function withSamples(card: EvidenceResult, refs: string[]) {
    const input = releaseRolloutInput();
    const stage = { ...input.stageA!, cards: [...input.stageA!.cards, card] };
    const out = input.research!.output!;
    const chosen = out.conclusion.hypothesis_id!;
    return {
      ...input,
      stageA: stage,
      researchStageA: stage,
      research: {
        ...input.research!,
        output: {
          ...out,
          hypotheses: out.hypotheses.map((h) => (h.id === chosen ? { ...h, mechanism_refs: refs } : h)),
        },
      },
    };
  }
  /** 阶段 A 的卡与研判的检查卡之后的下一个编号 */
  const nextRef = () => {
    const input = releaseRolloutInput();
    const used = [...input.stageA!.cards, ...(input.research!.output!.check_cards ?? [])].map((c) =>
      Number(c.ref.slice('card:'.length)),
    );
    return `card:${Math.max(...used) + 1}`;
  };
  const keyIssue = (input: ReturnType<typeof withSamples>) =>
    composeMessage(input)
      .message.sections.find((s) => s.kind === 'key_issue')!
      .blocks.map((b) => b.text)
      .join('\n');

  it('机制之后一行：卡的引用、总行数与行数最多的类别；日志原文不进入消息', () => {
    const ref = nextRef();
    const text = keyIssue(withSamples(samplesCard(ref, QUOTA('')), [ref]));
    const lines = text.split('\n');
    const mech = lines.findIndex((l) => l.includes('机制：'));
    expect(lines[mech + 1]).toBe(`样例：${ref}（共 13 行）配额耗尽 12，其他 1`);
    expect(text).not.toContain('weekly quota exhausted');
  });

  it('日志行达到 limit 时计数加 ≥；没有取得日志行时写原因码的说明', () => {
    const ref = nextRef();
    const card = samplesCard(ref, QUOTA(''));
    const truncated = { ...card, samples: { ...card.samples!, truncated: true } };
    expect(keyIssue(withSamples(truncated, [ref]))).toContain(`样例：${ref}（共 ≥13 行）配额耗尽 ≥12，其他 ≥1`);
    const timeout = {
      ...card,
      samples: { ...card.samples!, code: 'samples_timeout' as const, lines: 0, groups: [], classes: [] },
    };
    expect(keyIssue(withSamples(timeout, [ref]))).toContain(`样例：${ref} 没有取得样例，原因：错误日志的查询超时`);
  });
});
