import type { EvidenceResult } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { mergeRunEvidence } from '../../src/incident/read.js';

// 研判的全部证据（模型所见）：阶段 A 的卡在前，区分性检查产生的卡在后；证据快照、实时重跑与研判明细共用

const card = (ref: string, card_id: string) => ({ ref, card_id }) as EvidenceResult;

describe('研判的全部证据', () => {
  it('阶段 A 的卡保留编号排在前面，检查卡排在后面', () => {
    const stageA = [card('card:1', 'workload/pod-restarts/memory'), card('card:2', 'workload/rollout/statefulset')];
    const checks = [card('card:3', 'check/h1/1')];
    expect(mergeRunEvidence(stageA, checks).map((c) => c.ref)).toEqual(['card:1', 'card:2', 'card:3']);
  });

  it('同一个引用只保留阶段 A 的卡', () => {
    const stageA = [card('card:1', 'workload/pod-restarts/memory')];
    const checks = [card('card:1', 'check/h1/1'), card('card:2', 'check/h2/2')];
    expect(mergeRunEvidence(stageA, checks).map((c) => c.card_id)).toEqual([
      'workload/pod-restarts/memory',
      'check/h2/2',
    ]);
  });

  it('没有阶段 A 报告时只有检查卡', () => {
    expect(mergeRunEvidence([], [card('card:1', 'check/h1/1')])).toHaveLength(1);
  });
});
