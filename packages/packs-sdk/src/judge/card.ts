// 证据卡的编译与判定（DESIGN §6.1）。
//
// 判定顺序：
// 1. 任一引用所需能力不可用：无法判定，显示状态 capability_missing。
// 2. 所有 no_data 语义的引用都没有样本或报错：无法判定（没有任何样本永远不是正常）。
// 3. 按顺序求 let；依赖缺数据引用或不可用 let 的 let 不可用。
// 4. undeterminable_if 命中：无法判定。
// 5. abnormal_if 按顺序求值，命中第一条：异常。
// 6. 都不命中：有规则因缺数据无法求值，或有 no_data 引用缺数据、报错时为无法判定；否则为正常。
// 表达式求值出错（缺样本之外的错误）时为无法判定，原因 evaluation_error。

import type { Environment } from '@marcbachmann/cel-js';
import { IntlMessageFormat } from 'intl-messageformat';
import { TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { COST_BUDGET, MAX_LOG_LINES, MAX_POINTS, MAX_SERIES, estimateCost, identifiers } from '../cel/cost.js';
import { NoSamplesError, PackLintError } from '../cel/errors.js';
import { formatValue, type Unit } from '../cel/format.js';
import { RESERVED_NAMES } from '../cel/library.js';
import { isEmpty, toCelSeries, type RefData } from './data.js';
import type {
  CardDefinition,
  CardOutcome,
  ConditionOutcome,
  EntityBinding,
  Locale,
  LocalizedText,
  ReasonKind,
  Scalar,
  WindowBinding,
} from './types.js';

const UNITS = new Set(['none', 'percent', 'ratio', 'bytes', 'seconds', 'count', 'per_second']);

interface CompiledExpr {
  source: string;
  run: (ctx: Record<string, unknown>) => unknown;
  ids: Set<string>;
  cost: number;
}

interface CompiledMessage {
  text: LocalizedText;
  formats: Partial<Record<Locale, IntlMessageFormat>>;
}

interface CompiledRule {
  expr: CompiledExpr;
  say: CompiledMessage;
  /** 求值为 false 时的说明 */
  normalSay: CompiledMessage | null;
}

/** 观测值最多记录的 let 绑定数（与契约 EvidenceResult.observations 的 maxProperties 一致） */
export const MAX_OBSERVATIONS = 16;

export interface CompiledCard {
  def: CardDefinition;
  lets: Array<{ name: string; expr: CompiledExpr }>;
  undeterminable: CompiledRule[];
  abnormal: CompiledRule[];
  value: CompiledExpr | null;
  threshold: CompiledExpr | null;
  baseline: CompiledExpr | null;
  table: {
    rowsFrom: string;
    columns: Array<{ header: LocalizedText; expr: CompiledExpr; unit: Unit }>;
    sortBy: CompiledExpr | null;
    limit: number;
  } | null;
  refNames: Set<string>;
  maxCost: number;
}

function messageArgs(els: MessageFormatElement[], out: Set<string>): void {
  for (const el of els) {
    if (el.type === TYPE.literal || el.type === TYPE.pound) {
      continue;
    }
    if (el.type === TYPE.tag) {
      messageArgs(el.children, out);
      continue;
    }
    out.add(el.value);
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      Object.values(el.options).forEach((o) => messageArgs(o.value, out));
    }
  }
}

export interface CompileOptions {
  /** 卡片的全局 id，用于报错定位 */
  where: string;
}

