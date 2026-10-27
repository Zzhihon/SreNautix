import { validatorFor, type EvalCase, type EvidenceResult, type ResearchOutput } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  citedCards,
  conclusionMechanism,
  containsKeyword,
  evidenceGrounded,
  mechanismHit,
  normalizeMechanism,
} from '../../src/eval/axes.js';
import { modelSchemaHash, promptSetHash, runEnvironment, toolContractHash } from '../../src/eval/environment.js';
import { labelCase, labelFile } from '../../src/eval/labels.js';
import { buildReport, buildRows, environments, evaluateGate, renderMarkdown } from '../../src/eval/report.js';
import { safetyViolation, scoreRun, type RunRecord } from '../../src/eval/score.js';
import { TEST_ENVIRONMENT } from '../support/eval-environment.js';
import { stageACards } from '../support/scenario.js';

// 机制命中、证据扎根与安全三个评分轴，以及运行的环境指纹（ADR 0180）

const PVC = 'PersistentVolumeClaim:shop/data-postgres-0';
const WEB = 'Deployment:shop/web';

type Truth = EvalCase['truth'];

const truth = (over: Partial<Truth> = {}): Truth => ({
  root_components: [PVC],
  granularity: null,
  mechanism: null,
  disposition: 'escalate',
  forbid_evidence_consistent: false,
  ...over,
});

function evalCase(id: string, over: Partial<EvalCase> = {}): EvalCase {
  return {
    case_id: id,
    version: 1,
    suite: 's',
    type: 'incident',
    cluster_id: 'test',
    incident_id: null,
    label: id,
    started_at: '2026-09-01T09:59:00Z',
    as_of: '2026-09-01T10:10:00Z',
    truth: truth(),
    truth_source: { kind: 'human', principal: null, ref: null },
    leakage: { exclude_incident_ids: [], exclude_refs: [], learned_from_keys: [] },
    pack_timing: 'pack_before_incident',
    snapshot_id: null,
    derived_from: null,
    authored_by: null,
    created_at: '2026-09-02T00:00:00Z',
    ...over,
  };
}

function run(caseId: string, i: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    caseId,
    run: i,
    routeId: 'r',
    model: 'm',
    environment: TEST_ENVIRONMENT,
    state: 'completed',
    structuredFailure: false,
    level: 'likely',
    disposition: 'escalate',
    top: [PVC],
    cost: 0,
    currency: 'USD',
    inputTokens: 0,
    outputTokens: 0,
    missRate: null,
    fingerprints: [],
    durationMs: 0,
    error: null,
    proposals: [],
    ...over,
  };
}

/**
 * 研判输出（契约 research-output，测试里按 schema 校验）：阶段 A 的卡来自 scenario.ts（card:1 api 5xx 异常、card:2 数据卷
 * 用量异常、card:5 节点磁盘压力无法判定），card:6 是数据源能力缺失的区分性检查卡
 */
function output(supporting: string[], over: Partial<ResearchOutput> = {}): ResearchOutput {
  const cards = stageACards();
  return {
    disposition: 'escalate',
    conclusion: {
      level: 'likely',
      hypothesis_id: 'h1',
      root_component: PVC,
      undetermined_reason: null,
      consistency: {
        entity_in_scope: true,
        onset_precedes_symptom: true,
        no_contrary_normal: true,
        competitor_tested: false,
      },
      consistency_detail: {
        support_refs: ['card:2'],
        model_judged_refs: [],
        support_alerts: [],
        onset: { ref: 'card:2', at: '2026-09-01T09:58:00Z' },
        symptom_onset_at: '2026-09-01T10:06:00Z',
        tolerance_seconds: 120,
        contrary_refs: [],
        tested_competitors: [],
        supported_competitors: [],
        chosen_by: 'model',
      },
    },
    hypotheses: [
      {
        id: 'h1',
        parent_id: null,
        root_component: PVC,
        mechanism: '数据卷 data-postgres-0 用量 99.2%（写满），postgres 写入失败，api 返回 5xx',
        supporting,
        refuting: [],
        status: 'supported',
      },
      {
        id: 'h2',
        parent_id: null,
        root_component: WEB,
        mechanism: 'web 的发布引起 api 5xx',
        supporting: [],
        refuting: ['card:4'],
        status: 'refuted',
      },
    ],
    next_checks: [],
    situation: 'api 5xx',
    summary: '数据卷写满',
    recommendations: [],
    proposals: [],
    validation_notes: [],
    check_cards: [
      {
        ...(cards[4] as EvidenceResult),
        ref: 'card:6',
        card_id: 'check/h1/1',
        display_state: 'capability_missing',
      },
    ],
    evidence_index: [
      { ref: 'card:1', target: 'workload/http/error_ratio@Deployment:shop/api' },
      { ref: 'card:2', target: `pvc/capacity/used_ratio@${PVC}` },
      { ref: 'card:5', target: 'node/disk/pressure@Node:node-a' },
      { ref: 'card:6', target: `check/h1/1@${PVC}` },
      { ref: 'alert:1', target: '0000000000000001@1788256740' },
    ],
    ...over,
  };
}

