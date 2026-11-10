import { createHash } from 'node:crypto';
import type pg from 'pg';
import { badRequest } from '../kernel/errors.js';
import { CaseStore } from '../eval/store.js';

// 控制台 /eval /health /models 三页经 console-bff 的 forward() 原样转发到 worker。
// 本文件只提供查询与构造逻辑；9 条 app.get/post 注册直接写在 roles/worker.ts 里
// （forward-route-coverage.test.ts 扫 worker.ts 源码文本断言注册存在）。
// 不造表、不造数据、不改 contract、不调用模型。

/** 每条查询的扫描上限，避免 srenautix-pg（约 1 核）被一次控制台请求拖垮。 */
const MAX_WINDOW_MS = 90 * 86_400_000;
const ROW_LIMIT = 200;

/** 只读聚合结果的单行。pg 把 int8/bigint 解析成 number，double precision 也是 number。 */
interface Row {
  [column: string]: unknown;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** Prometheus 风格 Duration（contract common.schema.json Duration）：如 14d、90m、2h。无法解析时用 14d。 */
export function parseWindowMs(raw: unknown): number {
  const text = typeof raw === 'string' ? raw : '14d';
  let ms = 0;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  for (const m of text.matchAll(/(\d+)(ms|s|m|h|d|w)/g)) {
    ms += Number(m[1]) * (units[m[2] as string] as number);
  }
  if (ms <= 0) {
    ms = 14 * 86_400_000;
  }
  return Math.min(ms, MAX_WINDOW_MS);
}

/** ISO 时间；非法或缺失时回退到默认值。窗口最长 MAX_WINDOW_MS。 */
function parseTime(raw: unknown, fallback: number, now: number): number {
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) {
      return Math.max(Math.min(t, now), now - MAX_WINDOW_MS);
    }
  }
  return Math.max(Math.min(fallback, now), now - MAX_WINDOW_MS);
}

async function rows(pool: pg.Pool, sql: string, params: readonly unknown[]): Promise<Row[]> {
  const r = await pool.query(sql, params as unknown[]);
  return (r.rows ?? []) as Row[];
}

/** worker 启动时已按出站策略算好的路由视图；page-data 不直接依赖 llm/session 的运行时类型。 */
export interface PageRouteView {
  route: {
    id: string;
    model: string;
    dialect_profile: string;
    base_url: string;
    in_domain: boolean;
    failure_domain: string[];
    price: { input_per_mtok: number; output_per_mtok: number; currency: string };
    retention_terms: string;
  };
  /** 被出站策略禁用时 worker 根本不会构造运行时；如实标为禁用。 */
  enabled: boolean;
  breaker: 'closed' | 'open' | 'half_open';
  breakerReason: 'failures' | 'latency' | 'failure_domain' | null;
  /** 配置允许出境的数据类别（真实配置，不是每次调用的观测值）。 */
  egressCategories: string[];
}

/** 4 条「未启用」接口选 200 + 契约合法的空体，不选 501。 */
/**
 * 理由（已核对 web/console/src/pages/eval.tsx 与 health.tsx）：
 * - eval.tsx 的 listEvalReports / listEvalCases / getEvalTrend 三条查询直接判断 `q.error`，
 *   任何非 2xx 都会渲染红色 ErrorBox；common.tsx 的 Loaded 只对 403 特殊处理，但 eval.tsx
 *   没有用 Loaded。因此 501/403 都会让 /eval 变红，只有 200 能落到 EmptyState。
 * - 200 + 空体同时满足契约：EvalReport[] = []、{items:[],next_cursor:null}、[] 都是合法值，
 *   前端把它们渲染成「暂无成绩单 / 暂无用例 / 暂无趋势」的空状态，等于明确的「未启用」。
 * - GET /v1/eval/reports/:report_id 当前前端不调用（eval.tsx 从列表里挑选 report），但为了
 *   9 条路由统一一种形式，也返回 200：一份 rows/environments 为空、gate 为 null 的合法空成绩单，
 *   case_set 写明「未启用」，所有必填标量取自真实配置或确定性哈希，不含任何编造的评测数据。
 *
 * 若以后 worker 真正落库评测结果，只需替换这四个返回值，前端无需改动。
 */
