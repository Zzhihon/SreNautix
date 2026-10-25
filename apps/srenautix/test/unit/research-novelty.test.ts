import type { EvidenceNovelty, EvidenceResult } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { noveltyConfig, noveltyOptions } from '../../src/config/novelty.js';
import { cardsOf } from '../../src/remediation/render.js';
import { deriveDisposition } from '../../src/research/disposition.js';
import { incidentBook } from '../../src/research/incident.js';
import { judgeLadder, requiredCap } from '../../src/research/ladder.js';
import { Ledger } from '../../src/research/ledger.js';
import { incidentSegments } from '../../src/research/prompt.js';
import {
  decideNovelty,
  DEFAULT_NOVELTY,
  isRoutine,
  rankValue,
  sampleOffsets,
  type NoveltySample,
} from '../../src/stage-a/novelty.js';
import { missingRequired, requiredEvidence } from '../../src/stage-a/required.js';
import { incident, researchCase, stageA, stageACards } from '../support/scenario.js';

// 证据基线与最低取证集合（ADR 0153）

const HOUR = 3_600_000;
const W = { from: '2026-09-01T09:00:00Z', to: '2026-09-01T09:40:00Z' };

function samples(spec: Array<[number, EvidenceResult['verdict'], number | null]>): NoveltySample[] {
  return spec.map(([hours, verdict, value]) => ({
    offset: { ms: hours * HOUR, comparison: hours === 1 ? '1h' : hours === 24 ? '24h' : hours === 168 ? '7d' : null },
    window: W,
    verdict,
    value,
  }));
}

/** 7 天内每 6 小时一个样本与 1 小时对照：verdictOf、valueOf 按提前的小时数给出 */
function week(verdictOf: (h: number) => EvidenceResult['verdict'], valueOf: (h: number) => number | null) {
  const hours = [1, ...Array.from({ length: 28 }, (_, i) => (i + 1) * 6)];
  return samples(hours.map((h) => [h, verdictOf(h), valueOf(h)]));
}

const routine = (n: Partial<EvidenceNovelty> = {}): EvidenceNovelty => ({
  status: 'routine',
  rule: 'abnormal_share',
  value: 7,
  comparisons: [],
  samples: 29,
  abnormal_share: 0.6,
  range: null,
  reason: '常态',
  ...n,
});

describe('证据基线的判定', () => {
  it('样本时段：对照时段与均匀样本去重，与事件窗口重叠的不取', () => {
    const all = sampleOffsets(DEFAULT_NOVELTY, 40 * 60_000);
    expect(all.length).toBe(29);
    expect(all.filter((s) => s.comparison).map((s) => s.comparison)).toEqual(['1h', '24h', '7d']);
    expect(all.map((s) => s.ms / HOUR).slice(0, 4)).toEqual([1, 6, 12, 18]);
    // 2 小时窗口：1 小时对照会与事件窗口重叠
    expect(sampleOffsets(DEFAULT_NOVELTY, 2 * HOUR)[0]!.ms).toBe(6 * HOUR);
  });

  it('得出结论的样本少于 min_samples 时为 unknown', () => {
    const n = decideNovelty(
      { value_number: 5, unit: 'count' },
      samples([
        [1, 'abnormal', 3],
        [24, 'undeterminable', null],
      ]),
      DEFAULT_NOVELTY,
      false,
    );
    expect(n).toMatchObject({ status: 'unknown', samples: 1, rule: null });
  });

  it('条件在多数基线时段同样成立：abnormal_share', () => {
    const n = decideNovelty(
      { value_number: 7, unit: 'count' },
      week(
        (h) => (h % 12 === 0 ? 'normal' : 'abnormal'),
        (h) => h % 40,
      ),
      DEFAULT_NOVELTY,
      false,
    );
    expect(n).toMatchObject({ status: 'routine', rule: 'abnormal_share' });
    expect(n.comparisons.map((c) => c.offset)).toEqual(['1h', '24h', '7d']);
  });

  it('条件在基线时段出现过、主值在分位区间内：within_range；条件从没出现过时不按主值判为常态', () => {
    // 每 5 个样本有 1 个异常，主值 0–28
    const sometimes = week(
      (h) => (h % 30 === 0 ? 'abnormal' : 'normal'),
      (h) => h % 29,
    );
    expect(decideNovelty({ value_number: 7, unit: 'count' }, sometimes, DEFAULT_NOVELTY, false)).toMatchObject({
      status: 'routine',
      rule: 'within_range',
    });
    // 主值落在区间之外
    expect(decideNovelty({ value_number: 80, unit: 'count' }, sometimes, DEFAULT_NOVELTY, false).status).toBe('novel');
    // 卡片按别的条件判定（例如超时次数），主值只是展示用的排队数：基线全部正常时不按主值判为常态
    const never = week(
      () => 'normal',
      (h) => h % 29,
    );
    expect(decideNovelty({ value_number: 7, unit: 'count' }, never, DEFAULT_NOVELTY, false)).toMatchObject({
      status: 'novel',
      abnormal_share: 0,
    });
    // 14 个样本里只有一个时段出现过一次很高的值（49），其余为 0–2：区间不被它撑大，主值 6 明显异常
    const once = samples([
      ...Array.from({ length: 13 }, (_, i): [number, EvidenceResult['verdict'], number] => [
        (i + 1) * 6,
        'normal',
        i % 3,
      ]),
      [24 * 4, 'abnormal', 49],
    ]);
    const n = decideNovelty({ value_number: 6, unit: 'count' }, once, DEFAULT_NOVELTY, false);
    expect(n).toMatchObject({ status: 'novel', range: { low: 0, high: 2 } });
  });

  it('不插值的分位数向中位数一侧取整', () => {
    expect(rankValue([0, 1, 2, 3, 49], 0.95)).toBe(3);
    expect(rankValue([0, 1, 2, 3, 49], 0.05)).toBe(1);
    expect(rankValue([5], 0.95)).toBe(5);
  });

  it('计数与速率类主值与对照时段最大值相差不到 3 倍：below_ratio；其他单位不适用', () => {
    // 区间很窄（大多数样本为 0），主值落在区间之外；对照时段 24h 为 4
    const spec = week(
      (h) => (h === 24 ? 'abnormal' : 'normal'),
      (h) => (h === 24 ? 4 : 0),
    );
    expect(decideNovelty({ value_number: 10, unit: 'count' }, spec, DEFAULT_NOVELTY, false)).toMatchObject({
      status: 'routine',
      rule: 'below_ratio',
    });
    expect(decideNovelty({ value_number: 13, unit: 'count' }, spec, DEFAULT_NOVELTY, false).status).toBe('novel');
    expect(decideNovelty({ value_number: 10, unit: 'percent' }, spec, DEFAULT_NOVELTY, false).status).toBe('novel');
  });

  it('配置：默认值即 ADR 0153 的取值；min_samples 大于样本总数时拒绝', () => {
    expect(noveltyOptions(noveltyConfig.parse({}))).toEqual(DEFAULT_NOVELTY);
    expect(() => noveltyOptions(noveltyConfig.parse({ samples: 2, min_samples: 8 }))).toThrow(/min_samples/);
  });
});

