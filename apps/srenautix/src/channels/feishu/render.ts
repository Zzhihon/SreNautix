import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NotifyRun } from '@srenautix/contract';
import type {
  ActionResultView,
  ChatTarget,
  DigestInput,
  Language,
  RegisteredButton,
  Rendered,
  RenderOptions,
} from '../../notify/channel.js';
import type { ExternalDigestView } from '../../notify/external.js';
import type { ButtonTarget, DesiredIncidentMessage } from '../../notify/ports.js';
import { linkTarget } from '../../notify/markdown.js';
import { FEEDBACK_REASON_CODES } from '../../proposals/feedback.js';
import { shortId } from '../../notify/shortid.js';
import { clip, hm, oneLine, publicHttpsUrl, t, ymdhm } from '../../notify/text.js';
import { payloadHash, MAX_RESULTS_SHOWN } from '../telegram/render.js';
import { displayKey } from '@srenautix/core';

/** 卡片 JSON 的上限是 30 KB；留出余量，超过时按优先级省略段落。 */
export const MAX_CARD_BYTES = 28 * 1024;

const SECTION_PRIORITY: Record<string, number> = {
  situation: 5,
  root_cause: 4,
  key_issue: 6,
  topology: 3,
  remedy: 3,
  evidence: 2,
};

const TEMPLATE: Record<string, string> = { critical: 'red', warning: 'orange', info: 'blue' };

type El = Record<string, unknown>;

const plain = (content: string, extra: El = {}): El => ({ tag: 'div', text: { tag: 'plain_text', content, ...extra } });
const heading = (content: string): El => ({ tag: 'markdown', content: `**${escapeFeishu(content)}**` });

/** 飞书 markdown 的转义（卡片 JSON 2.0 富文本组件的特殊字符表），& 一并转义，避免拼出 HTML 实体 */
export function escapeFeishu(s: string): string {
  return s.replace(/[&*~<>[\]\-_#`]/g, (c) => {
    switch (c) {
      case '~':
        return '&sim;';
      case '`':
        return '&#96;';
      default:
        return `&#${c.charCodeAt(0)};`;
    }
  });
}

/** 富文本片段 → 飞书 markdown：加粗、斜体、行内代码、链接（只允许 http 与 https） */
export function feishuMarkdown(runs: readonly NotifyRun[]): string {
  return runs
    .map((r) => {
      if (!r.text) {
        return '';
      }
      const body = r.style === 'code' ? `\`${r.text.replace(/`/g, "'")}\`` : escapeFeishu(r.text);
      const styled = r.style === 'bold' ? `**${body}**` : r.style === 'italic' ? `*${body}*` : body;
      const href = r.href && /^https?:\/\//.test(r.href) ? r.href : null;
      return href ? `[${styled}](${linkTarget(href)})` : styled;
    })
    .join('');
}
const hr = (): El => ({ tag: 'hr' });

/**
 * 按钮回调值的签名：value = {k: short id, s: HMAC-SHA256(key, k) 的前 16 个 base64url 字符}。
 * 回调请求本身另有签名校验；这里保证按钮的 short id 只能来自 server 渲染的卡片。
 */
export class ButtonSigner {
  constructor(private readonly key: Buffer) {}

  sign(k: string): string {
    return createHmac('sha256', this.key).update(k).digest('base64url').slice(0, 16);
  }

  value(k: string): { k: string; s: string } {
    return { k, s: this.sign(k) };
  }

  verify(v: unknown): string | null {
    if (!v || typeof v !== 'object') {
      return null;
    }
    const { k, s } = v as { k?: unknown; s?: unknown };
    if (typeof k !== 'string' || typeof s !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(k)) {
      return null;
    }
    const want = Buffer.from(this.sign(k));
    const got = Buffer.from(s);
    return want.length === got.length && timingSafeEqual(want, got) ? k : null;
  }
}

interface Part {
  priority: number;
  omitted: string;
  elements: El[];
}

function assembleCard(header: El, parts: Part[], tail: El[]): El {
  const elements: El[] = [];
  parts.forEach((p, i) => {
    if (!p.elements.length) {
      return;
    }
    if (i > 0 && elements.length) {
      elements.push(hr());
    }
    elements.push(...p.elements);
  });
  if (tail.length) {
    elements.push(hr(), ...tail);
  }
  return { schema: '2.0', config: { update_multi: true }, header, body: { elements } };
}

