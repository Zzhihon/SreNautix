import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIMIZATION } from '../../src/optimize/config.js';
import { BackendLimiter, OptimizationMetrics, PrioritySemaphore, type LoadGuard } from '../../src/optimize/limits.js';

// 后端查询的上限与负载保护（ADR 0146 §6.1、§6.2）：不变量 16 的单元部分

const limits = DEFAULT_OPTIMIZATION.limits;

function setup(guard: LoadGuard | null = null, now = { t: 1_000_000 }) {
  const registry = new Registry();
  const metrics = new OptimizationMetrics(registry);
  const limiter = new BackendLimiter(limits, metrics, guard, () => now.t);
  const value = async (name: string, labels: Record<string, string>) =>
    (await registry.getSingleMetric(name)?.get())?.values.find((v) =>
      Object.entries(labels).every(([k, x]) => v.labels[k] === x),
    )?.value ?? 0;
  const queries = (backend: string, outcome: string) =>
    value('srenautix_optimization_backend_queries_total', { backend, outcome });
  return { limiter, now, value, queries };
}

const deferred = () => {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
};

describe('后端查询的上限', () => {
  it('负载保护卡异常时不发出查询，结果为 load_guard，计入保护卡的次数；结果缓存 1 分钟', async () => {
    let calls = 0;
    let state: { guard: string; reason: string } | null = {
      guard: 'postgres/primary-cpu',
      reason: 'CPU 用量 82% of limit',
    };
    const guard: LoadGuard = async () => {
      calls++;
      return state;
    };
    const { limiter, now, value, queries } = setup(guard);
    let sent = 0;
    const r = await limiter.run('dbstats', 'optimization', async () => ++sent);
    expect(r).toMatchObject({ ok: false, outcome: 'load_guard' });
    expect(sent).toBe(0);
    expect(await value('srenautix_optimization_guard_trips_total', { guard: 'postgres/primary-cpu' })).toBe(1);
    expect(await queries('dbstats', 'load_guard')).toBe(1);
    state = null;
    // 1 分钟内用缓存的异常结果
    now.t += 30_000;
    expect((await limiter.run('dbstats', 'optimization', async () => ++sent)).ok).toBe(false);
    expect(calls).toBe(1);
    now.t += 31_000;
    expect(await limiter.run('dbstats', 'optimization', async () => ++sent)).toEqual({ ok: true, value: 1 });
    expect(calls).toBe(2);
  });

  it('超过每小时上限的查询不发出；1 小时后恢复；语句文本另有配额', async () => {
    const { limiter, now, queries } = setup();
    let sent = 0;
    for (let i = 0; i < limits.dbstats.per_hour; i++) {
      expect((await limiter.run('dbstats', 'optimization', async () => ++sent)).ok).toBe(true);
      now.t += 1000;
    }
    const over = await limiter.run('dbstats', 'optimization', async () => ++sent);
    expect(over).toMatchObject({ ok: false, outcome: 'quota' });
    expect(sent).toBe(limits.dbstats.per_hour);
    expect(await queries('dbstats', 'quota')).toBe(1);
    now.t += 3_600_000;
    for (let i = 0; i < limits.dbstats.statement_text_per_hour; i++) {
      expect((await limiter.run('dbstats', 'optimization', async () => ++sent, { quota: ['dbstats_text'] })).ok).toBe(
        true,
      );
    }
    const text = await limiter.run('dbstats', 'optimization', async () => ++sent, { quota: ['dbstats_text'] });
    expect(text).toMatchObject({ ok: false, outcome: 'quota', reason: expect.stringContaining('dbstats_text') });
    // 语句文本的配额用完，其他 dbstats 操作照常
    expect((await limiter.run('dbstats', 'optimization', async () => ++sent)).ok).toBe(true);
  });

  it('事件研判不受每小时上限与负载保护约束', async () => {
    const guard: LoadGuard = async () => ({ guard: 'victoria/cpu', reason: '85%' });
    const { limiter } = setup(guard);
    let sent = 0;
    for (let i = 0; i < limits.traces.per_hour + 5; i++) {
      expect((await limiter.run('traces', 'incident', async () => ++sent)).ok).toBe(true);
    }
    expect(sent).toBe(limits.traces.per_hour + 5);
  });

  it('主动分析的并发不超过上限；查询出错时释放名额并记为 error', async () => {
    const { limiter, queries } = setup();
    let running = 0;
    let peak = 0;
    const gate = deferred();
    const tasks = Array.from({ length: 6 }, () =>
      limiter.run('metrics', 'optimization', async () => {
        running++;
        peak = Math.max(peak, running);
        await gate.p;
        running--;
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(limits.metrics.concurrency);
    gate.resolve();
    await Promise.all(tasks);
    const failed = await limiter.run('metrics', 'optimization', async () => {
      throw new Error('vm 503');
    });
    expect(failed).toMatchObject({ ok: false, outcome: 'error', reason: 'vm 503' });
    expect(limiter.semaphore('metrics')?.inUse).toBe(0);
    expect(await queries('metrics', 'error')).toBe(1);
  });

  it('信号量上事件研判优先：先于已在等待的主动分析得到名额', async () => {
    const s = new PrioritySemaphore(1);
    const order: string[] = [];
    const first = await s.acquire('optimization');
    // 每个等待者拿到名额后记录顺序并立即释放
    const take = (purpose: 'incident' | 'optimization', name: string) =>
      s.acquire(purpose).then((release) => {
        order.push(name);
        release();
      });
    const waits = [take('optimization', 'opt-1'), take('optimization', 'opt-2'), take('incident', 'incident')];
    first();
    await Promise.all(waits);
    expect(order).toEqual(['incident', 'opt-1', 'opt-2']);
    expect(s.inUse).toBe(0);
    // 释放时名额直接交给等待者，期间新来的请求不能插队超出容量
    const a = await s.acquire('optimization');
    const b = s.acquire('optimization');
    a();
    const c = s.acquire('optimization');
    expect(s.inUse).toBe(1);
    (await b)();
    (await c)();
    expect(s.inUse).toBe(0);
  });
});
