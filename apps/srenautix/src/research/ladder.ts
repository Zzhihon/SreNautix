import type { ConclusionLevel, ConsistencyDetail, Incident } from '@srenautix/contract';
import type { CardEntry } from './evidence.js';
import type { Ledger, LedgerEntry } from './ledger.js';

// 结论阶梯（DESIGN §7.3）。evidence_consistent 只能由代码判定，四个条件同时满足：
// 1. 支持卡的实体在假设的范围内；
// 2. 支持卡异常的起始时间不晚于症状起始时间加容差；
// 3. 该机制所需的信号上没有相反的正常卡；
// 4. 至少检验并排除过一个竞争假设，并且没有竞争假设同样处于支持状态（ADR 0124）。
// 只读工具结果由小模型判定的卡可以支持 likely，不能单独支撑 evidence_consistent。
// 模型在 conclude 弃权、由代码按账本选中的假设（ADR 0120）最高为 likely；只有成员告警支持的假设（ADR 0122）为 likely；
// 规则判定的假设（ADR 0178）为 likely。
// 选中的假设有相反证据时（自己的检查给出推翻结果，或异常出现时间晚于症状），无论由模型还是代码选中，档位最高为
// inconclusive（ADR 0134，contraryLimits）。
// 每个条件的依据写进 consistency_detail（ADR 0125），通知与 issue 据此逐项说明档位。

export const ONSET_TOLERANCE_MS = 2 * 60_000;

/** 结论假设的来源：模型选中；模型弃权时代码按账本选中（ADR 0120）；规则判定没有被推翻时由代码改选（ADR 0178） */
export type ChosenBy = 'model' | 'ledger' | 'rule';

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

/**
 * 选中假设的证据条件（ADR 0146 §2.7 从结论阶梯中拆出，事件与主动优化的阶梯共用）：支持卡（规则判定与模型判定）、
 * 支持的成员告警、规则判定的支持卡中最早的异常起始、相反的正常卡、竞争假设的检验情况。
 * 事件研判在它之上判定"异常起始不晚于症状"，主动优化判定差距与份额（optimize/ladder.ts）。
 */
export interface EvidenceConditions {
  support: CardEntry[];
  ruleSupport: CardEntry[];
  modelSupport: CardEntry[];
  supportAlerts: string[];
  /** 规则判定的支持卡中有异常起始时间的，按时间与编号排序 */
  onsets: Array<{ ref: string; at: string }>;
  contrary: CardEntry[];
  competitorTested: boolean;
  testedCompetitors: string[];
  supportedCompetitors: string[];
}

