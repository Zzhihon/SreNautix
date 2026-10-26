import { randomUUID } from 'node:crypto';
import type { Alert, ChangeEvent, Disposition, EvidenceResult, Incident, StageAReport } from '@srenautix/contract';
import { CHANGE_ONSET_TOLERANCE_MS, evidenceFingerprint } from '@srenautix/core';
import { isBusinessImpact, type AlertMatcher } from '../alerts/business-impact.js';
import { changeNotes } from '../changes/notes.js';
import { isRoutine } from './novelty.js';
import type { RequiredEvidence } from './required.js';

/** 至少这个比例的卡没有数据时判为观测失明（DESIGN §7.1）。 */
export const BLIND_RATIO = 0.5;

const NO_DATA_REASONS = new Set(['no_data', 'source_error', 'capability_missing', 'observability_gap']);

export function observabilityBlind(cards: readonly EvidenceResult[]): boolean {
  if (cards.length === 0) {
    return false;
  }
  const missing = cards.filter((c) => c.verdict === 'undeterminable' && NO_DATA_REASONS.has(c.reason.kind)).length;
  return missing / cards.length >= BLIND_RATIO;
}

export interface DispositionInput {
  incident: Incident;
  alerts: Alert[];
  cards: EvidenceResult[];
  /** 有动作明确的规则提议（策略检查通过）。 */
  ruleActions: number;
  /** 领域包排除规则命中的规则 id。 */
  excludedBy: string | null;
  /** 业务影响告警（notify.business_impact_alerts，ADR 0166）；为空时没有业务影响告警 */
  impactAlerts?: readonly AlertMatcher[];
}

/** 事件现有成员中的业务影响告警（ADR 0166），不论状态 */
function impactMembers(
  incident: Pick<Incident, 'members'>,
  alerts: readonly Alert[],
  matchers: readonly AlertMatcher[] | undefined,
): Alert[] {
  if (!matchers?.length) {
    return [];
  }
  const members = new Set(incident.members.filter((m) => m.left_version === null).map((m) => m.alert_id));
  return alerts.filter((a) => members.has(a.alert_id) && isBusinessImpact(a.labels, matchers));
}

/**
 * 触发中的业务影响告警（ADR 0163、0166）：事件的成员中状态为 firing、满足 notify.business_impact_alerts 的告警 id。
 * 没有匹配器时没有业务影响告警
 */
export function businessImpactAlerts(
  incident: Pick<Incident, 'members'>,
  alerts: readonly Alert[],
  matchers: readonly AlertMatcher[] | undefined,
): string[] {
  return impactMembers(incident, alerts, matchers)
    .filter((a) => a.status === 'firing')
    .map((a) => a.alert_id);
}

/**
 * 计划内退役（ADR 0167）：事件现有的每一条成员告警都由事件变更中一次带 planned_by 的退役（kind retire）解释，并且成员中
 * 没有业务影响告警（不论状态）。一条告警由退役解释：告警不早于退役时刻减去 CHANGE_ONSET_TOLERANCE_MS 开始，并且
 * 告警的 job 标签在退役带走的抓取 job（scrape_jobs）里，或告警的组件是被退役的工作负载（targets 中不是管理应用的那些）。
 * 成立时返回解释这些告警的退役变更，否则为 null
 */
export function plannedRetirement(
  incident: Pick<Incident, 'members' | 'changes'>,
  alerts: readonly Alert[],
  matchers: readonly AlertMatcher[] | undefined,
): ChangeEvent[] | null {
  const planned = incident.changes.filter((c) => c.kind === 'retire' && (c.planned_by?.length ?? 0) > 0);
  if (!planned.length) {
    return null;
  }
  const members = new Set(incident.members.filter((m) => m.left_version === null).map((m) => m.alert_id));
  const own = alerts.filter((a) => members.has(a.alert_id));
  if (!own.length || own.length !== members.size || impactMembers(incident, alerts, matchers).length) {
    return null;
  }
  const explains = (c: ChangeEvent, a: Alert): boolean => {
    if (Date.parse(a.starts_at) + CHANGE_ONSET_TOLERANCE_MS < Date.parse(c.time)) {
      return false;
    }
    const job = a.labels.job;
    if (job !== undefined && (c.scrape_jobs ?? []).includes(job)) {
      return true;
    }
    const managers = new Set(c.refs);
    return a.component !== null && c.targets.some((t) => t === a.component && !managers.has(t));
  };
  const used = new Set<ChangeEvent>();
  for (const a of own) {
    const c = planned.find((x) => explains(x, a));
    if (!c) {
      return null;
    }
    used.add(c);
  }
  return [...used];
}

/** 显示业务受影响的证据：判为异常、并且证据基线没有判为常态的卡（ADR 0153） */
export function impactEvidence(cards: readonly EvidenceResult[]): EvidenceResult[] {
  return cards.filter((c) => c.verdict === 'abnormal' && !isRoutine(c));
}

