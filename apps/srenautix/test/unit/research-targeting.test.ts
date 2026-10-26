import type { ConcludeOutput, EvidenceResult, ResearchOutput } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { topComponents } from '../../src/eval/score.js';
import { incidentBook } from '../../src/research/incident.js';
import { judgeLadder } from '../../src/research/ladder.js';
import { Ledger } from '../../src/research/ledger.js';
import { mechanismTypes, signalTypes, targets } from '../../src/research/targeting.js';
import type { Subgraph } from '../../src/research/types.js';
import { validateConclusion } from '../../src/research/validate.js';
import { researchCase, stageA, T0 } from '../support/scenario.js';

// ADR 0133：推翻要有针对性，账本输出保留全部假设；ADR 0134：有相反证据时档位最高 inconclusive。
// 两个场景取自 CCHP 重建评测 aq-full3 的 trace：metrics-scrape 与 pg-lock。

const GW = 'StatefulSet:cchp-prod/gateway';
const GW_POD = 'Pod:cchp-prod/gateway-0';
const NODE = 'Node:appservice-03';
const SW = 'StatefulSet:cchp-data/seaweedfs-master';
const SW_POD = 'Pod:cchp-data/seaweedfs-master-2';
const PG = 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres';

const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

function entity(component: string): EvidenceResult['entity'] {
  const [kind, rest] = component.split(':') as [string, string];
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return { cluster_id: 'test', kind, namespace: ns, name: name as string, uid: null };
}

function card(
  ref: string,
  cardId: string,
  component: string,
  verdict: EvidenceResult['verdict'],
  anomalyMin: number | null = null,
): EvidenceResult {
  return {
    ref,
    card_id: cardId,
    title: { en: cardId },
    threshold: null,
    series: [],
    entity: entity(component),
    window: { from: iso(-60), to: iso(30) },
    verdict,
    display_state: verdict,
    reason: { kind: verdict === 'abnormal' ? 'rule' : 'all_clear', text: 'x' },
    value: null,
    table: null,
    queries: [],
    egress: 'redact',
    anomaly_started_at: anomalyMin === null ? null : iso(anomalyMin),
    evaluated_at: iso(30),
  };
}

function graph(nodes: string[], edges: Array<[string, string, string]>): Subgraph {
  return {
    topology_version: 1,
    root: nodes[0] as string,
    nodes: nodes.map((component, i) => {
      const e = entity(component) as NonNullable<EvidenceResult['entity']>;
      return {
        component,
        kind: e.kind,
        namespace: e.namespace,
        name: e.name,
        role: i === 0 ? ('root' as const) : ('member' as const),
        alerts: [],
        hops: i === 0 ? 0 : 1,
      };
    }),
    edges: edges.map(([from, to, relation]) => ({
      from,
      to,
      relation,
      provenance: 'structural' as const,
      confidence: 1,
      scope: 'instance' as const,
    })),
  };
}

function setup(cards: EvidenceResult[], sg: Subgraph) {
  const rc = researchCase({ stageA: stageA(cards), subgraph: sg });
  const book = incidentBook(rc);
  return { rc, book, ledger: new Ledger(book, rc.subgraph) };
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
    hypothesis_id: null,
    undetermined_reason: '账本中没有处于支持状态的假设',
    situation: 's',
    summary: 'm',
    recommendations: [],
    proposals: [],
    ...over,
  };
}

