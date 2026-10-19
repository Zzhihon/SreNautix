import { createHash } from 'node:crypto';
import type {
  ActionResultView,
  ChatTarget,
  DigestInput,
  Language,
  RegisteredButton,
  Rendered,
  RenderOptions,
} from '../../notify/channel.js';
import type { ButtonTarget, DesiredIncidentMessage } from '../../notify/ports.js';
import { shortId } from '../../notify/shortid.js';
import { clip, hm, oneLine, publicHttpsUrl, t, ymdhm } from '../../notify/text.js';
import { Doc, MAX_TEXT_UNITS, type Section } from './doc.js';
import type { TgButton, TgEntity, TgInlineKeyboard } from './types.js';

/** callback_data 是前缀加 16 个字符的 short id（18 字节，Bot API 上限 64 字节）。 */
export const CALLBACK_PREFIX = 'b:';

/** 存进 notify_messages.desired_payload 的 Telegram 消息内容。 */
export interface TelegramPayload {
  text: string;
  entities: TgEntity[];
  reply_markup: TgInlineKeyboard;
}

/** 各段的省略优先级：数字越小越先省略。 */
const SECTION_PRIORITY: Record<string, number> = { situation: 5, root_cause: 4, remedy: 3, evidence: 2 };

/** 最近操作最多列出的条数。 */
export const MAX_RESULTS_SHOWN = 5;

const QUOTE_MAX = 600;

export function payloadHash(p: unknown): string {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex');
}

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

function writeResults(s: Section, l: Language, results: readonly ActionResultView[]): void {
  if (!results.length) {
    return;
  }
  s.bold(t.misc(l, 'results'));
  for (const r of results.slice(0, MAX_RESULTS_SHOWN)) {
    s.nl().plain(`${hm(r.at)} ${clip(r.actor, 40)} ${t.action(l, r.action)}：${clip(oneLine(r.message), 160)}`);
  }
}

/** 一条事件消息。不可信文本只出现在 plain 或 blockquote 实体中，不使用 parse_mode。 */
export function renderIncident(
  chat: ChatTarget,
  d: DesiredIncidentMessage,
  results: readonly ActionResultView[],
  storm: { startedAt: Date } | null,
  opts: RenderOptions,
): Rendered {
  const l = chat.language;
  const m = d.message;
  const doc = new Doc();
  const head = doc.section(0, '');
  if (m.prefix) {
    head.plain(`${m.prefix} `);
  }
  head.bold(`[${t.severity(l, m.severity)}] ${clip(oneLine(m.title), 160)}`);
  head
    .nl()
    .plain(`${t.state(l, d.state)} · ${t.misc(l, 'incident')} `)
    .code(clip(d.label, 120));
  head.nl().plain(`${t.misc(l, 'first_firing')} ${ymdhm(d.firstFiringAt)}`);
  if (storm) {
    head.nl().plain(t.misc(l, 'storm', { at: hm(storm.startedAt) }));
  }
  if (m.banner) {
    head.nl().bold(clip(oneLine(m.banner), 200));
  }
  for (const sec of m.sections) {
    if (!sec.blocks.length) {
      continue;
    }
    const s = doc.section(SECTION_PRIORITY[sec.kind] ?? 1, t.omitted(l, sec.kind));
    s.bold(t.section(l, sec.kind));
    for (const b of sec.blocks) {
      const model = b.model_generated ? t.misc(l, 'model') : '';
      if (b.type === 'quote') {
        s.nl().plain(`${t.misc(l, 'source')}${clip(oneLine(b.source ?? '-'), 120)}`);
        s.nl().quote(clip(b.text, QUOTE_MAX));
      } else if (b.type === 'list_item') {
        s.nl().plain(`- ${model}${clip(b.text, 600)}`);
      } else {
        s.nl().plain(`${model}${clip(b.text, 800)}`);
      }
    }
  }
  writeResults(doc.section(1, t.omitted(l, 'results')), l, results);

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
    const s = doc.section(0, '');
    textLinks.forEach((u, i) => {
      if (i) {
        s.nl();
      }
      s.plain(t.misc(l, 'console')).code(u);
    });
  }
  const { text, entities } = doc.build(MAX_TEXT_UNITS, t.misc(l, 'truncated'));
  const payload: TelegramPayload = { text, entities, reply_markup: { inline_keyboard: [...rows.values()] } };
  return { payload, hash: payloadHash(payload), buttons: registered };
}

/** 风暴汇总消息：逐行列出事件与待审批数。 */
export function renderDigest(chat: ChatTarget, d: DigestInput, prefix: string): Rendered {
  const l = chat.language;
  const doc = new Doc();
  const head = doc.section(0, '');
  if (prefix) {
    head.plain(`${prefix} `);
  }
  head.bold(t.misc(l, 'digest_title', { at: hm(d.startedAt), n: d.members.length }));
  head.nl().plain(t.misc(l, 'digest_note'));
  const list = doc.section(0, '');
  d.members.forEach((x, i) => {
    if (i) {
      list.nl();
    }
    list.plain(`${i + 1}. `).bold(`[${t.severity(l, x.severity)}] ${clip(oneLine(x.title), 80)}`);
    list.plain(` · ${t.state(l, x.state)} · `).code(clip(x.label, 80));
    list
      .nl()
      .plain(
        `   ${x.pendingApprovals ? t.misc(l, 'digest_pending', { n: x.pendingApprovals }) : t.misc(l, 'digest_none')}`,
      );
  });
  const keyboard: TgButton[][] = [];
  if (d.consoleUrl && publicHttpsUrl(d.consoleUrl)) {
    keyboard.push([{ text: t.misc(l, 'open_console'), url: d.consoleUrl }]);
  } else if (d.consoleUrl) {
    doc.section(0, '').plain(t.misc(l, 'console')).code(d.consoleUrl);
  }
  const { text, entities } = doc.build(MAX_TEXT_UNITS, t.misc(l, 'truncated'));
  const payload: TelegramPayload = { text, entities, reply_markup: { inline_keyboard: keyboard } };
  return { payload, hash: payloadHash(payload), buttons: [] };
}
