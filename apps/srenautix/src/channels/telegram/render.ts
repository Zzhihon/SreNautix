import { createHash } from 'node:crypto';
import type { NotifyBlock, NotifyRun } from '@srenautix/contract';
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
import { shortId } from '../../notify/shortid.js';
import { clip, hm, oneLine, publicHttpsUrl, t, ymdhm } from '../../notify/text.js';
import { buildHtml, htmlToPlain, MAX_TEXT_UNITS, type Line, type Part } from './html.js';
import type { TgButton, TgInlineKeyboard } from './types.js';

/** callback_data 是前缀加 16 个字符的 short id（18 字节，Bot API 上限 64 字节）。 */
export const CALLBACK_PREFIX = 'b:';

/**
 * 存进 notify_messages.desired_payload 的 Telegram 消息内容：HTML 文本（parse_mode=HTML）与键盘。
 * 纯文本降级（plainPayload）没有 parse_mode，文字按原样显示。
 */
export interface TelegramPayload {
  text: string;
  parse_mode?: 'HTML';
  reply_markup: TgInlineKeyboard;
}

/** 去掉实体的纯文本降级（ADR 0145）：文字与键盘不变，不再有格式与链接。已经是纯文本时返回 null。 */
export function plainPayload(p: TelegramPayload): TelegramPayload | null {
  if (p.parse_mode !== 'HTML') {
    return null;
  }
  return { text: htmlToPlain(p.text), reply_markup: p.reply_markup };
}

/** 旧的四段结构（没有段级优先级时）的省略顺序：数字越小越先省略。 */
const SECTION_PRIORITY: Record<string, number> = {
  situation: 5,
  root_cause: 4,
  key_issue: 6,
  topology: 3,
  remedy: 3,
  evidence: 2,
};

/** 最近操作最多列出的条数。 */
export const MAX_RESULTS_SHOWN = 5;

const QUOTE_MAX = 600;
const LINE_MAX = 800;

export function payloadHash(p: unknown): string {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex');
}

const plain = (text: string): NotifyRun => ({ text, style: 'plain', href: null });
const bold = (text: string): NotifyRun => ({ text, style: 'bold', href: null });
const code = (text: string): NotifyRun => ({ text, style: 'code', href: null });

/** 按钮分行：同一提议的按钮一行，两个反馈维度各一行，其余各占一行。 */
function rowKey(b: { kind: string; target: ButtonTarget | null }, i: number): string {
  if (b.target?.proposalId) {
    return `p:${b.target.proposalId}`;
  }
  if (b.kind === 'feedback_confirm' || b.kind === 'feedback_reject') {
    return 'feedback_root';
  }
  if (b.kind === 'disposition_confirm' || b.kind === 'disposition_reject') {
    return 'feedback_disposition';
  }
  return `#${i}`;
}

/** 消息块 → 一行。不可信原文只出现在纯文本片段或引用块中；模型文字由组装方以斜体片段给出 */
export function blockLines(b: NotifyBlock, l: Language): Line[] {
  const indent = '  '.repeat(b.indent ?? 0);
  if (b.type === 'quote') {
    return [
      { runs: [plain(`${indent}${t.misc(l, 'source')}${clip(oneLine(b.source ?? '-'), 120)}`)] },
      { runs: [plain(clip(b.text, QUOTE_MAX))], quote: true },
    ];
  }
  const runs: NotifyRun[] = b.runs?.length
    ? clipLine(b.runs)
    : [plain(`${b.model_generated ? t.misc(l, 'model') : ''}${clip(b.text, LINE_MAX)}`)];
  if (b.type === 'list_item') {
    return [{ runs: [plain(`${indent}- `), ...runs] }];
  }
  return [{ runs: indent ? [plain(indent), ...runs] : runs }];
}

