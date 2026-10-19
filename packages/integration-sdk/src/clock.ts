// 回放时钟窗口：所有适配器在发出请求前检查请求的时刻与区间都落在 clock_window 内。

import type { TimeWindow } from '@srenautix/contract';
import { ClockWindowViolation } from './errors.js';

export function toMillis(ts: string): number {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) {
    throw new TypeError(`不是 RFC 3339 时间：${ts}`);
  }
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function assertInstantInClock(time: string, clock: TimeWindow): void {
  const t = toMillis(time);
  if (t < toMillis(clock.from) || t > toMillis(clock.to)) {
    throw new ClockWindowViolation(`时刻 ${time} 不在 [${clock.from}, ${clock.to}] 内`);
  }
}

export function assertWindowInClock(window: TimeWindow, clock: TimeWindow): void {
  const from = toMillis(window.from);
  const to = toMillis(window.to);
  if (from > to) {
    throw new RangeError(`区间起点晚于终点：${window.from} > ${window.to}`);
  }
  if (from < toMillis(clock.from) || to > toMillis(clock.to)) {
    throw new ClockWindowViolation(`区间 [${window.from}, ${window.to}] 不在 [${clock.from}, ${clock.to}] 内`);
  }
}

/** PromQL 的区间与 offset 会读取查询时刻之前的数据：回看量也必须落在时钟窗口内 */
export function assertLookbackInClock(evalFromMs: number, lookbackMs: number, clock: TimeWindow): void {
  if (evalFromMs - lookbackMs < toMillis(clock.from)) {
    throw new ClockWindowViolation(
      `查询回看到 ${toIso(evalFromMs - lookbackMs)}，早于时钟窗口起点 ${clock.from}`,
    );
  }
}
