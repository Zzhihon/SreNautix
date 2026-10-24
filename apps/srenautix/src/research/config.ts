import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parse } from 'yaml';
import { z } from 'zod';
import type { ModelRoute } from '@srenautix/contract';
import { readSecretFile } from '../config/files.js';
import { DEFAULT_BUDGET, type BudgetConfig } from '../llm/budget.js';
import { EGRESS_CATEGORIES, type EgressCategory } from '../llm/types.js';
import { resolveTimeouts, type ModelClass, type RouteTimeouts } from '../llm/timeouts.js';
import type { McpServerConfig } from '../tools/mcp.js';
import { DEFAULT_LIMITS, type ResearchLimits } from './controller.js';

// worker 角色的配置文件（/etc/srenautix/config.yaml）。密钥一律是挂载文件的路径。
//
//   cluster_id: prod
//   worker_id: worker-0                      # 默认取主机名（Pod 名）
//   code_sha: <40 位提交>                    # 镜像构建时注入，写进研判清单
//   listen: { api: ":8080", metrics: ":9090", probes: ":8081" }
//   database: { password_file: /etc/srenautix/secrets/db/password, pool_size: 4 }
//   hub: { url: http://srenautix-server:8080, token_file: /etc/srenautix/secrets/worker/token }
//   inbound: { token_sha256_file: /etc/srenautix/secrets/worker/inbound-sha256 }   # server 调用 worker 的 token 的 sha256，每行一个
//   language: zh
//   llm:
//     allow_cross_border: false
//     honeytokens_file: /etc/srenautix/secrets/honeytokens
//     egress: { categories: [metrics, logs, traces, events, topology, changes, alerts, knowledge, sql, code] }
//     probe_on_start: true
//     routes: [ … 与 eval 配置相同 … ]      # 每条路由可选 model_class 与 timeouts: { first_token, idle, total }（ADR 0098）
//                                          # 以及 role: regular | last_resort（兜底路由，ADR 0152）
//   budget: { daily_tokens: 15000000, daily_warn_ratio: 0.8, on_exhausted: critical_only, per_research_input_tokens: 150000,
//             purposes: { optimization: { daily_tokens: 3000000 } },   # 主动优化的每日用量上限（ADR 0146 §5.3）
//             last_resort: { daily_tokens: 2000000 } }                 # 兜底路由合计的每日上限，配置了兜底路由时必填（ADR 0152）
//   research: { deadline: 8m, max_steps: 3, checks_per_step: 3, tool_calls: 12 }
//   mcp: [ … 只读 MCP 服务器与工具白名单 … ]

const duration = z.string().regex(/^\d+(ms|s|m|h)$/);
const UNIT: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const ms = (d: string) => {
  const m = /^(\d+)(ms|s|m|h)$/.exec(d) as RegExpExecArray;
  return Number(m[1]) * (UNIT[m[2] as string] as number);
};

const route = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    base_url: z.string().url(),
    api: z.enum(['responses', 'chat_completions']),
    model: z.string().min(1),
    dialect_profile: z.string().min(1),
    price: z
      .object({
        currency: z.enum(['USD', 'CNY']),
        input_per_mtok: z.number().min(0),
        output_per_mtok: z.number().min(0),
        cached_input_per_mtok: z.number().min(0).nullable(),
      })
      .strict(),
    failure_domain: z.array(z.string()).default([]),
    in_domain: z.boolean(),
    tier: z.enum(['small', 'large']),
    role: z.enum(['regular', 'last_resort']).optional(),
    retention_terms: z.string(),
    api_key_file: z.string(),
    model_class: z.enum(['hosted_large', 'hosted_small', 'local']).optional(),
    timeouts: z
      .object({ first_token: duration.optional(), idle: duration.optional(), total: duration.optional() })
      .strict()
      .optional(),
  })
  .strict();

const mcpTool = z
  .object({
    name: z.string().min(1),
    range: z
      .object({ from: z.string(), to: z.string(), format: z.enum(['unix', 'rfc3339']) })
      .strict()
      .optional(),
    instant: z
      .object({ at: z.string(), format: z.enum(['unix', 'rfc3339']) })
      .strict()
      .optional(),
    step: z.string().optional(),
    lines: z.string().optional(),
    live: z.boolean(),
    result: z.enum(['prometheus', 'json', 'text', 'lines']),
  })
  .strict();

