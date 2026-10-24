import { describe, expect, it } from 'vitest';
import type { NotifyRun } from '@srenautix/contract';
import {
  buildHtml,
  entityBytes,
  MAX_ENTITIES,
  MAX_ENTITY_BYTES,
  MAX_TEXT_UNITS,
  type Part,
} from '../../src/channels/telegram/html.js';
import { renderIncident, type TelegramPayload } from '../../src/channels/telegram/render.js';
import { composeMessage, type ComposeInput } from '../../src/notify/compose.js';
import type { DesiredIncidentMessage } from '../../src/notify/ports.js';
import { largeIncidentInput } from '../support/report-fixture.js';
import { parseTelegramHtml, serializedEntityBytes, TELEGRAM_ENTITY_BYTES_LIMIT } from '../support/telegram-html.js';

// #13：大事件的 editMessageText 返回 400 ENTITIES_TOO_LONG。文字长度（4096）与实体数（100）都没有超，
// 超的是实体列表序列化后的总大小：告警来源与数据源查询的链接很长

function telegramOf(input: ComposeInput): TelegramPayload {
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
  return renderIncident({ channel: 'telegram', chat: '-1001234567890', language: 'zh' }, d, [], null, {
    callbacks: true,
  }).payload as TelegramPayload;
}

/** 消息里全部链接片段的地址（不论最后有没有分到实体） */
function composedLinks(input: ComposeInput): string[] {
  const { message } = composeMessage(input);
  return message.sections.flatMap((s) =>
    s.blocks.flatMap((b) => (b.runs ?? []).filter((r) => r.href).map((r) => r.href as string)),
  );
}

describe('Telegram 实体总大小（ENTITIES_TOO_LONG）', () => {
  it('实体的字节数与独立实现的 TL 序列化相同', () => {
    const urls = [
      'https://a.test/',
      `https://a.test/${'x'.repeat(237)}`,
      `https://a.test/${'x'.repeat(238)}`,
      'https://例子.test/路径',
    ];
    for (const url of urls) {
      expect(entityBytes('text_link', url) + 8).toBe(
        serializedEntityBytes([{ type: 'text_link', offset: 0, length: 1, url }]),
      );
    }
    expect(entityBytes('blockquote') + 8).toBe(serializedEntityBytes([{ type: 'blockquote', offset: 0, length: 1 }]));
    expect(entityBytes('other') + 8).toBe(serializedEntityBytes([{ type: 'bold', offset: 0, length: 1 }]));
  });

  it('70 个成员、53 张卡的事件：按 Bot API 的规则解析，文字、实体数与实体总大小都不超限（黄金文件）', async () => {
    const input = largeIncidentInput();
    expect(input.incident.members).toHaveLength(70);
    expect(input.stageA!.cards).toHaveLength(53);
    // 复现：组装出的链接全部用作实体时远超服务端的上限
    const all = composedLinks(input);
    expect(serializedEntityBytes(all.map((url) => ({ type: 'text_link', offset: 0, length: 1, url })))).toBeGreaterThan(
      2 * TELEGRAM_ENTITY_BYTES_LIMIT,
    );
    const payload = telegramOf(input);
    const { text, entities } = parseTelegramHtml(payload.text);
    await expect(payload.text).toMatchFileSnapshot('../fixtures/report/large-incident.telegram.html');
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_UNITS);
    expect(entities.length).toBeLessThanOrEqual(MAX_ENTITIES);
    const bytes = serializedEntityBytes(entities);
    expect(bytes).toBeLessThanOrEqual(MAX_ENTITY_BYTES);
    expect(bytes).toBeLessThan(TELEGRAM_ENTITY_BYTES_LIMIT);
    // 链接放不下时文字照样保留，只是不带链接；前面的段（告警来源）优先分到链接
    const links = entities.filter((e) => e.type === 'text_link');
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThan(all.length);
    expect(text.startsWith('[影子] [严重]')).toBe(true);
    expect(text).toContain('证据链');
  });
});

describe('buildHtml 的实体字节预算', () => {
  const run = (text: string, href: string | null = null, style: NotifyRun['style'] = 'plain'): NotifyRun => ({
    text,
    style,
    href,
  });
  const part = (lines: NotifyRun[][]): Part => ({
    priority: 0,
    omitted: '',
    more: '',
    title: '段',
    folded: false,
    lines: lines.map((runs) => ({ runs })),
  });

  it('按输出顺序分配链接，放不下的长链接按纯文字输出，后面较短的链接照样带链接；文字不变、标签闭合', () => {
    const long = (i: number) => `https://vmalert.example.test/alert?id=${i}&expr=${'x'.repeat(2000)}`;
    const lines: NotifyRun[][] = [];
    for (let i = 0; i < 6; i++) {
      lines.push([run(`告警${i} `, long(i)), run('值 ', null), run('0.35', null, 'code')]);
    }
    lines.push([run('短链接', 'https://console.example.test/incidents/1')]);
    const { html } = buildHtml([part(lines)]);
    const { text, entities } = parseTelegramHtml(html);
    expect(serializedEntityBytes(entities)).toBeLessThanOrEqual(MAX_ENTITY_BYTES);
    const urls = entities.filter((e) => e.type === 'text_link').map((e) => e.url);
    // 每个长链接约 2050 字节，只放得下 4 个
    expect(urls).toEqual([long(0), long(1), long(2), long(3), 'https://console.example.test/incidents/1']);
    for (let i = 0; i < 6; i++) {
      expect(text).toContain(`告警${i} 值 0.35`);
    }
    // 等宽与段标题照样有格式
    expect(entities.filter((e) => e.type === 'code')).toHaveLength(6);
    expect(entities.filter((e) => e.type === 'bold')).toHaveLength(1);
  });

  it('单个链接超过整个预算时按纯文字输出', () => {
    const { html } = buildHtml([part([[run('巨长', `https://a.test/${'y'.repeat(MAX_ENTITY_BYTES)}`)]])]);
    expect(html).not.toContain('<a ');
    expect(parseTelegramHtml(html).text).toContain('巨长');
  });
});
