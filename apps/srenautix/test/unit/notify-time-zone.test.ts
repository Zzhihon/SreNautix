import { describe, expect, it } from 'vitest';
import { renderIncident, type TelegramPayload } from '../../src/channels/telegram/render.js';
import { composeMessage } from '../../src/notify/compose.js';
import type { DesiredIncidentMessage } from '../../src/notify/ports.js';
import { hm, tzLabel, ymdhm } from '../../src/notify/text.js';
import { largeIncidentInput } from '../support/report-fixture.js';

// 消息里的时间按 notify.time_zone 书写，时间后写 UTC 或偏移；没有配置时与之前一样是 UTC

describe('消息的时区', () => {
  it('UTC 写 UTC，其余写偏移；时刻换成这个时区的墙上时间', () => {
    const at = new Date('2026-10-20T15:50:00Z');
    expect([ymdhm(at), hm(at)]).toEqual(['2026-10-20 15:50 UTC', '15:50 UTC']);
    expect(ymdhm(at, 'Asia/Shanghai')).toBe('2026-10-20 23:50 UTC+8');
    expect(ymdhm(new Date('2026-10-20T18:30:00Z'), 'Asia/Shanghai')).toBe('2026-10-21 02:30 UTC+8');
    expect(tzLabel('Asia/Kolkata', at)).toBe('UTC+5:30');
  });

  it('时间线的标题与时刻、消息头的首次触发都用同一个时区', () => {
    const input = { ...largeIncidentInput(), timeZone: 'Asia/Shanghai' };
    const { message, targets } = composeMessage(input);
    const inc = input.incident;
    const d: DesiredIncidentMessage = {
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
      timeZone: input.timeZone,
    };
    const text = (
      renderIncident({ channel: 'telegram', chat: '-1001', language: 'zh' }, d, [], null, { callbacks: false })
        .payload as TelegramPayload
    ).text;
    expect(text).toContain('首次触发 2026-10-20 23:50 UTC+8');
    expect(text).toContain('时间线（UTC+8，10-20）');
    expect(text).not.toContain('时间线（UTC，');
    // UTC 15:50:30 的首个告警在时间线里写成 23:50:30
    expect(text).toContain('23:50:30');
  });
});
