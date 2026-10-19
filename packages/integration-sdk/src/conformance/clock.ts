// 回放时钟窗口（DESIGN §10.5、§14.3）：所有读取类适配器都必须在发出请求之前拒绝超出时钟窗口的时刻与区间。
// 检查方法：把适配器指向一个不监听的地址，窗口内的请求得到连接错误（说明真的发出了请求），
// 窗口外的请求得到 ClockWindowViolation（说明在发出请求之前就被拒绝）。

import type { TimeWindow } from '@srenautix/contract';
import { toIso, toMillis } from '../clock.js';
import { Checks, expectReject, type ConformanceReport } from './report.js';

export interface ClockSubject {
  name: string;
  /** 用给定的请求窗口与时钟窗口发出一次读取 */
  read(window: TimeWindow, clock: TimeWindow): Promise<unknown>;
  /** 可选：带回看的读取（例如 PromQL 的 rate(x[1h])），回看越过时钟窗口起点必须被拒绝 */
  readWithLookback?(at: string, lookbackSeconds: number, clock: TimeWindow): Promise<unknown>;
}

export async function runClockConformance(subject: ClockSubject, clock: TimeWindow): Promise<ConformanceReport> {
  const c = new Checks('clock', subject.name);
  const from = toMillis(clock.from);
  const to = toMillis(clock.to);
  const mid = Math.round((from + to) / 2);
  const inside = { from: toIso(mid - 60_000), to: toIso(mid) };

  await c.run('inside-reaches-network', '窗口内的请求会发出', () =>
    expectReject('窗口内', () => subject.read(inside, clock), 'DatasourceError'),
  );
  await c.run('end-after-clock', '结束时间晚于时钟窗口终点时拒绝', () =>
    expectReject(
      '越过终点',
      () => subject.read({ from: inside.from, to: toIso(to + 1000) }, clock),
      'ClockWindowViolation',
    ),
  );
  await c.run('start-before-clock', '开始时间早于时钟窗口起点时拒绝', () =>
    expectReject(
      '早于起点',
      () => subject.read({ from: toIso(from - 1000), to: inside.to }, clock),
      'ClockWindowViolation',
    ),
  );
  await c.run('future', '未来的区间拒绝', () =>
    expectReject(
      '未来',
      () => subject.read({ from: toIso(to + 3600_000), to: toIso(to + 7200_000) }, clock),
      'ClockWindowViolation',
    ),
  );
  const lookback = subject.readWithLookback;
  if (lookback) {
    await c.run('lookback-before-clock', '回看越过时钟窗口起点时拒绝', () =>
      expectReject('回看', () => lookback(toIso(from + 60_000), 3600, clock), 'ClockWindowViolation'),
    );
    await c.run('lookback-inside', '回看在窗口内时发出请求', () =>
      expectReject('回看在内', () => lookback(toIso(mid), 60, clock), 'DatasourceError'),
    );
  }
  return c.report();
}
