import type { EvidenceControlResult } from '@srenautix/contract';
import type { CardEntry, EvidenceBook } from './evidence.js';
import type { LadderResult } from './ladder.js';
import type { LedgerEntry } from './ledger.js';

// 共因约束（ADR 0179）：假设把根因放在故障对象之外的组件上（例如共享的入口或出口），而故障对象的异常卡声明了对照对象
// （controls）时，假设必须由对照结果支持。约束只读 EvidenceResult.controls.results，与对照对象的选择方式无关：
// - 对照对象多数异常（异常数不少于有结论的对象数的一半）：共因成立，不改变假设；
// - 对照对象多数正常：同一入口上的其他对象同时段没有失败，假设被推翻；
// - 没有对照结果，或者有对象无法判定：对照证据不足，结论档位最高为 inconclusive。

export type ControlState = 'none' | 'holds' | 'refuted' | 'unavailable';

export interface ControlCheck {
  state: ControlState;
  /** 写入账本依据与 validation_notes 的说明；没有约束时为 null */
  reason: string | null;
}

const NONE: ControlCheck = { state: 'none', reason: null };

/** 故障对象的卡：判为异常、带对照结果、实体是事件中有成员告警的组件，并且不是假设的根因本身 */
function subjectCards(book: EvidenceBook, e: LedgerEntry): CardEntry[] {
  const withAlerts = new Set(book.alertEntries.flatMap(([, m]) => (m.component !== null ? [m.component] : [])));
  return book.allCards.filter(
    (c) =>
      c.result.verdict === 'abnormal' &&
      c.result.controls !== undefined &&
      c.component !== null &&
      c.component !== e.rootComponent &&
      withAlerts.has(c.component),
  );
}

function tally(results: readonly EvidenceControlResult[]): {
  abnormal: number;
  normal: number;
  undeterminable: number;
} {
  const t = { abnormal: 0, normal: 0, undeterminable: 0 };
  for (const r of results) {
    t[r.verdict]++;
  }
  return t;
}

/** 假设的共因检验；规则判定的假设由领域包的规则确定，不在其中 */
export function commonCauseCheck(book: EvidenceBook, e: LedgerEntry): ControlCheck {
  if (e.rule) {
    return NONE;
  }
  const cards = subjectCards(book, e);
  if (!cards.length) {
    return NONE;
  }
  const t = tally(cards.flatMap((c) => c.result.controls!.results));
  const known = t.abnormal + t.normal;
  const where = `假设 ${e.id} 的根因 ${e.rootComponent} 不是故障对象 ${[...new Set(cards.map((c) => c.component))].join('、')} 本身，按共因检验；对照对象 ${t.abnormal} 个异常、${t.normal} 个正常、${t.undeterminable} 个无法判定（${cards.map((c) => c.ref).join('、')}）`;
  if (known === 0) {
    return { state: 'unavailable', reason: `${where}，没有对照对象得出结论` };
  }
  if (t.abnormal * 2 < known) {
    return { state: 'refuted', reason: `${where}，同一入口上的其他对象同时段多数正常，共因不成立` };
  }
  if (t.undeterminable > 0) {
    return { state: 'unavailable', reason: `${where}，部分对照对象无法判定` };
  }
  return { state: 'holds', reason: null };
}

/**
 * 按共因检验限制档位（ADR 0179）：对照证据不足时档位最高为 inconclusive。在规则判定改选之后、变更分级限制之后执行；
 * 档位已经低于 likely 时不变
 */
export function controlCap(r: LadderResult, chosen: LedgerEntry | null, book: EvidenceBook): LadderResult {
  if (!chosen || (r.level !== 'likely' && r.level !== 'evidence_consistent')) {
    return r;
  }
  const c = commonCauseCheck(book, chosen);
  if (c.state !== 'unavailable' && c.state !== 'refuted') {
    return r;
  }
  return {
    ...r,
    level: 'inconclusive',
    notes: [...r.notes, `${c.reason}，档位由 ${r.level} 改为 inconclusive（ADR 0179）`],
  };
}
