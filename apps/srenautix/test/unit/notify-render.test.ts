import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NotifyRun } from '@srenautix/contract';
import { ButtonSigner, MAX_CARD_BYTES, renderCard, renderDigestCard } from '../../src/channels/feishu/render.js';
import { buildHtml, MAX_ENTITIES, MAX_TEXT_UNITS, type Part } from '../../src/channels/telegram/html.js';
import {
  CALLBACK_PREFIX,
  renderDigest,
  renderIncident,
  type TelegramPayload,
} from '../../src/channels/telegram/render.js';
import type { ActionResultView, ChatTarget, DigestInput, Rendered } from '../../src/notify/channel.js';
import { composeMessage, type ComposeInput } from '../../src/notify/compose.js';
import { feishuButtonKey } from '../../src/notify/index.js';
import { issueMarkdown } from '../../src/notify/markdown.js';
import type { DesiredIncidentMessage } from '../../src/notify/ports.js';
import { releaseRolloutInput } from '../support/report-fixture.js';
import { parseTelegramHtml } from '../support/telegram-html.js';

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

/** HTML 消息按 Bot API 的规则解析（不合法时抛出，对应 400 can't parse entities），并检查长度与实体数 */
function parsed(p: TelegramPayload): ReturnType<typeof parseTelegramHtml> {
  expect(p.parse_mode).toBe('HTML');
  const r = parseTelegramHtml(p.text);
  expect(r.text.length).toBeGreaterThan(0);
  expect(r.text.length).toBeLessThanOrEqual(MAX_TEXT_UNITS);
  expect(r.entities.length).toBeLessThanOrEqual(MAX_ENTITIES);
  expect(hasLoneSurrogate(r.text), '截断切开了代理对').toBe(false);
  return r;
}

