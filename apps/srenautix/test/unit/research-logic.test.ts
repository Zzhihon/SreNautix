import type { ConcludeOutput, EvidenceResult, ResearchOutput } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET } from '../../src/llm/budget.js';
import { Egress } from '../../src/llm/egress.js';
import { buildRuntimes } from '../../src/llm/routes.js';
import { ModelLayer } from '../../src/llm/session.js';
import { DEFAULT_LIMITS, runStageB } from '../../src/research/controller.js';
import { EvidenceBook } from '../../src/research/evidence.js';
import { judgeLadder } from '../../src/research/ladder.js';
import { Ledger, scopeOf } from '../../src/research/ledger.js';
import { WorkerMetrics } from '../../src/research/metrics.js';
import { validateConclusion } from '../../src/research/validate.js';
import { MemorySink, testRoute } from '../support/research-env.js';
import { feedback, incident, researchCase, stageA, stageACards, subgraph, T0 } from '../support/scenario.js';

const PG = 'StatefulSet:shop/postgres';
const WEB = 'Deployment:shop/web';
const API = 'Deployment:shop/api';

function setup(cards: EvidenceResult[] = stageACards()) {
  const rc = researchCase({ stageA: stageA(cards) });
  const book = new EvidenceBook(rc);
  const ledger = new Ledger(book, rc.subgraph);
  return { rc, book, ledger };
}

function checkCard(component: string, verdict: EvidenceResult['verdict'], anomalyMin: number | null): EvidenceResult {
  const [kind, rest] = component.split(':') as [string, string];
  const [ns, name] = rest.split('/') as [string, string];
  return {
    ref: 'card:1',
    card_id: 'check/x/1',
    title: { en: 'check' },
    threshold: null,
    series: [],
    entity: { cluster_id: 'test', kind, namespace: ns, name, uid: null },
    window: { from: new Date(T0 - 3_600_000).toISOString(), to: new Date(T0 + 1_800_000).toISOString() },
    verdict,
    display_state: verdict,
    reason: { kind: 'rule', text: 'x' },
    value: null,
    table: null,
    queries: [],
    egress: 'redact',
    anomaly_started_at: anomalyMin === null ? null : new Date(T0 + anomalyMin * 60_000).toISOString(),
    evaluated_at: new Date(T0 + 1_800_000).toISOString(),
  };
}

const hyp = (id: string, root: string, supporting: string[] = []) => ({
  id,
  parent_id: null,
  root_component: root,
  mechanism: `${root} 引起`,
  supporting,
  refuting: [],
});

describe('证据簿', () => {
  it('卡、告警、变更的运行内编号；检查卡接着编号', () => {
    const { book } = setup();
    expect(book.refs()).toEqual(['card:1', 'card:2', 'card:3', 'card:4', 'card:5', 'alert:1', 'alert:2', 'change:1']);
    const c = book.addCheckCard(checkCard(PG, 'normal', null), 'h1', 'rule');
    expect(c.ref).toBe('card:6');
    expect(book.evidenceMap().find((m) => m.ref === 'card:6')?.target).toBe(`check/x/1@${PG}`);
  });
});

describe('假设账本', () => {
  it('范围：根因、它直接依赖的对象与它拥有的对象；调用它的上游不在范围内', () => {
    expect([...scopeOf(PG, subgraph())].sort()).toEqual(
      ['Node:node-a', 'PersistentVolumeClaim:shop/data-postgres-0', PG].sort(),
    );
    const owned = {
      ...subgraph(),
      edges: [
        {
          from: 'Pod:shop/api-1',
          to: API,
          relation: 'owned_by',
          provenance: 'structural' as const,
          confidence: 1,
          scope: 'instance' as const,
        },
      ],
    };
    expect([...scopeOf(API, owned)].sort()).toEqual(['Pod:shop/api-1', API].sort());
  });

  it('范围内的异常卡支持；不存在的引用被删除并记录', () => {
    const { ledger } = setup();
    const notes: string[] = [];
    ledger.merge([hyp('h1', PG, ['card:2', 'card:99']), hyp('h2', WEB, ['change:1'])], notes);
    ledger.evaluate();
    expect(notes).toEqual(['假设 h1 的支持引用不存在，已删除：card:99']);
    expect(ledger.entries.get('h1')?.status).toBe('supported');
    // web 的错误率卡正常且有数据：h2 的机制信号上没有异常、有相反的正常卡 → 推翻
    expect(ledger.entries.get('h2')?.status).toBe('refuted');
  });

  it('针对假设的检查结果为正常时推翻；检查前排在第一的支持假设在竞争者都推翻后满足停止条件', () => {
    const { book, ledger } = setup();
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', API, [])], []);
    ledger.evaluate();
    expect(ledger.entries.get('h2')?.status).toBe('supported');
    book.addCheckCard(checkCard(API, 'normal', null), 'h2', 'rule');
    ledger.noteCheckRun('h2');
    ledger.evaluate();
    expect(ledger.entries.get('h2')?.status).toBe('refuted');
    const leader = ledger.ranked()[0];
    expect(leader?.id).toBe('h1');
    expect(ledger.competitorsResolved(leader as never)).toBe(true);
    expect(ledger.competitorTested(leader as never)).toBe(true);
  });

  it('反馈：否定的根因固定为推翻，人工给出的根因固定为支持，之后的证据不改变', () => {
    const { ledger } = setup();
    const notes: string[] = [];
    ledger.merge([hyp('h1', API, ['card:1']), hyp('h2', PG, [])], notes);
    ledger.applyFeedback([feedback({ verdict: 'rejected', root_component: PG })], API, notes);
    ledger.evaluate();
    expect(ledger.entries.get('h1')).toMatchObject({ status: 'refuted', pinned: 'human_rejected' });
    expect(ledger.entries.get('h2')).toMatchObject({ status: 'supported', pinned: 'human_confirmed' });
  });

  it('未绑定账号的反馈不生效', () => {
    const { ledger } = setup();
    ledger.merge([hyp('h1', API, ['card:1'])], []);
    ledger.applyFeedback([feedback({ verdict: 'rejected', root_component: PG, linked: false })], API, []);
    ledger.evaluate();
    expect(ledger.entries.get('h1')?.pinned).toBeNull();
  });
});

