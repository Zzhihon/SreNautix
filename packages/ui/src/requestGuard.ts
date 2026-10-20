// 读请求的兜底防护（防止前端请求风暴）：同一个读请求（方法 + 完整 URL）
// - 同一时刻只有一个在途：后来的等前一个结束再发，不会因为反复失效而堆积成百上千个并发请求；
// - 在一个时间窗内的发出次数有上限：超过时等到窗口里最早的一次过期再发。
// 只约束 GET；写请求与事件流不经过这里。

export interface RequestGuardOptions {
  /** 时间窗（毫秒） */
  windowMs: number;
  /** 时间窗内同一个读请求最多发出几次 */
  maxPerWindow: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_REQUEST_GUARD: RequestGuardOptions = { windowMs: 10_000, maxPerWindow: 6 };

interface Lane {
  starts: number[];
  tail: Promise<void>;
}

export class RequestGuard {
  private readonly lanes = new Map<string, Lane>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** 因超过上限而推迟的次数（测试与诊断用） */
  delayed = 0;

  constructor(private readonly o: RequestGuardOptions = DEFAULT_REQUEST_GUARD) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 按 key 排队执行 fn：前一个结束后才开始，并遵守时间窗上限 */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(key) ?? { starts: [], tail: Promise.resolve() };
    this.lanes.set(key, lane);
    const result = lane.tail.then(async () => {
      for (;;) {
        const t = this.now();
        lane.starts = lane.starts.filter((s) => t - s < this.o.windowMs);
        if (lane.starts.length < this.o.maxPerWindow) {
          lane.starts.push(t);
          break;
        }
        this.delayed++;
        await this.sleep(this.o.windowMs - (t - (lane.starts[0] as number)));
      }
      return fn();
    });
    lane.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 包装 fetch：GET 请求按 URL 经过防护，其他请求直接发出 */
  wrap(fetchFn: typeof globalThis.fetch): typeof globalThis.fetch {
    return (input, init) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET') {
        return fetchFn(input, init);
      }
      const url = input instanceof Request ? input.url : input.toString();
      return this.run(url, () => fetchFn(input, init));
    };
  }
}
