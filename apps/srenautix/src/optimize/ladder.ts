import type { ConclusionLevel, FindingConclusion, OptimizationConsistency } from '@srenautix/contract';
import { evidenceConditions, ownRefutation } from '../research/ladder.js';
import type { Ledger, LedgerEntry } from '../research/ledger.js';

// 优化结论阶梯（ADR 0146 §2.4）：档位名称与事件研判相同，条件按优化场景定义，全部由代码判定。
// evidence_consistent 同时满足：
// ① 差距成立（§2.2）；
// ② 至少一张份额卡表明这个发现的实体占指标的比例不低于 gates.min_share（compute 领域按实体自身计算，份额为 1）；
//    趋势触发的目标另外要求机制的变化起点不晚于指标恶化起点加 1 小时；
// ③ 机制信号上没有相反的正常卡（ADR 0133）；
// ④ 检验并排除过竞争假设（同一发现上的其他假设，ADR 0124）。
// likely：有支持卡但不满足全部条件；inconclusive：有假设、没有支持卡，或撞上相反证据的上限（ADR 0134）；
// undetermined：没有假设。模型弃权、由代码按账本选中的假设最高为 likely（ADR 0120）。

export const TREND_ONSET_TOLERANCE_MS = 3_600_000;

/** 发现的份额卡：证据引用 → 份额 */
export interface ShareCard {
  ref: string;
  share: number;
}

export interface FindingLadderInput {
  finding: string;
  /** 运行级的差距是否成立 */
  gapHolds: boolean;
  shareCards: readonly ShareCard[];
  minShare: number;
  /** 趋势触发的目标：指标恶化的起点（毫秒）；其余目标为 null */
  trendOnset: number | null;
  chosen: LedgerEntry | null;
  chosenBy: 'model' | 'ledger';
  /** 这个发现上是否有假设 */
  hasHypotheses: boolean;
  note: string | null;
  undeterminedReason: string | null;
}

export interface FindingLadderResult {
  conclusion: FindingConclusion;
  notes: string[];
}

export function judgeFinding(ledger: Ledger, f: FindingLadderInput): FindingLadderResult {
  const notes: string[] = [];
  const consistency: OptimizationConsistency = {
    gap_holds: f.gapHolds,
    share_holds: false,
    trend_onset: f.trendOnset === null ? null : false,
    no_contrary_normal: false,
    competitor_tested: false,
  };
  const shares = f.shareCards.filter((c) => c.share >= f.minShare);
  consistency.share_holds = shares.length > 0;
  const base = {
    finding: f.finding,
    hypothesis_id: f.chosen?.id ?? null,
    share_refs: shares.map((c) => c.ref),
    chosen_by: f.chosenBy,
    note: f.note,
  };
  if (!f.chosen) {
    const level: ConclusionLevel = f.hasHypotheses ? 'inconclusive' : 'undetermined';
    return {
      conclusion: {
        ...base,
        level,
        consistency,
        support_refs: [],
        contrary_refs: [],
        undetermined_reason: f.undeterminedReason ?? (f.hasHypotheses ? '没有选中假设' : '这个发现上没有假设'),
      },
      notes,
    };
  }
  const e = evidenceConditions(ledger, f.chosen);
  consistency.no_contrary_normal = e.contrary.length === 0;
  consistency.competitor_tested = e.competitorTested;
  if (f.trendOnset !== null) {
    const first = e.onsets[0];
    consistency.trend_onset = first !== undefined && Date.parse(first.at) <= f.trendOnset + TREND_ONSET_TOLERANCE_MS;
  }
  const support = e.ruleSupport;
  let level: ConclusionLevel;
  if (e.support.length === 0) {
    level = 'inconclusive';
    notes.push(`发现 ${short(f.finding)} 的假设 ${f.chosen.id} 没有范围内的支持卡`);
  } else {
    const all =
      consistency.gap_holds &&
      consistency.share_holds &&
      consistency.trend_onset !== false &&
      consistency.no_contrary_normal &&
      consistency.competitor_tested &&
      support.length > 0;
    level = all ? 'evidence_consistent' : 'likely';
    if (!consistency.gap_holds) {
      notes.push(`发现 ${short(f.finding)}：差距不成立`);
    }
    if (!consistency.share_holds) {
      notes.push(`发现 ${short(f.finding)}：没有份额卡表明实体的份额不低于 ${f.minShare}`);
    }
    if (consistency.trend_onset === false) {
      notes.push(`发现 ${short(f.finding)}：机制的变化起点晚于指标恶化起点加 1 小时，或无法确定`);
    }
    if (!consistency.no_contrary_normal) {
      notes.push(`发现 ${short(f.finding)}：机制信号上有相反的正常卡 ${e.contrary.map((c) => c.ref).join('、')}`);
    }
    if (!consistency.competitor_tested) {
      notes.push(`发现 ${short(f.finding)}：没有检验并排除同一发现上的竞争假设`);
    }
    if (support.length === 0) {
      notes.push(`发现 ${short(f.finding)}：支持卡都由模型判定，不能单独支撑 evidence_consistent`);
    }
    if (level === 'evidence_consistent' && f.chosenBy === 'ledger') {
      level = 'likely';
      notes.push(
        `发现 ${short(f.finding)}：满足 evidence_consistent 的条件，但模型弃权、由代码按账本选中，档位为 likely`,
      );
    }
    // 相反证据的上限（ADR 0134）：自己的检查给出推翻结果时档位最高为 inconclusive
    const own = ownRefutation(ledger, f.chosen);
    if (own) {
      notes.push(
        `发现 ${short(f.finding)} 的假设 ${f.chosen.id} ${own}，档位由 ${level} 退回 inconclusive（ADR 0134）`,
      );
      level = 'inconclusive';
    }
  }
  return {
    conclusion: {
      ...base,
      level,
      consistency,
      support_refs: e.support.map((c) => c.ref),
      contrary_refs: e.contrary.map((c) => c.ref),
      undetermined_reason: null,
    },
    notes,
  };
}

/**
 * 模型弃权时代码按账本代选（ADR 0120 的优化版本）：这个发现上处于支持状态的假设只有一个、并且有范围内的支持卡
 */
export function ledgerPickInGroup(ledger: Ledger, group: string): LedgerEntry | null {
  const supported = ledger.ranked().filter((e) => e.group === group && e.status === 'supported');
  if (supported.length !== 1) {
    return null;
  }
  const pick = supported[0] as LedgerEntry;
  return ledger.supportCards(pick).length > 0 ? pick : null;
}

const short = (fp: string) => fp.slice(7, 19);
