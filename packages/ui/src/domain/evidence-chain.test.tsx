import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createI18n } from '../i18n';
import { evidence, incident, researchOutput } from '../test/fixtures';
import { renderUi } from '../test/render';
import { EvidenceList } from './EvidenceCard';
import { buildEvidenceChain, cardCharts, formatValue, keyMoments, mergeEvidence } from './evidence-chain';
import { EvidenceNavProvider } from './evidence-nav';
import { HypothesisList } from './HypothesisList';

const fmt = createI18n('zh-CN', 'Asia/Shanghai').fmt;
const routine = {
  status: 'routine' as const,
  rule: 'abnormal_share' as const,
  value: 0.94,
  comparisons: [
    {
      offset: '1h',
      window: { from: '2026-10-19T04:48:00Z', to: '2026-10-19T05:28:00Z' },
      verdict: 'abnormal' as const,
      value: 0.84,
    },
    {
      offset: '7d',
      window: { from: '2026-10-12T05:48:00Z', to: '2026-10-12T06:28:00Z' },
      verdict: 'normal' as const,
      value: 0.52,
    },
  ],
  samples: 29,
  abnormal_share: 0.83,
  range: null,
  reason: '基线样本 29 个，其中异常 24 个：属于常态',
};

// 研判输出（fixtures）：h1 是结论采用的假设，支持卡 card:1；h2 被 card:3 推翻
const cards = [
  evidence({ ref: 'card:1', display_state: 'abnormal' }),
  evidence({ ref: 'card:2', display_state: 'abnormal', unit: 'percent', novelty: routine }),
  evidence({ ref: 'card:3', display_state: 'normal' }),
  evidence({ ref: 'card:4', display_state: 'abnormal' }),
  evidence({ ref: 'card:5', display_state: 'undeterminable', reason: { kind: 'no_data', text: '没有样本' } }),
  evidence({ ref: 'card:6', display_state: 'normal' }),
];

describe('证据链', () => {
  it('卡按在论证里的位置分组，并标出引用它的假设', () => {
    const chain = buildEvidenceChain(cards, researchOutput());
    expect(chain.groups.map((g) => [g.id, g.cards.map((r) => r.ref)])).toEqual([
      ['for', ['card:1']],
      ['others', ['card:3']],
      ['abnormal', ['card:4']],
      ['routine', ['card:2']],
      ['undetermined', ['card:5']],
      ['normal', ['card:6']],
    ]);
    expect(chain.leader?.id).toBe('h1');
    expect(chain.roles.get('card:1')).toMatchObject([{ kind: 'supports', leader: true }]);
    expect(chain.roles.get('card:3')).toMatchObject([{ kind: 'refutes', leader: false }]);
  });

  it('没有研判输出时只按判定与是否常态分组', () => {
    expect(buildEvidenceChain(cards, null).groups.map((g) => [g.id, g.cards.length])).toEqual([
      ['abnormal', 2],
      ['routine', 1],
      ['undetermined', 1],
      ['normal', 2],
    ]);
  });

  it('研判明细的卡在前，快照只补没有的卡', () => {
    const withSeries = evidence({ ref: 'card:1', display_state: 'abnormal' });
    const bare = evidence({ ref: 'card:1', display_state: 'abnormal', series: [] });
    const extra = evidence({ ref: 'card:9', display_state: 'normal' });
    expect(mergeEvidence([withSeries], undefined, [bare, extra])).toEqual([withSeries, extra]);
  });

  it('关键时刻按时间排列，最早的异常带上它的卡', () => {
    const inc = incident({ first_firing_at: '2026-10-19T06:18:00Z', ended_at: '2026-10-19T06:40:00Z' });
    const early = evidence({ ref: 'card:7', display_state: 'abnormal', anomaly_started_at: '2026-10-19T06:10:00Z' });
    const m = keyMoments([...cards, early], inc, '2026-10-19T06:22:10Z');
    expect(m.map((x) => x.kind)).toEqual(['onset', 'firing', 'concluded', 'resolved']);
    expect(m[0]?.card?.ref).toBe('card:7');
  });

  it('同一个查询的序列画在一张图里，按取值不同的标签命名；即时查询的单点序列不画图', () => {
    const points = (v: number): Array<[number, number | null]> => [
      [1760854080, v],
      [1760854140, v],
    ];
    const r = evidence({
      ref: 'card:1',
      display_state: 'abnormal',
      unit: 'percent',
      threshold: 0.9,
      series: [
        { ref: 'mem', labels: { pod: 'gateway-0', namespace: 'prod' }, points: points(0.6) },
        { ref: 'mem', labels: { pod: 'gateway-1', namespace: 'prod' }, points: points(0.95) },
        { ref: 'oom', labels: { pod: 'gateway-0' }, points: [[1760854140, 1]] },
        { ref: 'restarts', labels: {}, points: points(41) },
      ],
    });
    expect(cardCharts(r)).toMatchObject([
      { ref: 'mem', scaled: true, folded: 0, lines: [{ label: 'gateway-1' }, { label: 'gateway-0' }] },
      // 单位是 percent，取值 41 不是比例：阈值线与单位不适用于这张图
      { ref: 'restarts', scaled: false, lines: [{ label: 'restarts' }] },
    ]);
  });

  it('数值按卡片的单位写', () => {
    expect(formatValue(0.9, 'percent', fmt)).toBe('90%');
    expect(formatValue(3 * 1024 ** 3, 'bytes', fmt)).toBe('3 GiB');
    expect(formatValue(0.25, 'seconds', fmt)).toBe('250 ms');
    expect(formatValue(7856336065.62, 'none', fmt)).toBe('7.86B');
  });
});