export function compileCard(base: Environment, def: CardDefinition, opts: CompileOptions): CompiledCard {
  const where = opts.where;
  const fail = (detail: string): never => {
    throw new PackLintError(where, detail);
  };
  const refNames = new Set<string>();
  for (const r of def.refs) {
    if (refNames.has(r.name) || RESERVED_NAMES.has(r.name)) {
      fail(`引用名 ${r.name} 重复或与保留名冲突`);
    }
    refNames.add(r.name);
  }
  if (!def.refs.some((r) => (r.empty_is ?? 'no_data') === 'no_data')) {
    fail('至少需要一个 empty_is 为 no_data 的引用，否则数据缺失时无法与"没有命中"区分');
  }
  const letNames = (def.judge.let ?? []).map((l) => l.name);
  for (const n of letNames) {
    if (refNames.has(n) || RESERVED_NAMES.has(n) || letNames.indexOf(n) !== letNames.lastIndexOf(n)) {
      fail(`let 名 ${n} 重复或与引用名、保留名冲突`);
    }
  }

  const env = base.clone();
  for (const r of refNames) {
    env.registerVariable(r, 'list');
  }
  env.registerVariable('params', 'map').registerVariable('entity', 'map').registerVariable('window', 'map');
  for (const n of letNames) {
    env.registerVariable(n, 'dyn');
  }
  const rowEnv = env.clone().registerVariable('row', 'map');

  let maxCost = 0;
  const compile = (source: string, what: string, e: Environment = env, visibleLets?: Set<string>): CompiledExpr => {
    const checked = e.check(source);
    if (!checked.valid) {
      fail(`${what} 的 CEL 不合法：${checked.error?.message ?? ''}：${source}`);
    }
    // 拓扑中的实体 kind 带 API 组（Application.argoproj.io），按字符串比较会把目标实体当成别的 kind
    if (/\bentity\.kind\s*(==|!=)|(==|!=)\s*entity\.kind\b|\bentity\.kind\s+in\b/.test(source)) {
      fail(`${what} 按字符串比较 entity.kind，改用 kind_is(entity.kind, "<Kind[.组]>")：${source}`);
    }
    const parsed = e.parse(source);
    const ids = identifiers(parsed.ast as never);
    if (visibleLets) {
      for (const id of ids) {
        if (letNames.includes(id) && !visibleLets.has(id)) {
          fail(`${what} 引用了在它之后定义的 let ${id}`);
        }
      }
    }
    const cost = estimateCost(parsed.ast as never, new Set([...refNames, ...letNames]));
    if (cost > COST_BUDGET) {
      fail(`${what} 的求值成本上界 ${cost} 超过 ${COST_BUDGET}：${source}`);
    }
    maxCost = Math.max(maxCost, cost);
    return { source, run: (ctx) => parsed(ctx), ids, cost };
  };

  const lets: CompiledCard['lets'] = [];
  const seen = new Set<string>();
  for (const l of def.judge.let ?? []) {
    lets.push({ name: l.name, expr: compile(l.cel, `let ${l.name}`, env, new Set(seen)) });
    seen.add(l.name);
  }

  const allowedArgs = new Set([...letNames, 'entity_name', 'entity_namespace', 'entity_kind']);
  const message = (text: LocalizedText, what: string): CompiledMessage => {
    const formats: CompiledMessage['formats'] = {};
    for (const [loc, src] of Object.entries(text) as Array<[Locale, string]>) {
      const f = new IntlMessageFormat(src, loc);
      const args = new Set<string>();
      messageArgs(f.getAst(), args);
      for (const a of args) {
        if (!allowedArgs.has(a)) {
          fail(`${what} 的文案引用了未定义的参数 ${a}`);
        }
      }
      formats[loc] = f;
    }
    return { text, formats };
  };

  const rules = (list: CardDefinition['judge']['undeterminable_if'], what: string): CompiledRule[] =>
    (list ?? []).map((r, i) => ({
      expr: compile(r.cel, `${what}[${i}]`),
      say: message(r.say, `${what}[${i}]`),
      normalSay: r.normal_say ? message(r.normal_say, `${what}[${i}].normal_say`) : null,
    }));

  const display = def.display;
  if (display?.unit && !UNITS.has(display.unit)) {
    fail(`未知的展示单位 ${display.unit}`);
  }
  let table: CompiledCard['table'] = null;
  if (display?.table) {
    const t = display.table;
    if (!refNames.has(t.rows_from)) {
      fail(`表格的 rows_from ${t.rows_from} 不是本卡的引用`);
    }
    table = {
      rowsFrom: t.rows_from,
      columns: t.columns.map((c, i) => {
        const unit = (c.unit ?? 'none') as Unit;
        if (!UNITS.has(unit)) {
          fail(`表格第 ${i} 列的单位 ${c.unit} 未知`);
        }
        return { header: c.header, expr: compile(c.cel, `表格第 ${i} 列`, rowEnv), unit };
      }),
      sortBy: t.sort_by ? compile(t.sort_by, '表格排序', rowEnv) : null,
      limit: t.limit ?? 8,
    };
  }

  return {
    def,
    lets,
    undeterminable: rules(def.judge.undeterminable_if, 'undeterminable_if'),
    abnormal: rules(def.judge.abnormal_if, 'abnormal_if'),
    value: display?.value ? compile(display.value, 'display.value') : null,
    threshold: display?.threshold ? compile(display.threshold, 'display.threshold') : null,
    baseline: display?.baseline ? compile(display.baseline, 'display.baseline') : null,
    table,
    refNames,
    maxCost,
  };
}

