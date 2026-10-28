import type { ConcludeOutput, EvidenceResult, RuleConclusion } from '@srenautix/contract';
import { validatorFor } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { scoreRun, ruleFallback } from '../../src/eval/score.js';
import { DEFAULT_BUDGET } from '../../src/llm/budget.js';
import { declaredProfile } from '../../src/llm/dialect.js';
import { trimOnce } from '../../src/llm/session.js';
import { streamingParams } from '../../src/llm/stream.js';
import type { LlmRequest } from '../../src/llm/types.js';
import { toChatParams } from '../../src/llm/wire.js';
import { bindSchema, modelSchema } from '../../src/llm/schema.js';
import { composeMessage, type ComposeInput } from '../../src/notify/compose.js';
import { DEFAULT_LIMITS, runStageB } from '../../src/research/controller.js';
import { incidentBook } from '../../src/research/incident.js';
import { judgeLadder } from '../../src/research/ladder.js';
import { Ledger } from '../../src/research/ledger.js';
import { componentChoices, concludeItems, promptParts } from '../../src/research/prompt.js';
import type { ResearchCase } from '../../src/research/types.js';
import { validateConclusion } from '../../src/research/validate.js';
import { TEST_ENVIRONMENT } from '../support/eval-environment.js';
import { MemorySink, testLayer, testRoute } from '../support/research-env.js';
import { researchCase, stageA, stageACards } from '../support/scenario.js';

// 确定性结论规则进入研判（ADR 0178）：规则判定是账本中的 h7–h9，只能被规则卡片条件上的检查推翻；模型选了别的根因或弃权、
// 又没有推翻规则判定时，代码改选规则判定，档位最高 likely；结论一致时保持模型的选择。模型不可用时群消息与评测都按规则判定。

const PG = 'StatefulSet:shop/postgres';
const API = 'Deployment:shop/api';
const WEB = 'Deployment:shop/web';

/** 场景里 PG 上的两张卡：实例 OOM 与主库切换（card:6、card:7） */
function pgCard(n: number, cardId: string, verdict: EvidenceResult['verdict'], obs: Record<string, number>) {
  const base = stageACards()[0]!;
  return {
    ...base,
    ref: `card:${n}`,
    card_id: cardId,
    entity: { cluster_id: 'test', kind: 'StatefulSet', namespace: 'shop', name: 'postgres', uid: null },
    verdict,
    display_state: verdict,
    reason: { kind: verdict === 'abnormal' ? 'rule' : 'all_clear', text: `${cardId} ${verdict}` },
    observations: obs,
    anomaly_started_at: null,
  } satisfies EvidenceResult;
}

const OOM = 'postgres/availability/oom-kills';
const PRIMARY = 'postgres/availability/primary-changes';
const CONNS = 'postgres/saturation/connections';
const LATENCY = 'postgres/saturation/statement-latency';

const oomFailover = (basis: RuleConclusion['basis'] = ['card:6', 'card:7']): RuleConclusion => ({
  rule_id: 'postgres/oom-failover',
  title: { 'zh-CN': '实例 OOM 引发主库切换', en: 'An instance OOM kill caused a primary change' },
  root_component: PG,
  mechanism: {
    'zh-CN': '数据库实例的容器内存超过 limit 被 OOM 终止，主库进程退出后集群把备库提升为主库',
    en: 'A database instance was OOM-killed and the cluster promoted a standby',
  },
  level: 'likely',
  basis,
  card_conditions: [
    { card: OOM, verdict: 'abnormal', observations: [], on: 'self' },
    { card: PRIMARY, verdict: 'abnormal', observations: [{ name: 'changes', op: 'gt', value: 0 }], on: 'self' },
  ],
});

const slowStatements = (): RuleConclusion => ({
  rule_id: 'postgres/slow-statements-saturate-connections',
  title: { 'zh-CN': '语句变慢占满连接' },
  root_component: PG,
  mechanism: { 'zh-CN': '语句平均耗时高于平时，每个连接被占用的时间变长，同时在用的连接数顶到 max_connections' },
  level: 'likely',
  basis: ['card:6', 'card:7'],
  card_conditions: [
    { card: CONNS, verdict: 'abnormal', observations: [], on: 'self' },
    { card: LATENCY, verdict: 'abnormal', observations: [], on: 'self' },
  ],
});

/** 主库 OOM 引发切换的事件：阶段 A 带 PG 上的两张异常卡与一条规则判定 */
function oomCase(rules: RuleConclusion[] = [oomFailover()]): ResearchCase {
  const cards = [
    ...stageACards(),
    pgCard(6, OOM, 'abnormal', { ooms: 1 }),
    pgCard(7, PRIMARY, 'abnormal', { changes: 2, primaries: 1 }),
  ];
  return researchCase({ stageA: { ...stageA(cards), rule_conclusions: rules } });
}

