import { z } from 'zod';
import { durationMs } from '../optimize/stats.js';
import { DEFAULT_NOVELTY, type NoveltyOptions } from '../stage-a/novelty.js';

// 证据基线的配置（ADR 0153）：server 的 stage_a.novelty 与评测配置的 reconstruct.novelty 相同，默认值即 ADR 中的取值

const duration = z.string().regex(/^([0-9]+(ms|s|m|h|d|w))+$/, '时长形如 30s、5m、24h、7d');

export const NOVELTY_CONFIG_DEFAULT = {
  enabled: DEFAULT_NOVELTY.enabled,
  comparisons: [...DEFAULT_NOVELTY.comparisons],
  span: DEFAULT_NOVELTY.span,
  samples: DEFAULT_NOVELTY.samples,
  min_samples: DEFAULT_NOVELTY.minSamples,
  abnormal_share: DEFAULT_NOVELTY.abnormalShare,
  quantile: DEFAULT_NOVELTY.quantile,
  ratio: DEFAULT_NOVELTY.ratio,
  timeout: `${DEFAULT_NOVELTY.timeoutMs / 1000}s`,
};

export const noveltyConfig = z
  .object({
    enabled: z.boolean().default(NOVELTY_CONFIG_DEFAULT.enabled),
    // 固定的对照时段（相对事件窗口提前的时长）
    comparisons: z.array(duration).min(1).default(NOVELTY_CONFIG_DEFAULT.comparisons),
    // 均匀样本覆盖的时长与样本数
    span: duration.default(NOVELTY_CONFIG_DEFAULT.span),
    samples: z.number().int().min(0).max(168).default(NOVELTY_CONFIG_DEFAULT.samples),
    // 得出结论的样本少于它时为 unknown
    min_samples: z.number().int().min(1).default(NOVELTY_CONFIG_DEFAULT.min_samples),
    // 规则 1：基线样本中判为异常的比例门槛
    abnormal_share: z.number().gt(0).max(1).default(NOVELTY_CONFIG_DEFAULT.abnormal_share),
    // 规则 2：主值分位区间 [1 − quantile, quantile]
    quantile: z.number().gt(0.5).max(1).default(NOVELTY_CONFIG_DEFAULT.quantile),
    // 规则 3：计数与速率类主值和对照时段最大值的倍数门槛
    ratio: z.number().gt(1).default(NOVELTY_CONFIG_DEFAULT.ratio),
    // 一次阶段 A 或一次检查取基线样本的期限
    timeout: duration.default(NOVELTY_CONFIG_DEFAULT.timeout),
  })
  .strict();

export type NoveltyConfig = z.infer<typeof noveltyConfig>;

export function noveltyOptions(c: NoveltyConfig): NoveltyOptions {
  if (c.min_samples > c.samples + c.comparisons.length) {
    throw new Error(`novelty.min_samples（${c.min_samples}）大于样本总数（${c.samples} + ${c.comparisons.length}）`);
  }
  return {
    enabled: c.enabled,
    comparisons: c.comparisons,
    span: c.span,
    samples: c.samples,
    minSamples: c.min_samples,
    abnormalShare: c.abnormal_share,
    quantile: c.quantile,
    ratio: c.ratio,
    timeoutMs: durationMs(c.timeout),
  };
}
