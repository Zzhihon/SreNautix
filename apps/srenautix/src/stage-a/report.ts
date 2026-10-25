import { randomUUID } from 'node:crypto';
import type { Alert, Disposition, EvidenceResult, Incident, StageAReport } from '@srenautix/contract';
import { evidenceFingerprint } from '@srenautix/core';
import { changeNotes } from '../changes/notes.js';
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
}

/**
 * 确定性的处置判断（DESIGN §7.1）：
 * ignore：命中抑制规则、领域包的排除规则，或者只有 forecast 和长期告警；
 * act：有动作明确的规则提议；escalate：critical 且有歧义，或者观测失明；undetermined：其余情况。
 */
export function disposition(i: DispositionInput): {
  disposition: Disposition;
  reason: StageAReport['disposition_reason'];
} {
  if (i.incident.suppressed) {
    return { disposition: 'ignore', reason: 'suppressed' };
  }
  if (i.excludedBy) {
    return { disposition: 'ignore', reason: 'pack_exclude' };
  }
  const members = new Set(i.incident.members.filter((m) => m.left_version === null).map((m) => m.alert_id));
  const own = i.alerts.filter((a) => members.has(a.alert_id));
  if (own.length > 0 && own.every((a) => a.classification.role === 'forecast' || a.classification.chronic)) {
    return { disposition: 'ignore', reason: 'forecast_or_chronic_only' };
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
    // 计划内的退役与尚未同步的提交写在后面（ADR 0161）
    const notes = changeNotes(c).map((n) => n.text);
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
