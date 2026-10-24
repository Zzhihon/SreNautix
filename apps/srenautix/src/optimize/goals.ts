import type { GoalBudget, GoalCreate, GoalSpec, Indicator } from '@srenautix/contract';
import { formatErrors, validatorOf } from '../llm/schema.js';
import { durationMs } from './stats.js';

// 下达目标（ADR 0146 §1.2、§5.1）：目标只引用领域包声明的指标或领域，参数按指标的 params schema 校验；
// 预算、窗口与期限取默认值并检查上限。模型、聊天与控制台都不提交自由的查询。

export const DEFAULT_BUDGET: GoalBudget = {
  tokens: 400_000,
  duration_seconds: 1200,
  checks: 12,
  dbstats_queries: 30,
  traces_queries: 10,
  logs_queries: 10,
  code_files: 200,
  code_bytes: 8 * 1024 * 1024,
  github_requests: 300,
};

export const DEFAULT_EXPIRES = '14d';
export const MAX_EXPIRES_MS = 30 * 24 * 3600_000;
export const DEFAULT_WINDOW = '7d';
export const MAX_WINDOW_MS = 14 * 24 * 3600_000;
/** 每个主体每天最多下达的目标数；每个集群同时最多未结束的目标数（§5.2） */
export const GOALS_PER_PRINCIPAL_PER_DAY = 5;
export const OPEN_GOALS_PER_CLUSTER = 10;

/** 目标可以引用的指标与领域（加载的领域包） */
export interface OptimizationCatalog {
  indicators: ReadonlyMap<string, { pack: string; def: Indicator }>;
  domains: ReadonlyMap<string, { packs: readonly string[]; indicators: readonly string[] }>;
}

export class GoalRejected extends Error {
  override name = 'GoalRejected';
}

/** 请求体（已按契约 GoalCreate 校验）→ 目标规格；origin 由认证上下文给出 */
export function goalSpec(
  create: GoalCreate,
  origin: GoalSpec['origin'],
  catalog: OptimizationCatalog,
): { spec: GoalSpec; expiresInMs: number } {
  const s = create.subject;
  if (s.type === 'indicator') {
    const ind = catalog.indicators.get(s.indicator);
    if (!ind) {
      throw new GoalRejected(`领域包中没有指标 ${s.indicator}`);
    }
    const schema = ind.def.params ?? { type: 'object', additionalProperties: false, properties: {} };
    const v = validatorOf(schema as Record<string, unknown>);
    if (!v(s.params)) {
      throw new GoalRejected(`指标 ${s.indicator} 的参数不合法：${formatErrors(v.errors)}`);
    }
    if (create.objective && create.objective.unit !== ind.def.unit) {
      throw new GoalRejected(`目标值的单位 ${create.objective.unit} 与指标的单位 ${ind.def.unit} 不同`);
    }
  } else {
    if (!catalog.domains.has(s.domain)) {
      throw new GoalRejected(`领域包中没有领域 ${s.domain}`);
    }
    if (create.objective) {
      throw new GoalRejected('领域体检没有目标值，差距按领域的门槛计算');
    }
  }
  if (create.objective) {
    const w = durationMs(create.objective.window);
    if (w > MAX_WINDOW_MS || w < 24 * 3600_000) {
      throw new GoalRejected('基线窗口必须在 1d 到 14d 之间');
    }
  }
  const expiresInMs = durationMs(create.expires_in ?? DEFAULT_EXPIRES);
  if (expiresInMs > MAX_EXPIRES_MS || expiresInMs < 3600_000) {
    throw new GoalRejected('有效期必须在 1h 到 30d 之间');
  }
  return {
    spec: {
      origin,
      subject: s,
      objective: create.objective,
      outputs: create.outputs,
      budget: { ...DEFAULT_BUDGET, ...(create.budget ?? {}) },
    },
    expiresInMs,
  };
}

/** 目标的基线窗口（毫秒）：目标值的 window，领域体检为默认 7 天 */
export function baselineWindowMs(spec: GoalSpec): number {
  return durationMs(spec.objective?.window ?? DEFAULT_WINDOW);
}
