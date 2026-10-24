import type { ComponentType, EvidenceResult } from '@srenautix/contract';
import type { PackSet } from '@srenautix/packs-sdk';
import { describe, expect, it } from 'vitest';
import { dispositionFacts, factRoots } from '../../src/remediation/facts.js';
import {
  deriveDisposition,
  fixTemplates,
  templateRoot,
  type DispositionInput,
} from '../../src/research/disposition.js';
import { incidentBook } from '../../src/research/incident.js';
import { Ledger } from '../../src/research/ledger.js';
import { dispositionSegment } from '../../src/research/prompt.js';
import type { DispositionFacts } from '../../src/research/types.js';
import { incident, researchCase, stageA, stageACards } from '../support/scenario.js';

// 处置推导（ADR 0138）

const PG = 'StatefulSet:shop/postgres';
const PROVIDER = 'provider:openai';

function cardsOf(cards: EvidenceResult[]) {
  const rc = researchCase({ stageA: stageA(cards) });
  return incidentBook(rc).allCards;
}

function input(over: Partial<DispositionInput> = {}): DispositionInput {
  const inc = incident();
  const s = stageA();
  return {
    model: 'escalate',
    incident: inc,
    stageA: s,
    level: 'likely',
    root: PG,
    proposals: 0,
    cards: cardsOf(stageACards()),
    facts: null,
    ...over,
  };
}

const facts = (f: Partial<DispositionFacts>): DispositionFacts => ({ external: [], remediations: [], ...f });

describe('处置推导', () => {
  it('观测失明一律 escalate', () => {
    const s = { ...stageA(), observability_blind: true };
    const r = deriveDisposition(input({ model: 'ignore', stageA: s, facts: facts({ external: [PG] }) }));
    expect(r.disposition).toBe('escalate');
    expect(r.notes[0]).toMatch(/观测失明/);
  });

  it('研判根因是集群外部组件（likely 及以上）：不论模型给出什么都为 ignore', () => {
    const r = deriveDisposition(input({ model: 'escalate', root: PROVIDER, facts: facts({ external: [PROVIDER] }) }));
    expect(r).toMatchObject({ disposition: 'ignore', basis: 'external' });
    expect(r.notes[0]).toMatch(/模型给出 escalate/);
    // 档位低于 likely 时外部组件不是依据：模型的 ignore 按严重度改写
    const low = deriveDisposition(
      input({ model: 'ignore', root: PROVIDER, level: 'inconclusive', facts: facts({ external: [PROVIDER] }) }),
    );
    expect(low.disposition).toBe('escalate');
  });

  it('ignore 不带修复：有有效提议或适用的修复模板时不给 ignore', () => {
    const withProposal = deriveDisposition(
      input({ model: 'ignore', root: PROVIDER, proposals: 1, facts: facts({ external: [PROVIDER] }) }),
    );
    expect(withProposal.disposition).toBe('escalate');
    expect(withProposal.notes[0]).toMatch(/1 条有效提议/);
    const withTemplate = deriveDisposition(
      input({
        model: 'ignore',
        root: PROVIDER,
        facts: facts({
          external: [PROVIDER],
          remediations: [{ root: PROVIDER, templates: [{ key: 'gitops/x', category: 'config_resource' }] }],
        }),
      }),
    );
    expect(withTemplate.disposition).toBe('escalate');
  });

  it('没有任何异常卡时为 ignore；只读工具结果由模型判定的异常卡不算确定性证据', () => {
    const normal = stageACards().map((c) => ({
      ...c,
      verdict: c.verdict === 'abnormal' ? ('normal' as const) : c.verdict,
    }));
    const book = incidentBook(researchCase({ stageA: stageA(normal) }));
    expect(deriveDisposition(input({ cards: book.allCards })).basis).toBe('evidence_normal');
    book.addCheckCard({ ...normal[0]!, verdict: 'abnormal', display_state: 'abnormal' }, 'h1', 'model');
    expect(deriveDisposition(input({ cards: book.allCards })).disposition).toBe('ignore');
    book.addCheckCard({ ...normal[0]!, verdict: 'abnormal', display_state: 'abnormal' }, 'h1', 'rule');
    expect(deriveDisposition(input({ cards: book.allCards })).disposition).toBe('escalate');
  });

  it('影响卡全部正常时为 ignore，影响卡有异常或无法判定时不是', () => {
    const cards = stageACards().map((c) => (c.ref === 'card:4' ? { ...c, impact: true } : c));
    expect(deriveDisposition(input({ cards: cardsOf(cards) })).basis).toBe('impact_normal');
    const bad = cards.map((c) => (c.ref === 'card:5' ? { ...c, impact: true } : c));
    expect(deriveDisposition(input({ cards: cardsOf(bad) })).disposition).toBe('escalate');
  });

  it('阶段 A 的确定性 ignore（抑制、排除、只有预测与长期告警）是依据，default 不是', () => {
    const s = { ...stageA(), disposition: 'ignore' as const, disposition_reason: 'forecast_or_chronic_only' as const };
    expect(deriveDisposition(input({ stageA: s })).basis).toBe('stage_a');
    expect(deriveDisposition(input({ model: 'ignore' })).disposition).toBe('escalate');
  });

  it('模型的 ignore 没有依据时按严重度改写', () => {
    const warning = { ...incident(), severity: 'warning' as const };
    const r = deriveDisposition(input({ model: 'ignore', incident: warning }));
    expect(r.disposition).toBe('undetermined');
    expect(r.notes[0]).toMatch(/没有确定性依据/);
  });

  it('act 需要有效提议、规则提议或修复模板使用的根因上适用的修复模板', () => {
    expect(deriveDisposition(input({ model: 'act', proposals: 1 })).disposition).toBe('act');
    expect(deriveDisposition(input({ model: 'act' })).disposition).toBe('escalate');
    expect(deriveDisposition(input({ model: 'act', root: null, proposals: 1 })).disposition).toBe('escalate');
    const tpl = facts({
      remediations: [
        { root: PG, templates: [{ key: 'gitops/memory-limit-raise', category: 'config_resource' }] },
        { root: 'Deployment:shop/api', templates: [{ key: 'gitops/noisy-alert-relax', category: 'alert_rule' }] },
      ],
    });
    const r = deriveDisposition(input({ model: 'act', facts: tpl }));
    expect(r).toMatchObject({ disposition: 'act', templates: ['gitops/memory-limit-raise'] });
    expect(r.notes[0]).toMatch(/修复模板 gitops\/memory-limit-raise/);
    // 档位低于 likely 时模板按事件根因匹配（ADR 0126）；告警规则类模板不算修复
    expect(templateRoot('inconclusive', 'Deployment:shop/api', PG)).toBe(PG);
    expect(fixTemplates(tpl, 'Deployment:shop/api')).toEqual([]);
    expect(deriveDisposition(input({ model: 'act', root: 'Deployment:shop/api', facts: tpl })).disposition).toBe(
      'escalate',
    );
  });

  it('escalate 与 undetermined 保持模型的取值', () => {
    expect(deriveDisposition(input({ model: 'undetermined' })).disposition).toBe('undetermined');
    expect(deriveDisposition(input({ model: 'escalate' })).notes).toEqual([]);
  });
});

