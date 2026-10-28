import type { EvidenceControlResult, EvidenceResult } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { composeMessage } from '../../src/notify/compose.js';
import { releaseRolloutInput } from '../support/report-fixture.js';

// 群消息关键问题里的对照行（ADR 0179）：故障对象的卡上的对照结果，只写对象数与各结论的个数

const control = (subject: string, verdict: EvidenceControlResult['verdict']): EvidenceControlResult => ({
  subject,
  picked_by: 'top_n',
  volume: 100,
  verdict,
  display_state: verdict,
  reason: { kind: verdict === 'abnormal' ? 'rule' : 'all_clear', text: `${subject} ${verdict}` },
  value: '0.5',
  value_number: 0.5,
  anomaly_started_at: null,
});

function withControls(results: EvidenceControlResult[] | null) {
  const input = releaseRolloutInput();
  const used = [...input.stageA!.cards, ...(input.research!.output!.check_cards ?? [])].map((c) =>
    Number(c.ref.slice('card:'.length)),
  );
  const base = input.stageA!.cards[0]!;
  const card: EvidenceResult = {
    ...base,
    ref: `card:${Math.max(...used) + 1}`,
    verdict: 'abnormal',
    display_state: 'abnormal',
    ...(results
      ? { controls: { method: 'entry_peers', by: 'target', subject: 'up-0', candidates: results.length, results } }
      : {}),
  };
  const stage = { ...input.stageA!, cards: [...input.stageA!.cards, card] };
  return { ...input, stageA: stage, researchStageA: stage };
}

const keyIssue = (input: ReturnType<typeof withControls>) =>
  composeMessage(input)
    .message.sections.find((s) => s.kind === 'key_issue')!
    .blocks.map((b) => b.text)
    .join('\n');

describe('关键问题里的对照行', () => {
  it('机制之后写对照对象数与异常、正常、无法判定各几个', () => {
    const text = keyIssue(
      withControls([control('p1', 'abnormal'), control('p2', 'normal'), control('p3', 'undeterminable')]),
    );
    expect(text).toContain('对照：同一入口上的其他 3 个对象，1 个异常，1 个正常，1 个无法判定');
  });

  it('没有对照结果的卡不写对照行', () => {
    expect(keyIssue(withControls(null))).not.toContain('对照：');
  });
});
