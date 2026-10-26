import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { EvalCase } from '@srenautix/contract';
import { stableUuid } from './import-seed.js';

// 评测标注文件（第二阶段三个环节共用，ADR 0110）：每条标注是一次故障，给出故障窗口、属于这次故障的告警、
// 可接受的根因组件键、处置判断、发现环节的成员要求与自愈环节的标准修复。标注含部署方集群的事实，只保存在部署方本地。
//
//   version: 1
//   cluster_id: prod
//   labels:
//     - id: release-2026-10-20
//       title: 发布回退失败
//       type: incident                       # incident、benign 或 abstain（真实原因不在可观测的数据里，
//                                            # 正确的结论是弃权：inconclusive 或 undetermined）
//       window: {from: …, to: …}             # 故障窗口：重建与发现统计都在这个窗口内
//       as_of: …                             # 分析时刻（阶段 B 的研判时刻）
//       fault_alerts:                        # 属于这次故障的告警（告警名 + 标签子集）
//         - {alertname: KubeDeploymentRolloutStuck, labels: {namespace: prod}}
//       roots: [Deployment:prod/api]         # 可接受的根因组件键（任一命中即为命中；分析环节的标准答案）
//       discovery_roots: []                  # 发现环节可接受的根因，为空时与 roots 相同
//       revisions: [{date: …, change: …, reason: …}]   # 修订记录
//       granularity: workload
//       mechanism: …
//       disposition: act
//       required_members: [[Deployment:prod/api, pod:prod/api-0]]   # 主事件必须覆盖的组件，每项是一组同义键
//       required_change_near: …              # 主事件的变更中必须有这个时刻前后 2 分钟内的一条
//       legacy_case: legacy:release:…        # 快照模式对应的种子用例
//       legacy_roots: [legacy.component:release]
//       learned_from: [release:…]            # 防泄漏：领域包知识条目的 learned_from 取值
//       fix:                                 # 标准修复（自愈 PR 的正确率按它判断）
//         class: release_rollback
//         repository: org/gitops
//         commit: abc1234
//         expect: [{path: apps/api/release.json, select: {}, pointer: /data/image, value: "…"}]
//       noise: [{card: app/archive/unlocated}]   # 噪声信号（ADR 0153）：重建的阶段 A 中这些卡应判为常态，
//                                            # 并且不出现在任何假设的支持证据中
//       evidence: [{kind: report, ref: operations/reports/….md}]

const time = z.string().refine((s) => !Number.isNaN(Date.parse(s)), '不是合法的时间');

const matcher = z
  .object({
    alertname: z.string().min(1),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const fixExpect = z
  .object({
    path: z.string().min(1),
    // 多文档 YAML 中选择文档：按字段的点分路径取值后比较（例如 kind、metadata.name）；空对象表示唯一的文档
    select: z.record(z.string(), z.string()).default({}),
    // JSON Pointer（RFC 6901）
    pointer: z.string().regex(/^(\/[^/]*)*$/),
    value: z.unknown(),
  })
  .strict();

export const FIX_CLASSES = ['release_rollback', 'config_resource', 'alert_rule', 'topology_pack'] as const;
export type FixClass = (typeof FIX_CLASSES)[number];

const fix = z
  .object({
    class: z.enum(FIX_CLASSES),
    repository: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    expect: z.array(fixExpect).min(1),
  })
  .strict();

export const label = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,150}$/),
    title: z.string().min(1),
    type: z.enum(['incident', 'benign', 'abstain']),
    window: z.object({ from: time, to: time }).strict(),
    as_of: time,
    fault_alerts: z.array(matcher).min(1),
    roots: z.array(z.string().min(1)).default([]),
    // 发现环节可接受的根因：为空时与 roots 相同。变更是源头、受影响的组件是分析环节的根因时分开写
    // （例如迁移失败：发现环节落在发布或迁移 Job 上，分析环节必须指出数据库的托管角色）
    discovery_roots: z.array(z.string().min(1)).default([]),
    // 标注的修订记录：每次修改标准答案都写一条，清单中列出供抽查
    revisions: z
      .array(z.object({ date: z.string().min(1), change: z.string().min(1), reason: z.string().min(1) }).strict())
      .default([]),
    granularity: z.enum(['pod', 'workload', 'component', 'node']).nullable().default(null),
    mechanism: z.string().max(600).nullable().default(null),
    disposition: z.enum(['act', 'ignore', 'escalate', 'undetermined']).nullable().default(null),
    required_members: z.array(z.array(z.string().min(1)).min(1)).default([]),
    required_change_near: time.nullable().default(null),
    legacy_case: z.string().nullable().default(null),
    legacy_roots: z.array(z.string().min(1)).default([]),
    learned_from: z.array(z.string().min(1)).default([]),
    fix: fix.nullable().default(null),
    // 噪声信号（ADR 0153）：卡片全局键 <pack>/<chain>/<card>
    noise: z
      .array(
        z
          .object({ card: z.string().regex(/^[a-z0-9_][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_-]*$/) })
          .strict(),
      )
      .default([]),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(['report', 'commit', 'pr', 'issue', 'knowledge', 'workflow', 'metrics', 'proposal', 'state']),
            ref: z.string().min(1),
            note: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (Date.parse(l.window.from) >= Date.parse(l.window.to)) {
      ctx.addIssue({ code: 'custom', message: `${l.id}：window.from 必须早于 window.to` });
    }
    if (Date.parse(l.as_of) < Date.parse(l.window.from) || Date.parse(l.as_of) > Date.parse(l.window.to)) {
      ctx.addIssue({ code: 'custom', message: `${l.id}：as_of 必须在故障窗口内` });
    }
    if (l.type === 'incident' && !l.roots.length) {
      ctx.addIssue({ code: 'custom', message: `${l.id}：incident 标注必须给出 roots` });
    }
    if (l.type === 'benign' && (l.roots.length || l.discovery_roots.length || l.disposition !== 'ignore')) {
      ctx.addIssue({ code: 'custom', message: `${l.id}：benign 标注的 roots 为空、disposition 为 ignore` });
    }
    if (l.type === 'abstain' && (l.roots.length || l.disposition !== null || l.fix !== null)) {
      ctx.addIssue({ code: 'custom', message: `${l.id}：abstain 标注的 roots 为空，不写 disposition 与 fix` });
    }
  });