describe('症状类型（ADR 0133）', () => {
  it('检查的信号类型先按卡名，通用卡名按证据链名', () => {
    expect([...signalTypes(`cardcheck:workload/pod-restarts/restarts@${GW}`)]).toEqual(['crash']);
    expect([...signalTypes(`cardcheck:workload/pod-restarts/memory@${GW}`)]).toEqual(['memory']);
    expect([...signalTypes(`cardcheck:node/node-network/errors@${NODE}`)]).toEqual(['network']);
    expect([...signalTypes(`cardcheck:node/node-health/conditions@${NODE}`)]).toEqual(['node']);
    expect([...signalTypes('cardcheck:cchp-alerts/cnpg-instance-restarted/condition@X')]).toEqual(['crash']);
    expect([...signalTypes('workload/memory-by-pod')]).toEqual(['memory']);
    expect(signalTypes('x/y').size).toBe(0);
  });

  it('机制的症状类型取关键词；"窗口内存在"不是内存', () => {
    const m = mechanismTypes('gateway 的初始化流程阻塞，Pod 未就绪。窗口内存在 spec 变更');
    expect([...m].sort()).toEqual(['readiness', 'release', 'startup']);
    expect(mechanismTypes('SeaweedFS master 不稳定影响对象存储访问').has('crash')).toBe(true);
    expect(mechanismTypes('主库内存逼近 limit 被 OOMKilled').has('memory')).toBe(true);
  });

  it('信号类型与机制无交集、也不是支持卡的定义时无关；任一边未知时视为对应', () => {
    const check = `cardcheck:workload/pod-restarts/restarts@${GW}`;
    expect(targets(check, '初始化阻塞，Pod 未就绪', new Set()).related).toBe(false);
    expect(targets(check, '初始化阻塞，Pod 未就绪', new Set(['workload/pod-restarts/restarts'])).related).toBe(true);
    expect(targets(check, '容器反复崩溃重启', new Set()).related).toBe(true);
    expect(targets(check, `${GW} 引起`, new Set()).related).toBe(true);
    expect(targets('x/y', '初始化阻塞', new Set()).related).toBe(true);
  });
});

describe('metrics-scrape：重启检查推翻不了初始化等待（ADR 0133）', () => {
  const INIT =
    'gateway 的初始化流程阻塞或反复失败，使主容器停留在 PodInitializing，导致 Pod 未就绪、指标端点不可用并触发告警。窗口内存在 spec 变更';
  const NODE_MECH = '三个 gateway Pod 位于同一节点；若节点失联或出现资源压力，可能共同导致初始化受阻和就绪下降';
  const sg = () =>
    graph(
      [GW, GW_POD, NODE],
      [
        [GW_POD, GW, 'owned_by'],
        [GW_POD, NODE, 'scheduled_on'],
      ],
    );
  const cards = () => [
    card('card:1', 'workload/release/init-waiting', GW, 'abnormal', -2),
    card('card:2', 'workload/pod-restarts/restarts', GW, 'normal'),
  ];

  function run() {
    const s = setup(cards(), sg());
    s.ledger.merge([hyp('h1', GW, INIT), hyp('h2', NODE, NODE_MECH)], []);
    s.ledger.evaluate();
    const c1 = s.book.addCheckCard(
      card('card:1', 'check/h1/1', GW, 'normal'),
      'h1',
      'rule',
      `cardcheck:workload/pod-restarts/restarts@${GW}`,
    );
    const note = s.ledger.noteCheckRun('h1', c1.ref);
    const c2 = s.book.addCheckCard(
      card('card:1', 'check/h2/2', NODE, 'normal'),
      'h2',
      'rule',
      `cardcheck:node/node-health/conditions@${NODE}`,
    );
    s.ledger.noteCheckRun('h2', c2.ref);
    s.ledger.evaluate();
    return { ...s, note, c1 };
  }

  it('根因上的重启检查正常时记为无关：h1 保持支持，不算检验过，不是相反的正常卡', () => {
    const { ledger, note, c1 } = run();
    const h1 = ledger.entries.get('h1');
    expect(h1).toMatchObject({ status: 'supported', checksRun: 0, checkRefs: [c1.ref] });
    expect(note).toMatch(/^检查 card:3（.*）测的信号不属于假设 h1 的机制，记为无关，不计入推翻/);
    expect(note).toMatch(/检查测的是 crash/);
    expect(ledger.contraryCards(h1 as never)).toEqual([]);
    expect(ledger.refutingChecks(h1 as never)).toEqual([]);
    // 节点检查测的正是 h2 机制预示的节点压力：推翻
    expect(ledger.entries.get('h2')).toMatchObject({ status: 'refuted', checksRun: 1 });
  });

  it('模型弃权时由账本选中 h1，档位 likely', () => {
    const { rc, book, ledger } = run();
    const v = validateConclusion(conclude({}), rc, book, ledger);
    expect(v.chosen?.id).toBe('h1');
    expect(v.chosenBy).toBe('ledger');
    expect(judgeLadder(ledger, v.chosen, rc.incident, true, v.chosenBy).level).toBe('likely');
  });

  it('机制是崩溃重启的假设照常被同一项检查推翻', () => {
    const s = setup(cards(), sg());
    s.ledger.merge([hyp('h1', GW, 'gateway 容器反复崩溃重启，Pod 未就绪')], []);
    const c = s.book.addCheckCard(
      card('card:1', 'check/h1/1', GW, 'normal'),
      'h1',
      'rule',
      `cardcheck:workload/pod-restarts/restarts@${GW}`,
    );
    expect(s.ledger.noteCheckRun('h1', c.ref)).toBeNull();
    s.ledger.evaluate();
    expect(s.ledger.entries.get('h1')).toMatchObject({ status: 'refuted', checksRun: 1 });
  });

  it('输出的账本保留全部假设、被推翻的在最后；召回@3 按完整排序计算', () => {
    const { ledger } = run();
    const hypotheses = ledger.toContract();
    expect(hypotheses.map((h) => [h.id, h.status])).toEqual([
      ['h1', 'supported'],
      ['h2', 'refuted'],
    ]);
    const out = {
      conclusion: { level: 'inconclusive', hypothesis_id: null, root_component: null },
      hypotheses,
    } as unknown as ResearchOutput;
    expect(topComponents(out)).toEqual([GW, NODE]);
    // 结论选中的在前，其余按状态：推翻的排在待检验之后
    const mixed = {
      conclusion: { level: 'likely', hypothesis_id: 'h3', root_component: 'C' },
      hypotheses: [
        { id: 'h1', root_component: 'A', status: 'refuted' },
        { id: 'h2', root_component: 'B', status: 'pending' },
        { id: 'h3', root_component: 'C', status: 'supported' },
        { id: 'h4', root_component: 'D', status: 'refuted' },
      ],
    } as unknown as ResearchOutput;
    expect(topComponents(mixed)).toEqual(['C', 'B', 'A']);
  });
});

