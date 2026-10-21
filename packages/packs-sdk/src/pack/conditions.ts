// 告警条件卡（ADR 0109）：从告警规则生成证据链，每个告警目录条目一张"告警条件"卡，作为该条目的主卡。
// - value：规则表达式本身；held：for > 0 时为 count_over_time((表达式)[for:1m])，等于 for 的分钟数表示条件在
//   (t - for, t] 的每分钟都成立，即告警在 t 已经触发；for 为 0 时只看 value；
// - 只看与实体对应的序列：条目 name_labels 中第一个出现在序列上的标签等于实体名，都不出现时整条序列都算
//   （与 pack test --alert-rules 的核对相同）；
// - inputs：表达式读取的原始序列是否存在（no_data 引用，都不存在时卡片无法判定）；缺失本身就是条件的表达式
//   （absent、absent_over_time）与不读任何序列的表达式（vector(1)）以抓取目标 up 是否存在代替；
// - 窗口与默认卡片窗口相同（首次触发前 30 分钟到之后 10 分钟），窗口内任一时刻告警已触发即判异常。

import type { AlertCatalogEntry, EvidenceChain, Signal } from '@srenautix/contract';
import { QuerySyntaxError, type PromqlEngine } from '@srenautix/integration-sdk';

export interface ConditionRule {
  alert: string;
  expr: string;
  /** Prometheus 时长；不写为 0 */
  for: string;
  /** 规则的静态标签（不含模板），条目的 match_labels 按它选规则 */
  labels: Record<string, string>;
  /** 规则来源，写进卡片说明 */
  source: string;
}

export interface ConditionPack {
  signals: Signal[];
  chains: EvidenceChain[];
  /** 条目 id → 对应的规则（同名告警的严重度变体没有按 match_labels 拆开时有多条） */
  ruleOf: Map<string, ConditionRule[]>;
  /** 没有任何目录条目对应的规则 */
  uncovered: ConditionRule[];
}

const SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** for 的分钟数；不是整分钟时报错（卡片以 1 分钟为步长求值） */
export function forMinutes(d: string): number {
  const parts = [...d.matchAll(/([0-9]+)(s|m|h|d|w)/g)];
  if (parts.map((p) => p[0]).join('') !== d) {
    throw new Error(`for 不是 Prometheus 时长：${d}`);
  }
  const s = parts.reduce((a, p) => a + Number(p[1]) * SECONDS[p[2]!]!, 0);
  if (s % 60 !== 0) {
    throw new Error(`for ${d} 不是整分钟`);
  }
  return s / 60;
}

/** 能按 PromQL 解析时为 promql，否则为 metricsql（vmalert 的 tlast_over_time 等） */
export function ruleDialect(engine: PromqlEngine, expr: string): 'promql' | 'metricsql' {
  try {
    engine.analyze(expr, 'promql');
    return 'promql';
  } catch (err) {
    if (!(err instanceof QuerySyntaxError)) {
      throw err;
    }
    engine.analyze(expr, 'metricsql');
    return 'metricsql';
  }
}

const q = (v: string) => JSON.stringify(v);

function inputsExpr(engine: PromqlEngine, expr: string, dialect: 'promql' | 'metricsql'): string {
  const a = engine.analyze(expr, dialect);
  const sels = [
    ...new Set(
      a.selectors.map(
        (s) =>
          `${s.metric}{${s.matchers
            .filter((m) => m.label !== '__name__')
            .map((m) => `${m.label}${m.op}${q(m.value)}`)
            .join(', ')}}`,
      ),
    ),
  ].sort();
  if (!sels.length || a.functions.some((f) => f === 'absent' || f === 'absent_over_time')) {
    return 'count(up)';
  }
  return sels.map((s) => `count(${s})`).join(' or ');
}

function filterCel(ref: string, nameLabels: string[]): string {
  const cond = nameLabels.reduceRight(
    (rest, l) => `(${q(l)} in s.labels ? s.labels[${q(l)}] == entity.name : ${rest})`,
    'true',
  );
  return `${ref}.filter(s, ${cond})`;
}

function snake(alert: string): string {
  return alert
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_.]+/g, '_');
}

/**
 * 条目对应的规则：告警名相同、match_labels 是规则静态标签的子集。同名告警的严重度变体没有按 match_labels 拆成
 * 不同条目时，条目对应其中的每一条，任何一条触发都是这个条目的告警在触发。没有对应的规则时报错
 */
export function rulesForCatalogEntry<R extends { alert: string; labels: Record<string, string> }>(
  rules: readonly R[],
  e: AlertCatalogEntry,
): R[] {
  const hits = rules.filter(
    (r) => r.alert === e.alertname && Object.entries(e.match_labels ?? {}).every(([k, v]) => r.labels[k] === v),
  );
  if (!hits.length) {
    throw new Error(`告警目录条目 ${e.id} 没有对应的 ${e.alertname} 规则`);
  }
  return hits;
}

