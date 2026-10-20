import type { ModelRoute } from '@srenautix/contract';

// 模型调用的超时（ADR 0098）。调用一律流式，超时分三项：
// - 首 token：从发出请求到收到第一个输出增量（正文、推理或函数调用参数）；覆盖排队与输入预填充；
// - 空闲：收到第一个增量之后，相邻两个流事件之间的最长间隔；模型还在输出就不会被这一项打断；
// - 总时长：可选的总上限，默认不设，由阶段 B 的期限约束。
// 默认值按模型类别给出，依据见 ADR 0098 的测量。

export type ModelClass = 'hosted_large' | 'hosted_small' | 'local';

export interface RouteTimeouts {
  firstTokenMs: number;
  idleMs: number;
  /** null 表示不设总时长，只受阶段 B 剩余时间约束 */
  totalMs: number | null;
}

export const TIMEOUT_DEFAULTS: Readonly<Record<ModelClass, RouteTimeouts>> = {
  // 托管大模型：62k 输入首 token 5–7 秒，147k 输入 63 秒（接近每次研判的输入上限）；取 2 倍
  hosted_large: { firstTokenMs: 120_000, idleMs: 30_000, totalMs: null },
  // 托管小模型：输入受阶段上限约束（≤ 30k），首 token 在 10 秒以内
  hosted_small: { firstTokenMs: 60_000, idleMs: 30_000, totalMs: null },
  // 本地推理（vLLM、llama.cpp，常见于 CPU 或单卡）：预填充约 100 token/秒，30k 输入约 300 秒
  local: { firstTokenMs: 300_000, idleMs: 60_000, totalMs: null },
};

/** 本地推理服务的方言档案 */
const LOCAL_PROFILES: ReadonlySet<string> = new Set(['qwen-vllm', 'llamacpp']);

/** 路由未声明 model_class 时的推断：本地方言档案为 local，否则按档位 */
export function inferModelClass(route: Pick<ModelRoute, 'tier' | 'dialect_profile'>): ModelClass {
  if (LOCAL_PROFILES.has(route.dialect_profile)) {
    return 'local';
  }
  return route.tier === 'large' ? 'hosted_large' : 'hosted_small';
}

export interface RouteTimeoutConfig {
  model_class?: ModelClass | undefined;
  timeouts?: { first_token?: number | undefined; idle?: number | undefined; total?: number | undefined } | undefined;
}

/**
 * 一条路由的生效超时：路由显式配置 > 全局 call_timeout（旧配置，只作总时长上限）> 模型类别默认值。
 * 显式值以毫秒给出。
 */
export function resolveTimeouts(
  route: Pick<ModelRoute, 'tier' | 'dialect_profile'>,
  cfg: RouteTimeoutConfig,
  legacyTotalMs: number | null = null,
): { modelClass: ModelClass; timeouts: RouteTimeouts } {
  const modelClass = cfg.model_class ?? inferModelClass(route);
  const d = TIMEOUT_DEFAULTS[modelClass];
  return {
    modelClass,
    timeouts: {
      firstTokenMs: cfg.timeouts?.first_token ?? d.firstTokenMs,
      idleMs: cfg.timeouts?.idle ?? d.idleMs,
      totalMs: cfg.timeouts?.total ?? legacyTotalMs ?? d.totalMs,
    },
  };
}

/** 能力探测等非流式短调用的超时：首 token 加一个空闲间隔 */
export function shortCallTimeoutMs(t: RouteTimeouts): number {
  const ms = t.firstTokenMs + t.idleMs;
  return t.totalMs === null ? ms : Math.min(ms, t.totalMs);
}
