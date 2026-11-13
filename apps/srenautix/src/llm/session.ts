import { createHash } from 'node:crypto';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type OpenAI from 'openai';
import type { DialectProfile, ModelRoute } from '@srenautix/contract';
import { logger } from '../kernel/log.js';
import type { WorkerMetrics } from '../research/metrics.js';
import {
  callCost,
  calibrate,
  estimateTokens,
  plausibleRatio,
  rawEstimate,
  type BudgetConfig,
  type Calibration,
  type ResearchLedger,
} from './budget.js';
import { touchesFailureDomain, type RouteBreaker } from './breaker.js';
import { EgressBlocked, type Egress } from './egress.js';
import { turnFingerprint, type Drift, type FingerprintTracker } from './fingerprint.js';
import { countHits, type RedactionHits } from './redact.js';
import { isLastResort, type DisabledRoute } from './routes.js';
import { reaskText, repairLocally, type Prepare, type RepairStep } from './repair.js';
import { StreamTimeout, streamingParams, streamTurn, type StreamParams, type StreamedTurn } from './stream.js';
import type { ModelClass, RouteTimeouts } from './timeouts.js';
import {
  LlmError,
  type EgressCategory,
  type LlmApi,
  type LlmPhase,
  type LlmRequest,
  type LlmTurn,
  type OutputFormat,
  type Segment,
  type TurnUsage,
} from './types.js';
import { buildParams, requestCategories, type ChatThinking } from './wire.js';

// 一次研判的模型会话（DESIGN §7.2、§8）：按阶段选模型档位、按路由优先级与熔断状态选路由、
// 驱动修复阶梯、按 usage 记账，并产出每次调用的记录、研判清单中的路由使用与出境清单。
// 事件涉及常规路由的故障域时先在这条路由上发一次探测调用，探测失败才对本次会话提前熔断（ADR 0202）。
// 兜底路由（role: last_resort，ADR 0152）只在全部常规路由都这样提前熔断时成为本次会话的路由组。

/** 剩余时间少于这个值时不再发起模型调用 */
export const MIN_CALL_WINDOW_MS = 5_000;

/** 输出达到上限而结束的 incomplete 取值：Chat 与 Messages 接口为 length，Responses 接口为 max_output_tokens */
const TRUNCATED: ReadonlySet<string> = new Set(['length', 'max_output_tokens']);

/**
 * 故障域探测调用（ADR 0202）：固定的一句提示、16 个输出 token，流式发出；超时比研判调用短。
 * 结论在模型层按路由缓存 ttlMs，并行的会话与同一会话的各阶段共用一次探测
 */
export const DOMAIN_PROBE = {
  prompt: 'Reply with the single word: ok',
  maxOutputTokens: 16,
  timeouts: { firstTokenMs: 20_000, idleMs: 10_000, totalMs: 30_000 },
  ttlMs: 60_000,
} as const;

/** 一次故障域探测的结论与用量 */
export interface DomainProbe {
  ok: boolean;
  /** 失败原因；成功时为空串 */
  detail: string;
  usage: TurnUsage;
  cost: number;
  bytes: number;
}

export interface RouteRuntime {
  route: ModelRoute;
  profile: DialectProfile;
  client: OpenAI;
  /** 流式调用的首 token、空闲与总时长超时（ADR 0098） */
  timeouts: RouteTimeouts;
  modelClass: ModelClass;
  /** Chat 与 Messages 请求体的思考模式设置（ADR 0158）；null 时不带 thinking 字段 */
  thinking: ChatThinking | null;
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
  api: LlmApi;
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
  /** 不在 llm.egress.categories 中、出站前删除的片段数，按类别；没有删除时不填（ADR 0146 §3.6） */
  dropped?: Partial<Record<EgressCategory, number>>;
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
  /** 故障域探测结论的缓存时长；省略时为 DOMAIN_PROBE.ttlMs */
  domainProbeTtlMs?: number;
}

export interface SessionContext {
  runId: string | null;
  /** 事件涉及的组件键（成员告警的实体与候选根因），用于故障域探测与提前熔断 */
  incidentComponents: readonly string[];
  /** 阶段 B 的硬期限（毫秒时间戳） */
  deadline: number;
  signal: AbortSignal;
  ledger: ResearchLedger;
  record(r: LlmCallRecord): Promise<void>;
  /**
   * 兜底路由的每日额度：上限与本次会话开始时当日已用的 token。
   * 不给出时本次会话不使用兜底路由（主动优化与评测）
   */
  lastResort?: { dailyTokens: number; usedToday: number };
}

