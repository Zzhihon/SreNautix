import type { ChangeEvent, EntityRef, EvidenceResult, IncidentMember } from '@srenautix/contract';
import { tryNodeKey } from '@srenautix/core';
import type { ResearchCase } from './types.js';

// 一次研判运行内的证据编号（契约 EvidenceRef）：card:<n> 指证据卡结果（阶段 A 的卡在前，区分性检查产生的卡在后），
// alert:<n> 指成员告警，change:<n> 指关联的变更。编号到定义与实体的映射写入研判清单的 evidence_map。

export function entityKey(e: EntityRef | null): string | null {
  if (!e) {
    return null;
  }
  return tryNodeKey(e.kind, e.namespace, e.name);
}

export interface CardEntry {
  ref: string;
  result: EvidenceResult;
  component: string | null;
  /** 区分性检查产生的卡：检查所针对的假设 */
  hypothesisId: string | null;
  /** 判定方式：领域包的 CEL 判定为 rule；只读工具结果由小模型判定为 model */
  judgedBy: 'rule' | 'model';
}

export class EvidenceBook {
  private readonly cards = new Map<string, CardEntry>();
  private readonly alerts = new Map<string, IncidentMember>();
  private readonly changes = new Map<string, ChangeEvent>();
  private next = 1;

  constructor(c: ResearchCase) {
    for (const r of c.stageA.cards) {
      this.addCard(r, null, 'rule', r.ref);
    }
    c.incident.members.filter((m) => m.left_version === null).forEach((m, i) => this.alerts.set(`alert:${i + 1}`, m));
    c.incident.changes.forEach((ch, i) => this.changes.set(`change:${i + 1}`, ch));
  }

  private addCard(
    result: EvidenceResult,
    hypothesisId: string | null,
    judgedBy: 'rule' | 'model',
    ref?: string,
  ): CardEntry {
    const r = ref ?? `card:${this.next}`;
    const m = /^card:(\d+)$/.exec(r);
    if (!m) {
      throw new Error(`证据卡引用不合法：${r}`);
    }
    if (this.cards.has(r)) {
      throw new Error(`证据卡引用重复：${r}`);
    }
    this.next = Math.max(this.next, Number(m[1]) + 1);
    const entry: CardEntry = {
      ref: r,
      result: { ...result, ref: r },
      component: entityKey(result.entity),
      hypothesisId,
      judgedBy,
    };
    this.cards.set(r, entry);
    return entry;
  }

  /** 加入一张区分性检查产生的卡，分配下一个编号 */
  addCheckCard(result: EvidenceResult, hypothesisId: string, judgedBy: 'rule' | 'model'): CardEntry {
    return this.addCard(result, hypothesisId, judgedBy);
  }

  card(ref: string): CardEntry | undefined {
    return this.cards.get(ref);
  }

  has(ref: string): boolean {
    return this.cards.has(ref) || this.alerts.has(ref) || this.changes.has(ref);
  }

  get allCards(): CardEntry[] {
    return [...this.cards.values()];
  }

  get alertEntries(): Array<[string, IncidentMember]> {
    return [...this.alerts.entries()];
  }

  get changeEntries(): Array<[string, ChangeEvent]> {
    return [...this.changes.entries()];
  }

  /** 本次运行中全部有效的证据引用（动态枚举 evidence_refs） */
  refs(): string[] {
    return [...this.cards.keys(), ...this.alerts.keys(), ...this.changes.keys()];
  }

  /** 进入提示词的卡：egress=never 的卡不出站 */
  promptCards(): CardEntry[] {
    return this.allCards.filter((c) => c.result.egress !== 'never');
  }

  evidenceMap(): Array<{ ref: string; target: string }> {
    return [
      ...this.allCards.map((c) => ({ ref: c.ref, target: `${c.result.card_id}@${c.component ?? ''}` })),
      ...this.alertEntries.map(([ref, m]) => ({ ref, target: m.alert_id })),
      ...this.changeEntries.map(([ref, ch]) => ({ ref, target: ch.change_id })),
    ];
  }
}
