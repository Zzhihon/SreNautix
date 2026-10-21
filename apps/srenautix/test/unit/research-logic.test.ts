import type { ConcludeOutput, EvidenceResult, ResearchOutput } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET } from '../../src/llm/budget.js';
import { Egress } from '../../src/llm/egress.js';
import { buildRuntimes } from '../../src/llm/routes.js';
import { ModelLayer } from '../../src/llm/session.js';
import { DEFAULT_LIMITS, runStageB } from '../../src/research/controller.js';
import { EvidenceBook } from '../../src/research/evidence.js';
import { judgeLadder } from '../../src/research/ladder.js';
import { Ledger, ownerOf, scopeOf } from '../../src/research/ledger.js';
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

  it('竞争假设检查后同样处于支持状态：likely（ADR 0124）', () => {
    const { book, ledger, rc } = setup();
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', API, []), hyp('h3', WEB, [])], []);
    book.addCheckCard(checkCard(API, 'abnormal', 3), 'h2', 'rule');
    ledger.noteCheckRun('h2');
    book.addCheckCard(checkCard(WEB, 'normal', null), 'h3', 'rule');
    ledger.noteCheckRun('h3');
    ledger.evaluate();
    expect(ledger.entries.get('h2')?.status).toBe('supported');
    expect(ledger.entries.get('h3')?.status).toBe('refuted');
    const r = judgeLadder(ledger, ledger.entries.get('h1') ?? null, rc.incident, true);
    expect(r.level).toBe('likely');
    expect(r.consistency.competitor_tested).toBe(false);
    expect(r.notes).toContain('假设 h1 的竞争假设 h2 同样处于支持状态，检查没有区分它们');
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

describe('成员告警作为支持证据（ADR 0122）', () => {
  it('根因本身上的 cause/change/symptom 告警支持它，当前状态卡全部正常也不推翻；只有告警支持时档位为 likely', () => {
    // API 上的阶段 A 卡改为正常：只剩 alert:2（ApiHighErrorRate，symptom，在 API 上）
    const cards = stageACards().map((c) => (c.ref === 'card:1' ? { ...c, verdict: 'normal' as const } : c));
    const { ledger, rc } = setup(cards);
    ledger.merge([hyp('h1', API, [])], []);
    ledger.evaluate();
    const h1 = ledger.entries.get('h1');
    expect(ledger.supportAlerts(h1 as never)).toEqual(['alert:2']);
    expect(h1?.status).toBe('supported');
    const r = judgeLadder(ledger, h1 ?? null, rc.incident, true);
    expect(r.level).toBe('likely');
    expect(r.consistency.entity_in_scope).toBe(false);
    expect(ledger.toContract()[0]?.supporting).toEqual(['alert:2']);
  });

  it('只有告警支持的第一名不满足停止条件，有支持卡才满足', () => {
    const cards = stageACards().map((c) => (c.ref === 'card:1' ? { ...c, verdict: 'normal' as const } : c));
    const { ledger } = setup(cards);
    ledger.merge([hyp('h1', API, [])], []);
    ledger.evaluate();
    expect(ledger.entries.get('h1')?.status).toBe('supported');
    expect(ledger.leaderSettled(ledger.ranked()[0])).toBe(false);
    const s = setup();
    s.ledger.merge([hyp('h1', API, [])], []);
    s.ledger.evaluate();
    expect(s.ledger.leaderSettled(s.ledger.ranked()[0])).toBe(true);
  });

  it('依赖对象上的告警只在模型引用时计入；meta 与 forecast 告警不计入', () => {
    const { ledger, rc, book } = setup();
    ledger.merge([hyp('h1', PG, []), hyp('h2', WEB, ['alert:1'])], []);
    // PVC 是 PG 挂载的依赖：没有引用时 alert:1 不计入
    expect(ledger.supportAlerts(ledger.entries.get('h1') as never)).toEqual([]);
    ledger.merge([hyp('h1', PG, ['alert:1']), hyp('h2', WEB, ['alert:1'])], []);
    expect(ledger.supportAlerts(ledger.entries.get('h1') as never)).toEqual(['alert:1']);
    // WEB 的范围不含 PVC：引用了也不计入
    expect(ledger.supportAlerts(ledger.entries.get('h2') as never)).toEqual([]);
    const meta = setup();
    (meta.rc.incident.members[1] as { role: string }).role = 'meta';
    const book2 = new EvidenceBook(meta.rc);
    const l2 = new Ledger(book2, meta.rc.subgraph);
    l2.merge([hyp('h1', API, [])], []);
    expect(l2.supportAlerts(l2.entries.get('h1') as never)).toEqual([]);
    expect(book.alertEntries).toHaveLength(2);
    expect(rc.incident.members).toHaveLength(2);
  });
});

describe('模型弃权时按账本选中（ADR 0120）', () => {
  it('唯一处于支持状态且有范围内异常卡的假设由代码选中，四个条件都满足时档位也只到 likely', () => {
    const { book, ledger, rc } = setup();
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', WEB, [])], []);
    book.addCheckCard(checkCard(WEB, 'normal', null), 'h2', 'rule');
    ledger.noteCheckRun('h2');
    ledger.evaluate();
    const v = validateConclusion(
      conclude({ hypothesis_id: null, undetermined_reason: '竞争假设没有检验', disposition: 'escalate' }),
      rc,
      book,
      ledger,
    );
    expect(v.chosen?.id).toBe('h1');
    expect(v.chosenBy).toBe('ledger');
    expect(v.undeterminedReason).toBeNull();
    const note = v.notes.find((n) => n.startsWith('模型弃权，代码按账本选中 h1'));
    expect(note).toContain('竞争假设没有检验');
    const byModel = judgeLadder(ledger, v.chosen, rc.incident, true, 'model');
    expect(byModel.level).toBe('evidence_consistent');
    const r = judgeLadder(ledger, v.chosen, rc.incident, true, v.chosenBy);
    expect(r.level).toBe('likely');
    expect(r.consistency).toEqual(byModel.consistency);
    expect(r.notes.at(-1)).toMatch(/模型弃权、由代码按账本选中/);
  });

  it('两个假设同时处于支持状态时不代选', () => {
    const { book, ledger, rc } = setup();
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', API, [])], []);
    ledger.evaluate();
    expect(ledger.list().filter((e) => e.status === 'supported')).toHaveLength(2);
    const v = validateConclusion(conclude({ hypothesis_id: null, undetermined_reason: 'x' }), rc, book, ledger);
    expect(v.chosen).toBeNull();
    expect(v.chosenBy).toBeNull();
    expect(v.undeterminedReason).toBe('x');
    expect(judgeLadder(ledger, v.chosen, rc.incident, true, v.chosenBy).level).toBe('inconclusive');
  });

  it('只由人工反馈固定为支持、没有异常卡的假设不代选；模型选了被推翻的假设时也不代选', () => {
    const { book, ledger, rc } = setup();
    ledger.merge([hyp('h1', WEB, [])], []);
    ledger.applyFeedback([feedback({ verdict: 'rejected', root_component: 'Node:node-a' })], WEB, []);
    ledger.evaluate();
    const pinned = ledger.list().find((e) => e.pinned === 'human_confirmed');
    expect(pinned?.status).toBe('supported');
    expect(ledger.supportCards(pinned as never)).toHaveLength(0);
    const abstained = validateConclusion(conclude({ hypothesis_id: null, undetermined_reason: 'x' }), rc, book, ledger);
    expect(abstained.chosen).toBeNull();
    const s = setup();
    s.ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', WEB, [])], []);
    s.ledger.evaluate();
    const r = validateConclusion(conclude({ hypothesis_id: 'h2', disposition: 'escalate' }), s.rc, s.book, s.ledger);
    expect(r.chosen).toBeNull();
    expect(r.chosenBy).toBeNull();
  });

  it('模型自己选中的假设照常按四个条件判定', () => {
    const { book, ledger, rc } = setup();
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', WEB, [])], []);
    book.addCheckCard(checkCard(WEB, 'normal', null), 'h2', 'rule');
    ledger.noteCheckRun('h2');
    ledger.evaluate();
    const v = validateConclusion(conclude({ hypothesis_id: 'h1', disposition: 'escalate' }), rc, book, ledger);
    expect(v.chosenBy).toBe('model');
    expect(judgeLadder(ledger, v.chosen, rc.incident, true, v.chosenBy).level).toBe('evidence_consistent');
  });
});

describe('组件粒度（ADR 0121）', () => {
  const DEP = 'Deployment:shop/worker';
  const RS = 'ReplicaSet:shop/worker-6d8';
  const POD = 'Pod:shop/worker-6d8-x1';
  const edge = (from: string, to: string, relation: string) => ({
    from,
    to,
    relation,
    provenance: 'structural' as const,
    confidence: 1,
    scope: 'instance' as const,
  });
  function owned() {
    const base = subgraph();
    const node = (component: string, kind: string, name: string) => ({
      component,
      kind,
      namespace: 'shop',
      name,
      role: 'member' as const,
      alerts: [],
      hops: 1,
    });
    const g = {
      ...base,
      nodes: [
        ...base.nodes,
        node(DEP, 'Deployment', 'worker'),
        node(RS, 'ReplicaSet', 'worker-6d8'),
        node(POD, 'Pod', 'worker-6d8-x1'),
      ],
      edges: [
        ...base.edges,
        edge(RS, DEP, 'owned_by'),
        edge(POD, RS, 'owned_by'),
        edge(POD, 'Node:node-a', 'scheduled_on'),
      ],
    };
    const card = { ...checkCard(POD, 'abnormal', -5), ref: 'card:1', card_id: 'pod/restarts' };
    const rc = researchCase({ subgraph: g, stageA: stageA([card]) });
    const book = new EvidenceBook(rc);
    return { rc, book, ledger: new Ledger(book, rc.subgraph), g };
  }

  it('属主取到顶层；范围沿 owned_by 向下包含全部成员，不含成员依赖的节点', () => {
    const { g } = owned();
    expect(ownerOf(POD, g)).toBe(DEP);
    expect(ownerOf(RS, g)).toBe(DEP);
    expect(ownerOf(PG, g)).toBe(PG);
    expect([...scopeOf(DEP, g)].sort()).toEqual([DEP, POD, RS].sort());
  });

  it('Pod 上的假设改为属主；落在同一组件上的假设合并，检查与结论按合并后的 id 引用', () => {
    const { rc, book, ledger } = owned();
    const notes: string[] = [];
    ledger.merge([hyp('h1', POD, ['card:1']), hyp('h2', DEP, ['alert:1']), hyp('h3', PG, [])], notes);
    ledger.evaluate();
    expect(ledger.entries.get('h1')).toMatchObject({ rootComponent: DEP, status: 'supported' });
    expect(ledger.entries.get('h1')?.supporting).toEqual(['card:1', 'alert:1']);
    expect(ledger.entries.has('h2')).toBe(false);
    expect(ledger.resolve('h2')).toBe('h1');
    expect(notes).toEqual([
      `假设 h1 的根因 ${POD} 由 ${DEP} 拥有，按组件粒度改为 ${DEP}`,
      `假设 h2 与 h1 的根因都是 ${DEP}，已并入 h1`,
    ]);
    const v = validateConclusion(conclude({ hypothesis_id: 'h2', disposition: 'escalate' }), rc, book, ledger);
    expect(v.chosen?.id).toBe('h1');
    expect(v.chosen?.rootComponent).toBe(DEP);
    // 下一轮模型改用 h2 指向别的组件时，别名解除
    ledger.merge([hyp('h1', DEP, ['card:1']), hyp('h2', API, [])], []);
    expect(ledger.resolve('h2')).toBe('h2');
    expect(ledger.entries.get('h2')?.rootComponent).toBe(API);
  });

  it('属主拥有的对象上的阶段 A 异常卡自动支持属主；依赖对象上的卡只在模型引用时计入', () => {
    const { ledger } = owned();
    ledger.merge([hyp('h1', DEP, []), hyp('h2', WEB, [])], []);
    ledger.evaluate();
    expect(ledger.supportCards(ledger.entries.get('h1') as never).map((c) => c.ref)).toEqual(['card:1']);
    expect(ledger.entries.get('h1')?.status).toBe('supported');
    // WEB 调用 API，API 上的异常卡（场景 card:1 在 API 上）没有被引用，不支持 WEB
    const s = setup();
    s.ledger.merge([hyp('h1', WEB, [])], []);
    expect(s.ledger.supportCards(s.ledger.entries.get('h1') as never)).toEqual([]);
  });

  it('范围外组件上的检查卡判定为正常时不推翻假设', () => {
    const { book, ledger } = setup();
    ledger.merge([hyp('h1', PG, ['card:2']), hyp('h2', API, [])], []);
    book.addCheckCard(checkCard(WEB, 'normal', null), 'h1', 'rule');
    ledger.noteCheckRun('h1');
    book.addCheckCard(checkCard(API, 'normal', null), 'h2', 'rule');
    ledger.noteCheckRun('h2');
    ledger.evaluate();
    expect(ledger.entries.get('h1')?.status).toBe('supported');
    expect(ledger.contraryCards(ledger.entries.get('h1') as never)).toEqual([]);
    expect(ledger.entries.get('h2')?.status).toBe('refuted');
  });

  it('属主拥有的某个成员上的检查卡正常时，有支持证据的属主假设不被推翻；没有支持证据时推翻', () => {
    const { book, ledger } = owned();
    ledger.merge([hyp('h1', DEP, [])], []);
    book.addCheckCard(checkCard(RS, 'normal', null), 'h1', 'rule');
    ledger.noteCheckRun('h1');
    ledger.evaluate();
    expect(ledger.entries.get('h1')?.status).toBe('supported');
    expect(ledger.contraryCards(ledger.entries.get('h1') as never).map((c) => c.ref)).toEqual(['card:2']);
    // 根因本身上的检查卡正常：直接推翻
    book.addCheckCard(checkCard(DEP, 'normal', null), 'h1', 'rule');
    ledger.evaluate();
    expect(ledger.entries.get('h1')?.status).toBe('refuted');
    // 没有支持证据的属主：成员上的正常检查卡推翻它
    const o = owned();
    o.ledger.merge([hyp('h1', DEP, [])], []);
    o.book.addCheckCard({ ...checkCard(RS, 'normal', null), card_id: 'x/y' }, 'h1', 'rule');
    const pod = o.book.card('card:1');
    (pod as { result: { verdict: string } }).result.verdict = 'normal';
    o.ledger.evaluate();
    expect(o.ledger.entries.get('h1')?.status).toBe('refuted');
  });

  it('反馈中的 Pod 根因按属主比对', () => {
    const { ledger } = owned();
    ledger.merge([hyp('h1', DEP, [])], []);
    ledger.applyFeedback([feedback({ verdict: 'rejected', root_component: PG })], POD, []);
    expect(ledger.entries.get('h1')).toMatchObject({ status: 'refuted', pinned: 'human_rejected' });
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
