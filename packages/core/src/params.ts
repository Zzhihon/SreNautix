// 收敛与根因排序的参数（rca-params，DESIGN §5）。默认值与 contract/schemas/pack.schema.json 的 RcaParams 一致
import type { AlertRole, RcaParams } from '@srenautix/contract';
import { parseDuration } from './time.js';

export interface ResolvedRcaParams {
  weights: {
    coverage: number;
    precedence: number;
    role_prior: number;
    recent_change: number;
    chronic_penalty: number;
  };
  rolePriors: Record<AlertRole, number>;
  /** 归并阈值 τ */
  mergeThreshold: number;
  /** 分差 δ */
  ambiguityMargin: number;
  adjacencyMs: number;
  changeWindowMs: number;
  chronicWindowMs: number;
  chronicRate: number;
  hubMinDependents: number;
  topK: number;
}

export const DEFAULT_RCA_PARAMS: ResolvedRcaParams = {
  weights: { coverage: 0.4, precedence: 0.15, role_prior: 0.2, recent_change: 0.15, chronic_penalty: 0.1 },
  rolePriors: { change: 1, cause: 0.8, symptom: 0.3, forecast: 0, meta: 0 },
  mergeThreshold: 0.6,
  ambiguityMargin: 0.1,
  adjacencyMs: 30 * 60_000,
  changeWindowMs: 30 * 60_000,
  chronicWindowMs: 7 * 86_400_000,
  chronicRate: 0.5,
  hubMinDependents: 3,
  topK: 3,
};

/** 按领域包与用户层的声明顺序叠加参数，后面的覆盖前面的 */
export function resolveRcaParams(layers: readonly RcaParams[]): ResolvedRcaParams {
  const out: ResolvedRcaParams = structuredClone(DEFAULT_RCA_PARAMS);
  for (const p of layers) {
    Object.assign(out.weights, p.weights ?? {});
    Object.assign(out.rolePriors, p.role_priors ?? {});
    if (p.merge_threshold !== undefined) out.mergeThreshold = p.merge_threshold;
    if (p.ambiguity_margin !== undefined) out.ambiguityMargin = p.ambiguity_margin;
    if (p.adjacency !== undefined) out.adjacencyMs = parseDuration(p.adjacency);
    if (p.change_window !== undefined) out.changeWindowMs = parseDuration(p.change_window);
    if (p.chronic_window !== undefined) out.chronicWindowMs = parseDuration(p.chronic_window);
    if (p.chronic_rate !== undefined) out.chronicRate = p.chronic_rate;
    if (p.hub_min_dependents !== undefined) out.hubMinDependents = p.hub_min_dependents;
    if (p.top_k !== undefined) out.topK = p.top_k;
  }
  return out;
}
