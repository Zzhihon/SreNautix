// 错误样例（契约 2.42.0，ADR 0177）：把日志引用取回的日志行按领域包声明的维度聚合、按错误类别归类，
// 每个类别取少量原始样例。样例与维度值先脱敏再截断：截断在脱敏之后，凭证不会因为被截成两半而躲过脱敏规则。

import type { CardSamples, EvidenceResult, EvidenceSamples, LocalizedText } from '@srenautix/contract';
import { toIso } from '@srenautix/integration-sdk';
import type { LogLine, RefData } from '../judge/data.js';
import type { Locale } from '../judge/types.js';

/** 脱敏函数：返回脱敏后的文本与替换的处数。由执行方提供（server 用出站模块的脱敏规则） */
export type Redactor = (text: string) => { text: string; hits: number };

/** 不脱敏：只用于在本机执行、结果不出站的场合（pack test 的夹具、查询快照的录制与回放） */
export const NO_REDACTION: Redactor = (text) => ({ text, hits: 0 });

export const SAMPLES_DEFAULTS = { per_class: 3, max_chars: 300, max_groups: 20 } as const;
/** 没有命中任何声明的类别的行 */
export const OTHER_CLASS = 'other';
/** 维度值在结果里最多保留的字符数 */
const DIMENSION_CHARS = 120;

export type SamplesCode = NonNullable<EvidenceSamples['code']>;

interface CompiledDimension {
  name: string;
  title: LocalizedText | null;
  label: string | null;
  regex: RegExp | null;
}

interface CompiledClass {
  id: string;
  title: LocalizedText;
  match: Array<{ dimension: string | null; regex: RegExp }>;
}

export interface CompiledSamples {
  spec: CardSamples;
  dimensions: CompiledDimension[];
  classes: CompiledClass[];
}

