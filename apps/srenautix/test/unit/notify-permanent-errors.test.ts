import { describe, expect, it } from 'vitest';
import { FeishuAdapter } from '../../src/channels/feishu/adapter.js';
import { FeishuApiError, FeishuClient } from '../../src/channels/feishu/client.js';
import { ButtonSigner, plainCard, renderCard } from '../../src/channels/feishu/render.js';
import { TelegramAdapter } from '../../src/channels/telegram/adapter.js';
import { TelegramApiError, TelegramClient, TelegramTransportError } from '../../src/channels/telegram/client.js';
import { htmlToPlain } from '../../src/channels/telegram/html.js';
import { plainPayload, renderIncident, type TelegramPayload } from '../../src/channels/telegram/render.js';
import { composeMessage } from '../../src/notify/compose.js';
import { feishuButtonKey } from '../../src/notify/index.js';
import type { DesiredIncidentMessage } from '../../src/notify/ports.js';
import { largeIncidentInput } from '../support/report-fixture.js';
import { parseTelegramHtml } from '../support/telegram-html.js';

// ADR 0145：渠道以永久错误拒绝的内容先降级为纯文本重试一次，仍然失败就放弃；其余错误照旧

const limits = { perChatPerMinute: 20, perAppPerMinute: null, perAppPerSecond: null, editGapMs: 0 };
const tg = new TelegramAdapter(new TelegramClient('http://127.0.0.1:9', 't'), [], limits, '');
const fs = new FeishuAdapter(
  new FeishuClient('http://127.0.0.1:9', 'app', 'secret'),
  [],
  limits,
  '',
  new ButtonSigner(feishuButtonKey('secret')),
);
const tgErr = (code: number, description: string) =>
  new TelegramApiError('editMessageText', code, description, null, null);

function largeDesired(): DesiredIncidentMessage {
  const input = largeIncidentInput();
  const { message, targets } = composeMessage(input);
  const inc = input.incident;
  return {
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
  };
}

describe('Telegram 错误分类', () => {
  it.each([
    ['Bad Request: ENTITIES_TOO_LONG', 'entities_too_long'],
    ['Bad Request: entities too long', 'entities_too_long'],
    ['Bad Request: message is too long', 'message_too_long'],
    ['Bad Request: can\'t parse entities: Unsupported start tag "span" at byte offset 3', 'parse_error'],
    ['Bad Request: BUTTON_URL_INVALID', 'bad_request'],
  ])('400 %s 是永久错误（%s）', (description, reason) => {
    expect(tg.classify(tgErr(400, description))).toEqual({ kind: 'permanent', reason });
  });

  it('message is not modified、要编辑的消息不存在与群的问题不是永久错误', () => {
    expect(
      tg.classify(tgErr(400, 'Bad Request: message is not modified: specified new message content and reply markup')),
    ).toEqual({ kind: 'not_modified' });
    expect(tg.classify(tgErr(400, 'Bad Request: message to edit not found'))).toEqual({ kind: 'target_gone' });
    expect(tg.classify(tgErr(400, "Bad Request: message can't be edited"))).toEqual({ kind: 'target_gone' });
    expect(tg.classify(tgErr(400, 'Bad Request: chat not found'))).toEqual({ kind: 'api' });
    expect(tg.classify(tgErr(400, 'Bad Request: not enough rights to send text messages to the chat'))).toEqual({
      kind: 'api',
    });
    expect(tg.classify(tgErr(403, 'Forbidden: bot was kicked from the supergroup chat'))).toEqual({ kind: 'api' });
    expect(tg.classify(tgErr(429, 'Too Many Requests: retry after 7'))).toMatchObject({ kind: 'rate_limited' });
    expect(tg.classify(tgErr(401, 'Unauthorized'))).toEqual({ kind: 'fatal' });
    expect(tg.classify(new TelegramTransportError('editMessageText', 'ECONNRESET'))).toEqual({ kind: 'transport' });
  });
});

describe('Telegram 纯文本降级', () => {
  it('去掉全部标签与实体：文字与 Bot API 解析 HTML 后的文字相同，键盘不变，没有 parse_mode', () => {
    const p = renderIncident(
      { channel: 'telegram', chat: '-1001234567890', language: 'zh' },
      largeDesired(),
      [],
      null,
      { callbacks: true },
    ).payload as TelegramPayload;
    const plain = tg.plain(p) as TelegramPayload;
    expect(plain.parse_mode).toBeUndefined();
    expect(plain.text).toBe(parseTelegramHtml(p.text).text);
    expect(plain.text).not.toMatch(/<\/?(b|i|code|a|blockquote)\b/);
    expect(plain.reply_markup).toEqual(p.reply_markup);
    // 已经是纯文本时不再降级
    expect(plainPayload(plain)).toBeNull();
  });

  it('还原转义：文字中的 & < > " 原样出现', () => {
    expect(
      htmlToPlain('<b>a &amp;&lt;b&gt; &quot;c&quot;</b>\n<a href="https://x.test/?a=1&amp;b=&quot;&gt;">链接</a>'),
    ).toBe('a &<b> "c"\n链接');
  });
});

describe('飞书错误分类与纯文本降级', () => {
  it('内容错误是永久错误；频率超限、撤回与凭证错误照旧', () => {
    const e = (code: number, http = 400) => new FeishuApiError('patch', http, code, 'msg');
    expect(fs.classify(e(230001))).toEqual({ kind: 'permanent', reason: 'invalid_param' });
    expect(fs.classify(e(230025))).toEqual({ kind: 'permanent', reason: 'content_too_long' });
    expect(fs.classify(e(230099))).toEqual({ kind: 'permanent', reason: 'invalid_card' });
    expect(fs.classify(e(230020))).toMatchObject({ kind: 'rate_limited' });
    expect(fs.classify(e(230011))).toEqual({ kind: 'target_gone' });
    expect(fs.classify(e(10003))).toEqual({ kind: 'fatal' });
    expect(fs.classify(e(230002))).toEqual({ kind: 'api' });
  });

  it('降级卡片保留标题，正文合成一个 plain_text，去掉按钮、表单与 markdown 标记', () => {
    const r = renderCard(
      { channel: 'feishu', chat: 'oc_test', language: 'zh' },
      largeDesired(),
      [],
      null,
      { callbacks: true },
      new ButtonSigner(feishuButtonKey('secret')),
    );
    const card = r.payload as { header: unknown; body: { elements: unknown[] } };
    const plain = plainCard(card) as {
      schema: string;
      config: { update_multi: boolean };
      header: unknown;
      body: { elements: Array<{ tag: string; text: { tag: string; content: string } }> };
    };
    expect(plain.schema).toBe('2.0');
    expect(plain.config.update_multi).toBe(true);
    expect(plain.header).toEqual(card.header);
    expect(plain.body.elements).toHaveLength(1);
    const el = plain.body.elements[0]!;
    expect(el.tag).toBe('div');
    expect(el.text.tag).toBe('plain_text');
    expect(el.text.content.length).toBeGreaterThan(100);
    expect(el.text.content).not.toMatch(/&#\d+;|\*\*|\]\(https?:/);
    expect(JSON.stringify(plain)).not.toMatch(/"tag":"(button|form|select_static|input|markdown)"/);
    expect(Buffer.byteLength(JSON.stringify(plain))).toBeLessThan(30 * 1024);
    expect(fs.plain(card)).toEqual(plain);
  });
});