describe('结论阶梯', () => {
  it('四个条件都满足才是 evidence_consistent', () => {
    const { book, ledger, rc } = setup();
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', WEB, [])], []);
    book.addCheckCard(checkCard(WEB, 'normal', null), 'h2', 'rule');
    ledger.noteCheckRun('h2');
    ledger.evaluate();
    const r = judgeLadder(ledger, ledger.entries.get('h1') ?? null, rc.incident, true);
    expect(r).toMatchObject({
      level: 'evidence_consistent',
      consistency: {
        entity_in_scope: true,
        onset_precedes_symptom: true,
        no_contrary_normal: true,
        competitor_tested: true,
      },
    });
  });

  it('没有检验过竞争假设：likely', () => {
    const { ledger, rc } = setup();
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', API, [])], []);
    ledger.evaluate();
    expect(judgeLadder(ledger, ledger.entries.get('h1') ?? null, rc.incident, true).level).toBe('likely');
  });

  it('支持卡的异常起始晚于症状加容差：likely', () => {
    const cards = stageACards();
    (cards[1] as EvidenceResult).anomaly_started_at = new Date(T0 + 20 * 60_000).toISOString();
    const { book, ledger, rc } = setup(cards);
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', WEB, [])], []);
    book.addCheckCard(checkCard(WEB, 'normal', null), 'h2', 'rule');
    ledger.noteCheckRun('h2');
    ledger.evaluate();
    const r = judgeLadder(ledger, ledger.entries.get('h1') ?? null, rc.incident, true);
    expect(r.level).toBe('likely');
    expect(r.consistency.onset_precedes_symptom).toBe(false);
  });

  it('只有模型判定的支持卡：likely', () => {
    const cards = stageACards().filter((c) => c.ref !== 'card:2');
    const { book, ledger, rc } = setup(cards);
    ledger.merge([hyp('h1', PG, []), hyp('h2', WEB, [])], []);
    book.addCheckCard(checkCard(PG, 'abnormal', -5), 'h1', 'model');
    book.addCheckCard(checkCard(WEB, 'normal', null), 'h2', 'rule');
    ledger.noteCheckRun('h1');
    ledger.noteCheckRun('h2');
    ledger.evaluate();
    expect(judgeLadder(ledger, ledger.entries.get('h1') ?? null, rc.incident, true).level).toBe('likely');
  });

  it('有假设没有支持卡：inconclusive；没有假设：undetermined', () => {
    const { ledger, rc } = setup();
    expect(judgeLadder(ledger, null, rc.incident, true).level).toBe('inconclusive');
    expect(judgeLadder(ledger, null, rc.incident, false).level).toBe('undetermined');
  });
});

function conclude(over: Partial<ConcludeOutput>): ConcludeOutput {
  return {
    disposition: 'act',
    hypothesis_id: 'h1',
    undetermined_reason: null,
    situation: 's',
    summary: 'm',
    recommendations: [],
    proposals: [],
    ...over,
  };
}