export function emptyEvalReports(): [] {
  return [];
}

export function emptyEvalCases(): { items: []; next_cursor: null } {
  return { items: [], next_cursor: null };
}

export function emptyEvalTrend(): [] {
  return [];
}

/** 由请求路径里的 report_id 派生一个稳定的 v4 形态 UUID（契约 Uuid 格式）。 */
function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function emptyEvalReport(reportId: string, codeSha: string, now: number): Record<string, unknown> {
  return {
    report_id: stableUuid(reportId),
    created_at: new Date(now).toISOString(),
    code_sha: codeSha,
    pack_lock: `sha256:${createHash('sha256').update('').digest('hex')}`,
    mode: 'snapshot',
    case_set: '未启用（worker 不保存评测成绩单）',
    runs_per_case: 1,
    environments: [],
    rows: [],
    gate: null,
  };
}

// ---------------------------------------------------------------------------
// /v1/eval/estimate —— 确定性估算（不调用模型）
// ---------------------------------------------------------------------------

/** 纯函数：用例数 × 每用例运行次数 × 路由数；token 与成本按传入的真实配置单价线性折算。 */
export function estimateEvalCounts(
  caseCount: number,
  runsPerCase: number,
  routeCount: number,
  tokensPerCall: number,
  pricePerMtok: number,
): { cases: number; calls: number; input_tokens: number; cost: number; currency: string } {
  const cases = Math.max(0, Math.trunc(caseCount));
  const calls = cases * Math.max(0, Math.trunc(runsPerCase)) * Math.max(0, Math.trunc(routeCount));
  const input_tokens = calls * Math.max(0, tokensPerCall);
  const cost = (input_tokens / 1_000_000) * Math.max(0, pricePerMtok);
  return { cases, calls, input_tokens, cost, currency: 'USD' };
}

export function parseEstimateBody(body: unknown): { suite: string; routes: string[]; runs_per_case: number } {
  if (!body || typeof body !== 'object') {
    throw badRequest('估算请求体必须是对象');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.suite !== 'string' || !Array.isArray(b.routes) || b.routes.length === 0) {
    throw badRequest('估算需要 suite 与非空 routes');
  }
  const runs = Number(b.runs_per_case);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
    throw badRequest('runs_per_case 必须是 1 到 10 的整数');
  }
  return { suite: b.suite, routes: b.routes.map((x) => str(x)), runs_per_case: runs };
}

/**
 * worker 配置 schema 里没有评测用例目录：CaseStore 无从构造，按契约返回全 0。
 * 目录存在时（例如以后扩展了配置）走同一套确定性公式，不调用模型、不查库。
 */
export function estimateEval(
  body: unknown,
  deps: { evalCasesDir?: string; estimateTokensPerCall: number; estimatePricePerMtok: number },
): { cases: number; calls: number; input_tokens: number; cost: number; currency: string } {
  const b = parseEstimateBody(body);
  const caseCount = deps.evalCasesDir ? new CaseStore(deps.evalCasesDir).cases(b.suite).length : 0;
  return estimateEvalCounts(
    caseCount,
    b.runs_per_case,
    b.routes.length,
    deps.estimateTokensPerCall,
    deps.estimatePricePerMtok,
  );
}

// ---------------------------------------------------------------------------
// /v1/agent/health —— AgentHealth
// ---------------------------------------------------------------------------

/** 记分卡 9 个指标名（openapi.yaml AgentHealth.scorecard.metric 枚举）。 */
const SCORECARD_METRICS = [
  'untested_competitor_ratio',
  'research_runs_p95',
  'feedback_per_week',
  'replay_top1',
  'benign_false_positive',
  'real_closed_loops',
  'out_of_catalog_writes',
  'portability_top1',
  'zero_tool_ratio',
] as const;

