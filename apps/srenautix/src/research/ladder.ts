import type { ConclusionLevel, ConsistencyDetail, Incident } from '@srenautix/contract';
import type { Ledger, LedgerEntry } from './ledger.js';

// 结论阶梯（DESIGN §7.3）。evidence_consistent 只能由代码判定，四个条件同时满足：
// 1. 支持卡的实体在假设的范围内；
// 2. 支持卡异常的起始时间不晚于症状起始时间加容差；
// 3. 该机制所需的信号上没有相反的正常卡；
// 4. 至少检验并排除过一个竞争假设，并且没有竞争假设同样处于支持状态（ADR 0124）。
// 只读工具结果由小模型判定的卡可以支持 likely，不能单独支撑 evidence_consistent。
// 模型在 conclude 弃权、由代码按账本选中的假设（ADR 0120）最高为 likely；只有成员告警支持的假设（ADR 0122）为 likely。
// 每个条件的依据写进 consistency_detail（ADR 0125），通知与 issue 据此逐项说明档位。

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
  /** 选中了假设时给出；没有选中假设时为 null */
  detail: ConsistencyDetail | null;
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

/** 竞争假设中执行过检查或已被推翻的 */
function testedCompetitors(ledger: Ledger, chosen: LedgerEntry): string[] {
  return ledger
    .competitors(chosen)
    .filter((e) => e.status === 'refuted' || (e.status === 'inconclusive' && e.checksRun > 0))
    .map((e) => e.id)
    .sort();
}

function detailOf(
  ledger: Ledger,
  chosen: LedgerEntry,
  incident: Incident,
  chosenBy: 'model' | 'ledger' | null,
): ConsistencyDetail {
  const support = ledger.supportCards(chosen);
  const rule = support.filter((c) => c.judgedBy === 'rule');
  const onsets = rule
    .filter((c) => c.result.anomaly_started_at !== null && c.result.anomaly_started_at !== undefined)
    .map((c) => ({ ref: c.ref, at: c.result.anomaly_started_at as string }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.ref.localeCompare(b.ref, 'en', { numeric: true }));
  return {
    support_refs: rule.map((c) => c.ref),
    model_judged_refs: support.filter((c) => c.judgedBy === 'model').map((c) => c.ref),
    support_alerts: ledger.supportAlerts(chosen),
    onset: onsets[0] ?? null,
    symptom_onset_at: new Date(symptomOnset(incident)).toISOString(),
    tolerance_seconds: ONSET_TOLERANCE_MS / 1000,
    contrary_refs: ledger.contraryCards(chosen).map((c) => c.ref),
    tested_competitors: testedCompetitors(ledger, chosen),
    supported_competitors: ledger
      .supportedCompetitors(chosen)
      .map((e) => e.id)
      .sort(),
    chosen_by: chosenBy ?? 'model',
  };
}

export function judgeLadder(
  ledger: Ledger,
  chosen: LedgerEntry | null,
  incident: Incident,
  hasHypotheses: boolean,
  chosenBy: 'model' | 'ledger' | null = 'model',
): LadderResult {
  if (!chosen) {
    return { level: hasHypotheses ? 'inconclusive' : 'undetermined', consistency: NONE, detail: null, notes: [] };
  }
  const detail = detailOf(ledger, chosen, incident, chosenBy);
  const notes: string[] = [];
  const support = ledger.supportCards(chosen);
  if (support.length === 0) {
    const alerts = ledger.supportAlerts(chosen);
    if (alerts.length > 0) {
      // 只有成员告警支持：告警规则判定的异常可以支撑 likely，不能支撑 evidence_consistent（ADR 0122）
      return {
        level: 'likely',
        consistency: { ...NONE, competitor_tested: ledger.competitorTested(chosen) },
        detail,
        notes: [`假设 ${chosen.id} 只有成员告警支持（${alerts.join('、')}），没有范围内的异常卡`],
      };
    }
    return {
      level: 'inconclusive',
      consistency: NONE,
      detail,
      notes: [`假设 ${chosen.id} 没有范围内的异常卡或成员告警支持`],
    };
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
    notes.push(`假设 ${chosen.id} 的机制信号上有相反的正常卡：${detail.contrary_refs.join('、')}`);
  }
  if (!consistency.competitor_tested) {
    const rivals = detail.supported_competitors;
    notes.push(
      rivals.length
        ? `假设 ${chosen.id} 的竞争假设 ${rivals.join('、')} 同样处于支持状态，检查没有区分它们`
        : `假设 ${chosen.id} 没有检验并排除任何竞争假设`,
    );
  }
  const all = Object.values(consistency).every(Boolean);
  // 模型弃权、由代码按账本选中的结论最高为 likely（ADR 0120）
  if (all && chosenBy === 'ledger') {
    notes.push(`假设 ${chosen.id} 满足 evidence_consistent 的四个条件，但模型弃权、由代码按账本选中，档位为 likely`);
    return { level: 'likely', consistency, detail, notes };
  }
  return { level: all ? 'evidence_consistent' : 'likely', consistency, detail, notes };
}
