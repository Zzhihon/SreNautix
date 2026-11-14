import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { readBalance, watchBalances, type BalanceReading } from '../../src/llm/balance.js';
import { workerRouteSchema } from '../../src/research/config.js';

// 路由账户余额（ADR 0207）：DeepSeek 的 /user/balance 返回体取自 2026-11-14 参考部署的一次真实读取。

const DEEPSEEK_BODY =
  '{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"49.64","granted_balance":"0.00","topped_up_balance":"49.64"}]}';

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function serve(
  status: number,
  body: string,
): Promise<{ base: string; seen: Array<{ url: string; auth: string }> }> {
  const seen: Array<{ url: string; auth: string }> = [];
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '' });
    res.writeHead(status, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

describe('读取路由账户余额', () => {
  it('DeepSeek：请求 base_url origin 上的 /user/balance，按币种返回余额', async () => {
    const { base, seen } = await serve(200, DEEPSEEK_BODY);
    const got = await readBalance('deepseek', { id: 'direct', base_url: base }, 'sk-test', AbortSignal.timeout(5000));
    expect(got).toEqual([{ currency: 'CNY', amount: 49.64 }]);
    expect(seen).toEqual([{ url: '/user/balance', auth: 'Bearer sk-test' }]);
  });

  it('非 2xx 与不认识的返回体抛出', async () => {
    const { base } = await serve(402, '{"error":"Insufficient Balance"}');
    await expect(
      readBalance('deepseek', { id: 'direct', base_url: base }, 'k', AbortSignal.timeout(5000)),
    ).rejects.toThrow('HTTP 402');
    server!.close();
    const bad = await serve(200, '{"balance_infos":[{"currency":"CNY","total_balance":12}]}');
    await expect(
      readBalance('deepseek', { id: 'direct', base_url: bad.base }, 'k', AbortSignal.timeout(5000)),
    ).rejects.toThrow('不认识的余额项');
  });

  it('watchBalances：读取一轮后等待间隔；不允许出站的路由不发请求，记为失败', async () => {
    const { base, seen } = await serve(200, DEEPSEEK_BODY);
    const ctrl = new AbortController();
    const readings: Array<[string, BalanceReading[]]> = [];
    const outcomes: Array<[string, boolean]> = [];
    const route = (id: string) => ({ id, base_url: base }) as never;
    const done = watchBalances(
      [
        { route: route('direct'), apiKey: 'k', kind: 'deepseek' },
        { route: route('blocked'), apiKey: 'k', kind: 'deepseek' },
      ],
      (r) => (r as { id: string }).id !== 'blocked',
      { readings: (id, rs) => readings.push([id, rs]), outcome: (id, ok) => outcomes.push([id, ok]) },
      ctrl.signal,
      () => undefined,
      fetch,
      60_000,
    );
    await expect.poll(() => outcomes.length).toBe(2);
    ctrl.abort();
    await done;
    expect(readings).toEqual([['direct', [{ currency: 'CNY', amount: 49.64 }]]]);
    expect(outcomes).toEqual([
      ['direct', true],
      ['blocked', false],
    ]);
    expect(seen).toHaveLength(1);
  });

  it('worker 路由配置接受 balance: deepseek，拒绝其他取值', () => {
    const route = workerRouteSchema;
    const base = {
      id: 'direct',
      api: 'chat_completions',
      base_url: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
      dialect_profile: 'openai-compatible',
      price: { currency: 'USD', input_per_mtok: 1.32, output_per_mtok: 3.96, cached_input_per_mtok: 0.044 },
      in_domain: true,
      tier: 'large',
      retention_terms: 'x',
      api_key_file: '/k',
    };
    expect(route.safeParse({ ...base, balance: 'deepseek' }).success).toBe(true);
    expect(route.safeParse({ ...base, balance: 'openai' }).success).toBe(false);
  });
});