describe('证据标签页', () => {
  const inc = incident({ first_firing_at: '2026-10-19T06:18:00Z' });

  it('先给出结论的证据链，再按分组列出卡；正常与常态的卡收成一行', () => {
    renderUi(
      <EvidenceList
        incidentRef="x"
        runId="6c5d4e3f-2a1b-4c0d-8e9f-a0b1c2d3e4f5"
        results={cards}
        output={researchOutput()}
        incident={inc}
        concludedAt="2026-10-19T06:22:10Z"
      />,
    );
    const summary = screen.getByRole('region', { name: '证据链' });
    expect(within(summary).getByText('根因 pg-main')).toBeTruthy();
    // 最早的异常与结论的支持证据都引用 card:1
    expect(within(summary).getAllByRole('button', { name: /card:1/ })).toHaveLength(2);
    expect(within(summary).getByText('告警触发')).toBeTruthy();
    const names = screen
      .getAllByRole('region')
      .map((s) => s.getAttribute('aria-label'))
      .filter((n) => n !== '证据链');
    expect(names).toEqual([
      '结论依据的证据',
      '其他假设用到的证据',
      '没有被假设引用的异常',
      '平时也成立的异常',
      '无法判定',
      '检查过，没有异常',
    ]);
    const open = (ref: string) => document.getElementById(ref)?.hasAttribute('data-open');
    expect([open('card-1'), open('card-4'), open('card-2'), open('card-3'), open('card-6')]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    // 引用它的假设写在卡上
    expect(within(document.getElementById('card-1') as HTMLElement).getByText('结论采用')).toBeTruthy();
  });

  it('点击证据链里的引用展开对应的卡；展开的常态卡显示与平时的对比', () => {
    renderUi(<EvidenceList incidentRef="x" runId={null} results={cards} output={researchOutput()} incident={inc} />);
    const card = document.getElementById('card-2') as HTMLElement;
    expect(card.hasAttribute('data-open')).toBe(false);
    fireEvent.click(within(card).getByRole('button', { name: /展开/ }));
    expect(card.hasAttribute('data-open')).toBe(true);
    expect(within(card).getByText('平时也这样')).toBeTruthy();
    const compare = within(card).getByRole('list', { name: '与事件之前的同长度时段对比' });
    expect([...compare.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '7 天前52%',
      '1 小时前84%',
      '本次94%',
    ]);
  });

  it('假设标签页里的引用写出卡的标题，点击后交给宿主打开这张卡', () => {
    const opened: string[] = [];
    renderUi(
      <EvidenceNavProvider nav={{ card: (ref) => cards.find((r) => r.ref === ref), open: (ref) => opened.push(ref) }}>
        <HypothesisList output={researchOutput()} />
      </EvidenceNavProvider>,
    );
    fireEvent.click(screen.getAllByRole('button', { name: /主库内存达到上限.*card:1/ })[0] as HTMLElement);
    expect(opened).toEqual(['card:1']);
  });
});