/** 单行超过上限时截短最后的片段 */
function clipLine(runs: NotifyRun[]): NotifyRun[] {
  let n = 0;
  const out: NotifyRun[] = [];
  for (const r of runs) {
    if (n + r.text.length > LINE_MAX) {
      out.push({ ...r, text: clip(r.text, Math.max(1, LINE_MAX - n)) });
      break;
    }
    out.push(r);
    n += r.text.length;
  }
  return out;
}

function resultsPart(l: Language, results: readonly ActionResultView[]): Part | null {
  if (!results.length) {
    return null;
  }
  return {
    priority: 1,
    omitted: t.omitted(l, 'results'),
    more: t.misc(l, 'more'),
    title: t.misc(l, 'results'),
    folded: false,
    lines: results.slice(0, MAX_RESULTS_SHOWN).map((r) => ({
      runs: [plain(`${hm(r.at)} ${clip(r.actor, 40)} ${t.action(l, r.action)}：${clip(oneLine(r.message), 160)}`)],
    })),
  };
}

/** 一条事件消息（parse_mode=HTML）。只在聊天里出现的块（scope 为 all 或 summary）进入消息。 */
export function renderIncident(
  chat: ChatTarget,
  d: DesiredIncidentMessage,
  results: readonly ActionResultView[],
  storm: { startedAt: Date } | null,
  opts: RenderOptions,
): Rendered {
  const l = chat.language;
  const m = d.message;
  const head: Line[] = [];
  const headline = m.headline?.length ? m.headline.map((r) => r.text).join('') : m.title;
  head.push({
    runs: [
      ...(m.prefix ? [plain(`${m.prefix} `)] : []),
      bold(`[${t.severity(l, m.severity)}] ${clip(oneLine(headline), 200)}`),
    ],
  });
  head.push({ runs: [plain(`${t.state(l, d.state)} · ${t.misc(l, 'incident')} `), code(clip(d.label, 120))] });
  head.push({ runs: [plain(`${t.misc(l, 'first_firing')} ${ymdhm(d.firstFiringAt)}`)] });
  if (storm) {
    head.push({ runs: [plain(t.misc(l, 'storm', { at: hm(storm.startedAt) }))] });
  }
  if (m.banner) {
    head.push({ runs: [bold(clip(oneLine(m.banner), 200))] });
  }
  const parts: Part[] = [{ priority: 0, omitted: '', more: '', title: null, folded: false, lines: head }];
  for (const sec of m.sections) {
    const blocks = sec.blocks.filter((b) => (b.scope ?? 'all') !== 'full');
    if (!blocks.length) {
      continue;
    }
    parts.push({
      priority: sec.priority ?? SECTION_PRIORITY[sec.kind] ?? 1,
      omitted: sec.omitted ?? t.omitted(l, sec.kind),
      more: t.misc(l, 'more'),
      title: sec.title ?? t.section(l, sec.kind),
      folded: sec.folded ?? false,
      lines: blocks.flatMap((b) => blockLines(b, l)),
    });
  }
  const res = resultsPart(l, results);
  if (res) {
    parts.push(res);
  }

  const rows = new Map<string, TgButton[]>();
  const registered: RegisteredButton[] = [];
  const textLinks: string[] = [];
  m.buttons.forEach((b, i) => {
    if (b.url !== null) {
      if (publicHttpsUrl(b.url)) {
        rows.set(`#${i}`, [{ text: b.label, url: b.url }]);
      } else {
        textLinks.push(b.url);
      }
      return;
    }
    if (b.callback === null || !opts.callbacks) {
      return;
    }
    const target = d.targets.find((x) => x.key === b.callback);
    if (!target) {
      throw new Error(`消息 ${d.incidentId} 的按钮 ${b.kind} 没有对应的作用对象 ${b.callback}`);
    }
    const sid = shortId(chat.channel, chat.chat, b.kind, target);
    registered.push({ shortId: sid, kind: b.kind, target, owner: null });
    const key = rowKey({ kind: b.kind, target }, i);
    rows.set(key, [...(rows.get(key) ?? []), { text: b.label, callback_data: CALLBACK_PREFIX + sid }]);
  });
  if (textLinks.length) {
    parts.push({
      priority: 0,
      omitted: '',
      more: '',
      title: null,
      folded: false,
      lines: textLinks.map((u) => ({ runs: [plain(t.misc(l, 'console')), code(u)] })),
    });
  }
  const { html } = buildHtml(parts, MAX_TEXT_UNITS);
  const payload: TelegramPayload = {
    text: html,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [...rows.values()] },
  };
  return { payload, hash: payloadHash(payload), buttons: registered };
}

