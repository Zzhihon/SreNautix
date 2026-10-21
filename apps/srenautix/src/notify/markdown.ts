import type { NotifyBlock, NotifyMessage, NotifyRun } from '@srenautix/contract';

// 事件 issue 的正文（GitHub Markdown，ADR 0125）：与聊天消息同一份 NotifyMessage，渲染 scope 为 all 与 full 的块（全文）。
// 文字中的 Markdown 与 HTML 特殊字符一律转义，@ 后插入零宽空格避免提及用户；链接只允许 http 与 https。

/** GitHub Markdown 的转义 */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]<>()#+!|~]/g, (c) => `\\${c}`).replace(/@/g, '@​');
}

/** Markdown 链接目标：括号与空白会提前结束链接，按百分号编码写出 */
export function linkTarget(href: string): string {
  return href.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function inlineCode(s: string): string {
  const fence = s.includes('`') ? '``' : '`';
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s.replace(/\n/g, ' ')}${pad}${fence}`;
}

export function runsMarkdown(runs: readonly NotifyRun[]): string {
  return runs
    .map((r) => {
      if (!r.text) {
        return '';
      }
      const body = r.style === 'code' ? inlineCode(r.text) : escapeMarkdown(r.text);
      const styled = r.style === 'bold' ? `**${body}**` : r.style === 'italic' ? `_${body}_` : body;
      const href = r.href && /^https?:\/\//.test(r.href) ? r.href : null;
      return href ? `[${styled}](${linkTarget(href)})` : styled;
    })
    .join('');
}

function blockMarkdown(b: NotifyBlock): string {
  const indent = '  '.repeat(b.indent ?? 0);
  if (b.type === 'quote') {
    const lines = b.text.split(/\r?\n/).map((l) => `> ${escapeMarkdown(l)}`);
    return [`> ${escapeMarkdown(b.source ?? '-')}`, '>', ...lines].join('\n');
  }
  if (b.type === 'heading') {
    // 标题本身已经加粗：片段按原样式输出，加粗的片段去掉加粗
    const runs = (b.runs ?? []).map((r) => (r.style === 'bold' ? { ...r, style: 'plain' as const } : r));
    return `\n#### ${runs.length ? runsMarkdown(runs) : escapeMarkdown(b.text)}\n`;
  }
  const body = b.runs?.length ? runsMarkdown(b.runs) : escapeMarkdown(b.text);
  if (b.type === 'list_item') {
    return `${indent}- ${body}`;
  }
  // 普通段落：缩进的段落写成列表下的续行
  return indent ? `${indent}${body}` : `${body}\n`;
}

/** issue 的标题与正文；marker 是开头的 HTML 注释（事件标记与报告版本），footer 是末尾的说明 */
export function issueMarkdown(m: NotifyMessage, marker: string, footer: string): { title: string; body: string } {
  const headline = m.headline?.length ? m.headline.map((r) => r.text).join('') : m.title;
  const out: string[] = [marker];
  if (m.banner) {
    out.push(`> **${escapeMarkdown(m.banner)}**`, '');
  }
  for (const sec of m.sections) {
    const blocks = sec.blocks.filter((b) => (b.scope ?? 'all') !== 'summary');
    if (!blocks.length) {
      continue;
    }
    out.push(`## ${escapeMarkdown(sec.title ?? sec.kind)}`, '');
    out.push(...blocks.map(blockMarkdown), '');
  }
  const links = m.buttons.filter((b) => b.url && /^https?:\/\//.test(b.url));
  if (links.length) {
    out.push(links.map((b) => `[${escapeMarkdown(b.label)}](${b.url!})`).join(' · '), '');
  }
  out.push(`_${escapeMarkdown(footer)}_`);
  return {
    title: `${m.prefix ? `${m.prefix} ` : ''}${headline}`.slice(0, 250),
    body: out.join('\n').replace(/\n{3,}/g, '\n\n'),
  };
}
