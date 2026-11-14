import type { ModelRoute } from '@srenautix/contract';

/**
 * 账户余额（ADR 0207）：服务方提供余额接口的路由配置 `balance`，worker 定期读取，导出
 * srenautix_llm_route_balance，告警按余额与消耗速度预警。只请求路由 base_url 同一 origin 上的余额接口，
 * 请求不带任何事件数据。
 */
export type BalanceKind = 'deepseek';

export interface BalanceReading {
  currency: string;
  amount: number;
}

/** 两次读取的间隔：余额变化以分钟计，不需要更频繁 */
export const BALANCE_INTERVAL_MS = 10 * 60 * 1000;

/** 读取一条路由的账户余额；接口失败或返回的形状不认识时抛出 */
export async function readBalance(
  kind: BalanceKind,
  route: Pick<ModelRoute, 'id' | 'base_url'>,
  apiKey: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<BalanceReading[]> {
  switch (kind) {
    case 'deepseek':
      return deepseekBalance(route, apiKey, signal, fetchFn);
  }
}

// DeepSeek 开放平台：GET /user/balance，balance_infos[] 每种币种一项，total_balance 为字符串
async function deepseekBalance(
  route: Pick<ModelRoute, 'id' | 'base_url'>,
  apiKey: string,
  signal: AbortSignal,
  fetchFn: typeof fetch,
): Promise<BalanceReading[]> {
  const url = new URL('/user/balance', new URL(route.base_url).origin);
  const res = await fetchFn(url, { headers: { authorization: `Bearer ${apiKey}` }, signal });
  if (!res.ok) {
    throw new Error(`路由 ${route.id} 的余额接口返回 HTTP ${res.status}`);
  }
  const body = (await res.json()) as { balance_infos?: Array<{ currency?: unknown; total_balance?: unknown }> };
  const out: BalanceReading[] = [];
  for (const b of body.balance_infos ?? []) {
    const amount = Number(b.total_balance);
    if (typeof b.currency !== 'string' || typeof b.total_balance !== 'string' || !Number.isFinite(amount)) {
      throw new Error(`路由 ${route.id} 的余额接口返回了不认识的余额项`);
    }
    out.push({ currency: b.currency, amount });
  }
  if (!out.length) {
    throw new Error(`路由 ${route.id} 的余额接口没有返回余额项`);
  }
  return out;
}

export interface BalanceTarget {
  route: ModelRoute;
  apiKey: string;
  kind: BalanceKind;
}

export interface BalanceSink {
  /** 一次读取成功：每种币种的余额 */
  readings(route: string, readings: BalanceReading[]): void;
  /** 一次读取的结果（成功为 true） */
  outcome(route: string, ok: boolean): void;
}

/**
 * 每 BALANCE_INTERVAL_MS 读取一次全部 targets 的余额，直到 signal 中止。出站检查与模型请求相同：出站已停止或
 * 路由不允许出站时不发请求，记为失败。
 */
export async function watchBalances(
  targets: readonly BalanceTarget[],
  allowed: (route: ModelRoute) => boolean,
  sink: BalanceSink,
  signal: AbortSignal,
  onError: (route: string, e: Error) => void,
  fetchFn: typeof fetch = fetch,
  intervalMs = BALANCE_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    for (const t of targets) {
      if (!allowed(t.route)) {
        sink.outcome(t.route.id, false);
        continue;
      }
      try {
        sink.readings(
          t.route.id,
          await readBalance(t.kind, t.route, t.apiKey, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), fetchFn),
        );
        sink.outcome(t.route.id, true);
      } catch (e) {
        if (signal.aborted) {
          return;
        }
        sink.outcome(t.route.id, false);
        onError(t.route.id, e as Error);
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
