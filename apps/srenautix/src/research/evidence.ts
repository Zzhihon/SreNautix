import type { ChangeEvent, EntityRef, EvidenceResult, IncidentMember } from '@srenautix/contract';
import { tryNodeKey } from '@srenautix/core';

// 一次研判运行内的证据编号（契约 EvidenceRef）：card:<n> 指证据卡结果（运行开始时已有的卡在前，区分性检查产生的卡在后），
// alert:<n> 指成员告警，change:<n> 指关联的变更。编号到定义与实体的映射写入研判清单的 evidence_map。
// 证据簿不依赖事件（ADR 0146 §2.7）：事件研判由 research/incident.ts 的 incidentBook 填入阶段 A 的卡、
// 仍在事件中的成员告警与变更；主动优化填入诊断卡、份额卡与变更，没有告警。

/** 证据簿开始时的内容 */
export interface BookInput {
  /** 已有的证据卡，按 ref 编号（card:<n>） */
  cards: readonly EvidenceResult[];
  /** 告警，按顺序编号为 alert:<n> */
  alerts: readonly IncidentMember[];
  /** 研判对象本身的变更，按顺序编号为 change:<n> */
  changes: readonly ChangeEvent[];
  /** 同一时段触及范围、但不属于研判对象的变更，接在 changes 后面编号，related 标出它们 */
  relatedChanges: readonly ChangeEvent[];
}

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
  /** 区分性检查产生的卡：执行的查询模板或卡片检查 id（ADR 0133 按它判断检查测的信号）；阶段 A 的卡为 null */
  check: string | null;
}

export class EvidenceBook {
  private readonly cards = new Map<string, CardEntry>();
  private readonly alerts = new Map<string, IncidentMember>();
  private readonly changes = new Map<string, ChangeEvent>();
  private next = 1;

  constructor(input: BookInput) {
    for (const r of input.cards) {
      this.addCard(r, null, 'rule', r.ref);
    }
    input.alerts.forEach((m, i) => this.alerts.set(`alert:${i + 1}`, m));
    input.changes.forEach((ch, i) => this.changes.set(`change:${i + 1}`, ch));
    // 相关变更接在研判对象的变更后面编号；related 标出它们不在研判对象里
    const n = input.changes.length;
    input.relatedChanges.forEach((ch, i) => {
      this.changes.set(`change:${n + i + 1}`, ch);
      this.related.add(`change:${n + i + 1}`);
    });
  }

  /** 不在事件里的相关变更的引用 */
  readonly related = new Set<string>();

  private addCard(
    result: EvidenceResult,
    hypothesisId: string | null,
    judgedBy: 'rule' | 'model',
    ref?: string,
    check: string | null = null,
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
      check,
    };
    this.cards.set(r, entry);
    return entry;
  }

  /** 加入一张区分性检查产生的卡，分配下一个编号；check 是执行的查询模板、卡片检查或工具 */
  addCheckCard(
    result: EvidenceResult,
    hypothesisId: string,
    judgedBy: 'rule' | 'model',
    check: string | null = null,
  ): CardEntry {
    return this.addCard(result, hypothesisId, judgedBy, undefined, check);
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

  /**
   * 进入提示词、有错误样例并且取得了日志行的卡（ADR 0177）：动态枚举 sample_refs，假设的 mechanism_refs 只能引用它们
   */
  sampleRefs(): string[] {
    return this.promptCards()
      .filter((c) => (c.result.samples?.lines ?? 0) > 0)
      .map((c) => c.ref);
  }

  evidenceMap(): Array<{ ref: string; target: string }> {
    return [
      ...this.allCards.map((c) => ({ ref: c.ref, target: `${c.result.card_id}@${c.component ?? ''}` })),
      ...this.alertEntries.map(([ref, m]) => ({ ref, target: m.alert_id })),
      ...this.changeEntries.map(([ref, ch]) => ({ ref, target: ch.change_id })),
    ];
  }
}