export function evidenceConditions(ledger: Ledger, chosen: LedgerEntry): EvidenceConditions {
  const support = ledger.supportCards(chosen);
  const ruleSupport = support.filter((c) => c.judgedBy === 'rule');
  const onsets = ruleSupport
    .filter((c) => c.result.anomaly_started_at !== null && c.result.anomaly_started_at !== undefined)
    .map((c) => ({ ref: c.ref, at: c.result.anomaly_started_at as string }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.ref.localeCompare(b.ref, 'en', { numeric: true }));
  return {
    support,
    ruleSupport,
    modelSupport: support.filter((c) => c.judgedBy === 'model'),
    supportAlerts: ledger.supportAlerts(chosen),
    onsets,
    contrary: ledger.contraryCards(chosen),
    competitorTested: ledger.competitorTested(chosen),
    testedCompetitors: testedCompetitors(ledger, chosen),
    supportedCompetitors: ledger
      .supportedCompetitors(chosen)
      .map((e) => e.id)
      .sort(),
  };
}

/**
 * 选中假设自己的检查给出推翻结果时的原因（ADR 0134 的第一项，见 contraryLimits）：针对它、实体在范围内、
 * 测的信号属于它的机制的检查卡判定为正常。没有时为 null
 */
export function ownRefutation(ledger: Ledger, chosen: LedgerEntry): string | null {
  const refuting = ledger.refutingChecks(chosen);
  return refuting.length
    ? `自己的检查给出推翻结果（${refuting.map((c) => `${c.ref} ${c.check ?? c.result.card_id}`).join('、')}）`
    : null;
}

function detailOf(
  ledger: Ledger,
  chosen: LedgerEntry,
  incident: Incident,
  chosenBy: ChosenBy | null,
): ConsistencyDetail {
  const e = evidenceConditions(ledger, chosen);
  return {
    support_refs: e.ruleSupport.map((c) => c.ref),
    model_judged_refs: e.modelSupport.map((c) => c.ref),
    support_alerts: e.supportAlerts,
    onset: e.onsets[0] ?? null,
    symptom_onset_at: new Date(symptomOnset(incident)).toISOString(),
    tolerance_seconds: ONSET_TOLERANCE_MS / 1000,
    contrary_refs: e.contrary.map((c) => c.ref),
    tested_competitors: e.testedCompetitors,
    supported_competitors: e.supportedCompetitors,
    chosen_by: chosenBy ?? 'model',
  };
}

export function judgeLadder(
  ledger: Ledger,
  chosen: LedgerEntry | null,
  incident: Incident,
  hasHypotheses: boolean,
  chosenBy: ChosenBy | null = 'model',
): LadderResult {
  if (!chosen) {
    return { level: hasHypotheses ? 'inconclusive' : 'undetermined', consistency: NONE, detail: null, notes: [] };
  }
  const detail = detailOf(ledger, chosen, incident, chosenBy);
  const notes: string[] = [];
  const support = ledger.supportCards(chosen);
  const capped = (r: LadderResult): LadderResult => {
    const why = contraryLimits(ledger, chosen, incident);
    if (why.length === 0 || r.level === 'inconclusive') {
      return r;
    }
    const by = chosenBy === 'ledger' ? '代码按账本选中的' : chosenBy === 'rule' ? '规则判定的' : '模型选中的';
    return {
      ...r,
      level: 'inconclusive',
      notes: [...r.notes, `${by}假设 ${chosen.id} ${why.join('；')}，档位由 ${r.level} 退回 inconclusive（ADR 0134）`],
    };
  };
  // 规则判定的假设（ADR 0178）：依据由领域包的确定性规则给出，档位为 likely，不能到 evidence_consistent；
  // 相反证据照样退回 inconclusive（ADR 0134）
  if (chosen.rule) {
    const ruleSupport = support.filter((c) => c.judgedBy === 'rule');
    const onset = symptomOnset(incident);
    return capped({
      level: 'likely',
      consistency: {
        entity_in_scope: ruleSupport.length > 0,
        onset_precedes_symptom: ruleSupport.some((c) => {
          const t = c.result.anomaly_started_at;
          return t !== null && t !== undefined && Date.parse(t) <= onset + ONSET_TOLERANCE_MS;
        }),
        no_contrary_normal: ledger.ruleRefutations(chosen).length === 0,
        competitor_tested: ledger.competitorTested(chosen),
      },
      detail,
      notes: [`假设 ${chosen.id} 是规则判定（${chosen.rule.rule_id}），档位最高为 likely（ADR 0178）`],
    });
  }
  if (support.length === 0) {
    const alerts = ledger.supportAlerts(chosen);
    if (alerts.length > 0) {
      // 只有成员告警支持：告警规则判定的异常可以支撑 likely，不能支撑 evidence_consistent（ADR 0122）
      return capped({
        level: 'likely',
        consistency: { ...NONE, competitor_tested: ledger.competitorTested(chosen) },
        detail,
        notes: [`假设 ${chosen.id} 只有成员告警支持（${alerts.join('、')}），没有范围内的异常卡`],
      });
    }
    const changes = ledger.supportChanges(chosen);
    if (changes.length > 0) {
      // 只有退役变更支持（ADR 0161）：与只有成员告警支持相同，可以支撑 likely，不能支撑 evidence_consistent
      return capped({
        level: 'likely',
        consistency: { ...NONE, competitor_tested: ledger.competitorTested(chosen) },
        detail,
        notes: [`假设 ${chosen.id} 只有退役变更支持（${changes.join('、')}），没有范围内的异常卡`],
      });
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
    return capped({ level: 'likely', consistency, detail, notes });
  }
  return capped({ level: all ? 'evidence_consistent' : 'likely', consistency, detail, notes });
}

/**
 * 最低取证集合（ADR 0153）：成员告警的 required_cards 有没有得出结论的卡（阶段 A 与区分性检查都没有补上）时，
 * 研判看不到区分原因所需的证据，档位只能是 undetermined。gaps 为 missingRequired 的说明
 */
export function requiredCap(r: LadderResult, gaps: readonly string[]): LadderResult {
  if (!gaps.length || r.level === 'undetermined') {
    return r;
  }
  return {
    ...r,
    level: 'undetermined',
    notes: [...r.notes, `最低取证集合没有覆盖（${gaps.join('；')}），档位由 ${r.level} 改为 undetermined（ADR 0153）`],
  };
}

/**
 * 有相反证据时档位最高为 inconclusive（ADR 0134），满足任一项即限制，返回原因：
 * - 选中假设自己的检查给出推翻结果：针对它、实体在范围内、测的信号属于它的机制的检查卡判定为正常（ADR 0133 的
 *   `refutingChecks`；成员上的这类卡在有支持证据时不推翻假设，但同样限制档位）；
 * - 异常出现时间晚于症状：事件有 symptom 角色的成员告警，规则判定的支持卡中有异常起始时间的，最早的也晚于最早的
 *   症状告警加容差。起始时间都未知、或事件没有症状告警时不限制（由 onset_precedes_symptom 记为不满足）。
 */
export function contraryLimits(ledger: Ledger, chosen: LedgerEntry, incident: Incident): string[] {
  const out: string[] = [];
  const own = ownRefutation(ledger, chosen);
  if (own) {
    out.push(own);
  }
  // 只和真实的症状比：事件没有 symptom 角色的成员告警时，symptomOnset 退回事件首次触发时间，那可能是更早一段的
  // cause 或 change 告警，不能据此说异常晚于症状
  if (!incident.members.some((m) => m.role === 'symptom')) {
    return out;
  }
  const symptom = symptomOnset(incident);
  const onsets = ledger
    .supportCards(chosen)
    .filter((c) => c.judgedBy === 'rule' && c.result.anomaly_started_at)
    .map((c) => ({ ref: c.ref, at: Date.parse(c.result.anomaly_started_at as string) }))
    .sort((a, b) => a.at - b.at);
  const first = onsets[0];
  if (first && first.at > symptom + ONSET_TOLERANCE_MS) {
    out.push(
      `支持卡最早的异常起始（${first.ref}，${new Date(first.at).toISOString()}）晚于症状起始 ${new Date(symptom).toISOString()} 加 ${ONSET_TOLERANCE_MS / 60_000} 分钟`,
    );
  }
  return out;
}
