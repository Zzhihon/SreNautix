import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { DialectProfile, ModelRoute, Severity } from '@srenautix/contract';
import type { LlmPhase, TurnUsage } from './types.js';

// token 计量与预算（DESIGN §7.5、§8.3）。计量一律依据服务方返回的 usage；
// 发送前的估算值按路由用实际 usage 持续校准，没有公开分词器的模型按字节估算。

/** 没有分词器时的字节估算：每个 token 至多按 2 字节计（中文约 3 字节一个字、英文约 4 字节一个 token，取保守值） */
export const BYTES_PER_TOKEN_FLOOR = 2;
/** 校准系数取指数加权平均与最近最大值中的较大者，再留 10% 余量 */
export const CALIBRATION_MARGIN = 1.1;
const EWMA_ALPHA = 0.2;

let o200k: Tiktoken | null = null;
let cl100k: Tiktoken | null = null;

function encoder(kind: DialectProfile['tokenizer']): Tiktoken | null {
  if (kind === 'tiktoken_o200k') {
    o200k ??= getEncoding('o200k_base');
    return o200k;
  }
  if (kind === 'tiktoken_cl100k') {
    cl100k ??= getEncoding('cl100k_base');
    return cl100k;
  }
  return null;
}

/** 未校准的原始估算：有分词器时数 token，否则按字节 */
export function rawEstimate(body: string, tokenizer: DialectProfile['tokenizer']): number {
  const enc = encoder(tokenizer);
  if (enc) {
    return enc.encode(body).length;
  }
  return Math.ceil(Buffer.byteLength(body, 'utf8') / BYTES_PER_TOKEN_FLOOR);
}

/** 一条路由的估算校准：实际 usage ÷ 原始估算 */
export interface Calibration {
  routeId: string;
  factor: number;
  recentMax: number;
  samples: number;
}

export function newCalibration(routeId: string): Calibration {
  return { routeId, factor: 1, recentMax: 1, samples: 0 };
}

/**
 * 可信的校准比例范围（ADR 0129）。分词器估算与服务方计数的差别在这之内：字节估算对中文与英文约为 0.4–0.7，
 * 有分词器时接近 1。之外的样本是服务方的计数异常（CCHP 的一次 2.9k token 请求报了 24,993 输入 token），
 * 计入后估算会长期偏大数倍，路由因"超过上下文"被跳过、研判因"超过预算"停止。
 */
export const CALIBRATION_RATIO_RANGE = { min: 0.2, max: 3 } as const;

export function plausibleRatio(ratio: number): boolean {
  return ratio >= CALIBRATION_RATIO_RANGE.min && ratio <= CALIBRATION_RATIO_RANGE.max;
}

/** 状态库里读回的校准：系数在可信范围之外（之前计入过异常样本）时从头校准 */
export function restoredCalibration(routeId: string, c: Calibration | null): Calibration {
  if (!c || !plausibleRatio(c.factor) || !plausibleRatio(c.recentMax)) {
    return newCalibration(routeId);
  }
  return c;
}

/** 按一次调用的实际输入更新校准；比例在可信范围之外的样本不计入（ADR 0129） */
export function calibrate(c: Calibration, raw: number, actualInput: number): Calibration {
  if (raw <= 0 || actualInput <= 0) {
    return c;
  }
  const ratio = actualInput / raw;
  if (!plausibleRatio(ratio)) {
    return c;
  }
  const factor = c.samples === 0 ? ratio : c.factor * (1 - EWMA_ALPHA) + ratio * EWMA_ALPHA;
  // 最近最大值缓慢回落，避免一次异常值长期抬高估算
  const recentMax = Math.max(ratio, c.recentMax * 0.98);
  return { routeId: c.routeId, factor, recentMax: c.samples === 0 ? ratio : recentMax, samples: c.samples + 1 };
}

export function estimateTokens(c: Calibration, raw: number): number {
  // 没有样本时字节估算本身已是保守值；有样本后按校准系数
  const k = c.samples === 0 ? 1 : Math.max(c.factor, c.recentMax) * CALIBRATION_MARGIN;
  return Math.ceil(raw * k);
}

/** 按路由单价计算一次调用的成本 */
export function callCost(price: ModelRoute['price'], u: TurnUsage): number {
  const cached = Math.min(u.cachedInput, u.input);
  const cachedPrice = price.cached_input_per_mtok ?? price.input_per_mtok;
  return (
    ((u.input - cached) * price.input_per_mtok + cached * cachedPrice + u.output * price.output_per_mtok) / 1_000_000
  );
}

