import { z } from 'zod';

/**
 * 业务库的只读连接：专用只读角色（默认 srenautix_stats），口令文件挂载自 Secret。
 * SQL 审计表变更源（changes.sql_audit，ADR 0151）与历史 dbstats 配置共用。
 */
export const pgReadConnection = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(5432),
    database: z.string().min(1),
    user: z.string().min(1).default('srenautix_stats'),
    password_file: z.string().min(1),
    ssl: z
      .union([z.boolean(), z.object({ ca_file: z.string().optional(), servername: z.string().optional() }).strict()])
      .default(false),
  })
  .strict();