export const labelFile = z
  .object({
    version: z.literal(1),
    cluster_id: z.string().min(1),
    labels: z.array(label).min(1),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const l of f.labels) {
      if (seen.has(l.id)) {
        ctx.addIssue({ code: 'custom', message: `标注 id 重复：${l.id}` });
      }
      seen.add(l.id);
    }
  });

export type Label = z.infer<typeof label>;
export type LabelFile = z.infer<typeof labelFile>;
export type AlertMatcher = z.infer<typeof matcher>;
export type FixExpect = z.infer<typeof fixExpect>;

export function loadLabels(path: string): LabelFile {
  return labelFile.parse(parse(readFileSync(path, 'utf8')));
}

/** 发现环节可接受的根因 */
export function discoveryRoots(l: Label): string[] {
  return l.discovery_roots.length ? l.discovery_roots : l.roots;
}

/** 告警是否属于这次故障：告警名相同且标签子集全部相等 */
export function matchesFault(l: Label, alertname: string, labels: Record<string, string>): boolean {
  return l.fault_alerts.some(
    (m) => m.alertname === alertname && Object.entries(m.labels).every(([k, v]) => labels[k] === v),
  );
}

/** 重建模式的评测用例：case_id 为 label:<id>，标准答案取自标注；snapshot_id 指向重建时生成的快照 */
export function labelCase(f: LabelFile, l: Label, suite: string, snapshotId: string, createdAt: string): EvalCase {
  return {
    case_id: `label:${l.id}`,
    version: 1,
    suite,
    type: l.type,
    cluster_id: f.cluster_id,
    incident_id: null,
    label: l.id,
    started_at: new Date(Date.parse(l.window.from)).toISOString(),
    as_of: new Date(Date.parse(l.as_of)).toISOString(),
    truth: {
      root_components: l.type === 'incident' ? [...l.roots, ...l.legacy_roots] : [],
      granularity: l.granularity,
      mechanism: l.mechanism,
      disposition: l.disposition,
      forbid_evidence_consistent: l.type !== 'incident',
    },
    truth_source: { kind: 'human', principal: null, ref: `label:${l.id}` },
    leakage: {
      exclude_incident_ids: [],
      exclude_refs: l.evidence.map((e) => e.ref),
      learned_from_keys: l.learned_from,
    },
    pack_timing: 'pack_after_incident',
    snapshot_id: snapshotId,
    derived_from: null,
    authored_by: null,
    created_at: createdAt,
  };
}

/** 快照模式：把标注写进对应的种子用例（新版本，标准答案改为标注；原有快照不变） */
export function relabelLegacy(c: EvalCase, l: Label, createdAt: string): EvalCase {
  return {
    ...c,
    version: c.version + 1,
    suite: c.suite.endsWith('-unlabeled') ? c.suite.slice(0, -'-unlabeled'.length) : c.suite,
    type: l.type,
    truth: {
      root_components: l.type === 'incident' ? [...l.legacy_roots, ...l.roots] : [],
      granularity: l.granularity,
      mechanism: l.mechanism,
      disposition: l.disposition,
      forbid_evidence_consistent: l.type !== 'incident',
    },
    truth_source: { kind: 'human', principal: null, ref: `label:${l.id}` },
    leakage: {
      ...c.leakage,
      exclude_refs: [...new Set([...c.leakage.exclude_refs, ...l.evidence.map((e) => e.ref)])],
      learned_from_keys: [...new Set([...c.leakage.learned_from_keys, ...l.learned_from])],
    },
    created_at: createdAt,
  };
}

/** 重建快照的确定性 id */
export function reconstructedSnapshotId(l: Label, codeSha: string): string {
  return stableUuid('reconstructed', `${l.id}@${codeSha}`);
}
