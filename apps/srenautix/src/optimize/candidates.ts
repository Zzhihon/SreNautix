import type { FindingEntity, FindingStatus, OptimizationCandidate } from '@srenautix/contract';

// 候选发现（ADR 0146 §2.2 第 3 步）：诊断卡在范围内的实体上执行，异常的（卡、实体）成为候选；份额卡给出每个候选在
// 指标中的份额。按“份额 × 差距”排序，前 3 个进入 hypothesize，其余写进输出的“未分析的候选”。
// 已有 fixed 状态的发现处于验证期内时不进入候选；被拒绝的发现在冷却期内、差距没有扩大 50% 以上时也不进入（G4 的前置）。

export const MAX_SELECTED = 3;
/** 冷却期内差距扩大到这个倍数以上时重新进入候选（ADR 0146 §2.5 G4） */
export const COOLDOWN_GAP_GROWTH = 1.5;

export interface DiagnosedEntity {
  finding: string;
  kind: string;
  entity: FindingEntity;
  component: string;
  diagnostic: string;
  card_ref: string;
  share: number | null;
  share_ref: string | null;
  gap: number | null;
}

/** 已保存的发现的状态（server.optimization_findings） */
export interface KnownFinding {
  status: FindingStatus;
  /** 被拒绝之后的冷却期限（毫秒） */
  cooldownUntil: number | null;
  /** 被拒绝时的差距 */
  gapAtRejection: number | null;
  /** fixed 之后的验证期限（毫秒）；没有验证期时为 null */
  verifyingUntil: number | null;
}

/** 排序得分：份额与差距都有时为乘积；缺一项时取另一项；都没有时为 0 */
export function candidateScore(share: number | null, gap: number | null): number {
  if (share !== null && gap !== null) {
    return share * gap;
  }
  return share ?? gap ?? 0;
}

export function rankCandidates(
  diagnosed: readonly DiagnosedEntity[],
  known: ReadonlyMap<string, KnownFinding>,
  now: number,
): OptimizationCandidate[] {
  // 同一发现由多张诊断卡命中时只保留得分最高的一条
  const best = new Map<string, DiagnosedEntity>();
  for (const d of diagnosed) {
    const cur = best.get(d.finding);
    if (!cur || candidateScore(d.share, d.gap) > candidateScore(cur.share, cur.gap)) {
      best.set(d.finding, d);
    }
  }
  const rows = [...best.values()].map((d) => {
    const k = known.get(d.finding);
    let skipped: OptimizationCandidate['skipped_reason'] = null;
    if (k?.status === 'fixed' && k.verifyingUntil !== null && k.verifyingUntil > now) {
      skipped = 'verifying';
    } else if (k?.status === 'verifying') {
      skipped = 'verifying';
    } else if (
      k?.status === 'rejected' &&
      k.cooldownUntil !== null &&
      k.cooldownUntil > now &&
      !(k.gapAtRejection !== null && d.gap !== null && d.gap >= k.gapAtRejection * COOLDOWN_GAP_GROWTH)
    ) {
      skipped = 'cooldown';
    } else if (k?.status === 'suppressed') {
      skipped = 'cooldown';
    }
    return { d, skipped, score: Math.max(0, candidateScore(d.share, d.gap)) };
  });
  rows.sort((a, b) => b.score - a.score || a.d.finding.localeCompare(b.d.finding));
  let selected = 0;
  return rows.map(({ d, skipped, score }) => {
    const take = skipped === null && selected < MAX_SELECTED;
    if (take) {
      selected++;
    }
    return {
      finding: d.finding,
      kind: d.kind,
      entity: d.entity,
      component: d.component,
      diagnostic: d.diagnostic,
      card_ref: d.card_ref,
      share: d.share,
      share_ref: d.share_ref,
      gap: d.gap,
      score,
      selected: take,
      skipped_reason: take ? null : (skipped ?? 'rank'),
    };
  });
}
