import type { EvidenceNovelty, EvidenceResult, Verdict } from '@srenautix/contract';
import { durationMs } from '../optimize/stats.js';

// 证据基线（ADR 0153）：判为异常的卡在同一实体上、按同样长度的窗口在事件之前的时段重新判定（基线样本），
// 与事件窗口比较。和基线相比没有明显升高的信号判为常态（routine）：不能作为根因或支持证据，只作背景。
//
// 基线样本的时段：固定的对照时段（默认事件前 1 小时、24 小时、7 天的同一时段）加上 span 内均匀分布的 samples 个时段
// （默认 7 天内每 6 小时一个），去重；与事件窗口重叠的时段（提前量小于窗口长度）不取。
// 只有得出结论（正常或异常）的样本参与判定，少于 min_samples 时为 unknown。依次检查：
// 1. abnormal_share：样本中判为异常的比例不低于门槛（默认 0.5），条件在大多数时段都成立；
// 2. within_range：条件在基线时段出现过（异常比例大于 0），并且事件窗口的主值落在样本主值的 [1 − q, q] 分位区间内（默认 q = 0.95）；
//    分位数取不插值的样本值（rankValue），一个时段的极端值不会把区间撑大到覆盖事件；
// 3. below_ratio：条件在基线时段出现过，主值的单位是计数或速率，与对照时段主值的最大值相差不到门槛倍数（默认 3 倍）。
// 条件在基线时段从没出现过时，主值只是展示用的数（例如卡片按超时次数判定、主值是排队数），不按主值判为常态。

export interface NoveltyOptions {
  /** 关闭时不取基线样本，异常卡没有 novelty */
  enabled: boolean;
  /** 固定的对照时段（相对事件窗口提前的时长） */
  comparisons: readonly string[];
  /** 均匀样本覆盖的时长 */
  span: string;
  /** 均匀样本数 */
  samples: number;
  /** 得出结论的样本少于它时为 unknown */
  minSamples: number;
  /** 规则 1 的门槛 */
  abnormalShare: number;
  /** 规则 2 的分位数 */
  quantile: number;
  /** 规则 3 的倍数 */
  ratio: number;
  /** 一次阶段 A（或一次检查）取基线样本的期限，毫秒 */
  timeoutMs: number;
}

export const DEFAULT_NOVELTY: NoveltyOptions = {
  enabled: true,
  comparisons: ['1h', '24h', '7d'],
  span: '7d',
  samples: 28,
  minSamples: 8,
  abnormalShare: 0.5,
  quantile: 0.95,
  ratio: 3,
  timeoutMs: 15_000,
};

/** 规则 3 适用的单位：计数与速率 */
const RATE_UNITS: ReadonlySet<string> = new Set(['count', 'per_second']);

export interface SampleOffset {
  /** 相对事件窗口提前的毫秒数 */
  ms: number;
  /** 固定对照时段的写法（例如 24h）；均匀样本为 null */
  comparison: string | null;
}

/** 窗口长度为 windowMs 的卡的基线样本时段，按提前量从小到大；与事件窗口重叠的不取 */
export function sampleOffsets(o: NoveltyOptions, windowMs: number): SampleOffset[] {
  const out = new Map<number, SampleOffset>();
  for (const c of o.comparisons) {
    const ms = durationMs(c);
    out.set(ms, { ms, comparison: c });
  }
  const span = durationMs(o.span);
  for (let k = 1; k <= o.samples; k++) {
    const ms = Math.round((span * k) / o.samples);
    if (!out.has(ms)) {
      out.set(ms, { ms, comparison: null });
    }
  }
  return [...out.values()].filter((s) => s.ms >= windowMs).sort((a, b) => a.ms - b.ms);
}

export interface NoveltySample {
  offset: SampleOffset;
  window: { from: string; to: string };
  verdict: Verdict;
  value: number | null;
}

