import type { EvalCase, EvidenceResult, ResearchOutput } from '@srenautix/contract';
import { resolveCards } from '../remediation/admission.js';

// 评测的机制与证据两个评分轴（ADR 0180）：
// - 机制命中：结论选中假设的 mechanism 经文本归一化后包含标准答案的每个必需关键词（一项是同义词数组时包含其中任一），
//   不包含任何排除关键词；
// - 证据扎根：结论引用的证据卡全部确实执行过，并且覆盖标准答案声明的每一项必需证据。
// 标准答案没有这些字段时，对应的轴不适用，不计入分母。

type Truth = EvalCase['truth'];

/** 机制断言的一项：关键词，或一组同义词（包含任一即可） */
export type MechanismExpect = NonNullable<Truth['mechanism_expect']>[number];
export type RequiredEvidence = NonNullable<Truth['required_evidence']>[number];

/**
 * 文本归一化：NFKC（全角字符转半角，例如全角数字与括号）、转小写、删除空白、连接号（各种横线）与连接符（下划线等）。
 * 模型的写法差异（"rate limit"、"rate-limit"、"Rate_Limit"、"５２４"）归一化后相同
 */
export function normalizeMechanism(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{Pd}\p{Pc}]+/gu, '');
}

const DIGIT = /[0-9]/;

/**
 * 归一化后的 text 是否包含归一化后的关键词。关键词以数字开头（结尾）时，命中位置之前（之后）的字符不能是数字：
 * "429" 不匹配 "14290"
 */
export function containsKeyword(text: string, keyword: string): boolean {
  const t = normalizeMechanism(text);
  const k = normalizeMechanism(keyword);
  if (!k.length) {
    throw new Error(`机制关键词归一化之后为空：${JSON.stringify(keyword)}`);
  }
  const leading = DIGIT.test(k[0] as string);
  const trailing = DIGIT.test(k[k.length - 1] as string);
  for (let i = t.indexOf(k); i >= 0; i = t.indexOf(k, i + 1)) {
    const before = i > 0 ? (t[i - 1] as string) : '';
    const after = t[i + k.length] ?? '';
    if ((leading && DIGIT.test(before)) || (trailing && DIGIT.test(after))) {
      continue;
    }
    return true;
  }
  return false;
}

/** 用例是否带机制断言（机制命中轴适用） */
export function hasMechanismAssertion(t: Truth): boolean {
  return (t.mechanism_expect?.length ?? 0) > 0 || (t.mechanism_forbid?.length ?? 0) > 0;
}

/** 用例是否声明了必需证据（证据扎根轴适用） */
export function hasRequiredEvidence(t: Truth): boolean {
  return (t.required_evidence?.length ?? 0) > 0;
}

/** 机制断言是否成立：没有机制文本（弃权、没有结论）时不成立 */
export function mechanismHit(mechanism: string | null | undefined, t: Truth): boolean {
  if (mechanism === null || mechanism === undefined) {
    return false;
  }
  const expect = t.mechanism_expect ?? [];
  const forbid = t.mechanism_forbid ?? [];
  return (
    expect.every((e) =>
      Array.isArray(e) ? e.some((k) => containsKeyword(mechanism, k)) : containsKeyword(mechanism, e),
    ) && !forbid.some((k) => containsKeyword(mechanism, k))
  );
}

/** 结论选中的假设；结论没有选中假设时为 null */
function chosenHypothesis(out: ResearchOutput): ResearchOutput['hypotheses'][number] | null {
  const id = out.conclusion.hypothesis_id;
  return id === null ? null : (out.hypotheses.find((h) => h.id === id) ?? null);
}

/** 结论选中假设的机制；没有选中假设时为 null */
export function conclusionMechanism(out: ResearchOutput): string | null {
  return chosenHypothesis(out)?.mechanism ?? null;
}

/** 结论引用的一张卡：研判运行内的引用、evidence_index 给出的 <card_id>@<组件>，以及是否确实执行过 */
export interface CitedCard {
  ref: string;
  target: string | null;
  /** 在研判运行的证据里找得到（阶段 A 卡或区分性检查产生的卡），并且不是数据源能力缺失 */
  executed: boolean;
}

/**
 * 结论引用的证据卡：选中假设的支持证据，加上结论阶梯给出的支持卡（规则判定与小模型判定），只取卡的引用。
 * 卡按研判运行时的证据簿解析（remediation/admission.ts 的 resolveCards，与自愈 PR 的准入相同）。
 * 没有选中假设时为空
 */
export function citedCards(out: ResearchOutput, stageACards: readonly EvidenceResult[]): CitedCard[] {
  const h = chosenHypothesis(out);
  if (!h) {
    return [];
  }
  const detail = out.conclusion.consistency_detail;
  const refs = [
    ...new Set([...h.supporting, ...(detail?.support_refs ?? []), ...(detail?.model_judged_refs ?? [])]),
  ].filter((r) => r.startsWith('card:'));
  const index = new Map((out.evidence_index ?? []).map((x) => [x.ref, x.target]));
  const cards = resolveCards(out, stageACards, refs);
  return refs.map((ref) => {
    const c = cards.get(ref) ?? null;
    return {
      ref,
      target: index.get(ref) ?? (c ? `${c.card_id}@` : null),
      executed: c !== null && c.display_state !== 'capability_missing',
    };
  });
}

/** 一张引用的卡是否满足一项必需证据：卡片全局键相同，给出组件时实体也相同 */
function satisfies(c: CitedCard, need: RequiredEvidence): boolean {
  if (!c.executed || c.target === null) {
    return false;
  }
  const at = c.target.indexOf('@');
  const card = at < 0 ? c.target : c.target.slice(0, at);
  const component = at < 0 ? '' : c.target.slice(at + 1);
  return card === need.card && (need.component === undefined || component === need.component);
}

/** 证据扎根：结论引用了卡、引用的卡全部确实执行过，并且覆盖每一项必需证据 */
export function evidenceGrounded(cited: readonly CitedCard[] | undefined, t: Truth): boolean {
  const cards = cited ?? [];
  if (!cards.length || cards.some((c) => !c.executed)) {
    return false;
  }
  return (t.required_evidence ?? []).every((need) => cards.some((c) => satisfies(c, need)));
}
