import { redactText } from '../../llm/redact.js';
import { DEFAULT_CODE_EXCLUDE, type AnchorKind, type BusinessRepositoryConfig } from '../config.js';
import { matchAny } from './glob.js';
import { enclosingFunction, languageOf, sourceFacts, type FunctionSpan, type SourceFacts } from './syntax.js';
import type { RepoCodeCache, TreeEntry } from './tree.js';

// 代码定位（ADR 0146 §3.5）：发现给出确定性的锚点，在运行中的提交的目录树上按锚点规则筛出候选文件（不超过 200 个或
// 8 MiB），用 tree-sitter 取出字符串字面量与函数边界后匹配：
// - sql：字面量与 .sql 文件中的语句按规范化语句的指纹比较，相等即命中（置信度高）；只有表名命中时置信度低；
// - span_name、metric_name、route：字符串字面量精确匹配（置信度中）；
// - 命中生成代码（文件头有 "Code generated … DO NOT EDIT"，例如 sqlc 的查询）时，按生成的函数名在候选文件中
//   再找一层调用方（置信度降一档）。
// 定位不经过模型。

export interface Anchor {
  kind: AnchorKind;
  /** sql 为规范化语句，其余为字面量 */
  value: string;
  /** sql 锚点涉及的表；只有表名命中时置信度低 */
  tables?: readonly string[];
}

export type MatchKind = 'sql_fingerprint' | 'sql_table' | 'literal' | 'caller';
export type Confidence = 'high' | 'medium' | 'low';

export interface CodeLocation {
  repository: string;
  commit: string;
  path: string;
  /** 函数或方法的起止行；不在函数里时为命中的字面量 */
  start_line: number;
  end_line: number;
  /** 命中的行（字面量或调用点） */
  line: number;
  /** 函数或方法名；字面量不在函数里时为它所在的常量或变量名，都没有时为 null */
  symbol: string | null;
  receiver: string | null;
  anchor: AnchorKind;
  match_kind: MatchKind;
  confidence: Confidence;
}

/** 规范化语句的指纹（libpg-query）；无法解析时为 null */
export type SqlFingerprint = (sql: string) => string | null;

export interface LocateLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_LOCATE_LIMITS: LocateLimits = { maxFiles: 200, maxBytes: 8 * 1024 * 1024 };

export interface LocateResult {
  locations: CodeLocation[];
  /** 实际读取的文件数与字节数（计入目标预算的代码文件） */
  read: { files: number; bytes: number };
  /** 读取过的文件内容（路径 → 内容），供 codeExcerpts 使用 */
  contents: Map<string, string>;
  notes: string[];
}

const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
const LOWER: Record<Confidence, Confidence> = { high: 'medium', medium: 'low', low: 'low' };
const SQL_WORD = /\b(select|insert|update|delete|with)\b/i;
const GENERATED = /^\/\/ Code generated .* DO NOT EDIT\.?$/m;

/** 仓库路径 → 代码根目录内的相对路径；不在根目录内时为 null */
function relative(path: string, root: string): string | null {
  const r = root.replace(/^\/+|\/+$/g, '');
  if (!r) {
    return path;
  }
  return path.startsWith(`${r}/`) ? path.slice(r.length + 1) : null;
}

/** 包含、排除与语言之后的候选文件（相对代码根目录匹配 glob） */
export function codeFiles(entries: readonly TreeEntry[], layout: BusinessRepositoryConfig): TreeEntry[] {
  const exclude = [...DEFAULT_CODE_EXCLUDE, ...layout.exclude];
  return entries.filter((e) => {
    const rel = relative(e.path, layout.root);
    if (rel === null || !matchAny(rel, layout.include) || matchAny(rel, exclude)) {
      return false;
    }
    if (e.path.endsWith('.sql')) {
      return true;
    }
    const lang = languageOf(e.path);
    return lang !== null && layout.languages.includes(lang === 'tsx' ? 'typescript' : lang);
  });
}

/** .sql 文件中的语句（按分号切分）与起止行 */
function sqlStatements(text: string): Array<{ value: string; startLine: number; endLine: number }> {
  const out: Array<{ value: string; startLine: number; endLine: number }> = [];
  let start = 0;
  const lineAt = (offset: number) => text.slice(0, offset).split('\n').length;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === ';') {
      const value = text.slice(start, i);
      if (value.trim()) {
        const lead = value.length - value.trimStart().length;
        out.push({ value: value.trim(), startLine: lineAt(start + lead), endLine: lineAt(i) });
      }
      start = i + 1;
    }
  }
  return out;
}

