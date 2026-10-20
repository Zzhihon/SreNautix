import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertRole } from '@srenautix/contract';
import { parse as parseYaml, stringify } from 'yaml';
import { isComponentKey } from '@srenautix/core';
import { z } from 'zod';
import { ConfigError } from '../config/files.js';

/**
 * 拓扑覆盖（DESIGN §4.4、§12.3）：Git 挂载的目录，给领域包没有映射到组件的告警指定组件与角色。每个 *.yaml 文件：
 *
 *   api_version: srenautix.io/topology-overrides/v1
 *   alerts:
 *     - cluster_id: prod
 *       alertname: KafkaConsumerLag
 *       match_labels: { topic: orders }   # 可省略；全部相等才命中
 *       component: Deployment:shop/orders-consumer
 *       role: cause
 *
 * 同一告警命中多条时取 match_labels 最多的一条，一样多时取先声明的。控制台为未映射的告警发起的 PR 修改的就是这些文件。
 */
export const OVERRIDES_API_VERSION = 'srenautix.io/topology-overrides/v1';

export const overrideSchema = z
  .object({
    cluster_id: z.string().min(1),
    alertname: z.string().min(1),
    match_labels: z.record(z.string(), z.string()).optional(),
    component: z
      .string()
      .refine(
        isComponentKey,
        '组件键形如 <kind>:<namespace>/<名称段> 或 <kind>:<名称段>，名称段按 ADR 0034 编码（例如 ClusterRole:system%3Aauth）',
      ),
    role: z.enum(['cause', 'change', 'symptom', 'forecast', 'meta']),
  })
  .strict();

export const overridesFileSchema = z
  .object({ api_version: z.literal(OVERRIDES_API_VERSION), alerts: z.array(overrideSchema) })
  .strict();

export type TopologyOverride = z.infer<typeof overrideSchema>;

export class TopologyOverrides {
  private constructor(
    private readonly entries: ReadonlyArray<{ o: TopologyOverride; file: string; index: number }>,
    readonly revision: string,
  ) {}

  static empty(): TopologyOverrides {
    return new TopologyOverrides([], 'empty');
  }

  /** 目录不存在时报错（配置写了目录却没有挂载）；文件不合法时报错，带文件名与字段。 */
  static load(dir: string): TopologyOverrides {
    if (!existsSync(dir)) {
      throw new ConfigError(`拓扑覆盖目录不存在：${dir}`);
    }
    const files = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort();
    const h = createHash('sha256');
    const entries: Array<{ o: TopologyOverride; file: string; index: number }> = [];
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      h.update(f).update('\0').update(text).update('\0');
      const parsed = parseOverridesFile(f, text);
      parsed.alerts.forEach((o, index) => entries.push({ o, file: f, index }));
    }
    const rev = existsSync(join(dir, 'REVISION')) ? readFileSync(join(dir, 'REVISION'), 'utf8').trim() : null;
    return new TopologyOverrides(entries, rev || `sha256:${h.digest('hex')}`);
  }

  /** 命中的覆盖规则；没有时为 null。 */
  match(clusterId: string, labels: Record<string, string>): { component: string; role: AlertRole; ref: string } | null {
    let best: { o: TopologyOverride; file: string; index: number } | null = null;
    for (const e of this.entries) {
      if (e.o.cluster_id !== clusterId || e.o.alertname !== labels.alertname) {
        continue;
      }
      const m = e.o.match_labels ?? {};
      if (!Object.entries(m).every(([k, v]) => labels[k] === v)) {
        continue;
      }
      if (!best || Object.keys(m).length > Object.keys(best.o.match_labels ?? {}).length) {
        best = e;
      }
    }
    return best ? { component: best.o.component, role: best.o.role, ref: `${best.file}#${best.index}` } : null;
  }

  get size(): number {
    return this.entries.length;
  }
}

export function parseOverridesFile(name: string, text: string): z.infer<typeof overridesFileSchema> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError(`拓扑覆盖文件 ${name} 不是合法 YAML：${(e as Error).message}`);
  }
  const r = overridesFileSchema.safeParse(raw);
  if (!r.success) {
    throw new ConfigError(
      `拓扑覆盖文件 ${name} 不合法：${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`,
    );
  }
  return r.data;
}

/** 在覆盖文件中追加一条规则（文件不存在时新建）。已有同一集群、同一告警名且 match_labels 相同的规则时返回 null。 */
export function addOverride(existing: string | null, name: string, o: TopologyOverride): string | null {
  const doc: z.infer<typeof overridesFileSchema> =
    existing === null ? { api_version: OVERRIDES_API_VERSION, alerts: [] } : parseOverridesFile(name, existing);
  const same = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) =>
    JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
  if (
    doc.alerts.some(
      (x) => x.cluster_id === o.cluster_id && x.alertname === o.alertname && same(x.match_labels, o.match_labels),
    )
  ) {
    return null;
  }
  doc.alerts.push(o);
  return stringify(doc, { lineWidth: 0 });
}
