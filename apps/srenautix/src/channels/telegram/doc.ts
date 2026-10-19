import type { TgEntity } from './types.js';

/**
 * sendMessage / editMessageText 的文本上限。Bot API 写作 4096 字符，这里按 UTF-16 code unit 计
 * （实体偏移同样以它计），BMP 之外的字符也不会超限。
 */
export const MAX_TEXT_UNITS = 4096;

/** 文本的 UTF-16 code unit 数。JS 字符串本身就是 UTF-16。 */
export const units = (s: string) => s.length;

type SpanKind = '' | 'bold' | 'code' | 'blockquote';

interface Span {
  text: string;
  kind: SpanKind;
}

/** 消息中的一段。priority 越小越先被省略；0 表示不可省略。 */
export class Section {
  readonly spans: Span[] = [];

  constructor(
    readonly priority: number,
    readonly omitted: string,
  ) {}

  private add(text: string, kind: SpanKind): this {
    this.spans.push({ text, kind });
    return this;
  }

  plain(text: string): this {
    return this.add(text, '');
  }

  bold(text: string): this {
    return this.add(text, 'bold');
  }

  /** 等宽实体：路径、命令、标识符，Telegram 客户端点击即可复制。 */
  code(text: string): this {
    return this.add(text, 'code');
  }

  /** 引用块：不可信原文只作为文本显示在引用实体里。 */
  quote(text: string): this {
    return this.add(text, 'blockquote');
  }

  nl(): this {
    return this.add('\n', '');
  }
}

/** 按顺序组装若干段，段与段之间空一行。 */
export class Doc {
  readonly sections: Section[] = [];

  section(priority: number, omitted: string): Section {
    const s = new Section(priority, omitted);
    this.sections.push(s);
    return s;
  }

  /**
   * 生成文本与实体。总长超过 limit 时，先按 priority 从小到大把可省略的段换成一行省略提示，
   * 仍超限时在行边界截断并追加 truncatedNote。
   */
  build(limit: number, truncatedNote: string): { text: string; entities: TgEntity[] } {
    const secs = [...this.sections];
    for (;;) {
      const r = assemble(secs);
      if (units(r.text) <= limit) {
        return r;
      }
      let victim = -1;
      secs.forEach((s, i) => {
        if (s.priority > 0 && (victim < 0 || s.priority < (secs[victim] as Section).priority)) {
          victim = i;
        }
      });
      if (victim < 0) {
        return hardCut(r.text, r.entities, limit, truncatedNote);
      }
      const old = secs[victim] as Section;
      const repl = new Section(0, '');
      if (old.omitted) {
        repl.plain(old.omitted);
      }
      secs[victim] = repl;
    }
  }
}

export function assemble(secs: readonly Section[]): { text: string; entities: TgEntity[] } {
  let text = '';
  const entities: TgEntity[] = [];
  let first = true;
  for (const s of secs) {
    if (!s.spans.length) {
      continue;
    }
    if (!first) {
      text += '\n\n';
    }
    first = false;
    // 段尾的换行不保留，段间统一空一行
    let spans = s.spans;
    while (spans.length && (spans[spans.length - 1] as Span).text === '\n') {
      spans = spans.slice(0, -1);
    }
    for (const sp of spans) {
      const n = units(sp.text);
      if (sp.kind && n > 0) {
        entities.push({ type: sp.kind, offset: text.length, length: n });
      }
      text += sp.text;
    }
  }
  return { text, entities };
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c < 0xdc00;

/** 在不超过 limit 的最后一个换行处截断，裁剪越界的实体，不切开代理对。 */
export function hardCut(
  text: string,
  entities: TgEntity[],
  limit: number,
  truncatedNote: string,
): { text: string; entities: TgEntity[] } {
  const budget = limit - units(truncatedNote);
  let cut = budget;
  for (let i = budget - 1; i > budget / 2; i--) {
    if (text.charCodeAt(i) === 10) {
      cut = i;
      break;
    }
  }
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) {
    cut--;
  }
  const kept: TgEntity[] = [];
  for (const e of entities) {
    if (e.offset >= cut) {
      continue;
    }
    kept.push(e.offset + e.length > cut ? { ...e, length: cut - e.offset } : e);
  }
  return { text: text.slice(0, cut) + truncatedNote, entities: kept };
}