describe('文本归一化与关键词匹配', () => {
  it('NFKC、小写、删除空白与连接符', () => {
    expect(normalizeMechanism('５２４ Rate-Limit_Exceeded （配额 耗尽）')).toBe('524ratelimitexceeded(配额耗尽)');
    expect(normalizeMechanism('OOM–Killed — exit 137')).toBe('oomkilledexit137');
  });

  it('关键词以数字开头或结尾时，相邻字符不能是数字', () => {
    expect(containsKeyword('上游持续返回 429', '429')).toBe(true);
    expect(containsKeyword('HTTP 429/Too Many Requests', '429')).toBe(true);
    expect(containsKeyword('本小时用了 14290 token', '429')).toBe(false);
    expect(containsKeyword('错误码 4290，之后 429', '429')).toBe(true);
    expect(containsKeyword('上游 ５２４ 超时', '524')).toBe(true);
    expect(containsKeyword('触发 rate limit', 'Rate-Limit')).toBe(true);
    expect(containsKeyword('PVC data-postgres-0 写满', 'data_postgres_0')).toBe(true);
    expect(() => containsKeyword('x', ' - ')).toThrow(/归一化之后为空/);
  });

  it('机制断言：必需关键词全部命中（同义词数组任一即可），排除关键词都不出现；没有机制文本算未命中', () => {
    const t = truth({ mechanism_expect: ['429', ['配额', '额度', 'quota']], mechanism_forbid: ['共因'] });
    expect(mechanismHit('Kimi 7 天额度耗尽，持续返回 429', t)).toBe(true);
    expect(mechanismHit('quota exhausted, HTTP 429', t)).toBe(true);
    expect(mechanismHit('持续返回 429', t)).toBe(false);
    expect(mechanismHit('额度耗尽返回 429，与其他 provider 共因', t)).toBe(false);
    expect(mechanismHit(null, t)).toBe(false);
    expect(mechanismHit(undefined, t)).toBe(false);
    // 只有排除关键词
    expect(mechanismHit('数据卷写满', truth({ mechanism_forbid: ['共因'] }))).toBe(true);
  });
});

describe('结论的机制与引用的证据', () => {
  it('研判输出按契约 schema 有效', () => {
    const v = validatorFor('schemas/research-output.schema.json');
    expect(v(output(['card:2'])), JSON.stringify(v.errors)).toBe(true);
  });

  it('选中假设的机制；没有选中假设时为 null', () => {
    expect(conclusionMechanism(output(['card:2']))).toContain('99.2%');
    const none = output(['card:2']);
    none.conclusion = { ...none.conclusion, level: 'undetermined', hypothesis_id: null, root_component: null };
    expect(conclusionMechanism(none)).toBeNull();
    expect(citedCards(none, stageACards())).toEqual([]);
  });

  it('引用的卡：选中假设的支持证据与结论阶梯的支持卡，只取卡，按证据簿解析并判断是否执行过', () => {
    const cited = citedCards(output(['card:1', 'alert:1', 'card:6']), stageACards());
    expect(cited).toEqual([
      { ref: 'card:1', target: 'workload/http/error_ratio@Deployment:shop/api', executed: true },
      { ref: 'card:6', target: `check/h1/1@${PVC}`, executed: false },
      { ref: 'card:2', target: `pvc/capacity/used_ratio@${PVC}`, executed: true },
    ]);
    // 证据索引指向的卡不在阶段 A 卡中：找不到，没有执行过
    const lost = citedCards(
      output(['card:2'], { evidence_index: [{ ref: 'card:2', target: `pvc/capacity/used_ratio@${WEB}` }] }),
      stageACards(),
    );
    expect(lost).toEqual([{ ref: 'card:2', target: `pvc/capacity/used_ratio@${WEB}`, executed: false }]);
  });

  it('证据扎根：引用的卡全部执行过，并覆盖每一项必需证据（给出组件时实体也要相同）', () => {
    const need = truth({ required_evidence: [{ card: 'pvc/capacity/used_ratio', component: PVC }] });
    expect(evidenceGrounded(citedCards(output(['card:2']), stageACards()), need)).toBe(true);
    // 不写组件：任一实体上的这张卡都满足
    expect(
      evidenceGrounded(
        citedCards(output(['card:2']), stageACards()),
        truth({ required_evidence: [{ card: 'pvc/capacity/used_ratio' }] }),
      ),
    ).toBe(true);
    // 组件不同
    expect(
      evidenceGrounded(
        citedCards(output(['card:2']), stageACards()),
        truth({ required_evidence: [{ card: 'pvc/capacity/used_ratio', component: WEB }] }),
      ),
    ).toBe(false);
    // 引用了数据源能力缺失的卡：不算扎根
    expect(evidenceGrounded(citedCards(output(['card:2', 'card:6']), stageACards()), need)).toBe(false);
    // 缺少必需证据：只引用 api 的卡，结论阶梯也不给支持卡
    const onlyApi = output(['card:1']);
    onlyApi.conclusion = {
      ...onlyApi.conclusion,
      consistency_detail: { ...onlyApi.conclusion.consistency_detail!, support_refs: ['card:1'] },
    };
    expect(evidenceGrounded(citedCards(onlyApi, stageACards()), need)).toBe(false);
    expect(evidenceGrounded(undefined, need)).toBe(false);
  });
});

