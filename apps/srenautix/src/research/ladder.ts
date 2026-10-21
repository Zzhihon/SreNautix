import type { ConclusionLevel, Incident } from '@srenautix/contract';
import type { Ledger, LedgerEntry } from './ledger.js';

// 结论阶梯（DESIGN §7.3）。evidence_consistent 只能由代码判定，四个条件同时满足：
// 1. 支持卡的实体在假设的范围内；
// 2. 支持卡异常的起始时间不晚于症状起始时间加容差；
// 3. 该机制所需的信号上没有相反的正常卡；
// 4. 至少检验过一个竞争假设。
// 只读工具结果由小模型判定的卡可以支持 likely，不能单独支撑 evidence_consistent。
// 模型在 conclude 弃权、由代码按账本选中的假设（ADR 0120）最高为 likely。

export const ONSET_TOLERANCE_MS = 2 * 60_000;

export interface Consistency {
  entity_in_scope: boolean;
  onset_precedes_symptom: boolean;
  no_contrary_normal: boolean;
  competitor_tested: boolean;
}

export interface LadderResult {
  level: ConclusionLevel;
  consistency: Consistency;
  notes: string[];
}

/** 症状起始时间：最早触发的 symptom 角色成员告警；没有症状告警时取事件首次触发时间 */
export function symptomOnset(incident: Incident): number {
  const symptoms = incident.members.filter((m) => m.role === 'symptom').map((m) => Date.parse(m.starts_at));
  return symptoms.length ? Math.min(...symptoms) : Date.parse(incident.first_firing_at);
}

const NONE: Consistency = {
  entity_in_scope: false,
  onset_precedes_symptom: false,
  no_contrary_normal: false,
  competitor_tested: false,
};

export function judgeLadder(
  ledger: Ledger,
  chosen: LedgerEntry | null,
  incident: Incident,
  hasHypotheses: boolean,
  chosenBy: 'model' | 'ledger' | null = 'model',
): LadderResult {
  if (!chosen) {
    return { level: hasHypotheses ? 'inconclusive' : 'undetermined', consistency: NONE, notes: [] };
  }
  const notes: string[] = [];
  const support = ledger.supportCards(chosen);
  if (support.length === 0) {
    return { level: 'inconclusive', consistency: NONE, notes: [`假设 ${chosen.id} 没有范围内的异常卡支持`] };
  }
  const ruleSupport = support.filter((c) => c.judgedBy === 'rule');
  const onset = symptomOnset(incident);
  const timely = ruleSupport.filter((c) => {
    const t = c.result.anomaly_started_at;
    return t !== null && t !== undefined && Date.parse(t) <= onset + ONSET_TOLERANCE_MS;
  });
  const consistency: Consistency = {
    entity_in_scope: ruleSupport.length > 0,
    onset_precedes_symptom: timely.length > 0,
    no_contrary_normal: ledger.contraryCards(chosen).length === 0,
    competitor_tested: ledger.competitorTested(chosen),
  };
  if (ruleSupport.length === 0) {
    notes.push(`假设 ${chosen.id} 的支持卡都由模型判定，不能单独支撑 evidence_consistent`);
  }
  if (ruleSupport.length > 0 && timely.length === 0) {
    notes.push(
      `假设 ${chosen.id} 的支持卡异常起始时间晚于症状起始时间加 ${ONSET_TOLERANCE_MS / 60_000} 分钟，或无法确定`,
    );
  }
  if (!consistency.no_contrary_normal) {
    notes.push(
      `假设 ${chosen.id} 的机制信号上有相反的正常卡：${ledger
        .contraryCards(chosen)
        .map((c) => c.ref)
        .join('、')}`,
    );
  }
  if (!consistency.competitor_tested) {
    notes.push(`假设 ${chosen.id} 没有检验过任何竞争假设`);
  }
  const all = Object.values(consistency).every(Boolean);
  // 模型弃权、由代码按账本选中的结论最高为 likely（ADR 0120）
  if (all && chosenBy === 'ledger') {
    notes.push(`假设 ${chosen.id} 满足 evidence_consistent 的四个条件，但模型弃权、由代码按账本选中，档位为 likely`);
    return { level: 'likely', consistency, notes };
  }
  return { level: all ? 'evidence_consistent' : 'likely', consistency, notes };
}
