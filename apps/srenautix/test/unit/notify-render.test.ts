import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ButtonSigner, MAX_CARD_BYTES, renderCard, renderDigestCard } from '../../src/channels/feishu/render.js';
import { Doc, MAX_TEXT_UNITS } from '../../src/channels/telegram/doc.js';
import {
  CALLBACK_PREFIX,
  renderDigest,
  renderIncident,
  type TelegramPayload,
} from '../../src/channels/telegram/render.js';
import type { ActionResultView, ChatTarget, DigestInput, Rendered } from '../../src/notify/channel.js';
import { feishuButtonKey } from '../../src/notify/index.js';
import type { DesiredIncidentMessage } from '../../src/notify/ports.js';

/** test/fixtures/render 下的渲染黄金用例，格式见该目录的 README.md。 */
interface RenderCase {
  file: string;
  name: string;
  kind: 'incident' | 'digest';
  channels: Array<'telegram' | 'feishu'>;
  chat: ChatTarget;
  results: ActionResultView[];
  storm: { startedAt: Date } | null;
  prefix: string;
  incident: DesiredIncidentMessage | null;
  digest: DigestInput | null;
  expect: {
    contains?: string[];
    not_contains?: string[];
    order?: string[];
    starts_with?: string;
    buttons?: string[][];
    url_buttons?: number;
    entities?: Array<{ type: string; text: string }>;
    only_entity_types?: string[];
    max_units?: number;
    feishu_buttons?: string[];
  };
}

const DIR = resolve(import.meta.dirname, '../fixtures/render');

/** 展开 {"$repeat": s, "times": n}。 */
function expand(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(expand);
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$repeat === 'string' && typeof o.times === 'number') {
      return o.$repeat.repeat(o.times);
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, expand(x)]));
  }
  return v;
}

function loadRenderCases(): RenderCase[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = expand(JSON.parse(readFileSync(join(DIR, file), 'utf8'))) as Record<string, unknown>;
      const chat = raw.chat as { chat: string; language: 'zh' | 'en' };
      const kind = raw.kind as 'incident' | 'digest';
      const input = raw.input as Record<string, unknown>;
      return {
        file,
        name: raw.name as string,
        kind,
        channels: raw.channels as Array<'telegram' | 'feishu'>,
        chat: { channel: 'telegram', chat: chat.chat, language: chat.language },
        results: ((raw.results as Array<Record<string, unknown>> | undefined) ?? []).map(
          (r) => ({ ...r, at: new Date(r.at as string) }) as ActionResultView,
        ),
        storm: raw.storm ? { startedAt: new Date((raw.storm as { startedAt: string }).startedAt) } : null,
        prefix: (raw.prefix as string | undefined) ?? '',
        incident:
          kind === 'incident'
            ? ({
                ...input,
                firstFiringAt: new Date(input.firstFiringAt as string),
                endedAt: input.endedAt ? new Date(input.endedAt as string) : null,
              } as DesiredIncidentMessage)
            : null,
        digest:
          kind === 'digest' ? ({ ...input, startedAt: new Date(input.startedAt as string) } as DigestInput) : null,
        expect: raw.expect as RenderCase['expect'],
      };
    });
}

const cases = loadRenderCases();
const signer = new ButtonSigner(feishuButtonKey('test-app-secret'));

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n < 0xe000)) {
        return true;
      }
      i++;
    } else if (c >= 0xdc00 && c < 0xe000) {
      return true;
    }
  }
  return false;
}

function telegram(c: RenderCase): Rendered {
  return c.kind === 'incident'
    ? renderIncident(c.chat, c.incident as NonNullable<RenderCase['incident']>, c.results, c.storm, { callbacks: true })
    : renderDigest(c.chat, c.digest as NonNullable<RenderCase['digest']>, c.prefix);
}

function checkText(text: string, e: RenderCase['expect']): void {
  if (e.starts_with) {
    expect(text.startsWith(e.starts_with), `开头应为 ${e.starts_with}：\n${text}`).toBe(true);
  }
  for (const s of e.contains ?? []) {
    expect(text, `缺少 ${s}`).toContain(s);
  }
  for (const s of e.not_contains ?? []) {
    expect(text, `不应出现 ${s}`).not.toContain(s);
  }
  let last = -1;
  for (const s of e.order ?? []) {
    const i = text.indexOf(s, last + 1);
    expect(i, `${s} 缺失或顺序不对：\n${text}`).toBeGreaterThan(last);
    last = i;
  }
}

