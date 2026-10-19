import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from '../config/files.js';

/**
 * 服务调用方（非人类）的 bearer token。文件只保存 token 的 sha256，由 Secret 挂载：
 *
 *   callers:
 *     - id: worker
 *       kind: worker
 *       token_sha256: <64 位十六进制>
 *     - id: spoke-prod-gateway
 *       kind: spoke
 *       role: gateway
 *       cluster_id: prod
 *       token_sha256: …
 *     - id: holmes
 *       kind: external
 *       channel: api
 *       actions: [workload_scale, pod_restart]
 *       namespaces: [shop]
 *       proposals_per_hour: 30
 *       token_sha256: …
 *
 * 外部调用方只能提议（DESIGN §9.3）：不能审批，也不能修改策略。
 */
const sha = z.string().regex(/^[0-9a-f]{64}$/);

const caller = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1), kind: z.literal('worker'), token_sha256: sha }).strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('spoke'),
      role: z.enum(['reader', 'gateway']),
      cluster_id: z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/),
      token_sha256: sha,
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('external'),
      channel: z.enum(['api', 'mcp']),
      actions: z.array(z.string().min(1)).min(1),
      namespaces: z.array(z.string().min(1)).min(1),
      proposals_per_hour: z.number().int().min(1).max(10_000).default(60),
      token_sha256: sha,
    })
    .strict(),
  z.object({ id: z.string().min(1), kind: z.literal('grafana'), token_sha256: sha }).strict(),
]);

const file = z.object({ callers: z.array(caller) }).strict();

export type ServiceCaller = z.infer<typeof caller>;

export class CallerRegistry {
  private readonly entries: Array<{ caller: ServiceCaller; digest: Buffer }>;

  constructor(callers: ServiceCaller[]) {
    const ids = callers.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      throw new ConfigError('服务调用方 id 不能重复');
    }
    const digests = callers.map((c) => c.token_sha256);
    if (new Set(digests).size !== digests.length) {
      throw new ConfigError('服务调用方的 token 不能重复');
    }
    this.entries = callers.map((c) => ({ caller: c, digest: Buffer.from(c.token_sha256, 'hex') }));
  }

  static load(path: string): CallerRegistry {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new ConfigError(`服务调用方文件 ${path} 不可读：${(e as Error).message}`);
    }
    const r = file.safeParse(raw);
    if (!r.success) {
      throw new ConfigError(
        `服务调用方文件 ${path} 不合法：${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`,
      );
    }
    return new CallerRegistry(r.data.callers);
  }

  /** 按 bearer token 查找调用方；逐个常量时间比较，耗时与命中哪一个无关。 */
  authenticate(token: string): ServiceCaller | null {
    const d = createHash('sha256').update(token).digest();
    let found: ServiceCaller | null = null;
    for (const e of this.entries) {
      if (timingSafeEqual(d, e.digest)) {
        found = e.caller;
      }
    }
    return found;
  }

  list(): ServiceCaller[] {
    return this.entries.map((e) => e.caller);
  }
}

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
