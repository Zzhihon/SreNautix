import type { EvidenceControlResult, EvidenceControls } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { commonCauseCheck, controlCap } from '../../src/research/common-cause.js';
import { incidentBook } from '../../src/research/incident.js';
import { judgeLadder } from '../../src/research/ladder.js';
import { Ledger } from '../../src/research/ledger.js';
import { researchCase, stageA, stageACards } from '../support/scenario.js';

// 共因约束（ADR 0179）：假设把根因放在故障对象之外时，按故障对象的卡上的对照结果检验。约束只读 controls.results，
// 与对照对象的选择方式无关：对照多数异常不推翻，多数正常推翻，对照不足时档位最高为 inconclusive。

const PG = 'StatefulSet:shop/postgres';
const API = 'Deployment:shop/api';

const control = (
  subject: string,
  verdict: EvidenceControlResult['verdict'],
  pickedBy: EvidenceControlResult['picked_by'] = 'top_n',
): EvidenceControlResult => ({
  subject,
  picked_by: pickedBy,
  volume: 100,
  verdict,
  display_state: verdict,
  reason: {
    kind: verdict === 'undeterminable' ? 'no_data' : verdict === 'abnormal' ? 'rule' : 'all_clear',
    text: `${subject} ${verdict}`,
  },
  value: verdict === 'abnormal' ? '0.9' : '0.01',
  value_number: verdict === 'abnormal' ? 0.9 : 0.01,
  anomaly_started_at: null,
});

/** api 上的错误率卡（card:1，事件里 api 有 symptom 成员告警）带对照结果；假设 h1 的根因默认是 PG（api 依赖的共享组件） */
function setup(results: EvidenceControlResult[] | null, root = PG) {
  const [first, ...rest] = stageACards();
  const controls: EvidenceControls | null = results
    ? { method: 'entry_peers', by: 'target', subject: 'api', candidates: results.length, results }
    : null;
  const rc = researchCase({ stageA: stageA([{ ...first!, ...(controls ? { controls } : {}) }, ...rest]) });
  const book = incidentBook(rc);
  const ledger = new Ledger(book, rc.subgraph);
  ledger.merge(
    [
      {
        id: 'h1',
        parent_id: null,
        root_component: root,
        mechanism: '依赖的组件故障',
        supporting: ['card:2'],
        refuting: [],
      },
    ],
    [],
  );
  ledger.evaluate();
  const h1 = ledger.entries.get('h1')!;
  const ladder = judgeLadder(ledger, h1, rc.incident, true, 'model');
  return { book, ledger, h1, ladder };
}

describe('共因约束', () => {
  it('对照全异常：共因成立，假设保持支持，档位不变', () => {
    const { book, h1, ladder } = setup([
      control('p1', 'abnormal'),
      control('p2', 'abnormal'),
      control('p3', 'abnormal', 'sampled'),
    ]);
    expect(commonCauseCheck(book, h1)).toEqual({ state: 'holds', reason: null });
    expect(h1.status).toBe('supported');
    expect(['likely', 'evidence_consistent']).toContain(ladder.level);
    expect(controlCap(ladder, h1, book)).toEqual(ladder);
  });

  it('对照全正常：同一入口上的其他对象同时段没有失败，假设被推翻', () => {
    const { book, h1 } = setup([control('p1', 'normal'), control('p2', 'normal'), control('p3', 'normal', 'sampled')]);
    const c = commonCauseCheck(book, h1);
    expect(c.state).toBe('refuted');
    expect(c.reason).toMatch(/共因不成立/);
    expect(h1.status).toBe('refuted');
    expect(h1.reasons.at(-1)).toMatch(/对照对象 0 个异常、3 个正常、0 个无法判定/);
  });

  it('对照多数正常（一个异常、两个正常）推翻；异常与正常各半不推翻', () => {
    const mostly = setup([control('p1', 'abnormal'), control('p2', 'normal'), control('p3', 'normal', 'sampled')]);
    expect(mostly.h1.status).toBe('refuted');
    const half = setup([control('p1', 'abnormal'), control('p2', 'normal')]);
    expect(commonCauseCheck(half.book, half.h1).state).toBe('holds');
    expect(half.h1.status).toBe('supported');
  });

  it('部分对照对象无法判定：假设保持支持，档位最高为 inconclusive 并写依据', () => {
    const { book, h1, ladder } = setup([
      control('p1', 'abnormal'),
      control('p2', 'abnormal'),
      control('p3', 'undeterminable', 'sampled'),
    ]);
    expect(commonCauseCheck(book, h1).state).toBe('unavailable');
    expect(h1.status).toBe('supported');
    expect(['likely', 'evidence_consistent']).toContain(ladder.level);
    const capped = controlCap(ladder, h1, book);
    expect(capped.level).toBe('inconclusive');
    expect(capped.notes.at(-1)).toMatch(
      /部分对照对象无法判定.*档位由 (likely|evidence_consistent) 改为 inconclusive（ADR 0179）/,
    );
  });

  it('没有对照结果或全部无法判定：对照证据不足，档位最高为 inconclusive', () => {
    for (const results of [[], [control('p1', 'undeterminable'), control('p2', 'undeterminable')]]) {
      const { book, h1, ladder } = setup(results);
      expect(commonCauseCheck(book, h1).state).toBe('unavailable');
      expect(h1.status).toBe('supported');
      expect(controlCap(ladder, h1, book).level).toBe('inconclusive');
    }
  });

  it('故障对象的卡没有声明对照对象：不检验，档位不变', () => {
    const { book, h1, ladder } = setup(null);
    expect(commonCauseCheck(book, h1)).toEqual({ state: 'none', reason: null });
    expect(controlCap(ladder, h1, book)).toEqual(ladder);
  });

  it('假设的根因就是故障对象本身：单一对象故障，不按共因检验', () => {
    const { book, h1, ladder } = setup(
      [control('p1', 'normal'), control('p2', 'normal'), control('p3', 'normal', 'sampled')],
      API,
    );
    expect(commonCauseCheck(book, h1).state).toBe('none');
    expect(h1.status).not.toBe('refuted');
    expect(controlCap(ladder, h1, book)).toEqual(ladder);
  });

  it('没有选中假设或档位已经低于 likely：档位不变', () => {
    const { book, h1, ladder } = setup([control('p1', 'normal'), control('p2', 'normal')]);
    expect(controlCap(ladder, null, book)).toEqual(ladder);
    const low = { ...ladder, level: 'inconclusive' as const };
    expect(controlCap(low, h1, book)).toEqual(low);
  });
});
