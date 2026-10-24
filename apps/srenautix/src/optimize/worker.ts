import type { EvidenceResult } from '@srenautix/contract';
import { logger } from '../log.js';
import { dailyGate } from '../llm/budget.js';
import type { CheckTemplate } from '../research/catalog.js';
import type { QueryRunContext, QueryRunner } from '../research/checks.js';
import type { ResearchState } from '../research/controller.js';
import { HubError, type ClaimedTask, type HubClient } from '../research/hub.js';
import type { WorkerDeps } from '../research/service.js';
import { runOptimization, type OptimizeRunResult } from './controller.js';
import type { GoalRunContext } from './runner.js';

// worker 的目标任务（ADR 0146 §2.3、§5.3）：读取 server 准备的输入 → 用途预算 → 优化控制器 → 交回输出 → 释放任务。
// 目标运行不发 worker 事件（research.* 只属于事件研判），结果由 server 校验后计算门槛与建议。

/**
 * 目标运行的区分性检查交给 server（POST /v1/research/tasks/{run_id}/goal-query）：server 在发现挂到的组件上执行模板，
 * 经主动分析的信号量、每小时上限与负载保护。server 拒绝的请求（模板不在领域中、参数不合法、负载保护）以无法判定的卡返回
 */
export class GoalQueryRunner implements QueryRunner {
  constructor(
    private readonly hub: HubClient,
    private readonly runId: string,
    /** 假设的根因（发现的实体键）→ 发现指纹 */
    private readonly findingOf: (entity: string) => string | null,
  ) {}

  async run(template: CheckTemplate, args: Record<string, unknown>, ctx: QueryRunContext): Promise<EvidenceResult> {
    const finding = this.findingOf(ctx.rootComponent);
    try {
      if (!finding) {
        throw new HubError(
          400,
          'bad_request',
          `假设 ${ctx.hypothesisId} 的实体 ${ctx.rootComponent} 不是进入分析的发现`,
        );
      }
      return await this.hub.goalQuery(this.runId, template.id, args, finding, ctx.signal);
    } catch (e) {
      if (!(e instanceof HubError) || e.status >= 500) {
        throw e;
      }
      const now = new Date().toISOString();
      const slash = template.id.indexOf('/');
      return {
        ref: 'card:1',
        card_id: `${template.id.slice(0, slash)}/templates/${template.id.slice(slash + 1)}`,
        title: { 'zh-CN': template.description, en: template.description },
        threshold: null,
        series: [],
        entity: null,
        window: { from: now, to: now },
        verdict: 'undeterminable',
        display_state: 'undeterminable',
        reason: { kind: 'evaluation_error', text: e.message },
        value: null,
        table: null,
        queries: [],
        egress: 'allow',
        anomaly_started_at: null,
        evaluated_at: now,
      };
    }
  }
}

/** 主动优化用途的当日用量比例；没有配置用途上限时为 1（不运行目标任务） */
export async function optimizationRatio(d: WorkerDeps): Promise<number> {
  const limit = d.budget.optimizationDailyTokens ?? 0;
  if (limit <= 0) {
    return 1;
  }
  return (await d.store.dailyTokens('optimization')) / limit;
}