describe('Telegram 渲染黄金用例', () => {
  for (const c of cases.filter((x) => x.channels.includes('telegram'))) {
    it(`${c.file}：${c.name}`, () => {
      const r = telegram(c);
      const p = r.payload as TelegramPayload;
      checkText(p.text, c.expect);
      expect(p.text.length).toBeGreaterThan(0);
      expect(p.text.length).toBeLessThanOrEqual(c.expect.max_units ?? MAX_TEXT_UNITS);
      expect(hasLoneSurrogate(p.text), '截断切开了代理对').toBe(false);
      for (const ent of p.entities) {
        expect(ent.offset).toBeGreaterThanOrEqual(0);
        expect(ent.length).toBeGreaterThan(0);
        expect(ent.offset + ent.length).toBeLessThanOrEqual(p.text.length);
        if (c.expect.only_entity_types) {
          expect(c.expect.only_entity_types).toContain(ent.type);
        }
      }
      for (const want of c.expect.entities ?? []) {
        const found = p.entities.some(
          (x) => x.type === want.type && p.text.slice(x.offset, x.offset + x.length) === want.text,
        );
        expect(found, `缺少实体 ${want.type}：${want.text}`).toBe(true);
      }
      if (c.expect.buttons) {
        expect(p.reply_markup.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual(c.expect.buttons);
      }
      const all = p.reply_markup.inline_keyboard.flat();
      if (c.expect.url_buttons !== undefined) {
        expect(all.filter((b) => b.url).length).toBe(c.expect.url_buttons);
      }
      const ids = new Set(r.buttons.map((b) => b.shortId));
      for (const b of all) {
        expect(Boolean(b.url) !== Boolean(b.callback_data), '按钮必须恰好是 URL 或回调之一').toBe(true);
        if (b.callback_data) {
          expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
          expect(b.callback_data.startsWith(CALLBACK_PREFIX)).toBe(true);
          expect(ids.has(b.callback_data.slice(CALLBACK_PREFIX.length)), '回调按钮必须登记').toBe(true);
        }
        if (b.url) {
          expect(b.url.startsWith('https://')).toBe(true);
        }
      }
      // 同样的输入渲染两次，short id 与哈希不变
      expect(telegram(c).hash).toBe(r.hash);
    });
  }

  it('不同渠道目标的同一个按钮得到不同的 short id；状态库降级时不登记回调按钮', () => {
    const c = cases.find((x) => x.file === 'buttons-layout.json') as RenderCase;
    const a = renderIncident(c.chat, c.incident!, [], null, { callbacks: true });
    const b = renderIncident({ ...c.chat, chat: '-1009999999999' }, c.incident!, [], null, { callbacks: true });
    expect(a.buttons[0]!.shortId).not.toBe(b.buttons[0]!.shortId);
    const degraded = renderIncident(c.chat, c.incident!, [], null, { callbacks: false });
    expect(degraded.buttons).toEqual([]);
    expect((degraded.payload as TelegramPayload).reply_markup.inline_keyboard.flat().every((x) => x.url)).toBe(true);
  });

  it('所属风暴写在头部', () => {
    const c = cases.find((x) => x.file === 'feedback-buttons.json') as RenderCase;
    const r = renderIncident(
      c.chat,
      c.incident!,
      [],
      { startedAt: new Date('2026-10-16T09:58:00Z') },
      { callbacks: true },
    );
    expect((r.payload as TelegramPayload).text).toContain('属于 09:58 UTC 开始的事件风暴，汇总消息中列出全部事件');
  });

  it('按钮没有对应的作用对象时立即失败', () => {
    const c = cases.find((x) => x.file === 'buttons-layout.json') as RenderCase;
    expect(() => renderIncident(c.chat, { ...c.incident!, targets: [] }, [], null, { callbacks: true })).toThrow(
      /没有对应的作用对象/,
    );
  });
});

describe('Telegram 文本组装', () => {
  it('硬截断保持实体有效、不切开代理对，并追加说明', () => {
    const d = new Doc();
    const s = d.section(0, '');
    for (let i = 0; i < 600; i++) {
      s.bold('告警🔥').plain(` 第 ${i} 行 😀`).nl();
    }
    const note = '\n…（内容过长已截断）';
    const r = d.build(MAX_TEXT_UNITS, note);
    expect(r.text.length).toBeLessThanOrEqual(MAX_TEXT_UNITS);
    expect(r.text.endsWith(note)).toBe(true);
    expect(hasLoneSurrogate(r.text)).toBe(false);
    for (const e of r.entities) {
      expect(e.offset + e.length).toBeLessThanOrEqual(r.text.length - note.length);
    }
  });

  it('先省略优先级小的段', () => {
    const d = new Doc();
    d.section(0, '').plain('头部');
    d.section(2, '建议已省略').plain('建'.repeat(3000));
    d.section(1, '操作已省略').plain('操'.repeat(3000));
    const r = d.build(MAX_TEXT_UNITS, '');
    expect(r.text).toContain('操作已省略');
    expect(r.text).not.toContain('建议已省略');
  });
});

/** 飞书卡片中按元素顺序拼接的全部文字（标题、副标题、文本、按钮）。 */
function cardText(card: unknown): { text: string; buttons: string[]; markdown: string[] } {
  const parts: string[] = [];
  const buttons: string[] = [];
  const markdown: string[] = [];
  const c = card as {
    header: { title: { content: string }; subtitle?: { content: string } };
    body: { elements: unknown[] };
  };
  parts.push(c.header.title.content);
  if (c.header.subtitle) {
    parts.push(c.header.subtitle.content);
  }
  const walk = (e: unknown) => {
    if (!e || typeof e !== 'object') {
      return;
    }
    const o = e as Record<string, unknown>;
    if (o.tag === 'div') {
      parts.push((o.text as { content: string }).content);
    } else if (o.tag === 'markdown') {
      markdown.push(o.content as string);
      parts.push((o.content as string).replace(/\*\*/g, ''));
    } else if (o.tag === 'button') {
      buttons.push((o.text as { content: string }).content);
    }
    for (const k of ['elements', 'columns']) {
      if (Array.isArray(o[k])) {
        (o[k] as unknown[]).forEach(walk);
      }
    }
  };
  c.body.elements.forEach(walk);
  return { text: parts.join('\n'), buttons, markdown };
}

describe('飞书卡片渲染黄金用例', () => {
  for (const c of cases.filter((x) => x.channels.includes('feishu'))) {
    it(`${c.file}：${c.name}`, () => {
      const chat = { ...c.chat, channel: 'feishu' as const, chat: 'oc_e4d2605ca917e695f54f11aaf56f0001' };
      const r =
        c.kind === 'incident'
          ? renderCard(chat, c.incident!, c.results, c.storm, { callbacks: true }, signer)
          : renderDigestCard(chat, c.digest!, c.prefix);
      const card = r.payload as { schema: string; config: { update_multi: boolean } };
      expect(card.schema).toBe('2.0');
      expect(card.config.update_multi).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(MAX_CARD_BYTES);
      const { text, buttons, markdown } = cardText(card);
      checkText(text, { ...c.expect });
      if (c.expect.feishu_buttons) {
        expect(buttons).toEqual(c.expect.feishu_buttons);
      }
      // 不可信文本只出现在 plain_text 中，markdown 元素只有模板标题
      for (const q of c.incident?.message.sections.flatMap((s) => s.blocks) ?? []) {
        for (const m of markdown) {
          expect(m).not.toContain(q.text.slice(0, 20));
        }
      }
      for (const b of r.buttons) {
        expect(JSON.stringify(card)).toContain(JSON.stringify(signer.value(b.shortId)));
      }
    });
  }

  it('超过 30 KB 时按优先级省略段落', () => {
    const c = cases.find((x) => x.file === 'sections-omitted-by-priority.json') as RenderCase;
    const big = {
      ...c.incident!,
      message: {
        ...c.incident!.message,
        sections: c.incident!.message.sections.map((s) => ({
          ...s,
          blocks: Array.from({ length: 12 }, () => ({
            type: 'text' as const,
            text: '证据'.repeat(390),
            source: null,
            model_generated: false,
          })),
        })),
      },
    };
    const r = renderCard(
      { channel: 'feishu', chat: 'oc_x', language: 'zh' },
      big,
      [],
      null,
      { callbacks: true },
      signer,
    );
    expect(Buffer.byteLength(JSON.stringify(r.payload))).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(cardText(r.payload).text).toContain('4. 相关证据已省略，见控制台');
    expect(cardText(r.payload).buttons).toEqual(['批准 #1']);
  });
});
