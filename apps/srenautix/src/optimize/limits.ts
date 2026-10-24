import { Counter, Histogram, type Registry } from 'prom-client';
import type { OptimizationConfig } from './config.js';

// 主动分析的后端查询上限与负载保护（ADR 0146 §6.1、§6.2，不变量 16）：
// - 每个后端一个信号量，事件研判与主动分析共用，事件研判优先（等待队列中事件研判的请求总排在前面）；
// - 主动分析另有自己的并发上限与每小时上限（滑动 1 小时窗口），超过时请求不发出，结果为 quota；
// - 每次主动分析的直接查询之前执行这个后端的负载保护卡（结果缓存 1 分钟），任何一张异常就不发出，结果为 load_guard；
// - 事件研判不受每小时上限与负载保护约束（它们是为了让主动分析让出）。

export type Backend = 'dbstats' | 'metrics' | 'traces' | 'logs' | 'kube' | 'github';
export const BACKENDS: readonly Backend[] = ['dbstats', 'metrics', 'traces', 'logs', 'kube', 'github'];

/** 查询的用途：事件研判（incident）优先于主动分析（optimization） */
export type QueryPurpose = 'incident' | 'optimization';

/** 主动分析的单独配额：dbstats 的语句文本 */
export type QuotaKey = Backend | 'dbstats_text';

export type QueryOutcome = 'ok' | 'error' | 'quota' | 'load_guard';

export type Limited<T> =
  | { ok: true; value: T }
  | { ok: false; outcome: 'quota' | 'load_guard'; reason: string }
  | { ok: false; outcome: 'error'; reason: string; error: unknown };

/**
 * 负载保护（§6.2）：返回异常的保护卡的说明，正常时为 null。由领域包的 load_guards 证据卡实现；
 * 没有负载保护卡的后端不调用
 */
export type LoadGuard = (backend: Backend, signal: AbortSignal) => Promise<{ guard: string; reason: string } | null>;

export class OptimizationMetrics {
  readonly queries: Counter<'backend' | 'outcome'>;
  readonly seconds: Histogram<'backend'>;
  readonly guardTrips: Counter<'guard'>;

  constructor(registry: Registry) {
    this.queries = new Counter({
      name: 'srenautix_optimization_backend_queries_total',
      help: '主动分析发往后端的查询，按后端与结果（ok、error、quota 超过每小时上限未发出、load_guard 负载保护异常未发出）',
      labelNames: ['backend', 'outcome'] as const,
      registers: [registry],
    });
    this.seconds = new Histogram({
      name: 'srenautix_optimization_backend_query_seconds',
      help: '主动分析发往后端的查询耗时（含等待信号量），单位秒',
      labelNames: ['backend'] as const,
      buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30],
      registers: [registry],
    });
    this.guardTrips = new Counter({
      name: 'srenautix_optimization_guard_trips_total',
      help: '负载保护卡异常、主动分析因此跳过查询或推迟运行的次数，按保护卡',
      labelNames: ['guard'] as const,
      registers: [registry],
    });
  }
}

/** 带优先级的信号量：事件研判的等待者排在主动分析之前 */
export class PrioritySemaphore {
  private used = 0;
  private readonly waiting: Array<{ purpose: QueryPurpose; resolve: () => void }> = [];

  constructor(readonly capacity: number) {}

  get inUse(): number {
    return this.used;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(purpose: QueryPurpose, signal?: AbortSignal): Promise<() => void> {
    if (this.used < this.capacity && this.waiting.length === 0) {
      this.used++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const entry = { purpose, resolve };
      // 事件研判插到第一个主动分析等待者之前
      const at = purpose === 'incident' ? this.waiting.findIndex((w) => w.purpose === 'optimization') : -1;
      if (at < 0) {
        this.waiting.push(entry);
      } else {
        this.waiting.splice(at, 0, entry);
      }
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) {
            this.waiting.splice(i, 1);
            reject(signal.reason);
          }
        },
        { once: true },
      );
    });
    // 释放方把名额直接交给了这个等待者（used 没有减少）
    return this.releaser();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) {
        return;
      }
      done = true;
      const next = this.waiting.shift();
      if (next) {
        next.resolve();
      } else {
        this.used--;
      }
    };
  }
}

/** 滑动 1 小时窗口的计数 */
class HourWindow {
  private readonly at: number[] = [];

  constructor(readonly limit: number) {}

  count(now: number): number {
    while (this.at.length && (this.at[0] as number) <= now - 3_600_000) {
      this.at.shift();
    }
    return this.at.length;
  }

  take(now: number): boolean {
    if (this.count(now) >= this.limit) {
      return false;
    }
    this.at.push(now);
    return true;
  }
}

/** 事件研判与主动分析共用的信号量总容量：VictoriaMetrics 为 8（§6.1），其余后端与主动分析的并发相同 */
const SHARED_CAPACITY: Partial<Record<Backend, number>> = { metrics: 8 };