const SYSTEM_TEXT: Record<Exclude<ReasonKind, 'rule'>, Record<Locale, string>> = {
  no_data: { 'zh-CN': '查询没有样本', en: 'The queries returned no samples' },
  partial_data: {
    'zh-CN': '部分查询没有样本，不能判定为正常',
    en: 'Some queries returned no samples; cannot conclude normal',
  },
  source_error: { 'zh-CN': '数据源读取失败', en: 'The data source failed' },
  capability_missing: { 'zh-CN': '所需的数据源能力不可用', en: 'A required data source capability is unavailable' },
  observability_gap: { 'zh-CN': '依赖的观测目标有缺口', en: 'The observed target has an observability gap' },
  evaluation_error: { 'zh-CN': '判定表达式求值出错', en: 'The judge expression failed to evaluate' },
  all_clear: { 'zh-CN': '没有命中任何异常条件', en: 'No abnormal condition matched' },
};

export interface JudgeInput {
  refs: Record<string, RefData>;
  params?: Record<string, number | string | boolean>;
  entity: EntityBinding;
  window: WindowBinding;
  locale?: Locale;
}

/** let 绑定的标量取值：数值、字符串、布尔；不可用的绑定与非有限数值为 null，列表与映射不记录 */
function observationsOf(
  card: CompiledCard,
  ctx: Record<string, unknown>,
  avail: Map<string, Availability>,
): Record<string, Scalar | null> {
  const out: Record<string, Scalar | null> = {};
  for (const l of card.lets) {
    if (Object.keys(out).length >= MAX_OBSERVATIONS) {
      break;
    }
    const a = avail.get(l.name);
    const v = ctx[l.name];
    if (a && !a.ok) {
      out[l.name] = null;
    } else if (typeof v === 'bigint') {
      out[l.name] = Number(v);
    } else if (typeof v === 'number') {
      out[l.name] = Number.isFinite(v) ? v : null;
    } else if (typeof v === 'string' || typeof v === 'boolean') {
      out[l.name] = v;
    } else if (v === null || v === undefined) {
      out[l.name] = null;
    }
  }
  return out;
}

type Availability = { ok: true } | { ok: false; kind: 'no_data' | 'source_error' | 'evaluation_error'; detail: string };

function truncate(d: RefData): unknown[] {
  switch (d.kind) {
    case 'metrics':
      return d.series.slice(0, MAX_SERIES).map((s) => {
        const c = toCelSeries(s);
        return c.values.length > MAX_POINTS
          ? { labels: c.labels, times: c.times.slice(-MAX_POINTS), values: c.values.slice(-MAX_POINTS) }
          : c;
      });
    case 'logs':
      return d.lines.slice(0, MAX_LOG_LINES).map((l) => ({ time: l.time / 1000, labels: l.labels, line: l.line }));
    case 'traces':
      return d.traces.slice(0, MAX_SERIES).map((t) => ({ ...t, start: t.start / 1000, labels: t.attributes }));
    case 'error':
    case 'capability_missing':
      return [];
  }
}

function toCelScalar(k: string, v: number | string | boolean | undefined): number | string | boolean {
  if (v === undefined) {
    throw new TypeError(`参数 ${k} 没有值`);
  }
  return v;
}