export const workerConfigSchema = z
  .object({
    cluster_id: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/),
    worker_id: z.string().min(1).default(hostname()),
    code_sha: z.string().regex(/^[0-9a-f]{40}$/),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    listen: z
      .object({
        api: z.string().default(':8080'),
        metrics: z.string().default(':9090'),
        probes: z.string().default(':8081'),
      })
      .strict()
      .default({ api: ':8080', metrics: ':9090', probes: ':8081' }),
    database: z
      .object({
        password_file: z.string().default('/etc/srenautix/secrets/db/password'),
        pool_size: z.number().int().min(2).max(32).default(4),
      })
      .strict()
      .default({ password_file: '/etc/srenautix/secrets/db/password', pool_size: 4 }),
    hub: z.object({ url: z.string().url(), token_file: z.string() }).strict(),
    inbound: z.object({ token_sha256_file: z.string() }).strict(),
    language: z.enum(['zh', 'en']).default('zh'),
    llm: z
      .object({
        allow_cross_border: z.boolean().default(false),
        honeytokens_file: z.string().optional(),
        // 允许出境的数据类别（ADR 0146 §3.6）；没有时为事件研判一直使用的类别，不含 sql 与 code
        egress: z
          .object({ categories: z.array(z.enum(EGRESS_CATEGORIES as [EgressCategory, ...EgressCategory[]])).min(1) })
          .strict()
          .optional(),
        probe_on_start: z.boolean().default(true),
        // 旧配置：只作为没有声明 timeouts.total 的路由的总时长上限；首 token 与空闲超时按模型类别（ADR 0098）
        call_timeout: duration.optional(),
        routes: z.array(route).min(1),
      })
      .strict(),
    budget: z
      .object({
        daily_tokens: z.number().int().min(1000),
        daily_warn_ratio: z.number().min(0.1).max(1).default(0.8),
        on_exhausted: z.enum(['critical_only', 'stage_a_only']).default('critical_only'),
        per_research_input_tokens: z.number().int().min(1000).default(DEFAULT_BUDGET.perResearchInputTokens),
        purposes: z
          .object({
            optimization: z
              .object({ daily_tokens: z.number().int().min(0) })
              .strict()
              .optional(),
          })
          .strict()
          .default({}),
        // 兜底路由合计的每日上限（ADR 0152）；用量同时计入 daily_tokens
        last_resort: z
          .object({ daily_tokens: z.number().int().min(1000) })
          .strict()
          .optional(),
      })
      .strict(),
    research: z
      .object({
        deadline: duration.default('8m'),
        max_steps: z.number().int().min(1).max(6).default(DEFAULT_LIMITS.maxSteps),
        checks_per_step: z.number().int().min(1).max(6).default(DEFAULT_LIMITS.checksPerStep),
        tool_calls: z.number().int().min(0).max(50).default(DEFAULT_LIMITS.toolCalls),
        claim_wait: duration.default('25s'),
      })
      .strict()
      .default({
        deadline: '8m',
        max_steps: DEFAULT_LIMITS.maxSteps,
        checks_per_step: DEFAULT_LIMITS.checksPerStep,
        tool_calls: DEFAULT_LIMITS.toolCalls,
        claim_wait: '25s',
      }),
    mcp: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            url: z.string().url(),
            bearer_token_file: z.string().optional(),
            tools: z.array(mcpTool).min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const spare = c.llm.routes.filter((r) => r.role === 'last_resort').map((r) => r.id);
    if (spare.length && !c.budget.last_resort) {
      ctx.addIssue({
        code: 'custom',
        path: ['budget', 'last_resort'],
        message: `配置了兜底路由 ${spare.join('、')}，必须给出 budget.last_resort.daily_tokens（ADR 0152）`,
      });
    }
  });

export type WorkerConfigRaw = z.infer<typeof workerConfigSchema>;

export interface WorkerConfig {
  raw: WorkerConfigRaw;
  routes: Array<{ route: ModelRoute; apiKey: string; timeouts: { modelClass: ModelClass; timeouts: RouteTimeouts } }>;
  hubToken: string;
  inboundTokenSha256: string[];
  honeytokens: string[];
  mcp: McpServerConfig[];
  budget: BudgetConfig;
  limits: ResearchLimits;
  claimWaitS: number;
}

export function resolveWorkerConfig(raw: WorkerConfigRaw): WorkerConfig {
  return {
    raw,
    routes: raw.llm.routes.map(({ api_key_file, model_class, timeouts, ...r }) => ({
      route: r,
      apiKey: readSecretFile(`路由 ${r.id} 的 api_key_file`, api_key_file),
      timeouts: resolveTimeouts(
        r,
        {
          model_class,
          timeouts: {
            first_token: timeouts?.first_token === undefined ? undefined : ms(timeouts.first_token),
            idle: timeouts?.idle === undefined ? undefined : ms(timeouts.idle),
            total: timeouts?.total === undefined ? undefined : ms(timeouts.total),
          },
        },
        raw.llm.call_timeout === undefined ? null : ms(raw.llm.call_timeout),
      ),
    })),
    hubToken: readSecretFile('hub.token_file', raw.hub.token_file),
    inboundTokenSha256: readSecretFile('inbound.token_sha256_file', raw.inbound.token_sha256_file)
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        if (!/^[0-9a-f]{64}$/.test(x)) {
          throw new Error('inbound.token_sha256_file 每行必须是 64 位十六进制的 sha256');
        }
        return x;
      }),
    honeytokens: raw.llm.honeytokens_file
      ? readFileSync(raw.llm.honeytokens_file, 'utf8')
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
      : [],
    mcp: raw.mcp.map((m) => ({
      id: m.id,
      url: m.url,
      bearerToken: m.bearer_token_file ? readSecretFile(`MCP 服务器 ${m.id} 的 token`, m.bearer_token_file) : null,
      tools: m.tools,
    })),
    budget: {
      ...DEFAULT_BUDGET,
      dailyTokens: raw.budget.daily_tokens,
      dailyWarnRatio: raw.budget.daily_warn_ratio,
      onExhausted: raw.budget.on_exhausted,
      perResearchInputTokens: raw.budget.per_research_input_tokens,
      // 没有配置时主动优化的每日用量为 0：worker 不运行目标任务
      optimizationDailyTokens: raw.budget.purposes.optimization?.daily_tokens ?? 0,
      ...(raw.budget.last_resort ? { lastResortDailyTokens: raw.budget.last_resort.daily_tokens } : {}),
    },
    limits: {
      ...DEFAULT_LIMITS,
      deadlineMs: ms(raw.research.deadline),
      maxSteps: raw.research.max_steps,
      checksPerStep: raw.research.checks_per_step,
      toolCalls: raw.research.tool_calls,
    },
    claimWaitS: Math.round(ms(raw.research.claim_wait) / 1000),
  };
}

export function loadWorkerConfig(path: string): WorkerConfig {
  return resolveWorkerConfig(workerConfigSchema.parse(parse(readFileSync(path, 'utf8'))));
}