function regex(source: string, what: string): RegExp {
  try {
    return new RegExp(source);
  } catch (err) {
    throw new TypeError(`${what} 的正则不合法：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** 正则的捕获组数（在空串上匹配加了空分支的同一个正则，结果的长度减一） */
function captureGroups(re: RegExp): number {
  return new RegExp(`${re.source}|`).exec('')!.length - 1;
}

/**
 * 编译并校验错误样例的声明：ref 必须是卡片中 mode 为 logs 的引用，卡片的出境方式不能是 allow，维度名唯一且 label 与
 * regex 二选一（regex 至少一个捕获组），类别 id 唯一且不是 other，类别条件引用的维度必须声明过。不合法时抛出 TypeError
 */
export function compileSamples(
  spec: CardSamples,
  refs: ReadonlyArray<{ name: string; mode: string }>,
  egress: EvidenceResult['egress'],
): CompiledSamples {
  const ref = refs.find((r) => r.name === spec.ref);
  if (!ref) {
    throw new TypeError(`ref ${spec.ref} 不是卡片中的引用`);
  }
  if (ref.mode !== 'logs') {
    throw new TypeError(`ref ${spec.ref} 的 mode 是 ${ref.mode}，必须是 logs`);
  }
  if (egress === 'allow') {
    throw new TypeError('声明错误样例的卡含有日志原文，egress 必须是 redact 或 never');
  }
  const dimensions = spec.dimensions.map((d): CompiledDimension => {
    if ((d.label === undefined) === (d.regex === undefined)) {
      throw new TypeError(`维度 ${d.name} 的 label 与 regex 必须二选一`);
    }
    const re = d.regex === undefined ? null : regex(d.regex, `维度 ${d.name}`);
    if (re && captureGroups(re) < 1) {
      throw new TypeError(`维度 ${d.name} 的正则没有捕获组`);
    }
    return { name: d.name, title: d.title ?? null, label: d.label ?? null, regex: re };
  });
  const names = new Set<string>();
  for (const d of dimensions) {
    if (names.has(d.name)) {
      throw new TypeError(`维度 ${d.name} 重复`);
    }
    names.add(d.name);
  }
  const ids = new Set<string>();
  const classes = (spec.classes ?? []).map((c): CompiledClass => {
    if (c.id === OTHER_CLASS) {
      throw new TypeError(`类别 id ${OTHER_CLASS} 保留给没有命中任何类别的行`);
    }
    if (ids.has(c.id)) {
      throw new TypeError(`类别 ${c.id} 重复`);
    }
    ids.add(c.id);
    return {
      id: c.id,
      title: c.title,
      match: c.match.map((m) => {
        if (m.dimension !== undefined && !names.has(m.dimension)) {
          throw new TypeError(`类别 ${c.id} 的条件引用了没有声明的维度 ${m.dimension}`);
        }
        return { dimension: m.dimension ?? null, regex: regex(m.regex, `类别 ${c.id} 的条件`) };
      }),
    };
  });
  return { spec, dimensions, classes };
}

/** 截断到 max 个字符（按码点），超出时加省略号 */
function cut(text: string, max: number): { text: string; cut: boolean } {
  const chars = Array.from(text);
  return chars.length > max ? { text: `${chars.slice(0, max).join('')}…`, cut: true } : { text, cut: false };
}

/** 取得了日志行之外的结果：没有样例，记原因码 */
function failed(c: CompiledSamples, code: SamplesCode): EvidenceSamples {
  return {
    ref: c.spec.ref,
    code,
    lines: 0,
    truncated: false,
    dimensions: c.dimensions.map((d) => d.name),
    groups: [],
    groups_omitted: 0,
    classes: [],
    redactions: 0,
  };
}

/** 证据期限内没有执行完的错误样例卡（server 在期限到达时补出这张卡的结果） */
export function samplesDeadline(c: CompiledSamples): EvidenceSamples {
  return failed(c, 'samples_deadline');
}

interface Group {
  key: string;
  dims: Record<string, string | null>;
  cls: string;
  count: number;
  first: number;
  last: number;
  /** 这个组合最新的几行（最多 per_class 行，从新到旧） */
  newest: Array<{ line: LogLine; dims: Record<string, string | null> }>;
}

/**
 * 聚合一个日志引用的结果。能力缺失与数据源报错（超时单独记）给出原因码与空的聚合；取得了日志行（包括零行）时 code 为 null。
 * 类别按原始的维度值与日志行匹配；结果里的维度值与样例都经过 redact，再截断。
 */
export function aggregateSamples(c: CompiledSamples, data: RefData | undefined, redact: Redactor): EvidenceSamples {
  if (!data) {
    throw new Error(`错误样例的引用 ${c.spec.ref} 没有数据`);
  }
  if (data.kind === 'capability_missing') {
    return failed(c, 'samples_capability_missing');
  }
  if (data.kind === 'error') {
    return failed(c, data.timeout ? 'samples_timeout' : 'samples_source_error');
  }
  if (data.kind !== 'logs') {
    throw new TypeError(`错误样例的引用 ${c.spec.ref} 不是日志引用（${data.kind}）`);
  }
  const perClass = c.spec.per_class ?? SAMPLES_DEFAULTS.per_class;
  const maxChars = c.spec.max_chars ?? SAMPLES_DEFAULTS.max_chars;
  const maxGroups = c.spec.max_groups ?? SAMPLES_DEFAULTS.max_groups;
  let redactions = 0;
  // 同一个维度值只脱敏一次，替换的处数也只计一次
  const seen = new Map<string, string>();
  const shown = (raw: string): string => {
    let v = seen.get(raw);
    if (v === undefined) {
      const r = redact(raw);
      redactions += r.hits;
      v = cut(r.text, DIMENSION_CHARS).text;
      seen.set(raw, v);
    }
    return v;
  };
  const groups = new Map<string, Group>();
  // 从新到旧处理，每个组合留下的就是最新的几行；时间相同时按内容排序，结果与数据源返回的顺序无关
  const lines = [...data.lines].sort((a, b) => b.time - a.time || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  for (const line of lines) {
    const raw: Record<string, string | null> = {};
    for (const d of c.dimensions) {
      raw[d.name] = d.label !== null ? (line.labels[d.label] ?? null) : (d.regex!.exec(line.line)?.[1] ?? null);
    }
    const cls =
      c.classes.find((k) =>
        k.match.every((m) => {
          const v = m.dimension === null ? line.line : raw[m.dimension];
          return v !== null && v !== undefined && m.regex.test(v);
        }),
      )?.id ?? OTHER_CLASS;
    const dims = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === null ? null : shown(v)]));
    const key = JSON.stringify([c.dimensions.map((d) => dims[d.name]), cls]);
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.first = Math.min(g.first, line.time);
      g.last = Math.max(g.last, line.time);
      if (g.newest.length < perClass) {
        g.newest.push({ line, dims });
      }
    } else {
      groups.set(key, { key, dims, cls, count: 1, first: line.time, last: line.time, newest: [{ line, dims }] });
    }
  }
  const order = (a: Group, b: Group) => b.count - a.count || b.last - a.last || (a.key < b.key ? -1 : 1);
  const all = [...groups.values()].sort(order);
  const declared = [...c.classes.map((k) => k.id), OTHER_CLASS];
  const counts = new Map<string, number>();
  for (const g of all) {
    counts.set(g.cls, (counts.get(g.cls) ?? 0) + g.count);
  }
  const classes = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || declared.indexOf(a[0]) - declared.indexOf(b[0]))
    .map(([cls, count]) => {
      // 同一类别内先轮流取不同的维度组合（行数多的组合在前），每个组合内从新到旧
      const mine = all.filter((g) => g.cls === cls);
      const picked: Group['newest'] = [];
      for (let i = 0; picked.length < perClass && mine.some((g) => g.newest.length > i); i++) {
        for (const g of mine) {
          const x = g.newest[i];
          if (x && picked.length < perClass) {
            picked.push(x);
          }
        }
      }
      return {
        class: cls,
        title: c.classes.find((k) => k.id === cls)?.title ?? null,
        count,
        samples: picked.map((x) => {
          const r = redact(x.line.line);
          redactions += r.hits;
          const t = cut(r.text, maxChars);
          return { at: toIso(x.line.time), dimensions: x.dims, text: t.text, cut: t.cut };
        }),
      };
    });
  return {
    ref: c.spec.ref,
    code: null,
    lines: lines.length,
    truncated: data.truncated,
    dimensions: c.dimensions.map((d) => d.name),
    groups: all.slice(0, maxGroups).map((g) => ({
      dimensions: g.dims,
      class: g.cls,
      count: g.count,
      first_at: toIso(g.first),
      last_at: toIso(g.last),
    })),
    groups_omitted: Math.max(0, all.length - maxGroups),
    classes,
    redactions,
  };
}

const HEAD: Record<Locale, { cls: string; count: string; first: string; last: string }> = {
  'zh-CN': { cls: '错误类别', count: '行数', first: '首次', last: '末次' },
  en: { cls: 'class', count: 'lines', first: 'first', last: 'last' },
};

/**
 * 没有声明 display.table 的错误样例卡，维度组合写成卡片的表格（控制台、issue 与消息的证据段照常展示）：
 * 每个维度一列，再加类别、行数与首末时间；日志行达到 limit 时行数前加 ≥
 */
export function samplesTable(
  c: CompiledSamples,
  s: EvidenceSamples,
  locale: Locale,
): NonNullable<EvidenceResult['table']> {
  const h = HEAD[locale];
  const title = (t: LocalizedText | null, fallback: string) => t?.[locale] ?? t?.['zh-CN'] ?? t?.en ?? fallback;
  const time = (iso: string) => iso.slice(0, 19).replace('T', ' ');
  return {
    head: [...c.dimensions.map((d) => title(d.title, d.name)), h.cls, h.count, h.first, h.last],
    rows: s.groups.map((g) => [
      ...c.dimensions.map((d) => g.dimensions[d.name] ?? '-'),
      title(c.classes.find((k) => k.id === g.class)?.title ?? null, g.class),
      `${s.truncated ? '≥' : ''}${g.count}`,
      time(g.first_at),
      time(g.last_at),
    ]),
  };
}