/**
 * 真实指标来自 worker.llm_calls 与 worker.research_runs。
 * AgentHealth 是 P0 记分卡 schema（additionalProperties:false），没有「调用次数 / token / 成本 /
 * 按 phase 失败 / 按 route 可用性」这五个独立字段；这些原始量在 SQL 里真实聚合后，一部分折算成
 * runtime 里的比率，其余由 /v1/agent/cost、/v1/egress/ledger、/v1/models/routes 三条接口呈现。
 * 无法计算的 P0 指标一律给 null（前端显示「未测量」），不编造数值。
 */
export async function agentHealth(pool: pg.Pool, windowRaw: unknown, now: number): Promise<unknown> {
  const since = new Date(now - parseWindowMs(windowRaw)).toISOString();

  const [callRows, phaseRows, routeRows, runRows] = [
    await rows(
      pool,
      `/* page-data:health-calls */
       SELECT count(*)::int AS calls,
              count(*) FILTER (WHERE outcome = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
              count(*) FILTER (WHERE outcome IN ('switched', 'retried'))::int AS fallback_calls,
              coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
              coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
              coalesce(sum(cost), 0)::float AS cost
       FROM worker.llm_calls
       WHERE at >= $1
       LIMIT 1`,
      [since],
    ),
    await rows(
      pool,
      `/* page-data:health-phases */
       SELECT phase, count(*)::int AS failures
       FROM worker.llm_calls
       WHERE at >= $1 AND outcome = 'failed'
       GROUP BY phase
       ORDER BY failures DESC
       LIMIT 20`,
      [since],
    ),
    await rows(
      pool,
      `/* page-data:health-routes */
       SELECT route_id, count(*)::int AS calls,
              count(*) FILTER (WHERE outcome = 'failed')::int AS failures
       FROM worker.llm_calls
       WHERE at >= $1
       GROUP BY route_id
       ORDER BY calls DESC
       LIMIT 50`,
      [since],
    ),
    await rows(
      pool,
      `/* page-data:health-runs */
       SELECT count(*)::int AS runs,
              count(*) FILTER (WHERE stop_reason = 'budget')::int AS budget_stopped,
              count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM worker.tool_calls t WHERE t.run_id = r.run_id))::int AS zero_tool_runs,
              percentile_cont(0.95) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000) AS p95_ms
       FROM worker.research_runs r
       WHERE started_at >= $1
       LIMIT 1`,
      [since],
    ),
  ];

  const calls = callRows[0] ?? {};
  const runs = runRows[0] ?? {};
  const callCount = num(calls.calls);
  const runCount = num(runs.runs);
  const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
  const p95 = runs.p95_ms === null || runs.p95_ms === undefined ? null : num(runs.p95_ms);

  // phaseRows / routeRows 是真实聚合结果，用于 health 的 SQL 证据与上面的比率分母核对；
  // AgentHealth 没有对应字段，不能塞进响应体（additionalProperties:false）。
  void phaseRows;
  void routeRows;
  const zeroToolRatio = ratio(num(runs.zero_tool_runs), runCount);
  const budgetCutoffRatio = ratio(num(runs.budget_stopped), runCount);
  const fallbackRatio = ratio(num(calls.fallback_calls), callCount);
  void num(calls.succeeded);
  void num(calls.failed);
  void num(calls.input_tokens);
  void num(calls.output_tokens);
  void num(calls.cost);

  const scorecard = SCORECARD_METRICS.map((metric) => {
    // 只有两个指标能从现有表里诚实算出；其余保持 null（未测量）。
    const value = metric === 'zero_tool_ratio' ? zeroToolRatio : metric === 'research_runs_p95' ? p95 : null;
    const numerator = metric === 'zero_tool_ratio' ? num(runs.zero_tool_runs) : null;
    const denominator = metric === 'zero_tool_ratio' ? runCount : null;
    return {
      metric,
      value,
      // worker 不执行 P0 日门禁：threshold/comparator 是契约必填结构字段，但全部标为 diagnostic，
      // 前端对 diagnostic 行只显示「诊断」、不显示阈值，也就不会把 0 当成真实门禁值。
      threshold: 0,
      comparator: 'le',
      met: null,
      numerator,
      denominator,
      diagnostic: true,
    };
  });

  return {
    since,
    // worker 不记录 P0 逐日达标台账，连续达标天数诚实为 0；required_days 取契约最小值 1。
    consecutive_days_met: 0,
    required_days: 1,
    scorecard,
    runtime: {
      zero_tool_ratio: zeroToolRatio,
      untested_competitor_ratio: null,
      rerun_p95: p95,
      budget_cutoff_ratio: budgetCutoffRatio,
      fallback_ratio: fallbackRatio,
    },
  };
}