/** 按目录条目生成条件卡；skip 中的条目（例如接入时丢弃的 Watchdog）不生成 */
export function generateConditionPack(
  engine: PromqlEngine,
  rules: readonly ConditionRule[],
  entries: readonly AlertCatalogEntry[],
  skip: ReadonlySet<string> = new Set(),
): ConditionPack {
  const ruleOf = new Map<string, ConditionRule[]>();
  for (const e of entries) {
    if (!skip.has(e.id)) {
      ruleOf.set(e.id, rulesForCatalogEntry(rules, e));
    }
  }
  const used = [...new Set([...ruleOf.values()].flat())];
  // 信号 id：告警名；同名规则（严重度或窗口不同的变体）按在规则文件中的顺序加序号
  const idOf = new Map(
    used.map((r) => {
      const same = rules.filter((x) => x.alert === r.alert);
      return [r, same.length > 1 ? `${snake(r.alert)}.${same.indexOf(r) + 1}` : snake(r.alert)];
    }),
  );
  const signals: Signal[] = [];
  for (const r of [...used].sort((a, b) => (idOf.get(a)! < idOf.get(b)! ? -1 : 1))) {
    const base = idOf.get(r)!;
    const dialect = ruleDialect(engine, r.expr);
    const alt = (expr: string) => (dialect === 'promql' ? { expr } : { expr, dialect });
    const minutes = forMinutes(r.for);
    signals.push({ id: `${base}.inputs`, kind: 'metrics', alternatives: [alt(inputsExpr(engine, r.expr, dialect))] });
    signals.push({ id: `${base}.value`, kind: 'metrics', alternatives: [alt(r.expr.trim())] });
    if (minutes > 0) {
      signals.push({
        id: `${base}.held`,
        kind: 'metrics',
        unit: 'count',
        alternatives: [alt(`count_over_time((\n${r.expr.trim()}\n)[${minutes}m:1m])`)],
      });
    }
  }

  const chains: EvidenceChain[] = [];
  for (const e of [...entries].filter((x) => ruleOf.has(x.id)).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const rs = ruleOf.get(e.id)!;
    const r = rs[0]!;
    const names = e.entity.name_labels ?? [];
    // 每条规则一组 value_<i>、held_<i>；inputs 取第一条规则（严重度变体读同样的序列）
    const refs: EvidenceChain['cards'][number]['refs'] = [
      { name: 'inputs', signal: `${idOf.get(r)!}.inputs`, mode: 'range' },
    ];
    const lets: Array<{ name: string; cel: string }> = [];
    const abnormal: Array<{ cel: string; say: { 'zh-CN': string; en: string } }> = [];
    rs.forEach((x, i) => {
      const base = idOf.get(x)!;
      const minutes = forMinutes(x.for);
      const variant = rs.length > 1 ? `（${x.labels.severity ?? i}）` : '';
      const variantEn = rs.length > 1 ? ` (${x.labels.severity ?? i})` : '';
      refs.push({ name: `value_${i}`, signal: `${base}.value`, mode: 'range', empty_is: 'normal' });
      lets.push(
        { name: `shown_${i}`, cel: filterCel(`value_${i}`, names) },
        { name: `peak_${i}`, cel: `count(shown_${i}) > 0 ? max(shown_${i}) : 0.0` },
      );
      if (minutes > 0) {
        refs.push({ name: `held_${i}`, signal: `${base}.held`, mode: 'range', empty_is: 'normal' });
        lets.push(
          { name: `mine_${i}`, cel: filterCel(`held_${i}`, names) },
          { name: `longest_${i}`, cel: `count(mine_${i}) > 0 ? max(mine_${i}) : 0.0` },
        );
        abnormal.push({
          cel: `count(inputs) > 0 && longest_${i} >= ${minutes}.0`,
          say: {
            'zh-CN': `告警 ${e.alertname}${variant} 的条件持续了 ${x.for}，表达式的值最高 {peak_${i}, number}`,
            en: `The condition of ${e.alertname}${variantEn} held for ${x.for}, with the expression peaking at {peak_${i}, number}`,
          },
        });
      } else {
        abnormal.push({
          cel: `count(inputs) > 0 && count(shown_${i}) > 0`,
          say: {
            'zh-CN': `告警 ${e.alertname}${variant} 的条件成立，表达式的值最高 {peak_${i}, number}`,
            en: `The condition of ${e.alertname}${variantEn} held, with the expression peaking at {peak_${i}, number}`,
          },
        });
      }
    });
    const forText = [...new Set(rs.map((x) => x.for))].join('、');
    chains.push({
      id: e.id,
      title: { 'zh-CN': `告警条件：${e.alertname}`, en: `Alert condition: ${e.alertname}` },
      cards: [
        {
          id: 'condition',
          title: { 'zh-CN': `告警 ${e.alertname} 的条件`, en: `Condition of alert ${e.alertname}` },
          note: {
            'zh-CN': `与 ${r.source} 中 ${e.alertname} 的表达式相同${rs.length > 1 ? `（${rs.length} 条严重度变体，任何一条成立）` : ''}；条件持续 for: ${forText} 时判异常`,
            en: `Same expression as ${e.alertname} in ${r.source}${rs.length > 1 ? ` (${rs.length} severity variants, any of them)` : ''}; abnormal when it holds for ${forText}`,
          },
          applies_to: { kinds: [e.entity.kind] },
          window: { before: '30m', after: '10m' },
          refs,
          // inputs 是 no_data 引用：表达式读取的序列在窗口内都不存在时，引用它的规则不可求值，卡片无法判定
          judge: { let: lets, abnormal_if: [abnormal[0]!, ...abnormal.slice(1)] },
          display: { value: 'peak_0' },
          egress: 'allow',
        },
      ],
    });
  }
  const uncovered = rules.filter((r) => !used.includes(r));
  return { signals, chains, ruleOf, uncovered };
}