function hasTable(text: string, table: string): boolean {
  const t = table.replace(/^.*\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${t}($|[^A-Za-z0-9_])`, 'i').test(text);
}

interface FileFacts {
  entry: TreeEntry;
  text: string;
  facts: SourceFacts;
  generated: boolean;
}

/** 字面量所在的常量或变量名：`name = …` 或 `const name = …` 写在字面量开始的那一行 */
function definedName(text: string, line: number): string | null {
  const l = text.split('\n')[line - 1] ?? '';
  return /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)\s*(?::?=|=)\s*[`"']/.exec(l)?.[1] ?? null;
}

/** 引用 name 的函数（生成代码里 sqlc 的查询函数引用语句常量） */
function functionUsing(f: FileFacts, name: string): FunctionSpan | null {
  const lines = f.text.split('\n');
  const re = new RegExp(`(^|[^A-Za-z0-9_])${name}($|[^A-Za-z0-9_])`);
  return f.facts.functions.find((fn) => lines.slice(fn.startLine, fn.endLine).some((l) => re.test(l))) ?? null;
}

export async function locateCode(
  layout: BusinessRepositoryConfig,
  commit: string,
  anchors: readonly Anchor[],
  deps: { cache: RepoCodeCache; fingerprint: SqlFingerprint },
  limits: LocateLimits = DEFAULT_LOCATE_LIMITS,
): Promise<LocateResult> {
  const notes: string[] = [];
  const tree = await deps.cache.tree(layout.repo, commit);
  if (tree.truncated) {
    notes.push(`${layout.repo}@${commit.slice(0, 12)} 的目录树被 GitHub 截断，只在返回的部分中定位`);
  }
  const base = codeFiles(tree.entries, layout);
  // 按锚点规则收缩范围：没有规则的锚点类型取全部代码文件
  const wanted = new Set<string>();
  for (const a of anchors) {
    const globs = layout.anchors[a.kind];
    for (const e of base) {
      const rel = relative(e.path, layout.root) as string;
      if (!globs || matchAny(rel, globs)) {
        wanted.add(e.path);
      }
    }
  }
  const candidates = base.filter((e) => wanted.has(e.path)).sort((a, b) => a.path.localeCompare(b.path));
  const picked: TreeEntry[] = [];
  let bytes = 0;
  for (const e of candidates) {
    if (picked.length >= limits.maxFiles || bytes + e.size > limits.maxBytes) {
      continue;
    }
    picked.push(e);
    bytes += e.size;
  }
  if (picked.length < candidates.length) {
    notes.push(
      `候选文件 ${candidates.length} 个，超过读取上限（${limits.maxFiles} 个或 ${Math.round(limits.maxBytes / 1048576)} MiB），只读取按路径排序的前 ${picked.length} 个`,
    );
  }
  const files: FileFacts[] = [];
  for (const entry of picked) {
    const text = await deps.cache.content(layout.repo, commit, entry);
    const lang = languageOf(entry.path);
    const facts: SourceFacts = lang
      ? await sourceFacts(lang, text)
      : { strings: sqlStatements(text), functions: [], calls: [] };
    files.push({ entry, text, facts, generated: GENERATED.test(text.slice(0, 2000)) });
  }

  const out: CodeLocation[] = [];
  const add = (f: FileFacts, a: Anchor, at: { startLine: number; endLine: number }, kind: MatchKind, c: Confidence) => {
    const fn = enclosingFunction(f.facts.functions, at.startLine);
    out.push({
      repository: layout.repo,
      commit,
      path: f.entry.path,
      start_line: fn?.startLine ?? at.startLine,
      end_line: fn?.endLine ?? at.endLine,
      line: at.startLine,
      symbol: fn?.name ?? definedName(f.text, at.startLine),
      receiver: fn?.receiver ?? null,
      anchor: a.kind,
      match_kind: kind,
      confidence: c,
    });
    // 生成代码：按生成的函数名再找一层调用方
    if (!f.generated) {
      return;
    }
    const sqlcName =
      a.kind === 'sql'
        ? /--\s*name:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(
            f.facts.strings.find((s) => s.startLine === at.startLine)?.value ?? '',
          )?.[1]
        : undefined;
    const holder =
      fn ??
      (() => {
        const name = definedName(f.text, at.startLine);
        return name ? functionUsing(f, name) : null;
      })();
    const callee = sqlcName ?? holder?.name ?? null;
    if (!callee) {
      return;
    }
    for (const g of files) {
      if (g.generated) {
        continue;
      }
      for (const call of g.facts.calls.filter((x) => x.name === callee)) {
        const caller = enclosingFunction(g.facts.functions, call.line);
        out.push({
          repository: layout.repo,
          commit,
          path: g.entry.path,
          start_line: caller?.startLine ?? call.line,
          end_line: caller?.endLine ?? call.line,
          line: call.line,
          symbol: caller?.name ?? null,
          receiver: caller?.receiver ?? null,
          anchor: a.kind,
          match_kind: 'caller',
          confidence: LOWER[c],
        });
      }
    }
  };

  for (const a of anchors) {
    if (a.kind === 'sql') {
      const target = deps.fingerprint(a.value);
      if (target === null) {
        notes.push('锚点语句无法规范化，只按表名定位');
      }
      for (const f of files) {
        for (const s of f.facts.strings) {
          if (!SQL_WORD.test(s.value)) {
            continue;
          }
          if (target !== null && deps.fingerprint(s.value) === target) {
            add(f, a, s, 'sql_fingerprint', 'high');
          } else if ((a.tables ?? []).some((t) => hasTable(s.value, t))) {
            add(f, a, s, 'sql_table', 'low');
          }
        }
      }
    } else {
      for (const f of files) {
        for (const s of f.facts.strings) {
          if (s.value === a.value) {
            add(f, a, s, 'literal', 'medium');
          }
        }
      }
    }
  }

  // 同一个位置只保留置信度最高的一条；按置信度、路径与行号排列
  const best = new Map<string, CodeLocation>();
  for (const l of out) {
    const k = `${l.path}:${l.start_line}:${l.symbol ?? ''}`;
    const cur = best.get(k);
    if (!cur || RANK[l.confidence] < RANK[cur.confidence]) {
      best.set(k, l);
    }
  }
  const locations = [...best.values()].sort(
    (x, y) => RANK[x.confidence] - RANK[y.confidence] || x.path.localeCompare(y.path) || x.start_line - y.start_line,
  );
  return {
    locations,
    read: { files: picked.length, bytes },
    contents: new Map(files.map((f) => [f.entry.path, f.text])),
    notes,
  };
}

/** 路径映射的 issue 标签（§3.5 的 labels） */
export function pathLabels(layout: BusinessRepositoryConfig, paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const rel = relative(p, layout.root) ?? p;
    for (const l of layout.labels) {
      if (matchAny(rel, [l.glob])) {
        out.add(l.label);
      }
    }
  }
  return [...out];
}

