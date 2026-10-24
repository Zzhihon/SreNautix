// 领域的诊断卡与份额卡按行得到逻辑实体（契约 2.28.0，ADR 0146 §1.3、§2.2）：卡片在组件上执行一次之后，
// 在同一份判定输入上对 rows_from 引用的每条序列求 key、display、labels、when 与 share。

import { evaluateCardRows, type CompiledExpr, type JudgeInput } from '../judge/card.js';
import type { PackSet } from '../pack/compile.js';
import type { CompiledContribution, CompiledDiagnostic, CompiledEntityRows } from '../pack/domains.js';

export interface EntityRow {
  /** 逻辑实体类型，例如 pg_statement */
  type: string;
  /** EntityRows.key 的结果：实体键中类型之后、组件之内的部分 */
  key: string;
  display: string | null;
  labels: Record<string, string>;
  /** 诊断卡：when 的结果；份额卡为 null */
  hit: boolean | null;
  /** 份额卡：share 的结果（0 到 1）；诊断卡为 null */
  share: number | null;
}

export interface DomainRows {
  kind: 'diagnostic' | 'contribution';
  item: CompiledDiagnostic | CompiledContribution;
  /** 有 entities 时按行得到的实体：诊断卡命中的在前，份额卡按份额降序，最多 limit 个 */
  rows: EntityRow[];
  /** 没有 entities 的份额卡：卡片实体的份额（share 不填为 1）；其余为 null */
  share: number | null;
}

/** 领域里的诊断卡或份额卡 */
export function domainItem(
  set: PackSet,
  domain: string,
  id: string,
): { kind: 'diagnostic'; item: CompiledDiagnostic } | { kind: 'contribution'; item: CompiledContribution } {
  const d = set.domains.get(domain);
  if (!d) {
    throw new Error(`没有领域 ${domain}`);
  }
  const diag = d.diagnostics.find((x) => x.id === id);
  if (diag) {
    return { kind: 'diagnostic', item: diag };
  }
  const contrib = d.contribution.find((x) => x.id === id);
  if (contrib) {
    return { kind: 'contribution', item: contrib };
  }
  throw new Error(`领域 ${domain} 没有诊断卡或份额卡 ${id}`);
}

const str = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : typeof v === 'string'
      ? v
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);

const clamp01 = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;

function rowsOf(set: PackSet, card: string, rows: CompiledEntityRows, input: JudgeInput): EntityRow[] {
  const e = set.cards.get(card)!;
  const exprs: Record<string, CompiledExpr> = { key: rows.key };
  if (rows.display) {
    exprs.display = rows.display;
  }
  if (rows.when) {
    exprs.when = rows.when;
  }
  if (rows.share) {
    exprs.share = rows.share;
  }
  for (const [k, v] of Object.entries(rows.labels)) {
    exprs[`label:${k}`] = v;
  }
  const out = evaluateCardRows(e.compiled, input, rows.rowsFrom, exprs).rows.flatMap((r) => {
    const key = str(r.values.key);
    if (key === null || key === '') {
      return [];
    }
    const labels: Record<string, string> = {};
    for (const k of Object.keys(rows.labels)) {
      const v = str(r.values[`label:${k}`]);
      if (v !== null) {
        labels[k] = v;
      }
    }
    return [
      {
        type: rows.type,
        key,
        display: str(r.values.display),
        labels,
        hit: rows.when ? r.values.when === true : null,
        share: rows.share ? clamp01(r.values.share) : null,
      },
    ];
  });
  // 同一个键出现多次（例如同一语句在多个角色下）时保留第一个
  const seen = new Set<string>();
  const unique = out.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
  unique.sort((a, b) =>
    rows.share
      ? (b.share ?? -1) - (a.share ?? -1) || a.key.localeCompare(b.key)
      : Number(b.hit) - Number(a.hit) || a.key.localeCompare(b.key),
  );
  return unique.slice(0, rows.limit);
}

/**
 * 在卡片的判定输入（runCard 结果的 judgeInput）上求一张诊断卡或份额卡的实体。卡片必须是这一项引用的卡
 */
export function domainRows(set: PackSet, domain: string, id: string, card: string, input: JudgeInput): DomainRows {
  const found = domainItem(set, domain, id);
  if (found.item.card !== card) {
    throw new Error(`领域 ${domain} 的 ${id} 引用卡片 ${found.item.card}，不是 ${card}`);
  }
  const rows = found.item.entities ? rowsOf(set, card, found.item.entities, input) : [];
  let share: number | null = null;
  if (found.kind === 'contribution' && !found.item.entities) {
    const expr = found.item.share;
    share = expr
      ? clamp01(evaluateCardRows(set.cards.get(card)!.compiled, input, null, {}, { share: expr }).scalars.share)
      : 1;
  }
  return { kind: found.kind, item: found.item, rows, share };
}