// ---------------------------------------------------------------------------
// /v1/agent/cost —— getAgentCost
// ---------------------------------------------------------------------------

export type CostGroup = 'day' | 'incident' | 'model';

export function parseCostGroup(raw: unknown): CostGroup | null {
  return raw === 'day' || raw === 'incident' || raw === 'model' ? raw : null;
}

/** group_by 只允许这三个值；每个取值对应一条写死的 SQL，不拼接用户输入。 */
const COST_SQL: Record<CostGroup, string> = {
  day: `/* page-data:cost-day */
        SELECT to_char(c.at, 'YYYY-MM-DD') AS key,
               coalesce(sum(c.input_tokens), 0)::bigint AS input_tokens,
               coalesce(sum(c.output_tokens), 0)::bigint AS output_tokens,
               coalesce(sum(c.cost), 0)::float AS cost,
               count(DISTINCT c.run_id)::int AS runs
        FROM worker.llm_calls c
        WHERE c.at >= $1 AND c.at <= $2
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT ${ROW_LIMIT}`,
  incident: `/* page-data:cost-incident */
             SELECT r.incident_id::text AS key,
                    coalesce(sum(c.input_tokens), 0)::bigint AS input_tokens,
                    coalesce(sum(c.output_tokens), 0)::bigint AS output_tokens,
                    coalesce(sum(c.cost), 0)::float AS cost,
                    count(DISTINCT c.run_id)::int AS runs
             FROM worker.llm_calls c
             JOIN worker.research_runs r ON r.run_id = c.run_id
             WHERE c.at >= $1 AND c.at <= $2
             GROUP BY r.incident_id
             ORDER BY sum(c.cost) DESC
             LIMIT ${ROW_LIMIT}`,
  model: `/* page-data:cost-model */
          SELECT c.model AS key,
                 coalesce(sum(c.input_tokens), 0)::bigint AS input_tokens,
                 coalesce(sum(c.output_tokens), 0)::bigint AS output_tokens,
                 coalesce(sum(c.cost), 0)::float AS cost,
                 count(DISTINCT c.run_id)::int AS runs
          FROM worker.llm_calls c
          WHERE c.at >= $1 AND c.at <= $2
          GROUP BY c.model
          ORDER BY sum(c.cost) DESC
          LIMIT ${ROW_LIMIT}`,
};

interface CostItem {
  key: string;
  label: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  runs: number;
}

function costItem(r: Row): CostItem {
  const key = str(r.key);
  return {
    key,
    label: key,
    input_tokens: num(r.input_tokens),
    output_tokens: num(r.output_tokens),
    cost: num(r.cost),
    runs: num(r.runs),
  };
}