describe('Telegram 渲染黄金用例', () => {
  for (const c of cases.filter((x) => x.channels.includes('telegram'))) {
    it(`${c.file}：${c.name}`, () => {
      const r = telegram(c);
      const p = r.payload as TelegramPayload;
      const { text, entities } = parsed(p);
      checkText(text, c.expect);
      expect(text.length).toBeLessThanOrEqual(c.expect.max_units ?? MAX_TEXT_UNITS);
      for (const ent of entities) {
        expect(ent.offset + ent.length).toBeLessThanOrEqual(text.length);
        if (c.expect.only_entity_types) {
          expect(c.expect.only_entity_types).toContain(ent.type);
        }
      }
      for (const want of c.expect.entities ?? []) {
        const found = entities.some(
          (x) => x.type === want.type && text.slice(x.offset, x.offset + x.length) === want.text,
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

const run = (text: string, style: NotifyRun['style'] = 'plain', href: string | null = null): NotifyRun => ({
  text,
  style,
  href,
});
const part = (o: Partial<Part> & { lines: Part['lines'] }): Part => ({
  priority: 1,
  omitted: '段已省略',
  more: '…其余见控制台',
  title: null,
  folded: false,
  ...o,
});

describe('Telegram HTML 组装', () => {
  it('转义 &、<、> 与链接中的引号；只用 Bot API 支持的标签；非 http(s) 链接按纯文字输出', () => {
    const r = buildHtml([
      part({
        priority: 0,
        lines: [
          {
            runs: [
              run('<b>click</b> & "x" &amp; ', 'plain'),
              run('a<b', 'code'),
              run(' 链接', 'italic', 'https://example.test/q?a=1&b="2"'),
              run(' 坏链接', 'bold', 'javascript:alert(1)'),
            ],
          },
          { runs: [run('引用 <i>不是格式</i>')], quote: true },
        ],
      }),
    ]);
    const p = parseTelegramHtml(r.html);
    expect(p.text).toBe('<b>click</b> & "x" &amp; a<b 链接 坏链接\n引用 <i>不是格式</i>');
    expect(p.entities.map((e) => e.type)).toEqual(['code', 'italic', 'text_link', 'bold', 'blockquote']);
    expect(p.entities.find((e) => e.type === 'text_link')?.url).toBe('https://example.test/q?a=1&b=%222%22');
    expect(r.units).toBe(p.text.length);
  });

  it('超长时从优先级最低的段的末尾逐块删减，标签闭合，折叠段整段在可展开引用块中', () => {
    const lines = (n: number, w: string) =>
      Array.from({ length: n }, (_, i) => ({
        runs: [run(`${w}${i} `, 'bold'), run('😀'.repeat(40)), run(' x', 'code')],
      }));
    const r = buildHtml([
      part({ priority: 0, title: '头部', lines: lines(3, '头') }),
      part({ priority: 3, title: '建议', omitted: '建议已省略', lines: lines(60, '建') }),
      part({ priority: 2, title: '证据', folded: true, omitted: '证据已省略', lines: lines(60, '证') }),
    ]);
    const p = parseTelegramHtml(r.html);
    expect(p.text.length).toBeLessThanOrEqual(MAX_TEXT_UNITS);
    expect(r.units).toBe(p.text.length);
    expect(hasLoneSurrogate(p.text)).toBe(false);
    // 证据段（优先级低）先删减到只剩省略说明，建议段保留一部分块并以“其余见控制台”结尾
    expect(p.text).toContain('证据已省略');
    expect(p.text).not.toContain('证0 ');
    expect(p.text).toContain('建0 ');
    expect(p.text).toMatch(/建\d+ [😀]+ x\n…其余见控制台/u);
    expect(p.entities.length).toBeLessThanOrEqual(MAX_ENTITIES);
  });

  it('折叠段放在 blockquote expandable 中；实体超过 100 个时依次放弃等宽、强调与链接的格式', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      runs: [run(`r${i}`, 'code'), run(' ', 'plain'), run('t', 'bold'), run(' l', 'plain', `https://e.test/${i}`)],
    }));
    const r = buildHtml([part({ priority: 0, title: '证据', folded: true, lines: many })]);
    const p = parseTelegramHtml(r.html);
    expect(r.html.startsWith('<b>证据</b>\n<blockquote expandable>')).toBe(true);
    expect(p.entities).toHaveLength(MAX_ENTITIES);
    const count = (t: string) => p.entities.filter((e) => e.type === t).length;
    // 段标题与引用块 2 个，链接 80 个，加粗 18 个，等宽 0 个
    expect([count('bold') - 1, count('expandable_blockquote'), count('text_link'), count('code')]).toEqual([
      18, 1, 80, 0,
    ]);
  });

  it('单块超过上限时截短并以“…”结尾，不切开代理对', () => {
    const r = buildHtml([part({ priority: 0, lines: [{ runs: [run('😀'.repeat(3000), 'bold')] }] })]);
    const p = parseTelegramHtml(r.html);
    expect(p.text.length).toBeLessThanOrEqual(MAX_TEXT_UNITS);
    expect(p.text.endsWith('…')).toBe(true);
    expect(hasLoneSurrogate(p.text)).toBe(false);
  });
});

describe('事件报告：2026-10-20 发布事故（黄金用例）', () => {
  const telegramOf = (input: ComposeInput) => {
    const { message, targets } = composeMessage(input);
    const inc = input.incident;
    const d: DesiredIncidentMessage = {
      incidentId: inc.incident_id,
      clusterId: inc.cluster_id,
      label: inc.label,
      severity: inc.severity,
      state: inc.state,
      firstFiringAt: new Date(inc.first_firing_at),
      endedAt: inc.ended_at ? new Date(inc.ended_at) : null,
      lane: 'urgent',
      message,
      targets,
      language: 'zh',
    };
    return {
      message,
      payload: renderIncident({ channel: 'telegram', chat: '-1001234567890', language: 'zh' }, d, [], null, {
        callbacks: true,
      }).payload as TelegramPayload,
    };
  };

  it('Telegram HTML 与黄金文件一致，并能按 Bot API 的规则解析', async () => {
    const { payload } = telegramOf(releaseRolloutInput());
    const { text, entities } = parsed(payload);
    await expect(payload.text).toMatchFileSnapshot('../fixtures/report/release-rollout-2026-10-20.telegram.html');
    // 主线顺序：现状 → 关键问题 → 拓扑联系 → 解决方案 → 证据链
    checkText(text, {
      starts_with: '[影子] [严重] StatefulSet:acme-prod/gateway：worker 没有可用副本',
      order: ['现状', '时间线（UTC，10-20）', '关键问题', '拓扑联系', '解决方案', '证据链'],
      contains: [
        '发布 rel-9a8c9cd6（15:59:52）与回退到 rel-fd8097cf（16:24:25）期间',
        '结论：可能（likely）',
        '不满足：同一信号上有 5 张相反的正常卡',
        '【模型】机制：',
        '—managed_by→ Application.argoproj.io:argocd/acme-prod —manages→ Deployment:acme-prod/control',
        '已执行的检查',
      ],
    });
    // 证据链在可展开的引用块里；每张卡带控制台卡片详情与数据源查询的链接
    expect(entities.some((e) => e.type === 'expandable_blockquote')).toBe(true);
    const urls = entities.filter((e) => e.type === 'text_link').map((e) => e.url!);
    expect(urls).toContain(
      'https://srenautix.example.test/incidents/e88a2a7c-0000-4000-8000-e88a2a7ca284?tab=evidence#card-38',
    );
    expect(urls.some((u) => u.startsWith('https://vm.example.test/vmui/#/?g0.expr='))).toBe(true);
    expect(urls.some((u) => u.startsWith('https://argocd.example.test/applications/argocd/acme-prod'))).toBe(true);
    // 模型写的文字都是斜体并带【模型】
    for (const e of entities.filter((x) => x.type === 'italic')) {
      expect(text.slice(e.offset, e.offset + e.length).startsWith('【模型】')).toBe(true);
    }
  });

  it("证据与告警里的 HTML、实体与 Markdown 原样作为文字出现，Bot API 能解析（#169 的 400 can't parse entities）", () => {
    const input = releaseRolloutInput();
    const evil = '<b>x</b> & &amp; <a href="javascript:1">y</a> </blockquote> **z** `w`';
    const c38 = input.researchStageA!.cards.find((c) => c.ref === 'card:38')!;
    c38.reason = { kind: 'rule', text: evil };
    c38.conditions = (c38.conditions ?? []).map((c) => (c.outcome === 'hit' ? { ...c, say: evil } : c));
    input.alerts = input.alerts.map((a) => ({ ...a, alertname: `${a.alertname}<&>` }));
    const { payload } = telegramOf(input);
    const { text } = parsed(payload);
    expect(text).toContain(evil);
    expect(text).toContain('KubePdbBlockingEviction<&>');
    expect(payload.text).not.toMatch(/<a href="javascript/);
  });

  it('飞书卡片：同样的五段，证据链在折叠面板中，markdown 文字已转义，大小不超过上限', () => {
    const { message, targets } = composeMessage(releaseRolloutInput());
    const inc = releaseRolloutInput().incident;
    const r = renderCard(
      { channel: 'feishu', chat: 'oc_x', language: 'zh' },
      {
        incidentId: inc.incident_id,
        clusterId: inc.cluster_id,
        label: inc.label,
        severity: inc.severity,
        state: inc.state,
        firstFiringAt: new Date(inc.first_firing_at),
        endedAt: null,
        lane: 'urgent',
        message,
        targets,
        language: 'zh',
      },
      [],
      null,
      { callbacks: true },
      signer,
    );
    const json = JSON.stringify(r.payload);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(json).toContain('"tag":"collapsible_panel"');
    const { text, markdown } = cardText(r.payload);
    checkText(text, { order: ['现状', '关键问题', '拓扑联系', '解决方案'] });
    // 链接以 markdown 写出，文字中的特殊字符已转义
    expect(markdown.some((m) => m.includes('[控制台](https://srenautix.example.test/incidents/'))).toBe(true);
    expect(markdown.join('\n')).not.toMatch(/<(?!br)/);
  });

  it('恢复后：问题陈述写恢复时间与持续时长，时间线以事件恢复结束', () => {
    const { payload } = telegramOf(releaseRolloutInput('end'));
    const { text } = parsed(payload);
    expect(text).toContain('18:49 恢复，持续 2 小时 59 分');
    expect(text).toContain('已恢复 · 事件');
  });

  it('issue 正文是全文：每个假设的全部证据、成员告警与变更带来源链接，Markdown 特殊字符已转义', () => {
    const { message } = telegramOf(releaseRolloutInput());
    const { title, body } = issueMarkdown(message, '<!-- srenautix:incident=x -->', '由 SreNautix 生成');
    expect(title).toBe('[影子] StatefulSet:acme-prod/gateway：worker 没有可用副本');
    for (const s of [
      '## 现状',
      '## 关键问题',
      '## 拓扑联系',
      '## 解决方案',
      '## 证据链',
      '#### 成员告警',
      '#### 变更',
    ]) {
      expect(body).toContain(s);
    }
    // 摘要中省略的支持卡在全文中都有
    expect(body).toContain('`card:76`');
    expect(body).not.toContain('其余 27 张见控制台');
    expect(body).toContain('[控制台](https://srenautix.example.test/incidents/');
    expect(body).toContain('_【模型】机制：');
    expect(body).toMatch(/\[发布 rel-9a8c9cd6\]\(https:\/\/argocd\.example\.test\/applications\/argocd\/acme-prod\)/);
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
