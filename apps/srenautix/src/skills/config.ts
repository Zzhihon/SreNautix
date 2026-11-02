import { z } from 'zod';

// server 的技能配置（ADR 0181 §6、§7）：skills.*。默认只有内置来源、没有启用任何技能、没有授予任何能力。
//
//   skills:
//     sources: [{kind: builtin}, {kind: dir, path: /etc/srenautix/skills/oom}]   # 后者覆盖前者的同名技能
//     reload_interval: 60s
//     enabled: [oom-rootcause]
//     grants:
//       oom-rootcause: {metrics.query_range: {}, logs.query: {max_lines: 1000}, kube.read: {objects: [pod_status]}, …}
//     scope:
//       oom-rootcause: {namespaces: [shop], kinds: [StatefulSet]}
//     params:
//       oom-rootcause: {rss_limit_ratio: 0.9}
//     limits: {duration: 15m, metrics_queries: 400, …}                 # 每次运行的上限，与清单的预算取较小者
//     concurrency: {metrics: 2, logs: 1, kube: 1, github: 2}           # 技能共用的后端并发
//     max_issues_per_hour: 3                                           # 不填时取 issues.max_per_hour，再没有时为 3
//     title_prefix: "[技能]"                                           # 不填时取 notify.prefix

const duration = z.string().regex(/^\d+(ms|s|m|h|d)$/, '时长形如 30s、5m、12h');
const skillName = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
const capability = z.enum(['metrics.query_range', 'logs.query', 'kube.read', 'code.read', 'issue.write']);

export const capabilityParams = z
  .object({
    objects: z.array(z.enum(['pod_status', 'events', 'pod_logs_previous'])).optional(),
    // 每次查询的行数，上限与日志接口 LogsQueryRequest.limit 相同
    max_lines: z.number().int().min(1).max(1000).optional(),
    repo_role: z.enum(['business', 'ops']).optional(),
  })
  .strict();

const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin') }).strict(),
  z.object({ kind: z.literal('dir'), path: z.string().min(1) }).strict(),
]);

const kinds = z.enum(['Deployment', 'StatefulSet', 'DaemonSet']);

export const SKILL_LIMITS_DEFAULT = {
  duration: '15m',
  metrics_queries: 400,
  logs_queries: 60,
  log_lines: 50_000,
  kube_reads: 40,
  github_requests: 200,
  code_files: 50,
  code_bytes: 4 * 1024 * 1024,
};

export const skillsConfig = z
  .object({
    sources: z
      .array(source)
      .min(1)
      .default([{ kind: 'builtin' }]),
    // 内置技能的目录；不填时为与代码同一发布物中的 skills/（仓库根目录；镜像中为 /app/skills）
    builtin_dir: z.string().min(1).optional(),
    reload_interval: duration.default('60s'),
    // 调度循环的间隔：到期的运行、每小时上限与投递
    interval: duration.default('15s'),
    enabled: z.array(skillName).default([]),
    grants: z.record(skillName, z.partialRecord(capability, capabilityParams)).default({}),
    scope: z
      .record(
        skillName,
        z.object({ namespaces: z.array(z.string().min(1)).min(1), kinds: z.array(kinds).min(1).optional() }).strict(),
      )
      .default({}),
    params: z.record(skillName, z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))).default({}),
    limits: z
      .object({
        duration: duration.default(SKILL_LIMITS_DEFAULT.duration),
        metrics_queries: z.number().int().min(1).default(SKILL_LIMITS_DEFAULT.metrics_queries),
        logs_queries: z.number().int().min(1).default(SKILL_LIMITS_DEFAULT.logs_queries),
        log_lines: z.number().int().min(1).default(SKILL_LIMITS_DEFAULT.log_lines),
        kube_reads: z.number().int().min(1).default(SKILL_LIMITS_DEFAULT.kube_reads),
        github_requests: z.number().int().min(1).default(SKILL_LIMITS_DEFAULT.github_requests),
        code_files: z.number().int().min(1).default(SKILL_LIMITS_DEFAULT.code_files),
        code_bytes: z.number().int().min(1).default(SKILL_LIMITS_DEFAULT.code_bytes),
      })
      .strict()
      .default(SKILL_LIMITS_DEFAULT),
    concurrency: z
      .object({
        metrics: z.number().int().min(1).max(8).default(2),
        logs: z.number().int().min(1).max(4).default(1),
        kube: z.number().int().min(1).max(4).default(1),
        github: z.number().int().min(1).max(4).default(2),
      })
      .strict()
      .default({ metrics: 2, logs: 1, kube: 1, github: 2 }),
    max_issues_per_hour: z.number().int().min(1).max(100).optional(),
    title_prefix: z.string().optional(),
  })
  .strict();

export type SkillsConfig = z.infer<typeof skillsConfig>;
export const DEFAULT_SKILLS: SkillsConfig = skillsConfig.parse({});