/** 一条兜底路由在本次会话中的用量（单独记账，ADR 0152） */
export interface RouteUsage {
  routeId: string;
  tokens: number;
  cost: number;
}

/** 因事件涉及其故障域而对本次会话提前熔断的路由 */
export interface PreOpenedRoute {
  routeId: string;
  component: string;
  /** 探测调用失败的原因；兜底路由不探测，为 null */
  probe: string | null;
}

/** 本次会话使用的路由组 */
interface RoutePlan {
  /** 常规路由；全部常规路由都因故障域提前熔断且本次会话有兜底额度时为兜底路由 */
  pool: readonly RouteRuntime[];
  lastResort: boolean;
  preOpened: readonly PreOpenedRoute[];
}

function skipText(p: PreOpenedRoute): string {
  const why = p.probe === null ? '' : `探测调用失败（${p.probe}），`;
  return `${p.routeId}：事件涉及该路由的故障域组件 ${p.component}，${why}提前熔断`;
}

export type StructuredFailure =
  | 'model_output_invalid'
  | 'model_output_truncated'
  | 'model_unavailable'
  | 'budget'
  | 'failure_domain'
  | 'deadline'
  | 'egress_blocked';

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
  if (signal.aborted) {
    return signal.reason;
  }
  // 流读到一半连接断开：undici 在读响应体时抛 TypeError('terminated')（或 'fetch failed'、带套接字错误码的错误），
  // 不经过 SDK 的错误类型。按网络失败处理（可重试、可换路由），而不是让它逃出研判、使整个进程退出
  if (isNetworkError(e)) {
    const cause = (e as { cause?: unknown }).cause;
    return new LlmError(
      'llm_network',
      null,
      `模型服务的连接中断：${(e as Error).message}${cause instanceof Error ? `（${cause.message}）` : ''}`.slice(
        0,
        600,
      ),
      routeId,
    );
  }
  return e;
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_ABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** fetch 与套接字层的网络错误（本身或 cause 链上带网络错误码，或 undici 的 terminated / fetch failed） */
export function isNetworkError(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x instanceof Error && i < 5; x = (x as { cause?: unknown }).cause, i++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) {
      return true;
    }
    if (x instanceof TypeError && (x.message === 'terminated' || x.message === 'fetch failed')) {
      return true;
    }
  }
  return false;
}

export class ModelLayer {
  private readonly domainProbes = new Map<string, { expires: number; result: Promise<DomainProbe> }>();

  constructor(readonly opts: ModelLayerOptions) {}

  get routes(): readonly RouteRuntime[] {
    return this.opts.routes;
  }

  get disabled(): readonly DisabledRoute[] {
    return this.opts.disabled ?? [];
  }

  /** 可用的常规路由（role 为 regular 或不填） */
  get regular(): readonly RouteRuntime[] {
    return this.opts.routes.filter((r) => !isLastResort(r.route));
  }

  /** 可用的兜底路由（role: last_resort） */
  get lastResort(): readonly RouteRuntime[] {
    return this.opts.routes.filter((r) => isLastResort(r.route));
  }