/** 处理一个目标任务；返回写入的运行状态 */
export async function runGoalTask(
  d: WorkerDeps,
  task: ClaimedTask,
  signal: AbortSignal,
): Promise<'completed' | 'failed'> {
  const ctx: GoalRunContext = await d.hub.goalContext(task.run_id);
  await d.store.startRun({
    runId: task.run_id,
    incidentId: ctx.goal.goal_id,
    incidentVersion: ctx.goal.revision,
    clusterId: ctx.goal.cluster_id,
    reason: task.reason,
    evidenceFingerprint: '',
    subjectType: 'goal',
  });
  const currency = d.layer.routes[0]?.route.price.currency ?? 'USD';
  const failRun = async (kind: string, message: string): Promise<'failed'> => {
    await d.store.finishGoalRun({
      runId: task.run_id,
      state: 'failed',
      stopReason: kind === 'budget_exhausted' ? 'budget' : null,
      output: null,
      error: { kind, message },
      input: 0,
      output_tokens: 0,
      cost: 0,
      currency,
      steps: [],
      checkCards: [],
    });
    await d.hub.failOptimization(task.run_id, kind, message);
    await d.hub.finish(task.run_id, task.worker_id, 'failed');
    return 'failed';
  };
  const unavailable = d.layer.unavailableReason();
  if (unavailable) {
    return failRun('model_unavailable', unavailable);
  }
  // 预算（ADR 0146 §5.3）：全部用途的当日上限按 info 级别判断，主动优化另有自己的当日上限
  const total = await d.store.dailyTokens();
  const gate = dailyGate(d.budget, total, 'info');
  if (!gate.allowed) {
    return failRun('budget_exhausted', `当日模型 token 已用 ${total}，主动优化让给事件研判`);
  }
  const ratio = await optimizationRatio(d);
  if (ratio >= 1) {
    return failRun(
      'budget_exhausted',
      d.budget.optimizationDailyTokens
        ? `主动优化当日已用 ${Math.round(ratio * d.budget.optimizationDailyTokens)} token，达到上限 ${d.budget.optimizationDailyTokens}`
        : '没有配置主动优化的每日用量（budget.purposes.optimization.daily_tokens）',
    );
  }
  const byEntity = new Map(ctx.candidates.filter((c) => c.selected).map((c) => [c.entity.key, c.finding]));
  const steps: Array<{ state: string; started_at: string; finished_at: string | null }> = [];
  let res: OptimizeRunResult;
  try {
    const deadline = Math.min(d.limits.deadlineMs, Date.parse(task.deadline_at) - Date.now());
    res = await runOptimization(
      { runId: task.run_id, ctx, signal },
      {
        layer: d.layer,
        metrics: d.metrics,
        language: d.language,
        limits: { ...d.limits, deadlineMs: deadline },
        query: new GoalQueryRunner(d.hub, task.run_id, (e) => byEntity.get(e) ?? null),
        now: () => Date.now(),
      },
      {
        step: async (state: ResearchState, startedAt: string, finishedAt: string | null) => {
          steps.push({ state, started_at: startedAt, finished_at: finishedAt });
          await d.store.step(task.run_id, state);
        },
        llmCall: (r) => d.store.llmCall(r),
        toolCall: (r) => d.store.toolCall(task.run_id, r),
      },
    );
  } catch (e) {
    logger.error('目标运行内部错误', { run_id: task.run_id, error: e });
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return failRun(signal.aborted ? 'deadline' : 'internal', message.slice(0, 2000));
  }
  let state = res.state;
  let error = res.error;
  if (res.output) {
    try {
      await d.hub.submitOptimization(task.run_id, res.output);
    } catch (e) {
      if (!(e instanceof HubError) || e.status >= 500) {
        throw e;
      }
      state = 'failed';
      error = { kind: 'internal', message: `server 拒绝了运行输出：${e.message}`.slice(0, 2000) };
    }
  }
  await d.store.finishGoalRun({
    runId: task.run_id,
    state,
    stopReason: res.stopReason,
    output: res.output,
    error,
    input: res.ledger.input,
    output_tokens: res.ledger.output,
    cost: res.ledger.cost,
    currency,
    steps,
    checkCards: res.book.allCards
      .filter((c) => c.hypothesisId !== null)
      .map((c) => ({ ref: c.ref, hypothesisId: c.hypothesisId as string, judgedBy: c.judgedBy, result: c.result })),
  });
  if (state === 'failed') {
    await d.hub.failOptimization(task.run_id, error?.kind ?? 'internal', error?.message ?? '');
  }
  await d.hub.finish(task.run_id, task.worker_id, state);
  logger.info('目标运行完成', {
    run_id: task.run_id,
    goal_id: ctx.goal.goal_id,
    state,
    stop: res.stopReason,
    levels: res.output?.conclusions.map((c) => c.level) ?? [],
    tokens: res.ledger.input + res.ledger.output,
    ...(error ? { error_kind: error.kind, error: error.message.slice(0, 1000) } : {}),
  });
  return state;
}