const GUARD_CACHE_MS = 60_000;

export class BackendLimiter {
  private readonly shared = new Map<Backend, PrioritySemaphore>();
  private readonly own = new Map<Backend, PrioritySemaphore>();
  private readonly hourly = new Map<QuotaKey, HourWindow>();
  private readonly guardCache = new Map<Backend, { at: number; result: { guard: string; reason: string } | null }>();

  constructor(
    limits: OptimizationConfig['limits'],
    private readonly metrics: OptimizationMetrics,
    private readonly guard: LoadGuard | null = null,
    private readonly now: () => number = Date.now,
  ) {
    for (const b of BACKENDS) {
      const l = limits[b];
      const concurrency = 'concurrency' in l ? l.concurrency : Number.POSITIVE_INFINITY;
      const shared = SHARED_CAPACITY[b] ?? concurrency;
      if (Number.isFinite(shared)) {
        this.shared.set(b, new PrioritySemaphore(Math.max(shared, Number.isFinite(concurrency) ? concurrency : 1)));
      }
      if (Number.isFinite(concurrency)) {
        this.own.set(b, new PrioritySemaphore(concurrency));
      }
      this.hourly.set(b, new HourWindow(l.per_hour));
    }
    this.hourly.set('dbstats_text', new HourWindow(limits.dbstats.statement_text_per_hour));
  }

  /** 本小时内主动分析在这个配额上已经发出的查询数 */
  used(key: QuotaKey): number {
    return this.hourly.get(key)?.count(this.now()) ?? 0;
  }

  /** 信号量（测试与状态页） */
  semaphore(backend: Backend): PrioritySemaphore | undefined {
    return this.shared.get(backend);
  }

  /** 负载保护的结果，缓存 1 分钟；没有负载保护时为 null */
  async guardState(backend: Backend, signal: AbortSignal): Promise<{ guard: string; reason: string } | null> {
    if (!this.guard) {
      return null;
    }
    const cached = this.guardCache.get(backend);
    const now = this.now();
    if (cached && now - cached.at < GUARD_CACHE_MS) {
      return cached.result;
    }
    const result = await this.guard(backend, signal);
    this.guardCache.set(backend, { at: now, result });
    return result;
  }

  /**
   * 执行一次后端查询。purpose=optimization 时依次检查负载保护与每小时配额（quota 给出额外占用的配额，例如语句文本），
   * 不满足时不调用 fn；然后在共用信号量（事件研判优先）与主动分析自己的并发上限内执行
   */
  async run<T>(
    backend: Backend,
    purpose: QueryPurpose,
    fn: () => Promise<T>,
    opts: { signal?: AbortSignal; quota?: QuotaKey[] } = {},
  ): Promise<Limited<T>> {
    const signal = opts.signal ?? new AbortController().signal;
    const started = this.now();
    if (purpose === 'optimization') {
      const tripped = await this.guardState(backend, signal);
      if (tripped) {
        this.metrics.guardTrips.inc({ guard: tripped.guard });
        this.metrics.queries.inc({ backend, outcome: 'load_guard' });
        return { ok: false, outcome: 'load_guard', reason: `负载保护 ${tripped.guard} 异常：${tripped.reason}` };
      }
      const keys: QuotaKey[] = [backend, ...(opts.quota ?? [])];
      const full = keys.find((k) => {
        const w = this.hourly.get(k);
        return w !== undefined && w.count(this.now()) >= w.limit;
      });
      if (full) {
        this.metrics.queries.inc({ backend, outcome: 'quota' });
        return {
          ok: false,
          outcome: 'quota',
          reason: `${full} 本小时已发出 ${this.used(full)} 次，达到主动分析的每小时上限`,
        };
      }
      for (const k of keys) {
        this.hourly.get(k)?.take(this.now());
      }
    }
    const releases: Array<() => void> = [];
    try {
      const own = purpose === 'optimization' ? this.own.get(backend) : undefined;
      if (own) {
        releases.push(await own.acquire(purpose, signal));
      }
      const shared = this.shared.get(backend);
      if (shared) {
        releases.push(await shared.acquire(purpose, signal));
      }
      const value = await fn();
      if (purpose === 'optimization') {
        this.metrics.queries.inc({ backend, outcome: 'ok' });
      }
      return { ok: true, value };
    } catch (error) {
      if (purpose === 'optimization') {
        this.metrics.queries.inc({ backend, outcome: 'error' });
      }
      return { ok: false, outcome: 'error', reason: error instanceof Error ? error.message : String(error), error };
    } finally {
      for (const r of releases.reverse()) {
        r();
      }
      if (purpose === 'optimization') {
        this.metrics.seconds.observe({ backend }, (this.now() - started) / 1000);
      }
    }
  }
}
