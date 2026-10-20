import type { QueryKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { createInvalidator, invalidationKeys, qk, retryDelay, shouldRetry } from './data';
import type { OutboxEvent } from './contract';
import { ApiError } from './port';
import { RequestGuard } from './requestGuard';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('读请求防护', () => {
  it('同一个读请求同一时刻只有一个在途，后来的排队', async () => {
    const g = new RequestGuard({ windowMs: 10_000, maxPerWindow: 100 });
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const call = () =>
      g.run('GET /v1/incidents?state=firing', async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => releases.push(r));
        inFlight--;
      });
    const all = Array.from({ length: 50 }, call);
    for (let i = 0; i < 50; i++) {
      await tick();
      releases.shift()?.();
    }
    await Promise.all(all);
    expect(peak).toBe(1);
  });

  it('时间窗内超过上限时推迟到窗口里最早的一次过期', async () => {
    let t = 0;
    const slept: number[] = [];
    const g = new RequestGuard({
      windowMs: 10_000,
      maxPerWindow: 3,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    const starts: number[] = [];
    for (let i = 0; i < 7; i++) {
      await g.run('k', async () => {
        starts.push(t);
      });
      t += 100;
    }
    expect(starts).toEqual([0, 100, 200, 10_000, 10_100, 10_200, 20_000]);
    expect(g.delayed).toBe(2);
    expect(slept).toEqual([9_700, 9_700]);
  });

  it('不同的读请求互不影响；写请求不经过防护', async () => {
    const seen: string[] = [];
    const g = new RequestGuard({ windowMs: 10_000, maxPerWindow: 1, sleep: () => new Promise(() => undefined) });
    const f = g.wrap(async (input, init) => {
      seen.push(`${init?.method ?? (input as Request).method} ${(input as Request).url ?? String(input)}`);
      return new Response('{}');
    });
    await f(new Request('http://h/v1/incidents?state=firing'));
    await f(new Request('http://h/v1/conditions'));
    await f(new Request('http://h/v1/incidents/x/feedback', { method: 'POST', body: '{}' }));
    await f(new Request('http://h/v1/incidents/x/feedback', { method: 'POST', body: '{}' }));
    expect(seen).toHaveLength(4);
  });
});

describe('事件驱动的失效', () => {
  function fakeClient() {
    const calls: Array<QueryKey | 'all'> = [];
    return {
      calls,
      invalidateQueries: async (f?: { queryKey?: QueryKey }, o?: { cancelRefetch?: boolean }) => {
        expect(o?.cancelRefetch).toBe(false);
        calls.push(f?.queryKey ?? 'all');
      },
    };
  }
  const event = (type: OutboxEvent['type']): OutboxEvent =>
    ({ type, payload: { run_id: 'r', proposal_id: 'p' } }) as unknown as OutboxEvent;

  it('一批上千条事件只失效一次，键按前缀去重', async () => {
    const qc = fakeClient();
    const inv = createInvalidator(qc, { delayMs: 20, minGapMs: 50 });
    for (let i = 0; i < 2000; i++) {
      inv.keys(invalidationKeys(event(i % 2 ? 'incident.updated' : 'condition.changed')));
    }
    inv.keys([qk.incidents({ state: 'firing', feedback: 'all', suppressed: false })]);
    await new Promise((r) => setTimeout(r, 40));
    expect(inv.flushes).toBe(1);
    expect(qc.calls.map((k) => JSON.stringify(k)).sort()).toEqual(
      [qk.incidents(), ['incident'], ['conditions'], ['clusters']].map((k) => JSON.stringify(k)).sort(),
    );
    inv.dispose();
  });

  it('持续到来的事件按最短间隔节流', async () => {
    const qc = fakeClient();
    const inv = createInvalidator(qc, { delayMs: 5, minGapMs: 60 });
    const started = Date.now();
    while (Date.now() - started < 200) {
      inv.keys([qk.incidents()]);
      await new Promise((r) => setTimeout(r, 2));
    }
    await new Promise((r) => setTimeout(r, 80));
    // 200 毫秒里事件不断，失效最多 200 / 60 + 1 次
    expect(inv.flushes).toBeGreaterThanOrEqual(2);
    expect(inv.flushes).toBeLessThanOrEqual(5);
    inv.dispose();
  });

  it('重连后的全量对账同样合并', async () => {
    const qc = fakeClient();
    const inv = createInvalidator(qc, { delayMs: 10, minGapMs: 10 });
    inv.keys([qk.incidents()]);
    inv.all();
    inv.all();
    await new Promise((r) => setTimeout(r, 30));
    expect(qc.calls).toEqual(['all']);
    inv.dispose();
  });
});

describe('重试与退避', () => {
  it('网络错误与 429 最多重试 4 次，5xx 最多 2 次，其他 4xx 不重试', () => {
    expect(shouldRetry(3, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(4, new TypeError('Failed to fetch'))).toBe(false);
    expect(shouldRetry(3, new ApiError(429, 'rate_limited', '', 'listIncidents'))).toBe(true);
    expect(shouldRetry(1, new ApiError(503, 'unavailable', '', 'listIncidents'))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, 'unavailable', '', 'listIncidents'))).toBe(false);
    expect(shouldRetry(0, new ApiError(403, 'forbidden', '', 'listIncidents'))).toBe(false);
  });

  it('指数退避，上限 30 秒，带抖动', () => {
    expect([0, 1, 2, 3, 10].map((n) => retryDelay(n, () => 1))).toEqual([1000, 2000, 4000, 8000, 30_000]);
    expect(retryDelay(2, () => 0)).toBe(2000);
  });
});