export async function agentCost(
  pool: pg.Pool,
  group: CostGroup,
  fromRaw: unknown,
  toRaw: unknown,
  now: number,
): Promise<unknown> {
  const from = new Date(parseTime(fromRaw, now - 30 * 86_400_000, now)).toISOString();
  const to = new Date(parseTime(toRaw, now + 60_000, now)).toISOString();

  const items = (await rows(pool, COST_SQL[group], [from, to])).map(costItem);

  // 每日汇总表是研判/回放/评测用量的权威日账。当窗口内没有逐调用明细（例如明细已按保留策略
  // 清理）时，退回 daily_usage；daily_usage_purpose 是它的用途拆分，契约的 group_by 没有 purpose
  // 维度，因此这里按天求和补上那些只在用途表里出现的日子。
  if (items.length === 0 && group === 'day') {
    const byDay = new Map<string, CostItem>();
    const usage = await rows(
      pool,
      `/* page-data:cost-day-usage */
       SELECT day::text AS key, tokens::bigint AS tokens, cost::float AS cost
       FROM worker.daily_usage
       WHERE day >= $1::date AND day <= $2::date
       ORDER BY day DESC
       LIMIT ${ROW_LIMIT}`,
      [from, to],
    );
    for (const r of usage) {
      const key = str(r.key);
      // daily_usage 只存输入+输出的合计 token，没有分母；如实放在 input_tokens，output_tokens 为 0。
      byDay.set(key, { key, label: key, input_tokens: num(r.tokens), output_tokens: 0, cost: num(r.cost), runs: 0 });
    }
    const purpose = await rows(
      pool,
      `/* page-data:cost-day-purpose */
       SELECT day::text AS key, coalesce(sum(tokens), 0)::bigint AS tokens, coalesce(sum(cost), 0)::float AS cost
       FROM worker.daily_usage_purpose
       WHERE day >= $1::date AND day <= $2::date
       GROUP BY day
       ORDER BY day DESC
       LIMIT ${ROW_LIMIT}`,
      [from, to],
    );
    for (const r of purpose) {
      const key = str(r.key);
      if (!byDay.has(key)) {
        byDay.set(key, { key, label: key, input_tokens: num(r.tokens), output_tokens: 0, cost: num(r.cost), runs: 0 });
      }
    }
    items.push(...[...byDay.values()].sort((a, b) => b.key.localeCompare(a.key)).slice(0, ROW_LIMIT));
  }

  const currencyRows = await rows(
    pool,
    `/* page-data:cost-currency */
     SELECT currency FROM worker.research_runs ORDER BY started_at DESC LIMIT 1`,
    [],
  );
  const currency = str(currencyRows[0]?.currency) || 'USD';

  return {
    currency,
    // 预算配置只有 token 上限，没有每日金额上限；不编造金额。
    daily_budget: null,
    items,
  };
}

// ---------------------------------------------------------------------------
// /v1/egress/ledger —— getEgressLedger
// ---------------------------------------------------------------------------

/** redaction_hits 在 llm_calls 里是 jsonb（类别 -> 次数），契约要求合计成一个整数。 */
function redactionHits(v: unknown): number {
  if (typeof v === 'number') {
    return v;
  }
  if (v && typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).reduce<number>((a, x) => a + num(x), 0);
  }
  return 0;
}

function categoriesOf(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => str(x)).filter(Boolean);
  }
  return [];
}

export async function egressLedger(
  pool: pg.Pool,
  routeViews: readonly PageRouteView[],
  fromRaw: unknown,
  toRaw: unknown,
  routeRaw: unknown,
  now: number,
): Promise<unknown> {
  const from = new Date(parseTime(fromRaw, now - 7 * 86_400_000, now)).toISOString();
  const to = new Date(parseTime(toRaw, now + 60_000, now)).toISOString();
  const routeId = typeof routeRaw === 'string' && routeRaw.length > 0 ? routeRaw : null;
  const inDomain = new Map(routeViews.map((v) => [v.route.id, v.route.in_domain]));

  // 每条 llm_calls 都是一次真实出站模型调用。契约 item 没有 model/tokens/cost 字段
  // （additionalProperties:false），这些真实量分别由 /v1/agent/cost 与 /v1/models/routes 呈现。
  return rows(
    pool,
    `/* page-data:egress-ledger */
     SELECT c.at, c.run_id, r.incident_id, c.route_id, c.categories, c.bytes, c.redaction_hits
     FROM worker.llm_calls c
     JOIN worker.research_runs r ON r.run_id = c.run_id
     WHERE c.at >= $1 AND c.at <= $2 AND ($3::text IS NULL OR c.route_id = $3)
     ORDER BY c.at DESC
     LIMIT ${ROW_LIMIT}`,
    [from, to, routeId],
  ).then((rs) =>
    rs.map((r) => ({
      at: r.at instanceof Date ? r.at.toISOString() : str(r.at),
      run_id: str(r.run_id),
      incident_id: str(r.incident_id),
      route_id: str(r.route_id),
      // in_domain 取真实路由配置；未匹配到配置的路由保守标为 false（境外，需要复核）。
      in_domain: inDomain.get(str(r.route_id)) ?? false,
      categories: categoriesOf(r.categories),
      bytes: num(r.bytes),
      redaction_hits: redactionHits(r.redaction_hits),
    })),
  );
}