/**
 * 确定性的处置判断（DESIGN §7.1）：
 * ignore：命中抑制规则、领域包的排除规则、全部成员告警由计划内的退役解释（ADR 0167），或者只有 forecast 和长期告警；
 * 有触发中的业务影响告警、并且有异常卡时不给 ignore（ADR 0163、0166）；
 * act：有动作明确的规则提议；escalate：critical 且有歧义，或者观测失明；undetermined：其余情况。
 */
export function disposition(i: DispositionInput): {
  disposition: Disposition;
  reason: StageAReport['disposition_reason'];
} {
  const held =
    businessImpactAlerts(i.incident, i.alerts, i.impactAlerts).length > 0 && impactEvidence(i.cards).length > 0;
  if (!held) {
    if (i.incident.suppressed) {
      return { disposition: 'ignore', reason: 'suppressed' };
    }
    if (i.excludedBy) {
      return { disposition: 'ignore', reason: 'pack_exclude' };
    }
    if (plannedRetirement(i.incident, i.alerts, i.impactAlerts)) {
      return { disposition: 'ignore', reason: 'planned_retirement' };
    }
    const members = new Set(i.incident.members.filter((m) => m.left_version === null).map((m) => m.alert_id));
    const own = i.alerts.filter((a) => members.has(a.alert_id));
    if (own.length > 0 && own.every((a) => a.classification.role === 'forecast' || a.classification.chronic)) {
      return { disposition: 'ignore', reason: 'forecast_or_chronic_only' };
    }
  }
  if (i.ruleActions > 0) {
    return { disposition: 'act', reason: 'rule_action' };
  }
  if (observabilityBlind(i.cards)) {
    return { disposition: 'escalate', reason: 'observability_blind' };
  }
  if (i.incident.severity === 'critical' && i.incident.root.ambiguous) {
    return { disposition: 'escalate', reason: 'critical_ambiguous' };
  }
  return { disposition: 'undetermined', reason: 'default' };
}

/** 时间线摘要：成员告警的触发与恢复、关联变更、异常卡的起始时间，按时间排序。 */
export function timeline(incident: Incident, alerts: Alert[], cards: EvidenceResult[]): StageAReport['timeline'] {
  const members = new Map(incident.members.filter((m) => m.left_version === null).map((m) => [m.alert_id, m]));
  const out: StageAReport['timeline'] = [];
  alerts.forEach((a) => {
    if (!members.has(a.alert_id)) {
      return;
    }
    const n = [...members.keys()].indexOf(a.alert_id) + 1;
    out.push({ at: a.starts_at, kind: 'alert_firing', text: `${a.alertname} 触发`, ref: `alert:${n}` });
    if (a.ends_at) {
      out.push({ at: a.ends_at, kind: 'alert_resolved', text: `${a.alertname} 恢复`, ref: `alert:${n}` });
    }
  });
  incident.changes.forEach((c, k) => {
    // 计划内的退役与尚未同步的提交写在后面（ADR 0161）；之后是关联分级与依据、命中的仓库路径（ADR 0169）
    const notes = changeNotes(c).map((n) => n.text);
    const link = incident.change_links?.find((l) => l.change_id === c.change_id);
    if (link) {
      notes.push(`关联分级 ${link.grade}（依据：${link.basis.join('、')}${link.rollback ? '；回退' : ''}）`);
    }
    if (c.paths?.length) {
      notes.push(`命中路径 ${c.paths.join('、')}`);
    }
    out.push({
      at: c.time,
      kind: 'change',
      text: [`${c.source} ${c.kind} ${c.refs.join(' ')}`.trim(), ...notes].join('；'),
      ref: `change:${k + 1}`,
    });
  });
  for (const c of cards) {
    if (c.verdict === 'abnormal' && c.anomaly_started_at) {
      out.push({ at: c.anomaly_started_at, kind: 'card_abnormal', text: c.value ?? c.card_id, ref: c.ref });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function verdictFingerprint(cards: readonly EvidenceResult[]): string {
  return evidenceFingerprint(cards.map((c) => ({ card_id: c.card_id, entity: c.entity, verdict: c.verdict })));
}

export interface BuildInput extends DispositionInput {
  runbooks: string[];
  ruleProposalIds: string[];
  fingerprint: string;
  degraded: boolean;
  now: Date;
  /** 成员告警的最低取证集合与缺口（ADR 0153）；降级通道与没有领域包时不计算 */
  required?: RequiredEvidence[];
}

export function buildReport(b: BuildInput): StageAReport {
  const d = disposition(b);
  return {
    report_id: randomUUID(),
    incident_id: b.incident.incident_id,
    incident_version: b.incident.incident_version,
    disposition: d.disposition,
    disposition_reason: d.reason,
    candidates: b.incident.candidates,
    ambiguous: b.incident.root.ambiguous,
    cards: b.cards,
    evidence_fingerprint: b.fingerprint,
    observability_blind: observabilityBlind(b.cards),
    timeline: timeline(b.incident, b.alerts, b.cards),
    runbooks: b.runbooks,
    rule_proposals: b.ruleProposalIds,
    degraded: b.degraded,
    rendered_at: b.now.toISOString(),
    ...(b.required ? { required_evidence: b.required } : {}),
  };
}
