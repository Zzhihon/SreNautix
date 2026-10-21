import { Parser } from 'htmlparser2';

/**
 * 按 Telegram Bot API 的 HTML 解析规则检查消息（https://core.telegram.org/bots/api#html-style），返回解析后的文字与实体。
 * 违反任一规则时抛出错误，对应 Bot API 的 400 "can't parse entities"：
 * - 只允许 Bot API 支持的标签与属性（本项目只输出 b、i、code、a href、blockquote [expandable]）；
 * - 标签必须成对闭合、正确嵌套，blockquote 不能嵌套；
 * - 不是标签或实体一部分的 &、<、> 必须转义，命名实体只允许 &lt; &gt; &amp; &quot;。
 */
export interface ParsedEntity {
  type: 'bold' | 'italic' | 'code' | 'text_link' | 'blockquote' | 'expandable_blockquote';
  offset: number;
  length: number;
  url?: string;
}

const TYPES: Record<string, ParsedEntity['type']> = {
  b: 'bold',
  i: 'italic',
  code: 'code',
  a: 'text_link',
  blockquote: 'blockquote',
};

export function parseTelegramHtml(html: string): { text: string; entities: ParsedEntity[] } {
  const bad = /&(?!(?:lt|gt|amp|quot|#\d+|#x[0-9a-fA-F]+);)/.exec(html);
  if (bad) {
    throw new Error(`未转义的 &：…${html.slice(Math.max(0, bad.index - 20), bad.index + 20)}…`);
  }
  let text = '';
  const entities: ParsedEntity[] = [];
  const stack: Array<{ name: string; start: number; url?: string; expandable: boolean }> = [];
  let error: string | null = null;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (!(name in TYPES)) {
          error ??= `不支持的标签 <${name}>`;
          return;
        }
        const keys = Object.keys(attribs);
        const allowed = name === 'a' ? ['href'] : name === 'blockquote' ? ['expandable'] : [];
        if (keys.some((k) => !allowed.includes(k))) {
          error ??= `<${name}> 不支持属性 ${keys.join(',')}`;
        }
        if (name === 'a' && !/^https?:\/\//.test(attribs.href ?? '')) {
          error ??= `<a> 的 href 不是 http(s)：${attribs.href ?? ''}`;
        }
        if (name === 'blockquote' && stack.some((s) => s.name === 'blockquote')) {
          error ??= 'blockquote 不能嵌套';
        }
        stack.push({ name, start: text.length, url: attribs.href, expandable: 'expandable' in attribs });
      },
      ontext(data) {
        text += data;
      },
      onclosetag(name, isImplied) {
        if (!(name in TYPES)) {
          return;
        }
        if (isImplied) {
          error ??= `<${name}> 没有闭合或嵌套错误`;
        }
        const top = stack.pop();
        if (!top || top.name !== name) {
          error ??= `</${name}> 与开始标签不匹配`;
          return;
        }
        const length = text.length - top.start;
        if (length > 0) {
          const type = name === 'blockquote' && top.expandable ? 'expandable_blockquote' : TYPES[name]!;
          entities.push({ type, offset: top.start, length, ...(top.url ? { url: top.url } : {}) });
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: false, recognizeSelfClosing: false },
  );
  parser.write(html);
  parser.end();
  if (error) {
    throw new Error(error);
  }
  if (stack.length) {
    throw new Error(`没有闭合的标签：${stack.map((s) => s.name).join(',')}`);
  }
  return { text, entities: entities.sort((a, b) => a.offset - b.offset) };
}