/** 超过大小上限时，按 priority 从小到大把可省略的段换成一行提示；仍超限时截短每个文本元素。 */
function fit(header: El, parts: Part[], tail: El[]): El {
  const ps = parts.map((p) => ({ ...p }));
  for (;;) {
    const card = assembleCard(header, ps, tail);
    if (Buffer.byteLength(JSON.stringify(card)) <= MAX_CARD_BYTES) {
      return card;
    }
    let victim = -1;
    ps.forEach((p, i) => {
      if (p.priority > 0 && (victim < 0 || p.priority < (ps[victim] as Part).priority)) {
        victim = i;
      }
    });
    if (victim < 0) {
      // 只剩不可省略的段：把文本元素截到 200 字符
      for (const p of ps) {
        p.elements = p.elements.map((e) =>
          e.tag === 'div' ? plain(clip(String((e.text as { content: string }).content), 200)) : e,
        );
      }
      return assembleCard(header, ps, tail);
    }
    const old = ps[victim] as Part;
    ps[victim] = { priority: 0, omitted: '', elements: old.omitted ? [plain(old.omitted)] : [] };
  }
}

/** 纯文本降级卡片的正文上限（字符），远低于卡片 JSON 的 30 KB */
const PLAIN_CARD_CHARS = 6000;

