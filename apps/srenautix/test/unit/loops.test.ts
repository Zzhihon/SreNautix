import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Leader } from '../../src/kernel/leader.js';
import { Loops } from '../../src/kernel/loops.js';

// server 的后台循环（kernel/loops.ts）：不叠加执行、只在主实例上、出错后下一轮继续、stop 之后不再执行

const leader = (is: () => boolean): Leader => ({
  isLeader: is,
  acquired: async () => undefined,
  stop: async () => undefined,
});

describe('后台循环', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('上一轮没有结束时跳过这一轮并计数，结束后照常执行', async () => {
    const skipped: string[] = [];
    const loops = new Loops(
      leader(() => true),
      (w) => skipped.push(w),
    );
    let release: () => void = () => undefined;
    let runs = 0;
    loops.every(
      1000,
      () => {
        runs++;
        return new Promise<void>((r) => {
          release = r;
        });
      },
      '慢循环',
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect([runs, skipped]).toEqual([1, ['慢循环', '慢循环']]);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
    loops.stop();
  });

  it('默认只在主实例上执行；leaderOnly: false 时每个实例都执行', async () => {
    let isLeader = false;
    const loops = new Loops(leader(() => isLeader));
    const ran: string[] = [];
    loops.every(1000, async () => void ran.push('leader'), 'a');
    loops.every(1000, async () => void ran.push('all'), 'b', { leaderOnly: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toEqual(['all']);
    isLeader = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toEqual(['all', 'leader', 'all']);
    loops.stop();
  });

  it('出错后下一轮继续；stop 之后不再执行', async () => {
    const loops = new Loops(leader(() => true));
    let runs = 0;
    loops.every(
      1000,
      async () => {
        runs++;
        throw new Error('boom');
      },
      '出错的循环',
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(runs).toBe(2);
    loops.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(2);
  });
});
