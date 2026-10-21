import type { NotifyRun } from '@srenautix/contract';

// Telegram 消息的 HTML（parse_mode=HTML，ADR 0125）。只使用 Bot API 支持的标签：b、i、code、a、blockquote（可展开）；
// 文本中的 &、<、> 与属性中的 " 一律转义。按段组装：超过长度上限时从优先级最低的段的末尾逐块删减，
// 删减以块为单位，标签总是闭合。实体（标签）数超过上限时，其余片段按纯文本输出。

/**
 * sendMessage / editMessageText 的文本上限（解析实体之后的文字）。Bot API 写作 4096 字符，这里按 UTF-16 code unit 计，
 * BMP 之外的字符也不会超限。
 */
export const MAX_TEXT_UNITS = 4096;
/** 一条消息里的实体数上限，超出部分 Telegram 不再显示格式 */
export const MAX_ENTITIES = 100;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** 链接只允许 http 与 https */
function safeHref(href: string | null): string | null {
  if (!href) {
    return null;
  }
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** 一行（块）：按顺序的片段；quote 为不可信原文的引用块 */
export interface Line {
  runs: NotifyRun[];
  quote?: boolean;
}

export interface Part {
  /** 0 不删减；其余数字越小越先删减 */
  priority: number;
  /** 段的块全部删掉时代替整段的一行 */
  omitted: string;
  /** 段删掉一部分块时追加在末尾的一行 */
  more: string;
  title: string | null;
  /** 证据链等较长的段：整段放在可展开的引用块里 */
  folded: boolean;
  lines: Line[];
}

const visible = (l: Line) => l.runs.reduce((n, r) => n + r.text.length, 0);

/** 段的文字长度；块全部删掉后只剩省略说明一行，没有块的段不输出 */
function partText(p: Part, kept: number, trimmed: boolean): number {
  if (kept === 0) {
    return trimmed ? p.omitted.length : 0;
  }
  let n = p.title ? p.title.length + 1 : 0;
  for (let i = 0; i < kept; i++) {
    n += visible(p.lines[i]!) + (i ? 1 : 0);
  }
  if (trimmed) {
    n += p.more.length + 1;
  }
  return n;
}

type Category = 'struct' | 'link' | 'emph' | 'code';

/**
 * 实体的分配：总数不超过 MAX_ENTITIES，按 段标题与引用块 → 链接 → 加粗与斜体 → 等宽 的顺序分配，
 * 某一类分不到的片段按纯文本输出
 */
class Budget {
  private readonly left: Record<Category, number>;

  constructor(demand: Record<Category, number>) {
    let rest = MAX_ENTITIES;
    const give = (n: number) => {
      const g = Math.min(n, rest);
      rest -= g;
      return g;
    };
    this.left = { struct: 0, link: 0, emph: 0, code: 0 };
    for (const c of ['struct', 'link', 'emph', 'code'] as const) {
      this.left[c] = give(demand[c]);
    }
  }

  take(c: Category): boolean {
    if (this.left[c] <= 0) {
      return false;
    }
    this.left[c]--;
    return true;
  }
}

const styleCategory = (s: NotifyRun['style']): Category | null =>
  s === 'code' ? 'code' : s === 'bold' || s === 'italic' ? 'emph' : null;

function runHtml(r: NotifyRun, b: Budget): string {
  if (!r.text) {
    return '';
  }
  const body = escapeHtml(r.text);
  const href = safeHref(r.href);
  const inner = wrap(r.style, body, b);
  return href && b.take('link') ? `<a href="${escapeAttr(href)}">${inner}</a>` : inner;
}

function wrap(style: NotifyRun['style'], body: string, b: Budget, category?: Category): string {
  const tag = style === 'bold' ? 'b' : style === 'italic' ? 'i' : style === 'code' ? 'code' : null;
  const c = category ?? styleCategory(style);
  return tag && c && b.take(c) ? `<${tag}>${body}</${tag}>` : body;
}

function lineHtml(l: Line, b: Budget, inFold: boolean): string {
  const html = l.runs.map((r) => runHtml(r, b)).join('');
  // 引用块不能嵌套：折叠段里的引用按普通文字输出
  return l.quote && !inFold && b.take('struct') ? `<blockquote>${html}</blockquote>` : html;
}

/** 保留下来的内容需要的实体数 */
function demandOf(parts: Part[], kept: number[]): Record<Category, number> {
  const d: Record<Category, number> = { struct: 0, link: 0, emph: 0, code: 0 };
  parts.forEach((p, i) => {
    const lines = p.lines.slice(0, kept[i]);
    if (!lines.length) {
      return;
    }
    d.struct += (p.title ? 1 : 0) + (p.folded ? 1 : 0);
    for (const l of lines) {
      if (l.quote && !p.folded) {
        d.struct++;
      }
      for (const r of l.runs) {
        if (!r.text) {
          continue;
        }
        if (safeHref(r.href)) {
          d.link++;
        }
        const c = styleCategory(r.style);
        if (c) {
          d[c]++;
        }
      }
    }
  });
  return d;
}

/**
 * 组装 HTML。返回 HTML 与解析后的文字长度；文字长度不超过 limit。
 */
export function buildHtml(parts: Part[], limit = MAX_TEXT_UNITS): { html: string; units: number } {
  const kept = parts.map((p) => p.lines.length);
  const trimmed = parts.map(() => false);
  const total = () =>
    parts.reduce((n, p, i) => {
      const len = partText(p, kept[i]!, trimmed[i]!);
      return len ? n + len + (n ? 2 : 0) : n;
    }, 0);
  for (;;) {
    if (total() <= limit) {
      break;
    }
    // 优先级最小、仍有块的段，从末尾删一块；只剩不可删减的段时，从最后一个仍有多块的段的末尾删
    let victim = -1;
    parts.forEach((p, i) => {
      if (p.priority > 0 && kept[i]! > 0 && (victim < 0 || p.priority < parts[victim]!.priority)) {
        victim = i;
      }
    });
    if (victim < 0) {
      for (let i = parts.length - 1; i >= 0; i--) {
        if (kept[i]! > 1) {
          victim = i;
          break;
        }
      }
    }
    if (victim < 0) {
      // 每段只剩一块仍超限：截短最长的一块
      let longest = 0;
      let at = { p: 0, l: 0 };
      parts.forEach((p, i) =>
        p.lines.slice(0, kept[i]).forEach((l, j) => {
          if (visible(l) > longest) {
            longest = visible(l);
            at = { p: i, l: j };
          }
        }),
      );
      const over = total() - limit;
      const line = parts[at.p]!.lines[at.l]!;
      parts[at.p]!.lines[at.l] = { ...line, runs: clipRuns(line.runs, Math.max(0, longest - over - 1)) };
      continue;
    }
    kept[victim]!--;
    trimmed[victim] = true;
  }
  const b = new Budget(demandOf(parts, kept));
  const chunks: string[] = [];
  let units = 0;
  parts.forEach((p, i) => {
    const lines = p.lines.slice(0, kept[i]);
    const len = partText(p, kept[i]!, trimmed[i]!);
    if (!len) {
      return;
    }
    units += len + (units ? 2 : 0);
    if (!lines.length) {
      chunks.push(escapeHtml(p.omitted));
      return;
    }
    // 段标题与折叠引用块先取实体，正文再按类别分配
    const title = p.title ? `${wrap('bold', escapeHtml(p.title), b, 'struct')}\n` : '';
    const fold = p.folded && b.take('struct');
    const body = lines.map((l) => lineHtml(l, b, p.folded)).join('\n');
    const tail = trimmed[i] ? `\n${escapeHtml(p.more)}` : '';
    chunks.push(fold ? `${title}<blockquote expandable>${body}${tail}</blockquote>` : `${title}${body}${tail}`);
  });
  return { html: chunks.join('\n\n'), units };
}

/** 把片段截到 n 个 code unit，不切开代理对，末尾加“…” */
export function clipRuns(runs: NotifyRun[], n: number): NotifyRun[] {
  const out: NotifyRun[] = [];
  let left = Math.max(0, n - 1);
  for (const r of runs) {
    if (left <= 0) {
      break;
    }
    if (r.text.length <= left) {
      out.push(r);
      left -= r.text.length;
      continue;
    }
    let cut = left;
    const c = r.text.charCodeAt(cut - 1);
    if (c >= 0xd800 && c < 0xdc00) {
      cut--;
    }
    out.push({ ...r, text: r.text.slice(0, cut) });
    left = 0;
  }
  out.push({ text: '…', style: 'plain', href: null });
  return out;
}
