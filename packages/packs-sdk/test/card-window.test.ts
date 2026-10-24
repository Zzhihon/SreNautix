import { describe, expect, it } from 'vitest';
import { cardWindow } from '../src/index.js';

// 卡片窗口（ADR 0107 §7、ADR 0149）：以锚点取 [锚点 − before, min(锚点 + after, now)]；
// 长期事件的终点取评估时刻，起点不早于终点减去最大窗口与数据保留期

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.parse('2026-10-24T08:00:00Z');
const card = { key: 'workload/pdb/disruptions', def: { window: { before: '30m', after: '10m' } } } as Parameters<
  typeof cardWindow
>[0];

describe('cardWindow', () => {
  it('没有 extend 时只按锚点取，终点不晚于 now', () => {
    const anchor = NOW - 13 * DAY;
    expect(cardWindow(card, anchor, NOW)).toEqual({ from: anchor - 30 * MIN, to: anchor + 10 * MIN });
    expect(cardWindow(card, NOW - 5 * MIN, NOW)).toEqual({ from: NOW - 35 * MIN, to: NOW });
  });

  it('首次触发在 13 天前：终点为评估时刻，起点为终点减去最大窗口（指标 11 天前才开始也在窗口内）', () => {
    const w = cardWindow(card, NOW - 13 * DAY, NOW, undefined, { until: NOW, maxWindowMs: DAY });
    expect(w).toEqual({ from: NOW - DAY, to: NOW });
    expect(w.from).toBeGreaterThan(NOW - 11 * DAY);
  });

  it('最大窗口覆盖锚点时起点仍是锚点 − before；不早于数据保留期', () => {
    const anchor = NOW - 13 * DAY;
    expect(cardWindow(card, anchor, NOW, undefined, { until: NOW, maxWindowMs: 30 * DAY })).toEqual({
      from: anchor - 30 * MIN,
      to: NOW,
    });
    expect(
      cardWindow(card, anchor, NOW, undefined, { until: NOW, maxWindowMs: 30 * DAY, notBefore: NOW - 7 * DAY }),
    ).toEqual({ from: NOW - 7 * DAY, to: NOW });
  });

  it('评估时刻在锚定窗口之内时不变；已恢复的事件以恢复时刻为终点，且不晚于 now', () => {
    const anchor = NOW - 5 * MIN;
    expect(cardWindow(card, anchor, NOW, undefined, { until: NOW, maxWindowMs: DAY })).toEqual({
      from: anchor - 30 * MIN,
      to: NOW,
    });
    const ended = NOW - 2 * DAY;
    expect(cardWindow(card, NOW - 13 * DAY, NOW, undefined, { until: ended, maxWindowMs: DAY })).toEqual({
      from: ended - DAY,
      to: ended,
    });
    expect(cardWindow(card, NOW - 13 * DAY, NOW, undefined, { until: NOW + DAY, maxWindowMs: DAY }).to).toBe(NOW);
  });

  it('检查覆盖的窗口同样适用', () => {
    const anchor = NOW - 3 * DAY;
    expect(
      cardWindow(card, anchor, NOW, { before: '2h', after: '1h' }, { until: NOW, maxWindowMs: 6 * 3600_000 }),
    ).toEqual({ from: NOW - 6 * 3600_000, to: NOW });
  });
});