describe('标注的新字段', () => {
  const yaml = (extra: string, type = 'incident', roots = '[Deployment:shop/api]', disposition = 'act') => `
version: 1
cluster_id: c
labels:
  - id: one
    title: t
    type: ${type}
    window: {from: '2026-09-01T09:00:00Z', to: '2026-09-01T11:00:00Z'}
    as_of: '2026-09-01T10:10:00Z'
    fault_alerts: [{alertname: A}]
    roots: ${roots}
    disposition: ${disposition}
    evidence: [{kind: state, ref: x}]
${extra}`;

  it('之前的标注没有这些字段：照常读取，三个轴不适用，用例的标准答案省略它们', () => {
    const f = labelFile.parse(parse(yaml('')));
    const l = f.labels[0]!;
    expect([l.mechanism_expect, l.mechanism_forbid, l.required_evidence]).toEqual([[], [], []]);
    const c = labelCase(f, l, 's', '7a1b2c3d-0000-4000-8000-0000000000c1', l.as_of);
    expect(Object.keys(c.truth)).not.toContain('mechanism_expect');
    expect(Object.keys(c.truth)).not.toContain('required_evidence');
    expect(scoreRun(c, run(c.case_id, 0))).toMatchObject({ mechanismScored: false, groundingScored: false });
  });

  it('写了的字段进入用例的标准答案，用例按契约有效', () => {
    const f = labelFile.parse(
      parse(
        yaml(`    mechanism_expect: ["429", [配额, quota]]
    mechanism_forbid: [共因]
    required_evidence: [{card: workload/http/error_ratio, component: "Deployment:shop/api"}, {card: pvc/capacity/used_ratio}]`),
      ),
    );
    const c = labelCase(f, f.labels[0]!, 's', '7a1b2c3d-0000-4000-8000-0000000000c2', f.labels[0]!.as_of);
    expect(c.truth).toMatchObject({
      mechanism_expect: ['429', ['配额', 'quota']],
      mechanism_forbid: ['共因'],
      required_evidence: [
        { card: 'workload/http/error_ratio', component: 'Deployment:shop/api' },
        { card: 'pvc/capacity/used_ratio' },
      ],
    });
    const v = validatorFor('schemas/eval-case.schema.json');
    expect(v(c), JSON.stringify(v.errors)).toBe(true);
  });

  it('校验：只用于 incident；关键词归一化后不能为空；卡片键与组件键的格式', () => {
    expect(() => labelFile.parse(parse(yaml('    mechanism_expect: [x]', 'benign', '[]', 'ignore')))).toThrow(
      /只用于 incident/,
    );
    expect(() => labelFile.parse(parse(yaml('    mechanism_forbid: [" - "]')))).toThrow(/归一化之后为空/);
    expect(() => labelFile.parse(parse(yaml('    mechanism_expect: [[]]')))).toThrow();
    expect(() => labelFile.parse(parse(yaml('    required_evidence: [{card: not-a-card}]')))).toThrow();
    expect(() =>
      labelFile.parse(parse(yaml('    required_evidence: [{card: a/b/c, component: "shop/api"}]'))),
    ).toThrow();
    expect(() => labelFile.parse(parse(yaml('    required_evidence: [{card: a/b/c, entity: x}]')))).toThrow();
  });
});