/** 风暴汇总消息：逐行列出事件与待审批数。 */
export function renderDigest(chat: ChatTarget, d: DigestInput, prefix: string): Rendered {
  const l = chat.language;
  const head: Line[] = [
    {
      runs: [
        ...(prefix ? [plain(`${prefix} `)] : []),
        bold(t.misc(l, 'digest_title', { at: hm(d.startedAt), n: d.members.length })),
      ],
    },
    { runs: [plain(t.misc(l, 'digest_note'))] },
  ];
  const list: Line[] = d.members.flatMap((x, i) => [
    {
      runs: [
        plain(`${i + 1}. `),
        bold(`[${t.severity(l, x.severity)}] ${clip(oneLine(x.title), 80)}`),
        plain(` · ${t.state(l, x.state)} · `),
        code(clip(x.label, 80)),
      ],
    },
    {
      runs: [
        plain(
          `   ${x.pendingApprovals ? t.misc(l, 'digest_pending', { n: x.pendingApprovals }) : t.misc(l, 'digest_none')}`,
        ),
      ],
    },
  ]);
  const parts: Part[] = [
    { priority: 0, omitted: '', more: '', title: null, folded: false, lines: head },
    {
      priority: 1,
      omitted: t.misc(l, 'truncated').trim(),
      more: t.misc(l, 'truncated').trim(),
      title: null,
      folded: false,
      lines: list,
    },
  ];
  const keyboard: TgButton[][] = [];
  if (d.consoleUrl && publicHttpsUrl(d.consoleUrl)) {
    keyboard.push([{ text: t.misc(l, 'open_console'), url: d.consoleUrl }]);
  } else if (d.consoleUrl) {
    parts.push({
      priority: 0,
      omitted: '',
      more: '',
      title: null,
      folded: false,
      lines: [{ runs: [plain(t.misc(l, 'console')), code(d.consoleUrl)] }],
    });
  }
  const { html } = buildHtml(parts, MAX_TEXT_UNITS);
  const payload: TelegramPayload = { text: html, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  return { payload, hash: payloadHash(payload), buttons: [] };
}

/** 外部上游的周期汇总（ADR 0147）：粗体标题，其后是总数、业务影响与每个上游一行。 */
export function renderExternalDigest(chat: ChatTarget, d: ExternalDigestView, prefix: string): Rendered {
  const l = chat.language;
  const parts: Part[] = [
    {
      priority: 0,
      omitted: '',
      more: '',
      title: null,
      folded: false,
      lines: [{ runs: [...(prefix ? [plain(`${prefix} `)] : []), bold(clip(oneLine(d.title), 200))] }],
    },
    {
      priority: 1,
      omitted: t.misc(l, 'truncated').trim(),
      more: t.misc(l, 'more'),
      title: null,
      folded: false,
      lines: d.blocks.flatMap((b) => blockLines(b, l)),
    },
  ];
  const keyboard: TgButton[][] = [];
  if (d.consoleUrl && publicHttpsUrl(d.consoleUrl)) {
    keyboard.push([{ text: t.misc(l, 'open_console'), url: d.consoleUrl }]);
  }
  const { html } = buildHtml(parts, MAX_TEXT_UNITS);
  const payload: TelegramPayload = { text: html, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } };
  return { payload, hash: payloadHash(payload), buttons: [] };
}
