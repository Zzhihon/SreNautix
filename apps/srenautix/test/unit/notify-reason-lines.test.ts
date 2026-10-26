import { REASON_CODES, reasonText } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { MAX_ENTITIES, MAX_ENTITY_BYTES, MAX_TEXT_UNITS } from '../../src/channels/telegram/html.js';
import { renderIncident, type TelegramPayload } from '../../src/channels/telegram/render.js';
import { composeMessage, finalMessage, type ComposeInput } from '../../src/notify/compose.js';
import type { DesiredIncidentMessage } from '../../src/notify/ports.js';
import { largeIncidentInput, releaseRolloutInput } from '../support/report-fixture.js';
import { parseTelegramHtml, serializedEntityBytes, TELEGRAM_ENTITY_BYTES_LIMIT } from '../support/telegram-html.js';

// 群消息的说明行（ADR 0172、0173）：研判失败、只出阶段 A 与入队跳过写原因码对应的文字；还没有阶段 A 报告时不带证据卡，
// 带一行“阶段 A 尚未生成：原因”；已结束事件编辑次数用完后的最后一次编辑是精简内容加说明行。新增的内容仍在 Telegram 的
// 文字长度、实体数与实体总大小之内。

function desired(input: ComposeInput): DesiredIncidentMessage {
  const { message, targets } = composeMessage(input);
  const inc = input.incident;
  return {
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
    language: input.language,
  };
}

function telegram(d: DesiredIncidentMessage): TelegramPayload {
  return renderIncident({ channel: 'telegram', chat: '-1001234567890', language: d.language }, d, [], null, {
    callbacks: true,
  }).payload as TelegramPayload;
}

function withinLimits(p: TelegramPayload): string {
  const { text, entities } = parseTelegramHtml(p.text);
  expect(text.length).toBeLessThanOrEqual(MAX_TEXT_UNITS);
  expect(entities.length).toBeLessThanOrEqual(MAX_ENTITIES);
  expect(serializedEntityBytes(entities)).toBeLessThanOrEqual(MAX_ENTITY_BYTES);
  expect(serializedEntityBytes(entities)).toBeLessThan(TELEGRAM_ENTITY_BYTES_LIMIT);
  return text;
}

const run = (state: string, kind: string | null) => ({
  run_id: '0b9a4e1c-0000-4000-8000-000000000001',
  state,
  disposition: null,
  conclusion_level: null,
  root_component: null,
  output: null,
  error: kind ? { kind, message: '原始的失败说明' } : null,
});

describe('研判的说明行带原因码的文字', () => {
  const base = () => releaseRolloutInput();

  it('研判失败：每种失败类型（含 server 判定的租约过期）写登记表的文字', () => {
    for (const e of REASON_CODES.filter((x) => x.groups.includes('research_failure') || x.code === 'lease_expired')) {
      const { message } = composeMessage({ ...base(), research: run('failed', e.code) });
      expect(message.banner).toBe(`模型研判失败：${e.text['zh-CN']}，以下为确定性报告`);
    }
    const en = composeMessage({ ...base(), language: 'en', research: run('failed', 'lease_expired') }).message;
    expect(en.banner).toBe(
      `Model research failed: ${reasonText('research', 'lease_expired', 'en')}; deterministic report below`,
    );
  });

  it('只出阶段 A：研判镜像的失败类型与入队跳过的原因都写登记表的文字，不写原始说明', () => {
    const egress = composeMessage({ ...base(), research: run('stage_a_only', 'model_unavailable') }).message;
    expect(egress.banner).toBe('只出确定性报告：模型不可用');
    expect(egress.banner).not.toContain('原始的失败说明');
    for (const e of REASON_CODES.filter((x) => x.groups.includes('research_skip'))) {
      const { message } = composeMessage({ ...base(), research: null, stageAOnlyReason: e.code });
      expect(message.banner).toBe(`只出确定性报告：${e.text['zh-CN']}`);
    }
  });

  it('失败的研判镜像没有失败类型时抛出', () => {
    expect(() => composeMessage({ ...base(), research: run('failed', null) })).toThrow(/没有失败类型/);
  });

  it('未登记的跳过原因抛出', () => {
    expect(() => composeMessage({ ...base(), research: null, stageAOnlyReason: 'later' })).toThrow(/不在登记表/);
  });
});

