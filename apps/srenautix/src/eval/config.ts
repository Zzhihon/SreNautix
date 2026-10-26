import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { ModelRoute } from '@srenautix/contract';
import { alertMatcher, upgradeMatchers } from '../alerts/business-impact.js';
import { readSecretFile } from '../config/files.js';
import { NOTIFY_RULES_DEFAULT, notifyRules } from '../config/server.js';
import { logger } from '../log.js';
import { NOVELTY_CONFIG_DEFAULT, noveltyConfig } from '../config/novelty.js';
import { DEFAULT_BUDGET, type BudgetConfig } from '../llm/budget.js';
import { resolveTimeouts, type ModelClass, type RouteTimeouts } from '../llm/timeouts.js';
import type { ChatThinking } from '../llm/wire.js';
import type { McpServerConfig } from '../tools/mcp.js';

// 评测配置（srenautix eval 的 --config / --compare 参数）：模型路由、出站策略与 reconstructed 模式的只读 MCP 服务器。
//
//   language: zh
//   allow_cross_border: false
//   honeytokens_file: /etc/srenautix/secrets/honeytokens   # 每行一个蜜标，可省略
//   routes:
//     - id: primary
//       base_url: https://llm.example.com/v1
//       api: responses
//       model: some-model
//       dialect_profile: openai-responses
//       price: { currency: USD, input_per_mtok: 1.25, output_per_mtok: 10, cached_input_per_mtok: 0.125 }
//       failure_domain: []
//       in_domain: true
//       tier: large
//       retention_terms: "…"
//       api_key_file: /etc/srenautix/secrets/llm/key     # 或 api_key_env: LLM_API_KEY
//       model_class: hosted_large                        # 可省略：按 tier 与方言档案推断（ADR 0098）
//       timeouts: { first_token_seconds: 120, idle_seconds: 30 }   # 可省略：按模型类别的默认值
//       role: last_resort                                # 可省略；评测把每条路由当作常规路由单独评测（ADR 0152）
//       thinking: disabled                               # 可省略；只用于 chat_completions，关闭服务方默认的思考模式（ADR 0158）
//   mcp: []
//
// 每条路由单独评测；命令行的 --route <id> 只评测列出的路由，只读取这些路由的密钥。

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
    api_key_env: z.string().optional(),
    api_key_file: z.string().optional(),
    context_tokens: z.number().int().min(1024).optional(),
    model_class: z.enum(['hosted_large', 'hosted_small', 'local']).optional(),
    timeouts: z
      .object({
        first_token_seconds: z.number().int().min(1).max(1800).optional(),
        idle_seconds: z.number().int().min(1).max(600).optional(),
        total_seconds: z.number().int().min(5).max(3600).optional(),
      })
      .strict()
      .optional(),
    thinking: z.enum(['disabled']).optional(),
  })
  .strict()
  .refine(
    (r) => (r.api_key_env === undefined) !== (r.api_key_file === undefined),
    '每条路由必须且只能给出 api_key_env 或 api_key_file 之一',
  );

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