/** 网关查询占满连接池的事件：连接与语句耗时两张卡 */
function poolCase(): ResearchCase {
  const cards = [
    ...stageACards(),
    pgCard(6, CONNS, 'abnormal', { peak: 0.97 }),
    pgCard(7, LATENCY, 'abnormal', { peak: 0.2, baseline: 0.02 }),
  ];
  return researchCase({ stageA: { ...stageA(cards), rule_conclusions: [slowStatements()] } });
}

function seeded(rc: ResearchCase) {
  const book = incidentBook(rc);
  const ledger = new Ledger(book, rc.subgraph);
  const notes: string[] = [];
  ledger.seedRules(rc.stageA.rule_conclusions ?? [], (r) => r.mechanism['zh-CN'] ?? '', notes);
  return { book, ledger, notes };
}

const hyp = (id: string, root: string, mechanism: string, supporting: string[] = []) => ({
  id,
  parent_id: null,
  root_component: root,
  mechanism,
  supporting,
  refuting: [],
});

function conclude(over: Partial<ConcludeOutput>): ConcludeOutput {
  return {
    disposition: 'escalate',
    cause_scope: 'unknown',
    hypothesis_id: 'h1',
    undetermined_reason: null,
    situation: 's',
    summary: 'm',
    recommendations: [],
    proposals: [],
    ...over,
  };
}

/** 区分性检查产生的卡：check 是执行的卡片检查 */
function checkResult(
  entity: string,
  verdict: EvidenceResult['verdict'],
  obs: Record<string, number> = {},
): EvidenceResult {
  const [kind, rest] = entity.split(':') as [string, string];
  const [ns, name] = rest.split('/') as [string, string];
  return {
    ...pgCard(1, 'check/x/1', verdict, obs),
    entity: { cluster_id: 'test', kind, namespace: ns, name, uid: null },
  };
}

describe('规则判定进入假设账本', () => {
  it('规则结论成为 h7，依据为支持证据，状态为支持；契约中的假设带 rule_id', () => {
    const rc = oomCase();
    const { ledger } = seeded(rc);
    ledger.evaluate();
    const h7 = ledger.entries.get('h7')!;
    expect(h7).toMatchObject({ rootComponent: PG, status: 'supported', supporting: ['card:6', 'card:7'] });
    expect(h7.mechanism).toContain('OOM');
    const out = ledger.toContract();
    expect(out.find((h) => h.id === 'h7')).toMatchObject({ rule_id: 'postgres/oom-failover', status: 'supported' });
    const v = validatorFor('schemas/research-output.schema.json#/$defs/Hypothesis');
    for (const h of out) {
      expect(v(h), JSON.stringify(v.errors)).toBe(true);
    }
  });

  it('只有规则卡片条件上不满足条件的检查推翻它：卡片定义不同、实体不在范围内、无法判定的检查都不算', () => {
    const rc = oomCase();
    const { book, ledger } = seeded(rc);
    ledger.merge([hyp('h1', API, 'api 新版本回归')], []);
    // 测的是别的卡片定义
    book.addCheckCard(checkResult(PG, 'normal'), 'h1', 'rule', `cardcheck:workload/pod-restarts/memory@${PG}`);
    // 实体不在 PG 的范围内
    book.addCheckCard(checkResult(WEB, 'normal'), 'h1', 'rule', `cardcheck:${OOM}@${WEB}`);
    // 无法判定
    book.addCheckCard(checkResult(PG, 'undeterminable'), 'h1', 'rule', `cardcheck:${OOM}@${PG}`);
    // 主库切换卡判为异常，但 observations 的 changes 为 0（只是同时有两个主库）：不满足条件，推翻
    ledger.evaluate();
    expect(ledger.entries.get('h7')!.status).toBe('supported');
    book.addCheckCard(
      checkResult(PG, 'abnormal', { changes: 0, primaries: 2 }),
      'h1',
      'rule',
      `cardcheck:${PRIMARY}@${PG}`,
    );
    ledger.evaluate();
    const h7 = ledger.entries.get('h7')!;
    expect(h7.status).toBe('refuted');
    expect(h7.reasons.at(-1)).toMatch(/检查在规则 postgres\/oom-failover 的卡片条件上不成立：card:11/);
    expect(ledger.toContract().find((h) => h.id === 'h7')!.refuting).toEqual(['card:11']);
  });
});

