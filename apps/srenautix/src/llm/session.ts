import { createHash } from 'node:crypto';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type OpenAI from 'openai';
import type { DialectProfile, ModelRoute } from '@srenautix/contract';
import { logger } from '../log.js';
import type { WorkerMetrics } from '../research/metrics.js';
import {
  callCost,
  calibrate,
  estimateTokens,
  rawEstimate,
  type BudgetConfig,
  type Calibration,
  type ResearchLedger,
} from './budget.js';
import { touchesFailureDomain, type RouteBreaker } from './breaker.js';
import { EgressBlocked, type Egress } from './egress.js';
import { turnFingerprint, type Drift, type FingerprintTracker } from './fingerprint.js';
import { countHits, type RedactionHits } from './redact.js';
import type { DisabledRoute } from './routes.js';
import { reaskText, repairLocally, type RepairStep } from './repair.js';
import { StreamTimeout, streamingParams, streamTurn } from './stream.js';
import type { ModelClass, RouteTimeouts } from './timeouts.js';
import {
  LlmError,
  type EgressCategory,
  type LlmPhase,
  type LlmRequest,
  type LlmTurn,
  type OutputFormat,
  type Segment,
} from './types.js';
import { requestCategories, toChatParams, toResponsesParams } from './wire.js';

// 一次研判的模型会话（DESIGN §7.2、§8）：按阶段选模型档位、按路由优先级与熔断状态选路由、
// 驱动修复阶梯、按 usage 记账，并产出每次调用的记录、研判清单中的路由使用与出境清单。

/** 剩余时间少于这个值时不再发起模型调用 */
export const MIN_CALL_WINDOW_MS = 5_000;

export interface RouteRuntime {
  route: ModelRoute;
  profile: DialectProfile;
  client: OpenAI;
  /** 流式调用的首 token、空闲与总时长超时（ADR 0098） */
  timeouts: RouteTimeouts;
  modelClass: ModelClass;
  breaker: RouteBreaker;
  calibration: Calibration;
  fingerprint: FingerprintTracker;
}

/** worker.llm_calls 的一行；只保存脱敏后的内容。outcome 与 repairStep 的取值与契约 LlmCall 一致 */
export interface LlmCallRecord {
  runId: string | null;
  seq: number;
  phase: LlmPhase;
  routeId: string;
  model: string;
  api: 'responses' | 'chat_completions';
  promptHash: string;
  outcome: 'succeeded' | 'retried' | 'switched' | 'failed';
  repairStep: RepairStep | null;
  errorKind: string | null;
  httpStatus: number | null;
  durationMs: number;
  estimatedInput: number;
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_tokens: number };
  cost: number;
  currency: string;
  bytes: number;
  redactionHits: RedactionHits;
  categories: EgressCategory[];
  fingerprint: string | null;
  request: string;
  response: string | null;
  note: string | null;
  at: string;
}

export interface RouteUse {
  phase: LlmPhase;
  route_id: string;
  model: string;
  dialect_profile: string;
  provider_fingerprint: string | null;
  sampling: Record<string, number | string | boolean>;
  seed: number | null;
}

export interface EgressEntry {
  route_id: string;
  in_domain: boolean;
  categories: EgressCategory[];
  redaction_hits: number;
  bytes: number;
}

export interface ModelLayerOptions {
  /** 可用的路由；可以为空（全部被出站策略禁用），这时阶段 B 不运行，只出阶段 A */
  routes: RouteRuntime[];
  /** 启动时被出站策略禁用的路由：不在 routes 中，任何情况下都不会被调用 */
  disabled?: readonly DisabledRoute[];
  egress: Egress;
  budget: BudgetConfig;
  metrics: WorkerMetrics;
  language: 'zh' | 'en';
  /** 路由校准系数变化后持久化 */
  onCalibration(c: Calibration): Promise<void>;
  /** 服务方指纹确认变化 */
  onDrift(d: Drift): Promise<void>;
}

export interface SessionContext {
  runId: string | null;
  /** 事件涉及的组件键（成员告警的实体与候选根因），用于故障域提前熔断 */
  incidentComponents: readonly string[];
  /** 阶段 B 的硬期限（毫秒时间戳） */
  deadline: number;
  signal: AbortSignal;
  ledger: ResearchLedger;
  record(r: LlmCallRecord): Promise<void>;
}