export interface CodeExcerpt {
  location: CodeLocation;
  /** 前后各 context 行，带行号；经脱敏 */
  text: string;
  redactions: number;
}

/**
 * 给模型的代码片段（§3.5）：每个位置命中行前后各 20 行，最多 5 个位置，经密钥扫描与脱敏（出境类别 code）。
 * files 是定位时读取过的文件内容（路径 → 内容）
 */
export function codeExcerpts(
  files: ReadonlyMap<string, string>,
  locations: readonly CodeLocation[],
  opts: { context?: number; max?: number } = {},
): CodeExcerpt[] {
  const context = opts.context ?? 20;
  const out: CodeExcerpt[] = [];
  for (const l of locations.slice(0, opts.max ?? 5)) {
    const text = files.get(l.path);
    if (text === undefined) {
      continue;
    }
    const lines = text.split('\n');
    const from = Math.max(1, l.line - context);
    const to = Math.min(lines.length, l.line + context);
    const raw = lines
      .slice(from - 1, to)
      .map((x, i) => `${String(from + i).padStart(5)}  ${x}`)
      .join('\n');
    const r = redactText(raw);
    out.push({
      location: l,
      text: r.text,
      redactions: Object.values(r.hits).reduce((n, v) => n + (v ?? 0), 0),
    });
  }
  return out;
}