/**
 * 不插值的分位数：q ≥ 0.5 时取第 floor(q × (n − 1)) 个（从小到大，从 0 起），q < 0.5 时取第 ceil(q × (n − 1)) 个，
 * 都向中位数一侧取整。样本只有十几个时，一个时段的极端值不会进入区间
 */
export function rankValue(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const r = q * (s.length - 1);
  return s[q >= 0.5 ? Math.floor(r) : Math.ceil(r)] as number;
}

const fmt = (v: number | null) => (v === null ? '无' : Number.isInteger(v) ? String(v) : v.toPrecision(4));

/** 由事件窗口的结果与基线样本判定新颖性；card 必须是异常卡 */
export function decideNovelty(
  card: Pick<EvidenceResult, 'value_number' | 'unit'>,
  samples: readonly NoveltySample[],
  o: NoveltyOptions,
  incomplete: boolean,
): EvidenceNovelty {
  const value = card.value_number ?? null;
  const comparisons = samples
    .filter((s) => s.offset.comparison !== null)
    .map((s) => ({ offset: s.offset.comparison as string, window: s.window, verdict: s.verdict, value: s.value }));
  const determinate = samples.filter((s) => s.verdict !== 'undeterminable');
  const abnormal = determinate.filter((s) => s.verdict === 'abnormal').length;
  const share = determinate.length ? abnormal / determinate.length : null;
  const values = determinate.map((s) => s.value).filter((v): v is number => v !== null);
  const range =
    values.length >= o.minSamples
      ? {
          low: rankValue(values, 1 - o.quantile),
          high: rankValue(values, o.quantile),
          quantile: o.quantile,
        }
      : null;
  const base = { value, comparisons, samples: determinate.length, abnormal_share: share, range };
  const summary = `基线样本 ${determinate.length} 个，其中异常 ${abnormal} 个`;
  if (determinate.length < o.minSamples) {
    return {
      ...base,
      status: 'unknown',
      rule: null,
      reason: `${summary}，少于 ${o.minSamples} 个${incomplete ? '（期限内没有取完）' : ''}，无法与基线比较`,
    };
  }
  if ((share as number) >= o.abnormalShare) {
    return {
      ...base,
      status: 'routine',
      rule: 'abnormal_share',
      reason: `${summary}，异常比例 ${fmt(share)} 不低于 ${o.abnormalShare}：条件在多数基线时段同样成立，属于常态`,
    };
  }
  if (abnormal > 0 && value !== null && range && value >= range.low && value <= range.high) {
    return {
      ...base,
      status: 'routine',
      rule: 'within_range',
      reason: `${summary}；主值 ${fmt(value)} 在基线样本的 ${1 - o.quantile}–${o.quantile} 分位区间 [${fmt(range.low)}, ${fmt(range.high)}] 内，属于常态`,
    };
  }
  const refs = comparisons
    .filter((c) => c.verdict !== 'undeterminable' && c.value !== null)
    .map((c) => c.value as number);
  const ref = refs.length ? Math.max(...refs) : null;
  if (abnormal > 0 && RATE_UNITS.has(card.unit ?? 'none') && value !== null && value > 0 && ref !== null && ref > 0) {
    const times = Math.max(value / ref, ref / value);
    if (times < o.ratio) {
      return {
        ...base,
        status: 'routine',
        rule: 'below_ratio',
        reason: `${summary}；主值 ${fmt(value)} 与对照时段最大值 ${fmt(ref)} 相差 ${fmt(times)} 倍，不到 ${o.ratio} 倍，属于常态`,
      };
    }
  }
  const against = range ? `，基线分位区间 [${fmt(range.low)}, ${fmt(range.high)}]` : '';
  return {
    ...base,
    status: 'novel',
    rule: null,
    reason: `${summary}；主值 ${fmt(value)}${against}，与基线相比明显异常`,
  };
}

/** 卡是否为常态（证据基线判为 routine） */
export function isRoutine(c: Pick<EvidenceResult, 'verdict' | 'novelty'>): boolean {
  return c.verdict === 'abnormal' && c.novelty?.status === 'routine';
}