describe('处置依据的计算', () => {
  const types: ComponentType[] = [
    { id: 'demo.provider', external: true, match: { kind: 'provider' } },
    { id: 'demo.db', match: { kind: 'StatefulSet', name_pattern: '^postgres$' } },
  ];
  // applicableRemediations 只用到 key、pack、def 与 when：手工构造编译后的模板
  const set = {
    remediations: [
      {
        key: 'demo/db-fix',
        pack: 'demo',
        def: { id: 'db-fix', category: 'config_resource', repository: 'gitops', params: {} },
        // 按根因自己的卡判断（ADR 0139）
        when: (c: Record<string, unknown>) => {
          const root = c.root as { kind: string } | null;
          const cards = c.root_cards as Record<string, { verdict: string }>;
          return root?.kind === 'StatefulSet' && cards['pvc/capacity/used_ratio']?.verdict === 'abnormal';
        },
      },
    ] as unknown as PackSet['remediations'],
  };

  it('外部组件按组件类型声明；修复模板按候选根因求值，只保留启用的修复类别', async () => {
    const inc = { ...incident(), components: [PG, PROVIDER] };
    const resolve = async (key: string) => {
      const [kind, rest] = key.split(':') as [string, string];
      const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
      return {
        cluster_id: 'test',
        kind,
        namespace: ns,
        name: name as string,
        node: null,
        component_type: kind === 'provider' ? 'demo.provider' : 'demo.db',
      };
    };
    const roots = factRoots(inc, { nodes: [], edges: [] });
    expect(roots).toEqual([PG, 'Deployment:shop/web', PROVIDER]);
    // 每个根因自己的卡：名字落在根因名里的实体（postgres 的数据卷属于 postgres）
    const scope = {
      cards: async (r: { name: string } | null, cards: readonly EvidenceResult[]) =>
        cards.filter((c) => r !== null && c.entity !== null && c.entity.name.includes(r.name)),
    };
    const f = await dispositionFacts({
      set,
      componentTypes: types,
      categories: ['config_resource', 'alert_rule'],
      incident: inc,
      alerts: [],
      cards: stageACards(),
      roots,
      resolve,
      scope,
    });
    expect(f).toEqual({
      external: [PROVIDER],
      remediations: [{ root: PG, templates: [{ key: 'demo/db-fix', category: 'config_resource' }] }],
    });
    const off = await dispositionFacts({
      set,
      componentTypes: types,
      categories: [],
      incident: inc,
      alerts: [],
      cards: stageACards(),
      roots,
      resolve,
      scope,
    });
    expect(off.remediations).toEqual([]);
  });
});

describe('conclude 的处置依据段', () => {
  it('只列出账本中未被推翻的假设的根因；都没有时不出现', () => {
    const rc = researchCase({ stageA: stageA() });
    rc.dispositionFacts = facts({
      external: [PROVIDER],
      remediations: [
        { root: PG, templates: [{ key: 'gitops/memory-limit-raise', category: 'config_resource' }] },
        {
          root: 'Deployment:shop/web',
          templates: [{ key: 'gitops/release-to-serving-version', category: 'release_rollback' }],
        },
      ],
    });
    const ledger = new Ledger(incidentBook(rc), rc.subgraph);
    expect(dispositionSegment(rc, ledger)).toEqual([]);
    ledger.merge([{ id: 'h1', parent_id: null, root_component: PG, mechanism: 'x', supporting: [], refuting: [] }], []);
    const [segment] = dispositionSegment(rc, ledger);
    expect(segment?.text).toContain('gitops/memory-limit-raise（config_resource）');
    expect(segment?.text).not.toContain('release-to-serving-version');
    expect(segment?.text).not.toContain(PROVIDER);
  });
});