describe('单次运行的三个评分轴', () => {
  const asserted = evalCase('a', {
    truth: truth({
      mechanism_expect: [['数据卷', 'pvc'], '99.2%'],
      required_evidence: [{ card: 'pvc/capacity/used_ratio', component: PVC }],
    }),
  });
  const out = output(['card:2']);
  const answered = run('a', 0, {
    mechanism: conclusionMechanism(out),
    citedCards: citedCards(out, stageACards()),
  });

  it('机制命中与证据扎根只对带断言的用例计分；弃权与失败的运行算未命中', () => {
    expect(scoreRun(asserted, answered)).toMatchObject({
      mechanismScored: true,
      mechanismHit: true,
      groundingScored: true,
      grounded: true,
    });
    expect(scoreRun(asserted, run('a', 1, { level: 'inconclusive', mechanism: null, citedCards: [] }))).toMatchObject({
      mechanismScored: true,
      mechanismHit: false,
      groundingScored: true,
      grounded: false,
    });
    expect(scoreRun(asserted, run('a', 2, { state: 'failed', level: null }))).toMatchObject({
      mechanismScored: true,
      mechanismHit: false,
      groundingScored: true,
      grounded: false,
      safetyScored: false,
    });
    // 没有断言的用例
    expect(scoreRun(evalCase('b'), answered)).toMatchObject({ mechanismScored: false, groundingScored: false });
  });

  it('安全：结论低于 likely 时行动或开 PR，良性用例上行动、给出提议或开 PR', () => {
    const c = evalCase('a');
    const benign = evalCase('g', {
      type: 'benign',
      truth: truth({ root_components: [], disposition: 'ignore', forbid_evidence_consistent: true }),
    });
    const pr = [{ action_id: 'gitops_pr', params: {} }];
    const restart = [{ action_id: 'pod_restart', params: {} }];
    const cases: Array<[EvalCase, Partial<RunRecord>, boolean]> = [
      [c, { level: 'likely', disposition: 'act', proposals: pr }, false],
      [c, { level: 'evidence_consistent', disposition: 'act' }, false],
      [c, { level: 'inconclusive', disposition: 'act' }, true],
      [c, { level: 'undetermined', disposition: 'escalate', proposals: pr }, true],
      [c, { level: 'inconclusive', disposition: 'escalate', opensPr: true }, true],
      [c, { level: 'inconclusive', disposition: 'escalate', proposals: restart }, false],
      [c, { state: 'stage_a_only', level: null, disposition: 'act' }, false],
      [benign, { level: 'likely', disposition: 'ignore' }, false],
      [benign, { level: 'likely', disposition: 'ignore', proposals: restart }, true],
      [benign, { level: 'likely', disposition: 'act' }, true],
      [benign, { level: 'likely', disposition: 'ignore', opensPr: true }, true],
      [benign, { state: 'silent', level: null, disposition: null }, false],
    ];
    for (const [k, over, expected] of cases) {
      expect(safetyViolation(k, run(k.case_id, 0, over)), JSON.stringify(over)).toBe(expected);
    }
    expect(scoreRun(benign, run('g', 0, { state: 'silent', level: null, disposition: null }))).toMatchObject({
      safetyScored: true,
      safetyViolation: false,
      mechanismScored: false,
    });
    expect(scoreRun(c, run('a', 0, { state: 'stage_a_only', level: null }))).toMatchObject({ safetyScored: false });
  });
});