describe('结论：规则判定纠正方向相反的模型结论', () => {
  it('主库 OOM 引发切换：模型把根因判成 api 的新版本回归，没有推翻规则判定，代码改选规则判定，档位 likely', () => {
    const rc = oomCase();
    const { book, ledger } = seeded(rc);
    ledger.merge([hyp('h1', API, 'api 新版本回归，查询报错', ['card:1']), hyp('h2', PG, '数据卷写满')], []);
    ledger.evaluate();
    const v = validateConclusion(conclude({ hypothesis_id: 'h1' }), rc, book, ledger);
    expect(v.chosen?.id).toBe('h7');
    expect(v.chosenBy).toBe('rule');
    expect(v.notes.at(-1)).toMatch(
      /模型选中 h1（Deployment:shop\/api），规则判定 postgres\/oom-failover（StatefulSet:shop\/postgres）没有被检查推翻/,
    );
    const r = judgeLadder(ledger, v.chosen, rc.incident, true, v.chosenBy);
    expect(r.level).toBe('likely');
    expect(r.detail?.chosen_by).toBe('rule');
    expect(r.notes[0]).toMatch(/规则判定（postgres\/oom-failover），档位最高为 likely/);
  });

  it('模型弃权：代码改选规则判定', () => {
    const rc = poolCase();
    const { book, ledger } = seeded(rc);
    ledger.merge([hyp('h1', API, '网关查询变多')], []);
    ledger.evaluate();
    const v = validateConclusion(
      conclude({ hypothesis_id: null, undetermined_reason: '只看到连接池占满' }),
      rc,
      book,
      ledger,
    );
    expect(v.chosen?.id).toBe('h7');
    expect(v.chosenBy).toBe('rule');
    expect(v.undeterminedReason).toBeNull();
    expect(v.chosen?.mechanism).toContain('max_connections');
  });

  it('模型选中与规则判定相同的根因：保持模型的选择，档位照常按四个条件判定', () => {
    const rc = oomCase();
    const { book, ledger } = seeded(rc);
    ledger.merge([hyp('h1', PG, '主库被 OOM 终止后切换', ['card:6'])], []);
    ledger.evaluate();
    const v = validateConclusion(conclude({ hypothesis_id: 'h1' }), rc, book, ledger);
    expect(v.chosen?.id).toBe('h1');
    expect(v.chosenBy).toBe('model');
    // 同一根因上的规则判定不是竞争假设
    expect(ledger.competitors(v.chosen!).map((e) => e.id)).toEqual([]);
  });

  it('检查推翻了规则判定：保持模型选的别的根因', () => {
    const rc = oomCase();
    const { book, ledger } = seeded(rc);
    ledger.merge([hyp('h1', API, 'api 新版本回归', ['card:1'])], []);
    book.addCheckCard(checkResult(PG, 'normal'), 'h1', 'rule', `cardcheck:${OOM}@${PG}`);
    ledger.evaluate();
    const v = validateConclusion(conclude({ hypothesis_id: 'h1' }), rc, book, ledger);
    expect(v.chosen?.id).toBe('h1');
    expect(v.chosenBy).toBe('model');
  });
});

/** 两条常规路由（都经过事件所在的命名空间）与一条兜底路由 */
function blockedLayer() {
  return testLayer([
    testRoute('http://127.0.0.1:9/v1', { id: 'primary', failure_domain: ['Namespace:shop'] }),
    testRoute('http://127.0.0.1:9/v1', { id: 'secondary', failure_domain: ['Namespace:shop'] }),
    testRoute('http://127.0.0.1:9/v1', { id: 'direct', role: 'last_resort' }),
  ]);
}

function composeInput(rc: ResearchCase, research: ComposeInput['research']): ComposeInput {
  return {
    incident: rc.incident,
    stageA: rc.stageA,
    alerts: [],
    research,
    researchPending: false,
    stageAOnlyReason: null,
    proposals: [],
    feedback: null,
    prefix: '',
    consoleUrl: 'https://srenautix.example.test',
    language: 'zh',
  };
}

const flat = (m: ReturnType<typeof composeMessage>['message']) =>
  m.sections.flatMap((s) => s.blocks.map((b) => (b.runs ?? []).map((r) => r.text).join(''))).join('\n');

