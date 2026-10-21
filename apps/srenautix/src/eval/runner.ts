import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalCase, EvalSnapshot } from '@srenautix/contract';
import { logger } from '../log.js';
import type { ModelLayer } from '../llm/session.js';
import { DEFAULT_LIMITS, runStageB, type ResearchLimits, type RunSink } from '../research/controller.js';
import type { WorkerMetrics } from '../research/metrics.js';
import type { QueryRunner } from '../research/checks.js';
import type { Language } from '../prompts/index.js';
import type { Tool } from '../tools/box.js';
import { replayCase, type Excluded } from './leakage.js';
import { topComponents, type RunRecord } from './score.js';
import { SnapshotTools } from './vcr.js';

// 回放评测：每个用例 × 每条路由 × k 次运行，各自独立运行阶段 B（replay 模式，不提交提议，不写库）。
// snapshot 模式的工具只读快照；reconstructed 模式的工具是配置的只读工具（按快照窗口约束时间范围）。

export interface EvalPlan {
  mode: 'snapshot' | 'reconstructed';
  cases: Array<{ c: EvalCase; s: EvalSnapshot }>;
  /** 每条路由单独评测：layer 中只含这一条路由 */
  layers: Array<{ routeId: string; layer: ModelLayer }>;
  runs: number;
  language: Language;
  metrics: WorkerMetrics;
  limits?: ResearchLimits;
  /** reconstructed 模式的只读工具（只读当前状态的工具会被过滤） */
  liveTools?: Tool[];
  query: QueryRunner | null;
  /** 按用例给出查询模板的执行方（重建模式每个用例的事件与时刻不同）；没有时用 query */
  queryFor?: (caseId: string) => QueryRunner | null;
  /** 本次评测的 token 上限（输入 + 输出）；达到后不再开始新的运行 */
  maxTokens: number;
  signal: AbortSignal;
  /** 研判记录目录：每次运行写一份 <case_id>/<route>-<run>.json（步骤、模型调用的请求与响应、工具调用、检查、输出） */
  traceDir?: string | null;
}

/**
 * 模型路由不可达（连接失败、熔断）时评测立即失败：这类运行量出的是评测机器到模型服务的网络，不是研判质量，
 * 记进成绩单会让整份成绩单失真（ADR 0110）。
 */
export class EvalInfrastructureError extends Error {
  override name = 'EvalInfrastructureError';
}

const INFRASTRUCTURE: ReadonlySet<string> = new Set(['model_unavailable', 'breaker_open']);

interface Trace {
  steps: Array<{ state: string; started_at: string; finished_at: string | null }>;
  llm_calls: unknown[];
  tool_calls: unknown[];
}

export interface EvalOutcome {
  runs: RunRecord[];
  excluded: Map<string, Excluded[]>;
  tokens: number;
  /** 因 token 上限没有运行的 (用例, 路由, 次序) */
  skipped: number;
}

function traceSink(t: Trace): RunSink {
  return {
    step: async (state, startedAt, finishedAt) => {
      t.steps.push({ state, started_at: startedAt, finished_at: finishedAt });
    },
    llmCall: async (r) => {
      t.llm_calls.push(r);
    },
    toolCall: async (r) => {
      t.tool_calls.push(r);
    },
  };
}

export async function runEval(p: EvalPlan): Promise<EvalOutcome> {
  const runs: RunRecord[] = [];
  const excluded = new Map<string, Excluded[]>();
  let tokens = 0;
  let skipped = 0;
  for (const { c, s } of p.cases) {
    const { rc, excluded: ex } = replayCase(c, s);
    excluded.set(c.case_id, ex);
    for (const { routeId, layer } of p.layers) {
      for (let i = 0; i < p.runs; i++) {
        if (tokens >= p.maxTokens) {
          skipped++;
          continue;
        }
        const vcr = p.mode === 'snapshot' ? new SnapshotTools(s) : null;
        const tools = vcr ? vcr.tools() : (p.liveTools ?? []);
        const started = Date.now();
        const trace: Trace = { steps: [], llm_calls: [], tool_calls: [] };
        const res = await runStageB(
          { runId: `eval:${c.case_id}:${routeId}:${i}`, rc, previous: null, signal: p.signal },
          {
            layer,
            metrics: p.metrics,
            language: p.language,
            limits: p.limits ?? DEFAULT_LIMITS,
            tools,
            query: p.queryFor ? p.queryFor(c.case_id) : p.query,
            replay: true,
            now: () => Date.now(),
          },
          traceSink(trace),
        );
        const used = res.ledger.input + res.ledger.output;
        tokens += used;
        const out = res.output;
        if (p.traceDir) {
          const dir = join(p.traceDir, encodeURIComponent(c.case_id));
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, `${routeId}-${i}.json`),
            `${JSON.stringify(
              {
                case_id: c.case_id,
                route: routeId,
                run: i,
                state: res.state,
                stop_reason: res.stopReason,
                error: res.error,
                truth: c.truth,
                output: out,
                checks: res.checks.map((x) => ({
                  check: x.check,
                  args: x.args,
                  outcome: x.outcome,
                  card: x.card,
                  error: x.error,
                })),
                ledger: res.ledger,
                ...trace,
              },
              null,
              1,
            )}\n`,
          );
        }
        if (res.error && INFRASTRUCTURE.has(res.error.kind)) {
          throw new EvalInfrastructureError(
            `用例 ${c.case_id} 路由 ${routeId} 第 ${i} 次：${res.error.kind}：${res.error.message}。评测停止，网络或模型服务恢复后重跑`,
          );
        }
        const route = layer.route(routeId).route;
        runs.push({
          caseId: c.case_id,
          run: i,
          routeId,
          model: route.model,
          state: res.state,
          structuredFailure: res.error?.kind === 'invalid_output',
          level: out?.conclusion.level ?? null,
          disposition: out?.disposition ?? s.context.stage_a.disposition,
          top: out ? topComponents(out) : [],
          cost: res.ledger.cost,
          currency: route.price.currency,
          inputTokens: res.ledger.input,
          outputTokens: res.ledger.output,
          missRate: vcr ? vcr.missRate() : null,
          fingerprints: [
            ...new Set(res.session.routeUses.map((u) => u.provider_fingerprint).filter((x): x is string => x !== null)),
          ],
          durationMs: Date.now() - started,
          error: res.error ? `${res.error.kind}: ${res.error.message}` : null,
          proposals: (out?.proposals ?? []).map((x) => ({ action_id: x.action_id, params: x.params })),
        });
        logger.info('评测运行完成', {
          case_id: c.case_id,
          route: routeId,
          run: i,
          state: res.state,
          conclusion_level: out?.conclusion.level ?? null,
          tokens: used,
        });
      }
    }
  }
  return { runs, excluded, tokens, skipped };
}