/** feishuMarkdown 的输出 → 纯文本：链接只留文字，去掉加粗与斜体标记，还原转义；行内代码原样保留 */
function markdownToPlain(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split('`')
    .map((s, i) =>
      i % 2
        ? s
        : s
            .replace(/\*/g, '')
            .replace(/&#(\d+);|&sim;/g, (_m, n: string | undefined) => (n ? String.fromCharCode(Number(n)) : '~')),
    )
    .join('');
}

function elementText(e: El): string[] {
  switch (e.tag) {
    case 'markdown':
      return [markdownToPlain(String(e.content ?? ''))];
    case 'div':
      return [String((e.text as { content?: string } | undefined)?.content ?? '')];
    case 'collapsible_panel': {
      const title = (e.header as { title?: { content?: string } } | undefined)?.title?.content;
      return [...(title ? [title] : []), ...((e.elements as El[] | undefined) ?? []).flatMap(elementText)];
    }
    default:
      // 按钮、表单、分隔线等交互或装饰元素不进入纯文本
      return [];
  }
}

/**
 * 去掉格式的纯文本降级卡片（ADR 0145）：标题不变，正文的文字合成一个 plain_text，去掉按钮与表单
 * （卡片更新只能是卡片，不能换成文本消息）。
 */
export function plainCard(card: unknown): El {
  const c = card as { header?: El; body?: { elements?: El[] } };
  const text = (c.body?.elements ?? [])
    .flatMap(elementText)
    .filter((s) => s.trim())
    .join('\n');
  return {
    schema: '2.0',
    config: { update_multi: true },
    ...(c.header ? { header: c.header } : {}),
    body: { elements: [plain(clip(text, PLAIN_CARD_CHARS) || '-')] },
  };
}

function writeResults(l: Language, results: readonly ActionResultView[]): El[] {
  if (!results.length) {
    return [];
  }
  return [
    heading(t.misc(l, 'results')),
    ...results
      .slice(0, MAX_RESULTS_SHOWN)
      .map((r) => plain(`${hm(r.at)} ${clip(r.actor, 40)} ${t.action(l, r.action)}：${clip(oneLine(r.message), 160)}`)),
  ];
}

const DISPOSITIONS = ['act', 'ignore', 'escalate', 'undetermined'] as const;

/** 一张事件卡片。不可信文本一律放进 plain_text，不进入 markdown。 */
export function renderCard(
  chat: ChatTarget,
  d: DesiredIncidentMessage,
  results: readonly ActionResultView[],
  storm: { startedAt: Date } | null,
  opts: RenderOptions,
  signer: ButtonSigner,
): Rendered {
  const l = chat.language;
  const m = d.message;
  const headline = m.headline?.length ? m.headline.map((r) => r.text).join('') : m.title;
  const title = `${m.prefix ? `${m.prefix} ` : ''}[${t.severity(l, m.severity)}] ${clip(oneLine(headline), 160)}`;
  const header: El = {
    title: { tag: 'plain_text', content: title },
    subtitle: {
      tag: 'plain_text',
      content: `${t.state(l, d.state)} · ${t.misc(l, 'incident')} ${clip(d.label, 120)} · ${t.misc(l, 'first_firing')} ${ymdhm(d.firstFiringAt)}`,
    },
    template: d.state === 'resolved' ? 'green' : (TEMPLATE[m.severity] ?? 'grey'),
  };
  const parts: Part[] = [];
  const head: El[] = [];
  if (storm) {
    head.push(plain(t.misc(l, 'storm', { at: hm(storm.startedAt) })));
  }
  if (m.banner) {
    head.push(plain(clip(oneLine(m.banner), 200), { text_color: 'red' }));
  }
  parts.push({ priority: 0, omitted: '', elements: head });
  for (const sec of m.sections) {
    const blocks = sec.blocks.filter((b) => (b.scope ?? 'all') !== 'full');
    if (!blocks.length) {
      continue;
    }
    const title = sec.title ?? t.section(l, sec.kind);
    const els: El[] = [];
    // 带富文本片段的连续块合成一个 markdown 元素（文字已按飞书的规则转义）；不可信原文与旧结构的块用 plain_text
    let md: string[] = [];
    const flush = () => {
      if (md.length) {
        els.push({ tag: 'markdown', content: md.join('\n') });
        md = [];
      }
    };
    for (const b of blocks) {
      const model = b.model_generated ? t.misc(l, 'model') : '';
      const indent = '　'.repeat(b.indent ?? 0);
      if (b.runs?.length) {
        md.push(`${indent}${b.type === 'list_item' ? '- ' : ''}${feishuMarkdown(b.runs)}`);
        continue;
      }
      flush();
      if (b.type === 'quote') {
        els.push(
          plain(`${t.misc(l, 'source')}${clip(oneLine(b.source ?? '-'), 120)}`, {
            text_color: 'grey',
            text_size: 'notation',
          }),
        );
        els.push(plain(clip(b.text, 600), { text_color: 'grey' }));
      } else if (b.type === 'list_item') {
        els.push(plain(`- ${model}${clip(b.text, 600)}`));
      } else {
        els.push(plain(`${model}${clip(b.text, 800)}`));
      }
    }
    flush();
    const elements = sec.folded
      ? [
          {
            tag: 'collapsible_panel',
            expanded: false,
            header: { title: { tag: 'plain_text', content: title } },
            elements: els,
          },
        ]
      : [heading(title), ...els];
    parts.push({
      priority: sec.priority ?? SECTION_PRIORITY[sec.kind] ?? 1,
      omitted: sec.omitted ?? t.omitted(l, sec.kind),
      elements,
    });
  }
  parts.push({ priority: 1, omitted: t.omitted(l, 'results'), elements: writeResults(l, results) });

  const registered: RegisteredButton[] = [];
  const tail: El[] = [];
  const rowButtons: El[] = [];
  const flushRow = () => {
    if (rowButtons.length) {
      tail.push({
        tag: 'column_set',
        columns: rowButtons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
      });
      rowButtons.length = 0;
    }
  };
  for (const b of m.buttons) {
    if (b.url !== null) {
      if (publicHttpsUrl(b.url)) {
        rowButtons.push({
          tag: 'button',
          type: 'default',
          text: { tag: 'plain_text', content: b.label },
          behaviors: [{ type: 'open_url', default_url: b.url }],
        });
      } else {
        tail.push(plain(`${t.misc(l, 'console')}${b.url}`));
      }
      continue;
    }
    if (b.callback === null || !opts.callbacks) {
      continue;
    }
    const target = d.targets.find((x) => x.key === b.callback);
    if (!target) {
      throw new Error(`消息 ${d.incidentId} 的按钮 ${b.kind} 没有对应的作用对象 ${b.callback}`);
    }
    const sid = shortId(chat.channel, chat.chat, b.kind, target);
    registered.push({ shortId: sid, kind: b.kind, target, owner: null });
    const button = (type: string, submit: boolean): El => ({
      tag: 'button',
      type,
      name: `b_${sid}`,
      text: { tag: 'plain_text', content: b.label },
      ...(submit ? { form_action_type: 'submit' } : {}),
      behaviors: [{ type: 'callback', value: signer.value(sid) }],
    });
    const form = (...fields: El[]): El => ({
      tag: 'form',
      name: `f_${sid}`,
      elements: [...fields, button(b.kind === 'reject' ? 'danger' : 'default', true)],
    });
    if (b.kind === 'reject') {
      flushRow();
      tail.push(
        form({
          tag: 'input',
          name: 'reason',
          required: true,
          max_length: 500,
          placeholder: { tag: 'plain_text', content: l === 'zh' ? '拒绝原因（必填）' : 'Reason (required)' },
        }),
      );
    } else if (b.kind === 'feedback_reject') {
      flushRow();
      tail.push(form(rootSelect(l, target), reasonSelect(l)));
    } else if (b.kind === 'disposition_reject') {
      flushRow();
      tail.push(
        form(
          {
            tag: 'select_static',
            name: 'disposition',
            required: true,
            placeholder: { tag: 'plain_text', content: l === 'zh' ? '正确的处置判断' : 'Correct disposition' },
            options: DISPOSITIONS.map((v) => ({ text: { tag: 'plain_text', content: t.disposition(l, v) }, value: v })),
          },
          reasonSelect(l),
        ),
      );
    } else {
      rowButtons.push(button(b.kind === 'approve' ? 'primary' : 'default', false));
    }
  }
  flushRow();
  const payload = fit(header, parts, tail);
  return { payload, hash: payloadHash(payload), buttons: registered };
}

/** 拒绝根因与拒绝处置的表单里的原因选择（ADR 0174），必选 */
function reasonSelect(l: Language): El {
  return {
    tag: 'select_static',
    name: 'reason_code',
    required: true,
    placeholder: { tag: 'plain_text', content: l === 'zh' ? '原因' : 'Reason' },
    options: FEEDBACK_REASON_CODES.map((v) => ({ text: { tag: 'plain_text', content: t.reason(l, v) }, value: v })),
  };
}

function rootSelect(l: Language, target: ButtonTarget): El {
  return {
    tag: 'select_static',
    name: 'root',
    required: true,
    placeholder: { tag: 'plain_text', content: l === 'zh' ? '真实根因组件' : 'Actual root component' },
    options: [
      ...target.choices.map((c) => ({ text: { tag: 'plain_text', content: clip(displayKey(c), 60) }, value: c })),
      { text: { tag: 'plain_text', content: l === 'zh' ? '不知道真实根因' : 'Unknown' }, value: '-' },
    ],
  };
}

export function renderDigestCard(chat: ChatTarget, d: DigestInput, prefix: string): Rendered {
  const l = chat.language;
  const header: El = {
    title: {
      tag: 'plain_text',
      content: `${prefix ? `${prefix} ` : ''}${t.misc(l, 'digest_title', { at: hm(d.startedAt), n: d.members.length })}`,
    },
    template: 'orange',
  };
  const els: El[] = [plain(t.misc(l, 'digest_note'))];
  d.members.forEach((x, i) => {
    els.push(
      plain(
        `${i + 1}. [${t.severity(l, x.severity)}] ${clip(oneLine(x.title), 80)} · ${t.state(l, x.state)} · ${clip(x.label, 80)} · ${
          x.pendingApprovals ? t.misc(l, 'digest_pending', { n: x.pendingApprovals }) : t.misc(l, 'digest_none')
        }`,
      ),
    );
  });
  const tail: El[] = [];
  if (d.consoleUrl && publicHttpsUrl(d.consoleUrl)) {
    tail.push({
      tag: 'button',
      type: 'default',
      text: { tag: 'plain_text', content: t.misc(l, 'open_console') },
      behaviors: [{ type: 'open_url', default_url: d.consoleUrl }],
    });
  } else if (d.consoleUrl) {
    tail.push(plain(`${t.misc(l, 'console')}${d.consoleUrl}`));
  }
  const payload = fit(header, [{ priority: 0, omitted: '', elements: els }], tail);
  return { payload, hash: payloadHash(payload), buttons: [] };
}

/** 外部上游的周期汇总卡片（ADR 0147）：块都是模板文字，写成 markdown，列表项一行一个上游。 */
export function renderExternalDigestCard(chat: ChatTarget, d: ExternalDigestView, prefix: string): Rendered {
  const l = chat.language;
  const header: El = {
    title: { tag: 'plain_text', content: `${prefix ? `${prefix} ` : ''}${clip(oneLine(d.title), 160)}` },
    template: 'blue',
  };
  const md = d.blocks.map((b) => {
    const body = feishuMarkdown(b.runs ?? [{ text: b.text, style: 'plain', href: null }]);
    return b.type === 'list_item' ? `- ${body}` : body;
  });
  const els: El[] = [{ tag: 'markdown', content: md.join('\n') }];
  const tail: El[] = [];
  if (d.consoleUrl && publicHttpsUrl(d.consoleUrl)) {
    tail.push({
      tag: 'button',
      type: 'default',
      text: { tag: 'plain_text', content: t.misc(l, 'open_console') },
      behaviors: [{ type: 'open_url', default_url: d.consoleUrl }],
    });
  }
  const payload = fit(header, [{ priority: 0, omitted: '', elements: els }], tail);
  return { payload, hash: payloadHash(payload), buttons: [] };
}