describe('pg-lock：有相反证据时档位最高 inconclusive（ADR 0134）', () => {
  const MECH = 'SeaweedFS master 不稳定影响对象存储访问，先造成 PostgreSQL WAL 归档失败，再促成数据库异常';
  const sg = () =>
    graph(
      [SW, SW_POD, PG],
      [
        [SW_POD, SW, 'owned_by'],
        [SW, PG, 'serves'],
      ],
    );
  const cards = () => [card('card:1', 'cchp-alerts/cnpg-wal-archive-failures/condition', PG, 'abnormal')];

  function run(withCheck: boolean) {
    const s = setup(cards(), sg());
    s.ledger.merge([hyp('h3', SW, MECH, ['card:1'])], []);
    if (withCheck) {
      const c = s.book.addCheckCard(
        card('card:1', 'check/h3/1', SW_POD, 'normal'),
        'h3',
        'rule',
        `cardcheck:workload/pod-restarts/restarts@${SW_POD}`,
      );
      s.ledger.noteCheckRun('h3', c.ref);
    }
    s.ledger.evaluate();
    return s;
  }

  it('自己的重启检查给出推翻结果：账本仍为支持（成员上的卡，ADR 0121），模型选中时档位退回 inconclusive', () => {
    const { rc, book, ledger } = run(true);
    const h3 = ledger.entries.get('h3');
    expect(h3?.status).toBe('supported');
    expect(ledger.refutingChecks(h3 as never).map((c) => c.ref)).toEqual(['card:2']);
    const v = validateConclusion(conclude({ hypothesis_id: 'h3', undetermined_reason: null }), rc, book, ledger);
    const r = judgeLadder(ledger, v.chosen, rc.incident, true, v.chosenBy);
    expect(r.level).toBe('inconclusive');
    expect(r.notes.at(-1)).toMatch(
      /^模型选中的假设 h3 自己的检查给出推翻结果（card:2 .*退回 inconclusive（ADR 0134）$/,
    );
    // 代码代选同样受限
    const byLedger = judgeLadder(ledger, v.chosen, rc.incident, true, 'ledger');
    expect(byLedger.level).toBe('inconclusive');
    expect(byLedger.notes.at(-1)).toMatch(/^代码按账本选中的假设 h3/);
  });

  it('没有这张检查卡时为 likely', () => {
    const { rc, ledger } = run(false);
    expect(judgeLadder(ledger, ledger.entries.get('h3') ?? null, rc.incident, true).level).toBe('likely');
  });
});