export function judgeCard(card: CompiledCard, input: JudgeInput): CardOutcome {
  const locale = input.locale ?? 'zh-CN';
  const def = card.def;
  const sys = (kind: Exclude<ReasonKind, 'rule'>, detail?: string) => ({
    kind,
    text: detail ? `${SYSTEM_TEXT[kind][locale]}：${detail}` : SYSTEM_TEXT[kind][locale],
  });
  const params = Object.fromEntries(
    Object.entries({ ...(def.params ?? {}), ...(input.params ?? {}) }).map(([k, v]) => [k, toCelScalar(k, v)]),
  );
  const empty: Omit<CardOutcome, 'verdict' | 'display_state' | 'reason'> = {
    value: null,
    value_number: null,
    threshold: null,
    baseline: null,
    table: null,
    anomaly_started_at: null,
    observations: {},
    params,
    conditions: [],
  };

  for (const r of def.refs) {
    if (!(r.name in input.refs)) {
      throw new Error(`卡片 ${def.id} 缺少引用 ${r.name} 的数据`);
    }
  }
  const missing = def.refs.filter((r) => input.refs[r.name]!.kind === 'capability_missing');
  if (missing.length) {
    const caps = missing.map((r) => (input.refs[r.name] as { capability: string }).capability);
    return {
      verdict: 'undeterminable',
      display_state: 'capability_missing',
      reason: sys('capability_missing', [...new Set(caps)].join(', ')),
      ...empty,
    };
  }

  // 每个引用的可用性
  const avail = new Map<string, Availability>();
  for (const r of def.refs) {
    const d = input.refs[r.name]!;
    if (d.kind === 'error') {
      avail.set(r.name, { ok: false, kind: 'source_error', detail: `${r.name}：${d.message}` });
    } else if (isEmpty(d) && (r.empty_is ?? 'no_data') === 'no_data') {
      avail.set(r.name, { ok: false, kind: 'no_data', detail: r.name });
    } else {
      avail.set(r.name, { ok: true });
    }
  }
  const required = def.refs.filter((r) => (r.empty_is ?? 'no_data') === 'no_data');
  const allRequiredMissing = required.every((r) => !avail.get(r.name)!.ok);

  const conditions: ConditionOutcome[] = [];

  const ctx: Record<string, unknown> = {
    params,
    entity: {
      cluster_id: input.entity.cluster_id,
      kind: input.entity.kind,
      namespace: input.entity.namespace ?? '',
      name: input.entity.name,
    },
    window: { from: input.window.from, to: input.window.to, anchor: input.window.anchor },
  };
  for (const r of def.refs) {
    ctx[r.name] = truncate(input.refs[r.name]!);
  }

  const blocked = (ids: Set<string>): Availability => {
    for (const id of ids) {
      const a = avail.get(id);
      if (a && !a.ok) {
        return a;
      }
    }
    return { ok: true };
  };

  class EvalFailure extends Error {
    constructor(readonly detail: string) {
      super(detail);
    }
  }
  const run = (
    e: CompiledExpr,
    c: Record<string, unknown>,
  ): { ok: true; v: unknown } | { ok: false; a: Availability } => {
    const b = blocked(e.ids);
    if (!b.ok) {
      return { ok: false, a: b };
    }
    try {
      return { ok: true, v: e.run(c) };
    } catch (err) {
      if (err instanceof NoSamplesError) {
        return { ok: false, a: { ok: false, kind: 'no_data', detail: err.message } };
      }
      throw new EvalFailure(`${e.source}：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const bool = (e: CompiledExpr, v: unknown): boolean => {
    if (typeof v !== 'boolean') {
      throw new EvalFailure(`${e.source} 的结果不是 bool`);
    }
    return v;
  };
  const sayArgs = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      entity_name: input.entity.name,
      entity_namespace: input.entity.namespace ?? '',
      entity_kind: input.entity.kind,
    };
    for (const l of card.lets) {
      const a = avail.get(l.name);
      const v = ctx[l.name];
      out[l.name] = a && !a.ok ? '—' : typeof v === 'bigint' ? Number(v) : v;
    }
    return out;
  };
  const say = (m: CompiledMessage): string => {
    const f = m.formats[locale] ?? m.formats['zh-CN'] ?? m.formats.en;
    if (!f) {
      throw new Error(`卡片 ${def.id} 的文案没有任何语言`);
    }
    return String(f.format(sayArgs() as never));
  };

  try {
    for (const l of card.lets) {
      const r = run(l.expr, ctx);
      if (r.ok) {
        ctx[l.name] = r.v;
        avail.set(l.name, { ok: true });
      } else {
        ctx[l.name] = null;
        avail.set(l.name, r.a);
      }
    }

    const num = (e: CompiledExpr | null): number | null => {
      const r = e ? run(e, ctx) : null;
      if (!r || !r.ok) {
        return null;
      }
      const v = typeof r.v === 'bigint' ? Number(r.v) : r.v;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const decorate = (): Omit<CardOutcome, 'verdict' | 'display_state' | 'reason'> => {
      const value = card.value ? run(card.value, ctx) : null;
      const anomaly = avail.get('anomaly_started_at');
      const started = ctx['anomaly_started_at'];
      const raw = value && value.ok ? (typeof value.v === 'bigint' ? Number(value.v) : value.v) : null;
      return {
        value: value && value.ok ? formatValue(value.v, def.display?.unit) : null,
        value_number: typeof raw === 'number' && Number.isFinite(raw) ? raw : null,
        threshold: num(card.threshold),
        baseline: num(card.baseline),
        table: renderTable(card, ctx, avail, locale),
        anomaly_started_at: anomaly && anomaly.ok && typeof started === 'number' ? started : null,
        observations: observationsOf(card, ctx, avail),
        params,
        conditions,
      };
    };
    // 求值一条条件并记录结果：命中时为 say，没有命中时为 normal_say
    const evaluate = (
      rule: CompiledRule,
      kind: ConditionOutcome['kind'],
    ): { ok: true; hit: boolean } | { ok: false; a: Availability } => {
      const r = run(rule.expr, ctx);
      if (!r.ok) {
        conditions.push({ kind, cel: rule.expr.source, outcome: 'unavailable', say: null });
        return r;
      }
      const hit = bool(rule.expr, r.v);
      conditions.push({
        kind,
        cel: rule.expr.source,
        outcome: hit ? 'hit' : 'miss',
        say: hit ? say(rule.say) : rule.normalSay ? say(rule.normalSay) : null,
      });
      return { ok: true, hit };
    };

    for (const rule of card.undeterminable) {
      const r = evaluate(rule, 'undeterminable');
      if (r.ok && r.hit) {
        return {
          verdict: 'undeterminable',
          display_state: 'undeterminable',
          reason: { kind: 'rule', text: say(rule.say) },
          ...decorate(),
        };
      }
    }
    const skipped: Availability[] = [];
    for (const rule of card.abnormal) {
      const r = evaluate(rule, 'abnormal');
      if (!r.ok) {
        skipped.push(r.a);
        continue;
      }
      if (r.hit) {
        return {
          verdict: 'abnormal',
          display_state: 'abnormal',
          reason: { kind: 'rule', text: say(rule.say) },
          ...decorate(),
        };
      }
    }
    const badRefs = def.refs
      .map((r) => avail.get(r.name)!)
      .filter((a): a is Exclude<Availability, { ok: true }> => !a.ok);
    const gaps = [...skipped.filter((a): a is Exclude<Availability, { ok: true }> => !a.ok), ...badRefs];
    if (gaps.length) {
      const err = gaps.find((g) => g.kind === 'source_error');
      const detail = [...new Set(gaps.map((g) => g.detail))].join('；');
      return {
        verdict: 'undeterminable',
        display_state: 'undeterminable',
        reason: err
          ? sys('source_error', detail)
          : allRequiredMissing
            ? sys('no_data', detail)
            : sys('partial_data', detail),
        ...decorate(),
      };
    }
    return { verdict: 'normal', display_state: 'normal', reason: sys('all_clear'), ...decorate() };
  } catch (err) {
    if (err instanceof EvalFailure) {
      return {
        verdict: 'undeterminable',
        display_state: 'undeterminable',
        reason: sys('evaluation_error', err.detail),
        ...empty,
        conditions,
      };
    }
    throw err;
  }
}

function renderTable(
  card: CompiledCard,
  ctx: Record<string, unknown>,
  avail: Map<string, Availability>,
  locale: Locale,
): CardOutcome['table'] {
  const t = card.table;
  if (!t) {
    return null;
  }
  const a = avail.get(t.rowsFrom);
  if (a && !a.ok) {
    return null;
  }
  const rows = (ctx[t.rowsFrom] as unknown[]).filter(
    (r) => !(typeof r === 'object' && r !== null && 'values' in r && (r as { values: unknown[] }).values.length === 0),
  );
  if (!rows.length) {
    return null;
  }
  const evalRow = (e: CompiledExpr, row: unknown): unknown => {
    try {
      return e.run({ ...ctx, row });
    } catch (err) {
      if (err instanceof NoSamplesError) {
        return null;
      }
      throw err;
    }
  };
  // 后端返回序列的顺序不固定：先按 sort_by 降序，再按标签排序，保证结果确定
  const num = (k: unknown) => (typeof k === 'number' ? k : typeof k === 'bigint' ? Number(k) : -Infinity);
  const keyed = rows.map((row) => ({
    row,
    k: t.sortBy ? num(evalRow(t.sortBy, row)) : 0,
    tie: JSON.stringify(Object.entries((row as { labels?: Record<string, string> }).labels ?? {}).sort()),
  }));
  keyed.sort((x, y) => y.k - x.k || (x.tie < y.tie ? -1 : x.tie > y.tie ? 1 : 0));
  const ordered = keyed.map((x) => x.row);
  return {
    head: t.columns.map((c) => c.header[locale] ?? c.header['zh-CN'] ?? c.header.en ?? ''),
    rows: ordered.slice(0, t.limit).map((row) =>
      t.columns.map((c) => {
        const v = evalRow(c.expr, row);
        return v === null ? '—' : formatValue(v, c.unit);
      }),
    ),
  };
}