export type StructuredFailure =
  'model_output_invalid' | 'model_unavailable' | 'budget' | 'failure_domain' | 'deadline' | 'egress_blocked';

export type StructuredResult<T> =
  | { ok: true; value: T; routeId: string; step: RepairStep; notes: string[] }
  | { ok: false; reason: StructuredFailure; detail: string; attempts: string[] };

export class BudgetStop extends Error {
  override name = 'BudgetStop';
}

export class DeadlineStop extends Error {
  override name = 'DeadlineStop';
}

/** 阶段使用的模型档位：hypothesize 与 conclude 用大模型，其余用小模型；对应档位没有可用路由时用另一档 */
export function tierFor(phase: LlmPhase): 'small' | 'large' {
  return phase === 'hypothesize' || phase === 'conclude' ? 'large' : 'small';
}

/** 把 SDK 的错误归类；调用方中止原样返回中止原因 */
export function classifyError(e: unknown, routeId: string, signal: AbortSignal): unknown {
  if (e instanceof LlmError || e instanceof EgressBlocked) {
    return e;
  }
  if (e instanceof StreamTimeout) {
    return new LlmError('llm_timeout', null, `模型调用超时：${e.message}`, routeId);
  }
  if (e instanceof APIUserAbortError) {
    return signal.aborted ? signal.reason : e;
  }
  if (e instanceof APIConnectionTimeoutError) {
    return new LlmError('llm_timeout', null, '模型调用超时', routeId);
  }
  if (e instanceof APIConnectionError) {
    const cause = (e as { cause?: unknown }).cause;
    if (cause instanceof EgressBlocked) {
      return cause;
    }
    return new LlmError(
      'llm_network',
      null,
      `连接模型服务失败：${e.message}${cause instanceof Error ? `（${cause.message}）` : ''}`,
      routeId,
    );
  }
  if (e instanceof APIError) {
    return new LlmError(
      'llm_http',
      e.status ?? null,
      `模型服务返回 HTTP ${e.status ?? '?'}：${e.message}`.slice(0, 600),
      routeId,
    );
  }
  return e;
}

export class ModelLayer {
  constructor(readonly opts: ModelLayerOptions) {}

  get routes(): readonly RouteRuntime[] {
    return this.opts.routes;
  }

  get disabled(): readonly DisabledRoute[] {
    return this.opts.disabled ?? [];
  }

  /** 没有可用路由时的降级原因（阶段 B 不运行，只出阶段 A）；有可用路由时为 null */
  unavailableReason(): string | null {
    if (this.opts.routes.length) {
      return null;
    }
    const why = this.disabled.map((d) => d.message).join('；');
    return `没有可用的模型路由${why ? `：${why}` : ''}。阶段 B 不运行，只出阶段 A`;
  }

  route(id: string): RouteRuntime {
    const r = this.opts.routes.find((x) => x.route.id === id);
    if (!r) {
      throw new Error(`没有路由 ${id}`);
    }
    return r;
  }

  /** 所有路由都声明了被管拓扑内的故障域时返回 true（配置校验告警、控制台横幅） */
  allRoutesInTopology(): boolean {
    return this.opts.routes.length > 0 && this.opts.routes.every((r) => r.route.failure_domain.length > 0);
  }

  /** 候选路由：先本档位，再另一档位；同档位按配置顺序 */
  ordered(phase: LlmPhase): RouteRuntime[] {
    const tier = tierFor(phase);
    return [
      ...this.opts.routes.filter((r) => r.route.tier === tier),
      ...this.opts.routes.filter((r) => r.route.tier !== tier),
    ];
  }

  session(ctx: SessionContext): ModelSession {
    return new ModelSession(this, ctx);
  }
}

type Draft = Omit<LlmCallRecord, 'outcome' | 'repairStep'>;

interface SentCall {
  turn: LlmTurn;
  draft: Draft;
  /** 为放进路由窗口与预算而裁掉的内容（ADR 0099），写进调用记录与研判的校验说明 */
  trimmed: string[];
}