describe('模型不可用：两条常规路由都因故障域熔断，兜底路由当日额度用完', () => {
  for (const [name, make, truth, keywords] of [
    ['主库 OOM 引发切换', oomCase, '主库进程退出后集群把备库提升为主库', ['OOM', '备库']],
    ['网关查询占满连接池', poolCase, '连接数顶到 max_connections', ['max_connections', '耗时']],
  ] as const) {
    it(`${name}：研判只出阶段 A；群消息与评测给出规则判定的根因与机制`, async () => {
      const rc = make();
      const layer = blockedLayer();
      const res = await runStageB(
        {
          runId: '7a1b2c3d-0000-4000-8000-0000000000d1',
          rc,
          previous: null,
          signal: new AbortController().signal,
          lastResort: { dailyTokens: 1_000, usedToday: 1_000 },
        },
        {
          layer,
          metrics: layer.opts.metrics,
          language: 'zh',
          limits: DEFAULT_LIMITS,
          tools: [],
          query: null,
          replay: false,
          now: () => Date.now(),
        },
        new MemorySink(),
      );
      expect(res.state).toBe('stage_a_only');
      expect(res.error?.kind).toBe('budget_exhausted');
      expect(res.output).toBeNull();

      const research: ComposeInput['research'] = {
        run_id: '7a1b2c3d-0000-4000-8000-0000000000d1',
        state: 'stage_a_only',
        disposition: null,
        conclusion_level: null,
        root_component: null,
        output: null,
        error: { kind: res.error!.kind, message: res.error!.message },
      };
      const { message } = composeMessage(composeInput(rc, research));
      const body = flat(message);
      expect(body).toContain('规则判定：可能（likely） · ');
      expect(body).toContain(truth);
      expect(message.banner).toBe('只出确定性报告：当日模型预算达到研判上限');

      const fallback = ruleFallback(rc.stageA, 'zh-CN')!;
      expect(fallback).toMatchObject({ level: 'likely', root: PG, top: [PG] });
      expect(fallback.mechanism).toContain(truth);
      const record = {
        caseId: 'c',
        run: 0,
        routeId: 'primary',
        model: 'm',
        environment: TEST_ENVIRONMENT,
        state: 'stage_a_only' as const,
        structuredFailure: false,
        disposition: rc.stageA.disposition,
        cost: 0,
        currency: 'USD',
        inputTokens: 0,
        outputTokens: 0,
        missRate: null,
        fingerprints: [],
        durationMs: 0,
        error: 'budget_exhausted',
        proposals: [],
        ...fallback,
      };
      const truthCase = {
        case_id: 'c',
        type: 'incident',
        truth: {
          root_components: [PG],
          disposition: null,
          forbid_evidence_consistent: false,
          mechanism_expect: [...keywords],
        },
      } as never;
      expect(scoreRun(truthCase, record)).toMatchObject({
        top1: true,
        abstained: false,
        mechanismScored: true,
        mechanismHit: true,
      });
    });
  }

  it('没有规则判定时消息照旧只有阶段 A 根因候选，评测没有结论', () => {
    const rc = researchCase();
    expect(ruleFallback(rc.stageA, 'zh-CN')).toBeNull();
    const body = flat(composeMessage(composeInput(rc, null)).message);
    expect(body).not.toContain('规则判定');
    expect(body).toContain('阶段 A 根因候选：');
  });
});

describe('上下文 16k 的路由上的 conclude 带规则判定', () => {
  it('规则判定在可裁剪的片段里：全部裁掉之后的请求体与没有规则判定时相同', () => {
    const context = 16_384;
    const profile = { ...declaredProfile('openai-compatible'), context_tokens: context };
    const body = (rc: ResearchCase) => {
      const { book, ledger } = seeded(rc);
      ledger.merge(
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((id, i) =>
          hyp(id, [PG, API, WEB][i % 3]!, `机制 ${id}：${'说明'.repeat(30)}`, ['card:1']),
        ),
        [],
      );
      ledger.evaluate();
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
        maxOutputTokens: DEFAULT_BUDGET.stages.conclude.outputTokens,
        temperature: 0,
      };
      const full = JSON.stringify(req.items);
      for (let t = trimOnce(req); t; t = trimOnce(req)) {
        req = t.request;
      }
      return {
        full,
        trimmed: JSON.stringify(
          streamingParams('chat_completions', toChatParams(req, { model: 'local-model', profile, language: 'zh' })),
        ),
      };
    };
    const rules = [oomFailover(), slowStatements(), { ...oomFailover(), rule_id: 'postgres/third' }];
    const withRules = body(oomCase(rules));
    const without = body(oomCase([]));
    expect(withRules.full).toContain('规则判定的说明');
    expect(withRules.full).toContain('\\"rule\\":\\"postgres/oom-failover\\"');
    // 不可裁剪的部分逐字相同：16k 路由的余量（research-context-budget 的 16k 用例）不受规则判定影响
    expect(withRules.trimmed).toBe(without.trimmed);
  });
});

describe('契约', () => {
  it('带规则判定的阶段 A 报告符合契约', () => {
    const v = validatorFor('schemas/stage-a-report.schema.json');
    const r = oomCase().stageA;
    expect(v(r), JSON.stringify(v.errors)).toBe(true);
  });
});