describe('常态的卡在研判中的处理', () => {
  // 场景：PVC 卡（card:2）是 postgres 假设唯一的支持证据
  function setup(mark: boolean) {
    const cards = stageACards().map((c) => (c.ref === 'card:2' && mark ? { ...c, novelty: routine() } : c));
    const rc = researchCase({ stageA: stageA(cards) });
    const book = incidentBook(rc);
    return { rc, book, ledger: new Ledger(book, rc.subgraph) };
  }
  const h1 = {
    id: 'h1',
    parent_id: null,
    root_component: 'StatefulSet:shop/postgres',
    mechanism: '数据卷写满',
    supporting: ['card:2'],
    refuting: [],
  };

  it('账本：常态的卡不计入支持，模型引用为支持时删除并写明', () => {
    const base = setup(false);
    base.ledger.merge([h1], []);
    base.ledger.evaluate();
    expect(base.ledger.entries.get('h1')!.status).toBe('supported');

    const s = setup(true);
    const notes: string[] = [];
    s.ledger.merge([h1], notes);
    s.ledger.evaluate();
    const e = s.ledger.entries.get('h1')!;
    expect(e.supporting).toEqual([]);
    expect(notes.join('\n')).toMatch(/card:2 与基线相比属于常态（ADR 0153）/);
    expect(s.ledger.supportCards(e)).toEqual([]);
    // 支持只剩常态的卡：根因自身的卡（card:3）全部正常，假设被推翻
    expect(e.status).toBe('refuted');
    expect(judgeLadder(s.ledger, e, s.rc.incident, true).level).toBe('inconclusive');
  });

  it('提示词：有常态的卡时多一段说明，卡上带 novelty；没有时与原来相同', () => {
    // 无法与基线比较的卡不带 novelty
    const unknown = stageACards().map((c) =>
      c.ref === 'card:2' ? { ...c, novelty: routine({ status: 'unknown', rule: null }) } : c,
    );
    const u = researchCase({ stageA: stageA(unknown) });
    const plain = researchCase({ stageA: stageA(stageACards()) });
    const join = (rc: typeof u) =>
      incidentSegments(rc, incidentBook(rc), 200_000, null)
        .map((x) => x.text)
        .join('\n');
    expect(join(u)).toBe(join(plain));
    const text = (mark: boolean) => {
      const s = setup(mark);
      return incidentSegments(s.rc, s.book, 200_000, null)
        .map((x) => x.text)
        .join('\n');
    };
    expect(text(false)).not.toMatch(/证据基线/);
    const marked = text(true);
    expect(marked).toMatch(/## 证据基线与最低取证集合（代码判定）/);
    expect(marked).toMatch(/"routine_cards":\["card:2"\]/);
    expect(marked).toMatch(/"novelty":\{"status":"routine"/);
  });

  it('处置：常态的异常卡按正常计；修复模板与规则提议的上下文里也按正常给出', () => {
    const cards = stageACards().map((c) =>
      c.verdict === 'abnormal' ? { ...c, novelty: routine() } : c,
    ) as EvidenceResult[];
    const book = incidentBook(researchCase({ stageA: stageA(cards) }));
    const r = deriveDisposition({
      model: 'escalate',
      incident: incident(),
      stageA: stageA(cards),
      level: 'inconclusive',
      root: null,
      ruleSupport: 0,
      proposals: 0,
      cards: book.allCards,
      facts: null,
    });
    expect(r).toMatchObject({ disposition: 'ignore', basis: 'evidence_normal' });
    expect(r.notes[0]).toMatch(/card:1、card:2 为常态/);
    expect(isRoutine(cards[0]!)).toBe(true);
    expect(cardsOf(cards)['pvc/capacity/used_ratio']).toMatchObject({ verdict: 'normal', display_state: 'normal' });
  });
});

describe('最低取证集合', () => {
  const PVC_ENTITY = { cluster_id: 'test', kind: 'PersistentVolumeClaim', namespace: 'shop', name: 'data-postgres-0' };
  const alert = {
    alert_id: 'a1',
    alertname: 'KubePersistentVolumeFillingUp',
    entity: { ...PVC_ENTITY, uid: null },
    classification: { catalog_entry: 'pvc/filling-up' },
  } as unknown as Parameters<typeof requiredEvidence>[1][number];
  const required = (entry: string) =>
    entry === 'pvc/filling-up' ? ['pvc/capacity/used_ratio', 'pvc/capacity/inodes'] : [];

  it('阶段 A 记录缺口；区分性检查补上后缺口消失', () => {
    const cards = stageACards();
    const r = requiredEvidence(required, [alert], cards);
    expect(r).toEqual([
      {
        alert_id: 'a1',
        alertname: 'KubePersistentVolumeFillingUp',
        catalog_entry: 'pvc/filling-up',
        entity: { ...PVC_ENTITY, uid: null },
        cards: ['pvc/capacity/used_ratio', 'pvc/capacity/inodes'],
        missing: ['pvc/capacity/inodes'],
      },
    ]);
    expect(missingRequired(r, cards)).toEqual([
      'KubePersistentVolumeFillingUp（PersistentVolumeClaim:shop/data-postgres-0）缺少 pvc/capacity/inodes',
    ]);
    const inodes = { ...cards[1]!, card_id: 'pvc/capacity/inodes', verdict: 'normal' as const };
    expect(missingRequired(r, [...cards, inodes])).toEqual([]);
    // 无法判定的卡不算覆盖
    expect(missingRequired(r, [...cards, { ...inodes, verdict: 'undeterminable' as const }])).toHaveLength(1);
  });

  it('研判：有缺口时档位只能是 undetermined，处置不能是 act 或 ignore', () => {
    const cards = stageACards();
    const rc = researchCase({ stageA: stageA(cards) });
    const book = incidentBook(rc);
    const ledger = new Ledger(book, rc.subgraph);
    ledger.merge(
      [
        {
          id: 'h1',
          parent_id: null,
          root_component: 'StatefulSet:shop/postgres',
          mechanism: '数据卷写满',
          supporting: ['card:2'],
          refuting: [],
        },
      ],
      [],
    );
    ledger.evaluate();
    const ladder = judgeLadder(ledger, ledger.entries.get('h1')!, rc.incident, true);
    expect(ladder.level).toBe('likely');
    const gaps = [
      'KubePersistentVolumeFillingUp（PersistentVolumeClaim:shop/data-postgres-0）缺少 pvc/capacity/inodes',
    ];
    const capped = requiredCap(ladder, gaps);
    expect(capped.level).toBe('undetermined');
    expect(capped.notes.at(-1)).toMatch(/档位由 likely 改为 undetermined（ADR 0153）/);
    expect(requiredCap(ladder, [])).toBe(ladder);
    const base = {
      incident: incident(),
      stageA: stageA(cards),
      level: capped.level,
      root: 'StatefulSet:shop/postgres',
      ruleSupport: 1,
      proposals: 1,
      cards: book.allCards,
      facts: null,
      gaps,
    };
    expect(deriveDisposition({ ...base, model: 'act' })).toMatchObject({ disposition: 'escalate' });
    const ignore = deriveDisposition({ ...base, model: 'ignore', proposals: 0 });
    expect(ignore.disposition).toBe('escalate');
    expect(ignore.notes[0]).toMatch(/最低取证集合没有覆盖/);
  });
});