/** 找到 rank 最小的可裁剪片段，换成更短的片段或去掉；没有可裁剪的片段时返回 null */
export function trimOnce(req: LlmRequest): { request: LlmRequest; label: string } | null {
  let best: { item: number; seg: number; rank: number } | null = null;
  req.items.forEach((it, ii) => {
    if (it.type !== 'system' && it.type !== 'user') {
      return;
    }
    it.segments.forEach((sg, si) => {
      if (sg.trim && (best === null || sg.trim.rank < best.rank)) {
        best = { item: ii, seg: si, rank: sg.trim.rank };
      }
    });
  });
  if (best === null) {
    return null;
  }
  const { item, seg } = best as { item: number; seg: number };
  const target = req.items[item] as Extract<LlmRequest['items'][number], { segments: Segment[] }>;
  const old = target.segments[seg] as Segment;
  const next = (old.trim as NonNullable<Segment['trim']>).next();
  const segments = [...target.segments];
  if (next) {
    segments[seg] = next;
  } else {
    segments.splice(seg, 1);
  }
  const items = [...req.items];
  items[item] = { ...target, segments };
  return { request: { ...req, items }, label: (old.trim as NonNullable<Segment['trim']>).label };
}

export function trimNote(routeId: string, trimmed: readonly string[]): string {
  return `为放进路由 ${routeId} 的上下文窗口与输入预算，提示词裁掉了：${trimmed.join('；')}`;
}

export class ModelSession {
  readonly routeUses: RouteUse[] = [];
  readonly egress: EgressEntry[] = [];
  private seq = 0;

  constructor(
    private readonly layer: ModelLayer,
    private readonly ctx: SessionContext,
  ) {}

  /** 因事件涉及其故障域而对本次研判提前熔断的路由 */
  preOpened(): Array<{ routeId: string; component: string }> {
    const out: Array<{ routeId: string; component: string }> = [];
    for (const r of this.layer.routes) {
      const c = touchesFailureDomain(this.ctx.incidentComponents, r.route.failure_domain);
      if (c) {
        out.push({ routeId: r.route.id, component: c });
      }
    }
    return out;
  }

