import { describe, expect, it } from 'vitest';
import { incidentOnsetMs, incidentOrigin } from '../../src/incident/onset.js';

// 事件的计时起点（ADR 0159）：一个事件运行约 1 小时后拆出的新事件，成员告警的首个触发时刻仍是原事件的开始时刻

describe('事件的计时起点', () => {
  it('新事件从首个告警的触发时刻计时', () => {
    const inc = {
      split_from: null,
      first_firing_at: '2026-10-25T10:25:00Z',
      created_at: '2026-10-25T10:25:42.252Z',
    };
    expect(incidentOrigin(inc)).toBe('new');
    expect(incidentOnsetMs(inc)).toBe(Date.parse('2026-10-25T10:25:00Z'));
  });

  it('拆分出的事件从拆分时刻（自己的 created_at）计时', () => {
    const inc = {
      split_from: '7a1b2c3d-0000-4000-8000-000000000001',
      first_firing_at: '2026-10-25T10:25:00Z',
      created_at: '2026-10-25T11:22:12.242Z',
    };
    expect(incidentOrigin(inc)).toBe('split');
    expect(incidentOnsetMs(inc)).toBe(Date.parse('2026-10-25T11:22:12.242Z'));
  });
});
