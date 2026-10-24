import { z } from 'zod';
import { validatorFor, type AnchorKind, type CodeLayout } from '@srenautix/contract';

// server 的主动优化配置（ADR 0146）：optimization.*。默认关闭；关闭时不创建目标、不访问业务仓库、不连接 dbstats。
//
//   optimization:
//     enabled: false
//     title_prefix: "[优化]"
//     repositories:
//       business:                                  # 业务仓库（只读代码，只创建 issue 与评论，§6.4）
//         repo: CCH-HQ/claude-code-hub-plus
//         default_branch: dev
//         code:                                    # 契约 CodeLayout（pack.schema.json，§3.5）
//           version: { rule: running, release_input: release_input, field: business_commit }
//           root: ""
//           include: ["**/*.go", "**/*.ts", "**/*.tsx", "**/*.sql"]
//           exclude: []                            # 测试、testdata、生成文件中的数据、密钥形状的文件总是排除
//           languages: [go, typescript]
//           anchors: [{ kind: sql, paths: ["internal/**", "db/**"] }]
//           labels: [{ paths: ["internal/gateway/**"], label: area/gateway }]
//     limits: { dbstats: { concurrency: 1, per_hour: 60, statement_text_per_hour: 6 }, … }   # §6.1

export type { AnchorKind };
export const ANCHOR_KINDS: readonly AnchorKind[] = ['sql', 'table', 'span_name', 'metric_name', 'route'];

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

/** 业务仓库读取时一律排除的路径（§3.5）：测试、testdata、生成的数据、密钥形状的文件 */
export const DEFAULT_CODE_EXCLUDE = [
  '**/*_test.go',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/testdata/**',
  '**/__tests__/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/*.pem',
  '**/.env*',
  '**/*secret*',
  '**/*.min.js',
] as const;

/** 业务仓库的代码布局按契约 CodeLayout 校验 */
const validCodeLayout = (v: unknown) => validatorFor<CodeLayout>('schemas/pack.schema.json#/$defs/CodeLayout')(v);
const codeLayout = z.custom<CodeLayout>(validCodeLayout, { message: '不符合契约 CodeLayout（pack.schema.json）' });

const businessRepository = z
  .object({
    repo: repoName,
    default_branch: z.string().min(1).default('main'),
    code: codeLayout,
  })
  .strict();

const backendLimit = (concurrency: number, perHour: number) =>
  z
    .object({
      concurrency: z.number().int().min(1).max(16).default(concurrency),
      per_hour: z.number().int().min(1).max(100_000).default(perHour),
    })
    .strict()
    .default({ concurrency, per_hour: perHour });

export const optimizationConfig = z
  .object({
    enabled: z.boolean().default(false),
    title_prefix: z.string().default('[优化]'),
    repositories: z.object({ business: businessRepository.optional() }).strict().default({}),
    // 后端查询的并发与每小时上限（§6.1）；事件研判与主动分析共用信号量，事件研判优先
    limits: z
      .object({
        dbstats: z
          .object({
            concurrency: z.number().int().min(1).max(4).default(1),
            per_hour: z.number().int().min(1).max(1000).default(60),
            statement_text_per_hour: z.number().int().min(0).max(100).default(6),
          })
          .strict()
          .default({ concurrency: 1, per_hour: 60, statement_text_per_hour: 6 }),
        metrics: backendLimit(2, 600),
        traces: backendLimit(1, 30),
        logs: backendLimit(1, 30),
        kube: z
          .object({ per_hour: z.number().int().min(1).max(10_000).default(60) })
          .strict()
          .default({ per_hour: 60 }),
        github: backendLimit(2, 1000),
      })
      .strict()
      .default({
        dbstats: { concurrency: 1, per_hour: 60, statement_text_per_hour: 6 },
        metrics: { concurrency: 2, per_hour: 600 },
        traces: { concurrency: 1, per_hour: 30 },
        logs: { concurrency: 1, per_hour: 30 },
        kube: { per_hour: 60 },
        github: { concurrency: 2, per_hour: 1000 },
      }),
  })
  .strict();

export type OptimizationConfig = z.infer<typeof optimizationConfig>;
export type BusinessRepositoryConfig = z.infer<typeof businessRepository>;

export const DEFAULT_OPTIMIZATION: OptimizationConfig = optimizationConfig.parse({});