  /**
   * 一次结构化调用，走完修复阶梯：每条路由上本地修复（解析、jsonrepair、校验、按字段挽救）失败时带上错误重新请求一次，
   * 仍失败或路由不可用时换下一条路由；全部失败返回失败原因，由调用方只出确定性报告。
   * 预算、期限与蜜标的截停对所有路由一样，直接结束。
   */
  async structured<T>(
    phase: LlmPhase,
    base: Omit<LlmRequest, 'output'>,
    output: OutputFormat & { full: Record<string, unknown> },
  ): Promise<StructuredResult<T>> {
    const unavailable = this.layer.unavailableReason();
    if (unavailable) {
      // 所有路由都被出站策略禁用：不发出任何请求
      return { ok: false, reason: 'egress_blocked', detail: unavailable, attempts: [unavailable] };
    }
    const attempts: string[] = [];
    const preOpened = new Map(this.preOpened().map((p) => [p.routeId, p.component]));
    const { metrics } = this.layer.opts;
    const order = this.layer.ordered(phase);
    let sawInvalid = false;
    let sawEgress = false;
    let candidates = 0;
    for (const [ri, rt] of order.entries()) {
      const id = rt.route.id;
      const last = ri === order.length - 1;
      const domain = preOpened.get(id);
      if (domain) {
        metrics.failureDomainSkips.inc({ route: id });
        attempts.push(`${id}：事件涉及该路由的故障域组件 ${domain}，提前熔断`);
        continue;
      }
      candidates++;
      const request: LlmRequest = { ...base, output: { name: output.name, schema: output.schema } };
      let current = request;
      let reasked = false;
      for (;;) {
        let sent: SentCall;
        try {
          sent = await this.send(rt, phase, current);
        } catch (e) {
          if (e instanceof BudgetStop) {
            return { ok: false, reason: 'budget', detail: e.message, attempts: [...attempts, e.message] };
          }
          if (e instanceof DeadlineStop) {
            return { ok: false, reason: 'deadline', detail: e.message, attempts: [...attempts, e.message] };
          }
          if (e instanceof CallFailed) {
            await this.ctx.record({
              ...e.draft,
              outcome: last ? 'failed' : 'switched',
              repairStep: reasked ? 'reask' : null,
            });
            if (e.cause instanceof EgressBlocked) {
              sawEgress = true;
              attempts.push(`${id}：${e.cause.message}`);
              if (e.cause.reason === 'halted' || e.cause.reason === 'honeytoken') {
                return { ok: false, reason: 'egress_blocked', detail: e.cause.message, attempts };
              }
            } else {
              attempts.push(`${id}：${(e.cause as Error).message}`);
            }
            break;
          }
          throw e;
        }
        const local = repairLocally(sent.turn, output.full);
        if (local.ok) {
          const step: RepairStep = reasked ? 'reask' : local.step;
          metrics.repair.inc({ phase, route: id, level: step, outcome: 'ok' });
          const notes = [...(sent.trimmed.length ? [trimNote(id, sent.trimmed)] : []), ...local.notes];
          await this.ctx.record({
            ...sent.draft,
            outcome: 'succeeded',
            repairStep: step,
            note: notes.join('；') || null,
          });
          return { ok: true, value: local.value as T, routeId: id, step, notes };
        }
        sawInvalid = true;
        const willReask = !reasked && !local.refusal;
        metrics.repair.inc({ phase, route: id, level: reasked ? 'reask' : local.step, outcome: 'failed' });
        await this.ctx.record({
          ...sent.draft,
          outcome: willReask ? 'retried' : last ? 'failed' : 'switched',
          repairStep: reasked ? 'reask' : local.step,
          errorKind: 'llm_output_invalid',
          note: [sent.draft.note, local.error].filter(Boolean).join('；'),
        });
        attempts.push(`${id}${reasked ? '（重新请求后）' : ''}：${local.error}`);
        if (!willReask) {
          break;
        }
        reasked = true;
        current = {
          ...request,
          items: [
            ...request.items,
            { type: 'assistant', text: sent.turn.text ?? '' },
            {
              type: 'user',
              segments: [{ text: reaskText(local.error, this.layer.opts.language), categories: [], egress: 'allow' }],
            },
          ],
        };
      }
      if (!last) {
        metrics.repair.inc({ phase, route: id, level: 'next_route', outcome: 'failed' });
      }
    }
    metrics.repair.inc({ phase, route: '', level: 'deterministic_only', outcome: 'failed' });
    if (candidates === 0) {
      return { ok: false, reason: 'failure_domain', detail: '所有路由都因事件涉及其故障域而提前熔断', attempts };
    }
    if (sawInvalid) {
      return { ok: false, reason: 'model_output_invalid', detail: '模型输出无效', attempts };
    }
    return {
      ok: false,
      reason: sawEgress ? 'egress_blocked' : 'model_unavailable',
      detail: attempts.join('；'),
      attempts,
    };
  }

