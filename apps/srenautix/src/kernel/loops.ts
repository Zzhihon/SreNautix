import type { Leader } from './leader.js';
import { logger } from './log.js';

export interface LoopOptions {
  /** 只在主实例上执行（默认）；false 时每个实例都执行，例如各实例都要读取的重新加载 */
  leaderOnly?: boolean;
}

/**
 * server 的后台循环：按间隔执行；上一轮还没有结束时跳过这一轮（onSkip 计数），不叠加执行；出错时记日志，下一轮重试；
 * stop 之后不再执行。定时器 unref，不阻止进程退出
 */
export class Loops {
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly leader: Leader,
    private readonly onSkip: (what: string) => void = () => undefined,
  ) {}

  every(ms: number, fn: () => Promise<unknown>, what: string, o: LoopOptions = {}): void {
    let busy = false;
    const t = setInterval(() => {
      if ((o.leaderOnly ?? true) && !this.leader.isLeader()) {
        return;
      }
      if (busy) {
        this.onSkip(what);
        return;
      }
      busy = true;
      fn()
        .catch((e: unknown) => logger.error(`${what}失败，下一轮重试`, { error: e }))
        .finally(() => {
          busy = false;
        });
    }, ms);
    t.unref();
    this.timers.push(t);
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers.length = 0;
  }
}