describe('还没有阶段 A 报告的消息（ADR 0173）', () => {
  const missing = (m: ComposeInput['stageAMissing']): ComposeInput => ({
    ...releaseRolloutInput(),
    stageA: null,
    researchStageA: null,
    research: null,
    stageAMissing: m,
  });

  it('说明行写原因：仍在执行、执行失败（带错误摘要）、补跑用完', () => {
    expect(composeMessage(missing(null)).message.banner).toBe('阶段 A 尚未生成：阶段 A 仍在执行');
    expect(composeMessage(missing({ code: 'stage_a_failed', detail: 'error: 证据卡数据源超时' })).message.banner).toBe(
      '阶段 A 尚未生成：阶段 A 执行失败（error: 证据卡数据源超时）',
    );
    expect(composeMessage(missing({ code: 'stage_a_missing', detail: '补跑 3 次仍然失败' })).message.banner).toBe(
      '阶段 A 尚未生成：阶段 A 补跑 3 次仍然失败，当前版本没有报告',
    );
    expect(composeMessage({ ...missing({ code: 'stage_a_failed', detail: 'x' }), language: 'en' }).message.banner).toBe(
      'Stage A not generated yet: stage A failed (x)',
    );
  });

  it('不带证据卡、处置行与处置反馈按钮；告警、时间线与根因候选照常', () => {
    const { message, targets } = composeMessage(missing({ code: 'stage_a_failed', detail: 'x' }));
    const all = JSON.stringify(message.sections);
    expect(all).not.toContain('card:');
    expect(all).not.toContain('阶段 A：');
    expect(all).not.toContain('处置：');
    expect(targets.some((t) => t.kind === 'disposition_confirm' || t.kind === 'disposition_reject')).toBe(false);
    expect(all).toContain('阶段 A 根因候选：');
    expect(message.buttons.at(-1)?.kind).toBe('open_console');
  });

  it('大事件没有阶段 A 报告时仍在 Telegram 的限制之内', () => {
    const input = { ...largeIncidentInput(), stageA: null, researchStageA: null, research: null };
    const text = withinLimits(
      telegram(desired({ ...input, stageAMissing: { code: 'stage_a_failed', detail: 'e'.repeat(2000) } })),
    );
    expect(text).toContain('阶段 A 尚未生成：阶段 A 执行失败（');
  });
});

describe('最后一次编辑的精简内容（ADR 0173）', () => {
  it('保留标题、头条、现状与关键问题，现状末尾加说明行与控制台链接；只留打开控制台的按钮', () => {
    const d = desired({ ...releaseRolloutInput('end') });
    const f = finalMessage(d);
    expect(f.message.title).toBe(d.message.title);
    expect(f.message.headline).toEqual(d.message.headline);
    expect(f.message.sections.map((s) => s.kind)).toEqual(['situation', 'key_issue']);
    const note = f.message.sections[0]!.blocks.at(-1)!;
    expect(note.text).toBe('消息停止更新（原因：编辑次数达到上限），完整内容见控制台');
    const open = d.message.buttons.at(-1)!;
    expect(note.runs?.at(-1)).toEqual({ text: '控制台', style: 'plain', href: open.url });
    expect(f.message.buttons).toEqual([open]);
    expect(f.targets).toEqual([]);
  });

  it('大事件的最后一次编辑在 Telegram 的限制之内，说明行与链接都在', () => {
    const d = desired({ ...largeIncidentInput(), incident: { ...largeIncidentInput().incident, state: 'resolved' } });
    const p = telegram(finalMessage(d));
    const text = withinLimits(p);
    expect(text).toContain('消息停止更新（原因：编辑次数达到上限），完整内容见控制台');
    const links = parseTelegramHtml(p.text)
      .entities.filter((e) => e.type === 'text_link')
      .map((e) => e.url);
    expect(links).toContain(d.message.buttons.at(-1)!.url);
  });
});