  /**
   * 没有可用的常规路由时的降级原因（阶段 B 不运行，只出阶段 A）；有可用的常规路由时为 null。
   * 兜底路由不改变这个判断：它只在常规路由因故障域提前熔断时使用
   */
  unavailableReason(): string | null {
    if (this.regular.length) {
      return null;
    }
    const why = this.disabled.map((d) => d.message).join('；');
    const spare = this.lastResort.map((r) => r.route.id);
    if (spare.length) {
      return `没有可用的常规模型路由${why ? `：${why}` : ''}；兜底路由 ${spare.join('、')} 只在常规路由因故障域提前熔断时使用。阶段 B 不运行，只出阶段 A`;
    }
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

  /** 路由组中的候选路由（默认为常规路由）：先本档位，再另一档位；同档位按配置顺序 */
  ordered(phase: LlmPhase, pool: readonly RouteRuntime[] = this.regular): RouteRuntime[] {
    const tier = tierFor(phase);
    return [...pool.filter((r) => r.route.tier === tier), ...pool.filter((r) => r.route.tier !== tier)];
  }

  /** 新会话；发出第一次调用或读取路由组之前要先 `await session.plan()`（structured 会自己调用） */
  session(ctx: SessionContext): ModelSession {
    return new ModelSession(this, ctx);
  }

  /**
   * 在一条路由上发出一次流式调用并更新熔断器；meter 累计实际发出的字节数（失败时同样有效）。
   * 熔断器不放行时抛 LlmError llm_breaker_open，不发出请求；其余错误按 classifyError 归类后抛出
   */
  async call(
    rt: RouteRuntime,
    params: StreamParams,
    timeouts: RouteTimeouts,
    capMs: number,
    signal: AbortSignal,
    meter: { bytes: number },
  ): Promise<StreamedTurn> {
    const id = rt.route.id;
    const admission = rt.breaker.admit(Date.now());
    if (!admission.allowed) {
      throw new LlmError('llm_breaker_open', null, `路由 ${id} 熔断中（${admission.reason}）`, id);
    }
    try {
      const r = await this.opts.egress.track(meter, () =>
        streamTurn(rt.client, rt.route.api, params, rt.profile, timeouts, capMs, signal, id),
      );
      rt.breaker.success(Date.now(), r.firstTokenMs, admission.probe);
      this.syncBreaker(rt);
      return r;
    } catch (rawErr) {
      const e = classifyError(rawErr, id, signal);
      if (e instanceof LlmError && e.countsAsFailure) {
        rt.breaker.failure(Date.now(), admission.probe);
      } else {
        rt.breaker.neutral(admission.probe);
      }
      this.syncBreaker(rt);
      throw e;
    }
  }

  /**
   * 路由的故障域探测结论（ADR 0202）。缓存有效时直接返回（fresh 为 false）；否则发一次探测调用，
   * 进行中的探测由同时到达的会话共用。fresh 为 true 的调用方把这次探测的用量记到自己的研判上
   */
  domainProbe(rt: RouteRuntime): { result: Promise<DomainProbe>; fresh: boolean } {
    const id = rt.route.id;
    const hit = this.domainProbes.get(id);
    if (hit && Date.now() < hit.expires) {
      return { result: hit.result, fresh: false };
    }
    const entry = { expires: Number.POSITIVE_INFINITY, result: this.runDomainProbe(rt) };
    this.domainProbes.set(id, entry);
    entry.result.then(
      () => {
        entry.expires = Date.now() + (this.opts.domainProbeTtlMs ?? DOMAIN_PROBE.ttlMs);
      },
      () => {
        this.domainProbes.delete(id);
      },
    );
    return { result: entry.result, fresh: true };
  }

  /** 发一次探测调用：只含固定文本，不含事件数据；与研判调用走同一个客户端、同一套出站检查、计量与熔断器 */
  private async runDomainProbe(rt: RouteRuntime): Promise<DomainProbe> {
    const { metrics } = this.opts;
    const route = rt.route;
    const req: LlmRequest = {
      items: [{ type: 'user', segments: [{ text: DOMAIN_PROBE.prompt, categories: [], egress: 'allow' }] }],
      maxOutputTokens: DOMAIN_PROBE.maxOutputTokens,
    };
    const wire = { model: route.model, profile: rt.profile, language: 'en' as const, thinking: rt.thinking };
    const params = streamingParams(route.api, buildParams(route.api, req, wire));
    const meter = { bytes: 0 };
    const none: TurnUsage = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
    const finish = (ok: boolean, detail: string, usage: TurnUsage): DomainProbe => {
      const cost = callCost(route.price, usage);
      metrics.failureDomainProbes.inc({ route: route.id, outcome: ok ? 'ok' : 'failed' });
      metrics.egressBytes.inc({ route: route.id, in_domain: String(route.in_domain) }, meter.bytes);
      metrics.llmTokens.inc({ route: route.id, direction: 'input' }, usage.input);
      metrics.llmTokens.inc({ route: route.id, direction: 'output' }, usage.output);
      metrics.llmCost.inc({ route: route.id, currency: route.price.currency }, cost);
      logger.info('故障域探测调用', { route: route.id, ok, ...(ok ? {} : { error: detail }) });
      return { ok, detail, usage, cost, bytes: meter.bytes };
    };
    try {
      const { turn } = await this.call(
        rt,
        params,
        DOMAIN_PROBE.timeouts,
        DOMAIN_PROBE.timeouts.totalMs,
        new AbortController().signal,
        meter,
      );
      return finish(true, '', turn.usage);
    } catch (e) {
      if (e instanceof LlmError || e instanceof EgressBlocked) {
        return finish(false, e.message.slice(0, 300), none);
      }
      throw e;
    }
  }

  private syncBreaker(rt: RouteRuntime): void {
    const open = rt.breaker.openReason;
    const metrics = this.opts.metrics;
    metrics.breakerOpen.set({ route: rt.route.id }, open ? 1 : 0);
    if (open && rt.breaker.consumeOpened()) {
      metrics.breakerOpened.inc({ route: rt.route.id, reason: open });
    }
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
  private planned: RoutePlan | null = null;
  private planning: Promise<RoutePlan> | null = null;
  private readonly spareUsage = new Map<string, RouteUsage>();

  constructor(
    private readonly layer: ModelLayer,
    private readonly ctx: SessionContext,
  ) {}

  /**
   * 确定本次会话的路由组，可以重复调用，只执行一次。
   * 事件涉及常规路由的故障域时先在这条路由上发一次探测调用（ADR 0202）：成功则照常使用这条路由，失败则对本次会话提前熔断。
   * 兜底路由不探测，事件涉及它的故障域时直接提前熔断。
   * 路由组（ADR 0152）：全部常规路由都提前熔断、本次会话有兜底额度、配置了兜底路由时为兜底路由，否则为常规路由。
   * 常规路由因真实调用失败而熔断不会让兜底路由进入路由组。
   */
  async plan(): Promise<void> {
    this.planning ??= this.planRoutes();
    this.planned = await this.planning;
  }

  private async planRoutes(): Promise<RoutePlan> {
    const regular = this.layer.regular;
    const spare = this.layer.lastResort;
    const checked = await Promise.all(
      this.layer.routes.map(async (rt): Promise<PreOpenedRoute | null> => {
        const component = touchesFailureDomain(this.ctx.incidentComponents, rt.route.failure_domain);
        if (!component) {
          return null;
        }
        const routeId = rt.route.id;
        if (isLastResort(rt.route)) {
          return { routeId, component, probe: null };
        }
        const { result, fresh } = this.layer.domainProbe(rt);
        const probe = await result;
        if (fresh) {
          this.recordProbe(rt, probe);
        }
        return probe.ok ? null : { routeId, component, probe: probe.detail };
      }),
    );
    const preOpened = checked.filter((p): p is PreOpenedRoute => p !== null);
    const opened = new Set(preOpened.map((p) => p.routeId));
    const allOpened = regular.length > 0 && regular.every((r) => opened.has(r.route.id));
    if (spare.length && this.ctx.lastResort && allOpened) {
      return { pool: spare, lastResort: true, preOpened };
    }
    return { pool: regular, lastResort: false, preOpened };
  }

  /** 本次会话发起的探测调用计入研判的用量与出境清单；探测不写调用记录 */
  private recordProbe(rt: RouteRuntime, probe: DomainProbe): void {
    this.ctx.ledger.record(probe.usage, probe.cost);
    if (probe.bytes > 0) {
      this.egress.push({
        route_id: rt.route.id,
        in_domain: rt.route.in_domain,
        categories: [],
        redaction_hits: 0,
        bytes: probe.bytes,
      });
    }
  }

  private get routePlan(): RoutePlan {
    if (!this.planned) {
      throw new Error('会话的路由组还没有确定：先调用 plan()');
    }
    return this.planned;
  }

  /** 本次会话使用兜底路由；路由组还没有确定（没有发出过调用）时为 false */
  get usingLastResort(): boolean {
    return this.planned?.lastResort ?? false;
  }

  /** 本次会话可能使用的路由（提示词按其中最小的上下文组装）；plan() 之后可用 */
  get pool(): readonly RouteRuntime[] {
    return this.routePlan.pool;
  }

  /** 本次会话成本的币种：路由组第一条路由的币种；路由组还没有确定（没有发出过调用）时按常规路由 */
  get currency(): string {
    return (this.planned?.pool ?? this.layer.regular)[0]?.route.price.currency ?? 'USD';
  }

  /** 兜底路由在本次会话中的用量，按路由；没有使用兜底路由时为空 */
  get lastResortUsage(): RouteUsage[] {
    return [...this.spareUsage.values()];
  }

  /** 因事件涉及其故障域而对本次会话提前熔断的路由；plan() 之后可用 */
  preOpened(): readonly PreOpenedRoute[] {
    return this.routePlan.preOpened;
  }

  /**
   * 一次结构化调用，走完修复阶梯：每条路由上本地修复（解析、jsonrepair、校验、按字段挽救）失败时带上错误重新请求一次，
   * 仍失败或路由不可用时换下一条路由；全部失败返回失败原因，由调用方只出确定性报告。
   * 预算、期限与蜜标的截停对所有路由一样，直接结束。
   */
  async structured<T>(
    phase: LlmPhase,
    base: Omit<LlmRequest, 'output'>,
    output: OutputFormat & { full: Record<string, unknown>; prepare?: Prepare },
  ): Promise<StructuredResult<T>> {
    const unavailable = this.layer.unavailableReason();
    if (unavailable) {
      // 所有路由都被出站策略禁用：不发出任何请求
      return { ok: false, reason: 'egress_blocked', detail: unavailable, attempts: [unavailable] };
    }
    await this.plan();
    const plan = this.routePlan;
    const attempts: string[] = [];
    const preOpened = new Map(plan.preOpened.map((p) => [p.routeId, p]));
    const { metrics } = this.layer.opts;
    const skip = (p: PreOpenedRoute) => {
      metrics.failureDomainSkips.inc({ route: p.routeId });
      attempts.push(skipText(p));
    };
    if (plan.lastResort) {
      // 常规路由全部因故障域提前熔断，本次会话改用兜底路由；尝试记录照样写明每条常规路由被跳过的原因
      for (const rt of this.layer.ordered(phase)) {
        skip(preOpened.get(rt.route.id) as PreOpenedRoute);
      }
    }
    const order = this.layer.ordered(phase, plan.pool);
    let sawInvalid = false;
    // 输出无效的调用里有没有截断以外的原因（不是 JSON、不符合 schema、拒绝、内容过滤）；全部是截断时失败原因写截断
    let sawMalformed = false;
    let sawEgress = false;
    let candidates = 0;
    for (const [ri, rt] of order.entries()) {
      const id = rt.route.id;
      const last = ri === order.length - 1;
      const domain = preOpened.get(id);
      if (domain) {
        skip(domain);
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
        const local = repairLocally(sent.turn, output.full, output.prepare);
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
        sawMalformed ||= !TRUNCATED.has(sent.turn.incomplete ?? '');
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
      const spare = plan.lastResort ? [] : this.layer.lastResort.map((r) => r.route.id);
      return {
        ok: false,
        reason: 'failure_domain',
        detail: spare.length
          ? `所有常规路由都因事件涉及其故障域、探测调用失败而提前熔断；兜底路由 ${spare.join('、')} 只用于事件研判`
          : '所有路由都因事件涉及其故障域而提前熔断（常规路由的探测调用失败）',
        attempts,
      };
    }
    if (sawInvalid) {
      return sawMalformed
        ? { ok: false, reason: 'model_output_invalid', detail: '模型输出无效', attempts }
        : { ok: false, reason: 'model_output_truncated', detail: '模型输出被截断', attempts };
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
    const wire = { model: route.model, profile: rt.profile, language, thinking: rt.thinking };
    const build = (r: LlmRequest) => {
      const prepared = egress.prepare(r);
      const sized: LlmRequest = {
        ...prepared.request,
        maxOutputTokens: Math.min(prepared.request.maxOutputTokens, stage.outputTokens),
      };
      const params = streamingParams(route.api, buildParams(route.api, sized, wire));
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
    const sentTemperature = 'temperature' in params ? params.temperature : undefined;
    const dropped = Object.entries(prepared.dropped);
    for (const [category, n] of dropped) {
      metrics.egressDropped.inc({ category }, n);
    }
    const notes = [
      ...(trimmed.length ? [trimNote(route.id, trimmed)] : []),
      ...(dropped.length
        ? [
            `出境类别不在 llm.egress.categories 中，出站前删除了片段：${dropped.map(([c, n]) => `${c} ${n} 个`).join('、')}`,
          ]
        : []),
    ];
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
      note: notes.length ? notes.join('；') : null,
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
    const spareOver = this.checkLastResort(route, estimated, sized.maxOutputTokens);
    if (spareOver) {
      metrics.budgetStops.inc({ reason: 'last_resort' });
      throw new BudgetStop(spareOver);
    }
    const cap = Math.min(rt.timeouts.totalMs ?? Number.POSITIVE_INFINITY, remaining);
    let turn: LlmTurn;
    let firstTokenMs: number | null;
    const meter = { bytes: 0 };
    try {
      ({ turn, firstTokenMs } = await this.layer.call(rt, params, rt.timeouts, cap, this.ctx.signal, meter));
    } catch (e) {
      const ms = Date.now() - started;
      if (e instanceof LlmError) {
        if (e.kind === 'llm_breaker_open') {
          throw new CallFailed({ ...draft, errorKind: e.kind }, e);
        }
        metrics.llmCalls.inc({ phase, route: route.id, outcome: 'failed', error_kind: e.kind });
        if (meter.bytes > 0) {
          metrics.egressBytes.inc({ route: route.id, in_domain: String(route.in_domain) }, meter.bytes);
          this.egress.push({
            route_id: route.id,
            in_domain: route.in_domain,
            categories: draft.categories,
            ...(dropped.length ? { dropped: prepared.dropped } : {}),
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
      if (e instanceof EgressBlocked) {
        throw new CallFailed({ ...draft, errorKind: `egress_${e.reason}`, durationMs: ms, note: e.message }, e);
      }
      throw e;
    }
    const bytes = meter.bytes;
    const ms = Date.now() - started;
    const cost = callCost(route.price, turn.usage);
    // 服务方没有在流里给出 usage 时按估算记账，研判预算照样生效
    this.ctx.ledger.record(turn.usage.input > 0 ? turn.usage : { ...turn.usage, input: estimated }, cost);
    if (isLastResort(route)) {
      const u = this.spareUsage.get(route.id) ?? { routeId: route.id, tokens: 0, cost: 0 };
      const tokens = (turn.usage.input > 0 ? turn.usage.input : estimated) + turn.usage.output;
      this.spareUsage.set(route.id, { routeId: route.id, tokens: u.tokens + tokens, cost: u.cost + cost });
    }
    if (raw > 0 && turn.usage.input > 0 && !plausibleRatio(turn.usage.input / raw)) {
      metrics.calibrationRejected.inc({ route: route.id });
      logger.warn('服务方报告的输入 token 与估算相差过大，不计入校准', {
        route: route.id,
        phase,
        raw_estimate: raw,
        usage_input: turn.usage.input,
      });
    }
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
        // 以实际发出的请求体为准：api: messages 不带采样参数
        ...(typeof sentTemperature === 'number' ? { temperature: sentTemperature } : {}),
      },
      seed: sized.seed ?? null,
    });
    this.egress.push({
      route_id: route.id,
      in_domain: route.in_domain,
      categories: draft.categories,
      ...(dropped.length ? { dropped: prepared.dropped } : {}),
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

  /**
   * 兜底路由的每日上限：当日已用（会话开始时读取）加本次会话已用，再加这次的输入估算与输出上限，超过上限时返回拒绝原因。
   * 常规路由返回 null
   */
  private checkLastResort(route: ModelRoute, estimated: number, maxOutput: number): string | null {
    if (!isLastResort(route)) {
      return null;
    }
    const quota = this.ctx.lastResort;
    if (!quota) {
      throw new Error(`兜底路由 ${route.id} 只在会话给出兜底额度时进入路由组`);
    }
    const used = quota.usedToday + this.lastResortUsage.reduce((n, u) => n + u.tokens, 0);
    if (used + estimated + maxOutput > quota.dailyTokens) {
      return `兜底路由当日已用 ${used} token，再发送约 ${estimated} token 输入（输出上限 ${maxOutput}）会超过每日上限 ${quota.dailyTokens}`;
    }
    return null;
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