export interface StageBudget {
  inputTokens: number;
  outputTokens: number;
}

export interface BudgetConfig {
  /** 每次研判的模型输入合计上限 */
  perResearchInputTokens: number;
  /** 每个阶段单次调用的输入与输出上限 */
  stages: Readonly<Record<LlmPhase, StageBudget>>;
  /** 每天（UTC）全部模型调用的 token 上限（输入 + 输出），覆盖研判、回放与评测 */
  dailyTokens: number;
  /** 达到这个比例后 warning 及以下事件只出阶段 A */
  dailyWarnRatio: number;
  /** 达到上限后的行为：critical_only 只有 critical 进入阶段 B；stage_a_only 全部只出阶段 A */
  onExhausted: 'critical_only' | 'stage_a_only';
}

export const DEFAULT_BUDGET: BudgetConfig = {
  perResearchInputTokens: 150_000,
  stages: {
    hypothesize: { inputTokens: 60_000, outputTokens: 6_000 },
    conclude: { inputTokens: 70_000, outputTokens: 8_000 },
    compress: { inputTokens: 30_000, outputTokens: 3_000 },
    still_consistent: { inputTokens: 20_000, outputTokens: 1_000 },
    repair: { inputTokens: 30_000, outputTokens: 8_000 },
  },
  dailyTokens: 5_000_000,
  dailyWarnRatio: 0.8,
  onExhausted: 'critical_only',
};

export interface DailyUsage {
  /** 当天 UTC 零点（毫秒） */
  day: number;
  tokens: number;
}

export function utcDay(now: number): number {
  return Math.floor(now / 86_400_000) * 86_400_000;
}

export type GateDecision = { allowed: true } | { allowed: false; reason: 'daily_warn' | 'daily_exhausted' };

/** 阶段 B 是否可以开始（入队与认领时都检查） */
export function dailyGate(cfg: BudgetConfig, used: number, severity: Severity): GateDecision {
  const ratio = used / cfg.dailyTokens;
  if (ratio >= 1) {
    if (cfg.onExhausted === 'stage_a_only' || severity !== 'critical') {
      return { allowed: false, reason: 'daily_exhausted' };
    }
    return { allowed: true };
  }
  if (ratio >= cfg.dailyWarnRatio && severity !== 'critical') {
    return { allowed: false, reason: 'daily_warn' };
  }
  return { allowed: true };
}

/** 回放与评测在当日预算用尽时推迟到次日 */
export function evalGate(cfg: BudgetConfig, used: number, planned: number): GateDecision {
  return used + planned > cfg.dailyTokens ? { allowed: false, reason: 'daily_exhausted' } : { allowed: true };
}

/** 一次研判内的预算账本：发送前按估算检查阶段上限与研判上限，返回后按 usage 记账 */
export class ResearchLedger {
  input = 0;
  output = 0;
  cost = 0;
  stop: string | null = null;

  constructor(private readonly cfg: BudgetConfig) {}

  /** 返回 null 表示可以发送；否则返回拒绝原因 */
  check(phase: LlmPhase, estimatedInput: number): string | null {
    const stage = this.cfg.stages[phase];
    if (estimatedInput > stage.inputTokens) {
      return `阶段 ${phase} 的输入估算 ${estimatedInput} token 超过单次上限 ${stage.inputTokens}`;
    }
    if (this.input + estimatedInput > this.cfg.perResearchInputTokens) {
      return `本次研判已用输入 ${this.input} token，再发送约 ${estimatedInput} token 会超过上限 ${this.cfg.perResearchInputTokens}`;
    }
    return null;
  }

  /** 一次调用可用的输入：阶段单次上限与研判剩余预算中的较小者（裁剪的目标，ADR 0099） */
  allowance(phase: LlmPhase): number {
    return Math.min(this.cfg.stages[phase].inputTokens, this.remaining());
  }

  /** 研判剩余的输入预算 */
  remaining(): number {
    return Math.max(0, this.cfg.perResearchInputTokens - this.input);
  }

  /** 只检查研判合计上限；裁剪到底仍超过阶段单次上限的请求按研判剩余预算放行（ADR 0099） */
  checkResearch(estimatedInput: number): string | null {
    if (this.input + estimatedInput > this.cfg.perResearchInputTokens) {
      return `本次研判已用输入 ${this.input} token，再发送约 ${estimatedInput} token 会超过上限 ${this.cfg.perResearchInputTokens}`;
    }
    return null;
  }

  record(u: TurnUsage, cost: number): void {
    this.input += u.input;
    this.output += u.output;
    this.cost += cost;
  }
}