const schema = z
  .object({
    language: z.enum(['zh', 'en']).default('zh'),
    allow_cross_border: z.boolean().default(false),
    honeytokens_file: z.string().optional(),
    routes: z.array(route).min(1),
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
    budget: z
      .object({
        per_research_input_tokens: z.number().int().min(1000).optional(),
        // 旧配置：只作为没有声明 timeouts.total_seconds 的路由的总时长上限（ADR 0098）
        call_timeout_seconds: z.number().int().min(5).max(600).optional(),
      })
      .strict()
      .default({}),
    // 重建评测（eval export、eval reconstruct，ADR 0110）：证据卡与查询模板读取的指标后端、加载的领域包、
    // 发布推导的版本标签（与 server 配置 changes.kubernetes 相同）
    reconstruct: z
      .object({
        cluster_id: z.string().min(1),
        metrics: z
          .object({
            url: z.string().url(),
            dialect: z.enum(['promql', 'metricsql']).default('promql'),
            bearer_token_file: z.string().optional(),
          })
          .strict(),
        packs: z.object({ dirs: z.array(z.string().min(1)).min(1) }).strict(),
        revision_labels: z.array(z.string().min(1)).default([]),
        // 与 server 的 changes.kubernetes.pre_step_labels 相同（ADR 0104 §13）
        pre_step_labels: z.array(z.string().min(1)).optional(),
        group_within_seconds: z.number().int().min(10).default(120),
        step_seconds: z.number().int().min(10).max(300).default(30),
        locale: z.enum(['zh-CN', 'en']).default('zh-CN'),
        evidence_concurrency: z.number().int().min(1).max(16).default(4),
        query_timeout_seconds: z.number().int().min(5).max(120).default(30),
        // 证据基线（ADR 0153），与 server 的 stage_a.novelty 相同
        novelty: noveltyConfig.default(NOVELTY_CONFIG_DEFAULT),
        // 业务影响告警（ADR 0163、0166），与 server 的 notify.business_impact_alerts 相同。弃用的 business_impact_labels
        // 在解析前转换为它（loadEvalConfig）
        business_impact_alerts: z.array(alertMatcher).default([]),
        // 推送规则（ADR 0175）：误推送按它判断，与 server 的 notify.severities、notify.digest 同一写法与默认值；
        // 业务影响告警取上面的 business_impact_alerts
        notify: notifyRules.default(NOTIFY_RULES_DEFAULT),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ReconstructConfig = NonNullable<z.infer<typeof schema>['reconstruct']>;

export interface EvalRouteConfig {
  route: ModelRoute;
  apiKey: string;
  contextTokens: number | null;
  timeouts: { modelClass: ModelClass; timeouts: RouteTimeouts };
  thinking: ChatThinking | null;
}

export interface EvalConfig {
  language: 'zh' | 'en';
  allowCrossBorder: boolean;
  honeytokens: string[];
  routes: EvalRouteConfig[];
  mcp: McpServerConfig[];
  budget: BudgetConfig;
  reconstruct: ReconstructConfig | null;
}

/** 只取重建部分（eval export 与只做发现重放时不需要模型密钥） */
export function loadReconstructConfig(path: string): ReconstructConfig {
  const r = schema.parse(upgradeEvalRaw(parse(readFileSync(path, 'utf8')), path)).reconstruct;
  if (!r) {
    throw new Error(`评测配置 ${path} 没有 reconstruct 部分`);
  }
  return r;
}

/** 弃用写法的转换（ADR 0166）：reconstruct.business_impact_labels 转为 reconstruct.business_impact_alerts，记录弃用警告 */
export function upgradeEvalRaw(raw: unknown, path: string): unknown {
  const r = raw && typeof raw === 'object' ? (structuredClone(raw) as Record<string, unknown>) : null;
  const rc = r?.reconstruct as Record<string, unknown> | undefined;
  if (!r || !rc || typeof rc !== 'object') {
    return raw;
  }
  const up = upgradeMatchers(rc.business_impact_alerts, rc.business_impact_labels, {
    current: 'reconstruct.business_impact_alerts',
    legacy: 'reconstruct.business_impact_labels',
  });
  if (up.value !== undefined) {
    rc.business_impact_alerts = up.value;
  }
  delete rc.business_impact_labels;
  for (const d of up.deprecated) {
    logger.warn('评测配置使用了弃用的写法', { path, detail: d });
  }
  return r;
}

/**
 * 读取评测配置。only 不为空时只保留其中列出的路由（命令行的 --route），其他路由的密钥不读取；
 * 列出了配置里没有的路由时报错
 */
export function loadEvalConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
  only: readonly string[] = [],
): EvalConfig {
  const raw = schema.parse(upgradeEvalRaw(parse(readFileSync(path, 'utf8')), path));
  const missing = only.filter((id) => !raw.routes.some((r) => r.id === id));
  if (missing.length) {
    throw new Error(
      `评测配置 ${path} 中没有路由 ${missing.join('、')}，可选：${raw.routes.map((r) => r.id).join('、')}`,
    );
  }
  const selected = only.length ? raw.routes.filter((r) => only.includes(r.id)) : raw.routes;
  const routes = selected.map((r): EvalRouteConfig => {
    const { api_key_env, api_key_file, context_tokens, model_class, timeouts, thinking, ...rest } = r;
    let apiKey: string;
    if (api_key_env !== undefined) {
      const v = env[api_key_env];
      if (!v) {
        throw new Error(`路由 ${r.id} 的密钥环境变量 ${api_key_env} 没有设置`);
      }
      apiKey = v;
    } else {
      apiKey = readSecretFile(`路由 ${r.id} 的 api_key_file`, api_key_file as string);
    }
    const sec = (v: number | undefined) => (v === undefined ? undefined : v * 1000);
    return {
      route: rest,
      apiKey,
      contextTokens: context_tokens ?? null,
      thinking: thinking ?? null,
      timeouts: resolveTimeouts(
        rest,
        {
          model_class,
          timeouts: {
            first_token: sec(timeouts?.first_token_seconds),
            idle: sec(timeouts?.idle_seconds),
            total: sec(timeouts?.total_seconds),
          },
        },
        raw.budget.call_timeout_seconds === undefined ? null : raw.budget.call_timeout_seconds * 1000,
      ),
    };
  });
  return {
    language: raw.language,
    allowCrossBorder: raw.allow_cross_border,
    honeytokens: raw.honeytokens_file
      ? readFileSync(raw.honeytokens_file, 'utf8')
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
      : [],
    routes,
    mcp: raw.mcp.map((m) => ({
      id: m.id,
      url: m.url,
      bearerToken: m.bearer_token_file ? readSecretFile(`MCP 服务器 ${m.id} 的 token`, m.bearer_token_file) : null,
      tools: m.tools,
    })),
    budget: {
      ...DEFAULT_BUDGET,
      perResearchInputTokens: raw.budget.per_research_input_tokens ?? DEFAULT_BUDGET.perResearchInputTokens,
    },
    reconstruct: raw.reconstruct ?? null,
  };
}