  /**
   * 在一条路由上发一次流式调用；期限、上下文长度、预算、熔断在发送前检查。
   * 估算超过路由窗口或本次可用预算时，按片段的裁剪顺序逐步裁剪，直到放得下或无可再裁（ADR 0099）。
   */
  private async send(rt: RouteRuntime, phase: LlmPhase, req: LlmRequest): Promise<SentCall> {
    const { egress, budget, metrics, language } = this.layer.opts;
    const route = rt.route;
    const started = Date.now();
    const remaining = this.ctx.deadline - started;
    if (remaining < MIN_CALL_WINDOW_MS) {
      throw new DeadlineStop(`阶段 B 剩余 ${Math.max(0, Math.round(remaining / 1000))} 秒，不再调用模型`);
    }
    const stage = budget.stages[phase];
    const wire = { model: route.model, profile: rt.profile, language };
    const build = (r: LlmRequest) => {
      const prepared = egress.prepare(r);
      const sized: LlmRequest = {
        ...prepared.request,
        maxOutputTokens: Math.min(prepared.request.maxOutputTokens, stage.outputTokens),
      };
      const params = streamingParams(
        route.api,
        route.api === 'responses' ? toResponsesParams(sized, wire) : toChatParams(sized, wire),
      );
      const body = JSON.stringify(params);
      const raw = rawEstimate(body, rt.profile.tokenizer);
      return { prepared, sized, params, body, raw, estimated: estimateTokens(rt.calibration, raw) };
    };
    let built = build(req);
    const window = rt.profile.context_tokens - built.sized.maxOutputTokens;
    const target = Math.min(window, this.ctx.ledger.allowance(phase));
    const trimmed: string[] = [];
    let current = req;
    while (built.estimated > target) {
      const t = trimOnce(current);
      if (!t) {
        break;
      }
      current = t.request;
      trimmed.push(t.label);
      built = build(current);
    }
    if (trimmed.length) {
      metrics.promptTrims.inc({ phase, route: route.id }, trimmed.length);
    }
    const { prepared, sized, params, body, raw, estimated } = built;
    const draft: Draft = {
      runId: this.ctx.runId,
      seq: ++this.seq,
      phase,
      routeId: route.id,
      model: route.model,
      api: route.api,
      promptHash: `sha256:${createHash('sha256').update(body).digest('hex')}`,
      errorKind: null,
      httpStatus: null,
      durationMs: 0,
      estimatedInput: estimated,
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
      cost: 0,
      currency: route.price.currency,
      bytes: 0,
      redactionHits: prepared.hits,
      categories: [...requestCategories(sized.items)] as EgressCategory[],
      fingerprint: null,
      request: body,
      response: null,
      note: trimmed.length ? trimNote(route.id, trimmed) : null,
      at: new Date(started).toISOString(),
    };
    if (estimated > window) {
      throw new CallFailed(
        { ...draft, errorKind: 'context' },
        new LlmError(
          'llm_budget',
          null,
          `裁剪后输入估算 ${estimated} token 加输出上限 ${sized.maxOutputTokens} 仍超过路由 ${route.id} 的上下文 ${rt.profile.context_tokens}`,
          route.id,
        ),
      );
    }
    // 裁剪到底仍超过阶段单次上限时，只要研判剩余预算够就照常发送，不让整次研判因超限失败
    const over = this.ctx.ledger.checkResearch(estimated);
    if (over) {
      metrics.budgetStops.inc({ reason: 'research' });
      throw new BudgetStop(over);
    }
    const admission = rt.breaker.admit(started);
    if (!admission.allowed) {
      throw new CallFailed(
        { ...draft, errorKind: 'llm_breaker_open' },
        new LlmError('llm_breaker_open', null, `路由 ${route.id} 熔断中（${admission.reason}）`, route.id),
      );
    }
    const cap = Math.min(rt.timeouts.totalMs ?? Number.POSITIVE_INFINITY, remaining);
    let turn: LlmTurn;
    let firstTokenMs: number | null;
    const meter = { bytes: 0 };
    try {
      ({ turn, firstTokenMs } = await egress.track(meter, () =>
        streamTurn(rt.client, route.api, params, rt.profile, rt.timeouts, cap, this.ctx.signal, route.id),
      ));
    } catch (rawErr) {
      const e = classifyError(rawErr, route.id, this.ctx.signal);
      const ms = Date.now() - started;
      if (e instanceof LlmError) {
        if (e.countsAsFailure) {
          rt.breaker.failure(Date.now(), admission.probe);
        } else {
          rt.breaker.neutral(admission.probe);
        }
        this.syncBreaker(rt);
        metrics.llmCalls.inc({ phase, route: route.id, outcome: 'failed', error_kind: e.kind });
        if (meter.bytes > 0) {
          metrics.egressBytes.inc({ route: route.id, in_domain: String(route.in_domain) }, meter.bytes);
          this.egress.push({
            route_id: route.id,
            in_domain: route.in_domain,
            categories: draft.categories,
            redaction_hits: countHits(prepared.hits),
            bytes: meter.bytes,
          });
        }
        throw new CallFailed(
          {
            ...draft,
            errorKind: e.kind,
            httpStatus: e.httpStatus,
            durationMs: ms,
            bytes: meter.bytes,
            note: [draft.note, e.message].filter(Boolean).join('；'),
          },
          e,
        );
      }
      rt.breaker.neutral(admission.probe);
      if (e instanceof EgressBlocked) {
        throw new CallFailed({ ...draft, errorKind: `egress_${e.reason}`, durationMs: ms, note: e.message }, e);
      }
      throw e;
    }
    const bytes = meter.bytes;
    const ms = Date.now() - started;
    rt.breaker.success(Date.now(), firstTokenMs, admission.probe);
    this.syncBreaker(rt);
    const cost = callCost(route.price, turn.usage);
    // 服务方没有在流里给出 usage 时按估算记账，研判预算照样生效
    this.ctx.ledger.record(turn.usage.input > 0 ? turn.usage : { ...turn.usage, input: estimated }, cost);
    rt.calibration = calibrate(rt.calibration, raw, turn.usage.input);
    metrics.estimateRatio.set({ route: route.id }, rt.calibration.factor);
    await this.layer.opts.onCalibration(rt.calibration);
    metrics.llmCalls.inc({ phase, route: route.id, outcome: 'succeeded', error_kind: '' });
    metrics.llmLatency.observe({ phase, route: route.id }, ms / 1000);
    if (firstTokenMs !== null) {
      metrics.llmFirstToken.observe({ phase, route: route.id }, firstTokenMs / 1000);
    }
    metrics.llmTokens.inc({ route: route.id, direction: 'input' }, turn.usage.input);
    metrics.llmTokens.inc({ route: route.id, direction: 'cached_input' }, turn.usage.cachedInput);
    metrics.llmTokens.inc({ route: route.id, direction: 'output' }, turn.usage.output);
    metrics.llmTokens.inc({ route: route.id, direction: 'reasoning' }, turn.usage.reasoning);
    metrics.llmCost.inc({ route: route.id, currency: route.price.currency }, cost);
    metrics.egressBytes.inc({ route: route.id, in_domain: String(route.in_domain) }, bytes);
    for (const [k, v] of Object.entries(prepared.hits)) {
      metrics.redactionHits.inc({ kind: k }, v ?? 0);
    }
    const fp = turnFingerprint(turn);
    const drift = rt.fingerprint.observe(fp);
    if (drift) {
      metrics.fingerprintDrift.inc({ route: route.id });
      logger.warn('模型服务方指纹变化，该路由的回放分数作废', { ...drift });
      await this.layer.opts.onDrift(drift);
    }
    this.routeUses.push({
      phase,
      route_id: route.id,
      model: route.model,
      dialect_profile: rt.profile.id,
      provider_fingerprint: fp,
      sampling: {
        max_output_tokens: sized.maxOutputTokens,
        ...(sized.temperature === undefined ? {} : { temperature: sized.temperature }),
      },
      seed: sized.seed ?? null,
    });
    this.egress.push({
      route_id: route.id,
      in_domain: route.in_domain,
      categories: draft.categories,
      redaction_hits: countHits(prepared.hits),
      bytes,
    });
    return {
      turn,
      trimmed,
      draft: {
        ...draft,
        durationMs: ms,
        bytes,
        cost,
        fingerprint: fp,
        response: turn.text,
        usage: {
          input_tokens: turn.usage.input,
          cached_input_tokens: turn.usage.cachedInput,
          output_tokens: turn.usage.output,
          reasoning_tokens: turn.usage.reasoning,
        },
      },
    };
  }

  private syncBreaker(rt: RouteRuntime): void {
    const open = rt.breaker.openReason;
    const metrics = this.layer.opts.metrics;
    metrics.breakerOpen.set({ route: rt.route.id }, open ? 1 : 0);
    if (open && rt.breaker.consumeOpened()) {
      metrics.breakerOpened.inc({ route: rt.route.id, reason: open });
    }
  }
}

/** 一次没有拿到可用响应的调用；draft 是要写入的调用记录 */
class CallFailed extends Error {
  override name = 'CallFailed';
  constructor(
    readonly draft: Draft,
    override readonly cause: LlmError | EgressBlocked,
  ) {
    super(cause.message);
  }
}