describe('代码校验', () => {
  it('提议：目录外、参数不合 schema、目标不在拓扑中、依据被推翻的都删除', () => {
    const { rc, book, ledger } = setup();
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', WEB, [])], []);
    ledger.evaluate();
    const v = validateConclusion(
      conclude({
        proposals: [
          { action_id: 'cnpg_switchover', params_json: '{}', hypothesis_id: 'h1', expected_effect: 'x' },
          {
            action_id: 'workload_scale',
            params_json: '{"namespace":"shop","kind":"Deployment","name":"api"}',
            hypothesis_id: 'h1',
            expected_effect: 'x',
          },
          {
            action_id: 'workload_scale',
            params_json: '{"namespace":"other","kind":"Deployment","name":"api","replicas":3}',
            hypothesis_id: 'h1',
            expected_effect: 'x',
          },
          {
            action_id: 'rollout_pause',
            params_json: '{"namespace":"shop","name":"web"}',
            hypothesis_id: 'h2',
            expected_effect: 'x',
          },
          {
            action_id: 'workload_scale',
            params_json: '{"namespace":"shop","kind":"Deployment","name":"api","replicas":3}',
            hypothesis_id: 'h1',
            expected_effect: 'x',
          },
        ],
      }),
      rc,
      book,
      ledger,
    );
    expect(v.proposals).toEqual([
      {
        action_id: 'workload_scale',
        params: { namespace: 'shop', kind: 'Deployment', name: 'api', replicas: 3 },
        hypothesis_id: 'h1',
        expected_effect: 'x',
      },
    ]);
    expect(v.notes).toHaveLength(4);
    expect(v.disposition).toBe('act');
  });

  it('修复建议：按类别排序、每类最多 3 条、runbook 与动作不在列表中时置空、引用清理', () => {
    const { rc, book, ledger } = setup();
    ledger.merge([hyp('h1', PG, ['card:2'])], []);
    ledger.evaluate();
    const rec = (
      id: string,
      kind: 'mitigation' | 'root_fix' | 'prevention' | 'investigation',
    ): ConcludeOutput['recommendations'][number] => ({
      id,
      kind,
      title: 't',
      rationale: 'r',
      steps: ['kubectl get pvc -n shop'],
      owner: 'platform',
      risk: 'low',
      risk_note: null,
      runbook_ref: 'nope.md#x',
      action_id: 'node_cordon',
      hypothesis_id: 'h1',
      evidence_refs: ['card:2', 'card:42'],
    });
    const v = validateConclusion(
      conclude({
        recommendations: [
          rec('r1', 'prevention'),
          rec('r2', 'mitigation'),
          rec('r3', 'mitigation'),
          rec('r4', 'mitigation'),
          rec('r5', 'mitigation'),
        ],
      }),
      rc,
      book,
      ledger,
    );
    expect(v.recommendations.map((r) => r.id)).toEqual(['r2', 'r3', 'r4', 'r1']);
    expect(v.recommendations[0]).toMatchObject({
      runbook_ref: null,
      action_id: null,
      evidence_refs: ['card:2'],
      generated_by: 'model',
    });
  });

  it('处置判断：观测失明一律 escalate；act 没有提议时按严重度改写；推翻的假设不能选中', () => {
    const blind = setup();
    blind.rc.stageA.observability_blind = true;
    blind.ledger.merge([hyp('h1', PG, ['card:2'])], []);
    expect(
      validateConclusion(conclude({ disposition: 'ignore' }), blind.rc, blind.book, blind.ledger).disposition,
    ).toBe('escalate');
    const s = setup();
    s.ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', WEB, [])], []);
    s.ledger.evaluate();
    expect(validateConclusion(conclude({}), s.rc, s.book, s.ledger).disposition).toBe('escalate');
    const r = validateConclusion(conclude({ hypothesis_id: 'h2', disposition: 'escalate' }), s.rc, s.book, s.ledger);
    expect(r.chosen).toBeNull();
    expect(r.undeterminedReason).toMatch(/已被推翻/);
  });
});

describe('指纹门控', () => {
  it('证据指纹不变且没有新的反馈：不调用模型，追加"仍然一致"', async () => {
    const egress = new Egress({ allowCrossBorder: false, honeytokens: [] }, () => undefined);
    const layer = new ModelLayer({
      routes: buildRuntimes(
        [
          {
            route: testRoute('http://127.0.0.1:9/v1'),
            apiKey: 'x',
            state: { profile: null, calibration: null, fingerprint: null },
          },
        ],
        egress,
        1000,
      ),
      egress,
      budget: DEFAULT_BUDGET,
      metrics: new WorkerMetrics('worker', false),
      language: 'zh',
      onCalibration: async () => undefined,
      onDrift: async () => undefined,
    });
    const rc = researchCase();
    const prevOutput = { validation_notes: ['旧'], conclusion: { root_component: PG } } as unknown as ResearchOutput;
    const sink = new MemorySink();
    const res = await runStageB(
      {
        runId: '7a1b2c3d-0000-4000-8000-0000000000c1',
        rc,
        previous: {
          runId: 'p',
          evidenceFingerprint: rc.stageA.evidence_fingerprint,
          incidentVersion: 1,
          finishedAt: new Date(T0 + 50 * 60_000).toISOString(),
          output: prevOutput,
          checkCards: [],
        },
        signal: new AbortController().signal,
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
      sink,
    );
    expect(res).toMatchObject({ state: 'completed', stopReason: 'no_change', stillConsistent: true });
    expect(res.output?.validation_notes.at(-1)).toMatch(/仍然一致/);
    expect(sink.llm).toHaveLength(0);
    expect(sink.steps).toHaveLength(0);
  });
});

describe('场景数据', () => {
  it('事件与阶段 A 报告符合契约', async () => {
    const { validatorFor } = await import('@srenautix/contract');
    const i = validatorFor('schemas/incident.schema.json');
    expect(i(incident()), JSON.stringify(i.errors)).toBe(true);
    const s = validatorFor('schemas/stage-a-report.schema.json');
    expect(s(stageA()), JSON.stringify(s.errors)).toBe(true);
  });
});