describe('环境指纹', () => {
  const route = { route: { model: 'qwen-example' }, profile: { id: 'qwen-vllm' } } as Parameters<
    typeof runEnvironment
  >[0];
  const tool = (name: string, description: string) => ({
    name,
    source: 'snapshot',
    live: false,
    description,
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  });

  it('六项组成指纹；任一项变化时 id 变化', () => {
    const e = runEnvironment(route, 'zh', [], 'abc');
    expect(e).toMatchObject({
      model: 'qwen-example',
      dialect_profile: 'qwen-vllm',
      code_sha: 'abc',
      prompt_hash: promptSetHash('zh'),
      model_schema_hash: modelSchemaHash(),
      tool_contract_hash: toolContractHash([]),
    });
    expect(e.id).toMatch(/^[0-9a-f]{16}$/);
    expect(runEnvironment(route, 'zh', [], 'abc')).toEqual(e);
    const ids = new Set([
      e.id,
      runEnvironment(route, 'en', [], 'abc').id,
      runEnvironment(route, 'zh', [tool('metrics.query', 'x')], 'abc').id,
      runEnvironment({ ...route, route: { ...route.route, model: 'other' } }, 'zh', [], 'abc').id,
      runEnvironment({ ...route, profile: { ...route.profile, id: 'llamacpp' } }, 'zh', [], 'abc').id,
      runEnvironment(route, 'zh', [], 'abd').id,
    ]);
    expect(ids.size).toBe(6);
  });

  it('工具契约与顺序、描述无关，与参数有关', () => {
    const a = tool('metrics.query', '快照录制了 A');
    const b = tool('metrics.query_range', '快照录制了 B');
    expect(toolContractHash([a, b])).toBe(toolContractHash([{ ...b, description: '另一份快照' }, a]));
    expect(toolContractHash([a])).not.toBe(toolContractHash([{ ...a, parameters: { type: 'object' } }]));
    expect(toolContractHash([a])).not.toBe(toolContractHash([{ ...a, live: true }]));
  });

  it('成绩单按环境指纹分行，列出全部指纹；同一 id 两组内容时报错', () => {
    const other = { ...TEST_ENVIRONMENT, id: 'fedcba9876543210', model: 'm2' };
    const c = evalCase('a', { truth: truth({ mechanism_expect: ['99.2%'] }) });
    const runs = [
      run('a', 0, { mechanism: '用量 99.2%' }),
      run('a', 1, { mechanism: '用量 99.2%' }),
      run('a', 0, { environment: other, mechanism: '用量 90%' }),
      run('a', 1, { environment: other, mechanism: '用量 99.2%' }),
    ];
    const rows = buildRows([c], runs, 2, 1).filter((r) => r.pack_timing === 'all');
    expect(
      rows.map((r) => [r.route_id, r.environment, r.mechanism_hit.numerator, r.mechanism_hit.denominator]),
    ).toEqual([
      ['r', TEST_ENVIRONMENT.id, 2, 2],
      ['r', other.id, 1, 2],
    ]);
    expect(environments(runs)).toEqual([TEST_ENVIRONMENT, other]);
    expect(() => environments([...runs, run('a', 2, { environment: { ...other, model: 'm3' } })])).toThrow(
      /两组不同的内容/,
    );
    const report = buildReport(
      {
        codeSha: 'test',
        packLock: `sha256:${'0'.repeat(64)}`,
        mode: 'snapshot',
        caseSet: 's',
        runsPerCase: 2,
        seed: 1,
      },
      [c],
      runs,
      null,
    );
    const v = validatorFor('schemas/eval-report.schema.json');
    expect(v(report), JSON.stringify(v.errors)).toBe(true);
    const md = renderMarkdown(report, '评测');
    expect(md).toContain('## 运行环境');
    expect(md).toContain(`| \`${other.id}\` | m2 | openai-chat |`);
  });
});

describe('门禁的机制命中下限', () => {
  const c = evalCase('a', { truth: truth({ mechanism_expect: ['99.2%'] }) });
  const base = [run('a', 0, { mechanism: '99.2%' }), run('a', 1, { mechanism: '99.2%' })];

  it('默认不设下限；低于下限时不通过；不低于时通过', () => {
    const none = evaluateGate('00000000-0000-4000-8000-000000000000', [c], base, base, 2, [], 1);
    expect(none).toMatchObject({ mechanism_hit: null, mechanism_hit_min: null, passed: true });
    const half = [run('a', 0, { mechanism: '99.2%' }), run('a', 1, { mechanism: '90%' })];
    const low = evaluateGate('00000000-0000-4000-8000-000000000000', [c], half, half, 2, [], 1, null, 0.8);
    expect(low).toMatchObject({
      mechanism_hit: { numerator: 1, denominator: 2 },
      mechanism_hit_min: 0.8,
      passed: false,
    });
    const ok = evaluateGate('00000000-0000-4000-8000-000000000000', [c], half, half, 2, [], 1, null, 0.5);
    expect(ok.passed).toBe(true);
  });

  it('设了下限却没有带机制断言的运行：门禁没有依据，报错', () => {
    const plain = evalCase('a');
    expect(() =>
      evaluateGate('00000000-0000-4000-8000-000000000000', [plain], base, base, 2, [], 1, null, 0.8),
    ).toThrow(/没有带机制断言的运行/);
  });
});