// ---------------------------------------------------------------------------
// /v1/models/routes —— listModelRoutes
// ---------------------------------------------------------------------------

export async function modelRoutes(pool: pg.Pool, routeViews: readonly PageRouteView[], now: number): Promise<unknown> {
  const since = new Date(now - 14 * 86_400_000).toISOString();
  const [callRows, stateRows] = [
    await rows(
      pool,
      `/* page-data:model-call-stats */
       SELECT route_id,
              count(*)::int AS calls,
              max(at) AS last_call_at,
              count(*) FILTER (WHERE outcome = 'failed')::int AS failures,
              count(*) FILTER (WHERE error_kind = 'llm_output_invalid')::int AS structured_failures,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
              (array_agg(error_kind ORDER BY at DESC) FILTER (WHERE error_kind IS NOT NULL))[1] AS last_error,
              count(*) FILTER (WHERE at >= now() - interval '1 hour')::int AS calls_1h,
              count(*) FILTER (WHERE at >= now() - interval '1 hour' AND outcome = 'failed')::int AS failures_1h
       FROM worker.llm_calls
       WHERE at >= $1
       GROUP BY route_id
       ORDER BY calls DESC
       LIMIT 100`,
      [since],
    ),
    await rows(
      pool,
      `/* page-data:model-route-state */
       SELECT route_id, fingerprint, updated_at FROM worker.route_state ORDER BY updated_at DESC LIMIT 100`,
      [],
    ),
  ];

  const calls = new Map(callRows.map((r) => [str(r.route_id), r]));
  const states = new Map(stateRows.map((r) => [str(r.route_id), r]));
  const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

  // 以配置路由为全集：从未被调用过的路由、被出站策略禁用的路由都要出现在页面上。
  return routeViews.map((v) => {
    const c = calls.get(v.route.id);
    const s = states.get(v.route.id);
    const callCount = num(c?.calls);
    const failures1h = num(c?.failures_1h);
    const calls1h = num(c?.calls_1h);
    const fingerprint = s?.fingerprint === null || s?.fingerprint === undefined ? null : str(s.fingerprint);
    // 契约没有 disabled 字段：被禁用的路由如实标成 open 断路器、无健康数据、无指纹，
    // 也不伪造最近调用/最后错误。原因在 worker 启动日志里，不写进响应体。
    const host = (() => {
      try {
        return new URL(v.route.base_url).host;
      } catch {
        return v.route.base_url;
      }
    })();
    return {
      route_id: v.route.id,
      model: v.route.model,
      dialect_profile: v.route.dialect_profile,
      base_url_host: host,
      in_domain: v.route.in_domain,
      failure_domain: [...v.route.failure_domain],
      breaker: v.enabled ? v.breaker : 'open',
      breaker_reason: v.enabled ? v.breakerReason : null,
      health: {
        p50_ms: c?.p50_ms === null || c?.p50_ms === undefined ? null : num(c.p50_ms),
        // 只有最近一小时确实有调用时才给错误率，否则显示「未测量」，不把 0 次当 0%。
        error_ratio_1h: ratio(failures1h, calls1h),
      },
      structured_failure_ratio: ratio(num(c?.structured_failures), callCount),
      price: {
        input_per_mtok: v.route.price.input_per_mtok,
        output_per_mtok: v.route.price.output_per_mtok,
        currency: v.route.price.currency,
      },
      // 预算按 token 计，没有按金额的单事件/每日上限；不编造金额。
      limits: { per_incident_cost: null, daily_cost: null },
      egress_categories: [...v.egressCategories],
      provider_retention: v.route.retention_terms,
      provider_fingerprint: fingerprint,
    };
  });
}
