import { readFileSync, writeFileSync } from 'node:fs';
import type { Incident } from '@srenautix/contract';
import { identityLabels } from '@srenautix/core';
import type pg from 'pg';
import { isMap, isSeq, parse, parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { EvalCandidateConfirm } from '../proposals/candidates.js';
import { label as labelSchema, labelFile, type Label } from './labels.js';

// 评测候选的导出与合并（ADR 0175）：
// - eval candidates export：从只读状态库读 [since, until) 内生成的候选，confirmed 的按事件生成完整标注（窗口、as_of、
//   fault_alerts 取成员告警、evidence 写明来源），pending 的列在另一节供查看；
// - eval label merge：把导出文件中 confirmed 的标注合并进部署者本地维护的标注文件，按 id 去重，按标注 schema 校验，
//   保留标注文件原有的注释与格式。

/** 故障窗口从首次触发之前这么久开始：重放需要事件开始之前的拓扑与告警 */
export const WINDOW_LEAD_MS = 15 * 60_000;
/** 故障窗口在事件结束（或最后一次更新）之后再延长这么久 */
export const WINDOW_TAIL_MS = 5 * 60_000;
/** 没有研判时，分析时刻取首次触发之后这么久（阶段 A 的时刻） */
export const STAGE_A_DELAY_MS = 60_000;

const time = z.string().refine((s) => !Number.isNaN(Date.parse(s)), '不是合法的时间');

const pendingEntry = z
  .object({
    candidate_id: z.string().uuid(),
    cluster_id: z.string().min(1),
    incident_id: z.string().uuid(),
    incident_label: z.string(),
    source: z.enum(['feedback', 'pr_closed', 'issue_not_planned', 'console']),
    source_ref: z.string(),
    suggested_type: z.enum(['incident', 'benign', 'abstain']).nullable(),
    reason_code: z.string().nullable(),
    reason: z.string().nullable(),
    created_at: time,
  })
  .strict();

const candidatesFile = z
  .object({
    version: z.literal(1),
    exported_at: time,
    since: time,
    until: time,
    confirmed: z.array(
      z.object({ cluster_id: z.string().min(1), candidate_id: z.string().uuid(), label: labelSchema }),
    ),
    pending: z.array(pendingEntry),
  })
  .strict();

export type CandidatesFile = z.infer<typeof candidatesFile>;

interface CandidateRow {
  candidate_id: string;
  cluster_id: string;
  incident_id: string;
  incident_label: string;
  incident: Incident;
  incident_updated_at: Date;
  research_run_id: string | null;
  run_started_at: Date | null;
  source: z.infer<typeof pendingEntry>['source'];
  source_ref: string;
  reason_code: string | null;
  reason: string | null;
  suggested_type: z.infer<typeof pendingEntry>['suggested_type'];
  state: 'pending' | 'confirmed' | 'dropped';
  label: EvalCandidateConfirm | null;
  decided_by: string | null;
  created_at: Date;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** 一个确认的候选 → 标注；按标注 schema 校验 */
export function candidateLabel(
  c: Pick<
    CandidateRow,
    | 'candidate_id'
    | 'incident_label'
    | 'incident'
    | 'incident_updated_at'
    | 'run_started_at'
    | 'source'
    | 'source_ref'
    | 'reason_code'
    | 'reason'
    | 'label'
    | 'decided_by'
  >,
  members: ReadonlyArray<{ alertname: string; labels: Record<string, string> }>,
): Label {
  if (!c.label) {
    throw new Error(`评测候选 ${c.candidate_id} 没有确认的标准答案`);
  }
  const inc = c.incident;
  const first = Date.parse(inc.first_firing_at);
  const asOf = c.run_started_at ? c.run_started_at.getTime() : first + STAGE_A_DELAY_MS;
  const end = inc.ended_at ? Date.parse(inc.ended_at) : c.incident_updated_at.getTime();
  const seen = new Set<string>();
  const faultAlerts: Label['fault_alerts'] = [];
  for (const m of members) {
    const labels = Object.fromEntries(
      Object.entries(identityLabels(m.labels)).filter(([k]) => k !== 'alertname'),
    ) as Record<string, string>;
    const k = JSON.stringify([m.alertname, labels]);
    if (!seen.has(k)) {
      seen.add(k);
      faultAlerts.push({ alertname: m.alertname, labels });
    }
  }
  const note = [
    `评测候选 ${c.candidate_id}`,
    `来源 ${c.source}`,
    ...(c.reason_code ? [`原因码 ${c.reason_code}`] : []),
    ...(c.decided_by ? [`${c.decided_by} 确认`] : []),
    ...(c.reason ? [`原因：${c.reason}`] : []),
  ].join('，');
  return labelSchema.parse({
    id: `candidate:${c.candidate_id}`,
    title: c.incident_label,
    type: c.label.type,
    window: { from: iso(first - WINDOW_LEAD_MS), to: iso(Math.max(end, asOf) + WINDOW_TAIL_MS) },
    as_of: iso(asOf),
    fault_alerts: faultAlerts,
    roots: c.label.roots,
    discovery_roots: [],
    revisions: [],
    granularity: null,
    mechanism: c.label.mechanism,
    disposition: c.label.disposition,
    required_members: [],
    required_change_near: null,
    legacy_case: null,
    legacy_roots: [],
    learned_from: [],
    fix: null,
    noise: [],
    evidence: [
      {
        kind: c.source === 'pr_closed' ? 'pr' : c.source === 'issue_not_planned' ? 'issue' : 'state',
        ref:
          c.source === 'pr_closed' || c.source === 'issue_not_planned' ? c.source_ref : `${c.source}:${c.source_ref}`,
        note,
      },
    ],
  });
}

/** 读取 [since, until) 内生成的候选（只读会话），confirmed 的生成标注，pending 的列出；放弃的不导出 */
export async function exportCandidates(
  q: Pick<pg.Client, 'query'>,
  since: Date,
  until: Date,
  now: Date,
): Promise<CandidatesFile> {
  const r = await q.query<CandidateRow>(
    `SELECT c.candidate_id, c.cluster_id, c.incident_id, i.label AS incident_label, i.body AS incident,
            i.updated_at AS incident_updated_at, c.research_run_id, rr.started_at AS run_started_at, c.source,
            c.source_ref, c.reason_code, c.reason, c.suggested_type, c.state, c.label, c.decided_by, c.created_at
       FROM server.eval_candidates c
       JOIN server.incidents i ON i.incident_id = c.incident_id
       LEFT JOIN server.research_runs rr ON rr.run_id = c.research_run_id
      WHERE c.created_at >= $1 AND c.created_at < $2 AND c.state <> 'dropped'
      ORDER BY c.created_at, c.candidate_id`,
    [since, until],
  );
  const out: CandidatesFile = {
    version: 1,
    exported_at: now.toISOString(),
    since: since.toISOString(),
    until: until.toISOString(),
    confirmed: [],
    pending: [],
  };
  for (const c of r.rows) {
    if (c.state === 'pending') {
      out.pending.push({
        candidate_id: c.candidate_id,
        cluster_id: c.cluster_id,
        incident_id: c.incident_id,
        incident_label: c.incident_label,
        source: c.source,
        source_ref: c.source_ref,
        suggested_type: c.suggested_type,
        reason_code: c.reason_code,
        reason: c.reason,
        created_at: c.created_at.toISOString(),
      });
      continue;
    }
    // 拆分时离开本事件的成员属于另一个事件，不算
    const ids = c.incident.members.filter((m) => m.left_version === null).map((m) => m.alert_id);
    const m = await q.query<{ alert_id: string; alertname: string; labels: Record<string, string> }>(
      'SELECT alert_id, alertname, labels FROM server.alert_state WHERE alert_id = ANY($1::text[]) ORDER BY starts_at, alert_id',
      [ids],
    );
    if (!m.rows.length) {
      throw new Error(`评测候选 ${c.candidate_id} 的事件 ${c.incident_label} 没有成员告警，无法生成 fault_alerts`);
    }
    out.confirmed.push({ cluster_id: c.cluster_id, candidate_id: c.candidate_id, label: candidateLabel(c, m.rows) });
  }
  return candidatesFile.parse(out);
}

export function writeCandidates(path: string, f: CandidatesFile): void {
  writeFileSync(path, stringify(f, { lineWidth: 0 }));
}

export function readCandidates(path: string): CandidatesFile {
  return candidatesFile.parse(parse(readFileSync(path, 'utf8')));
}

export interface MergeResult {
  added: string[];
  /** 标注文件里已经有同一 id 的标注，没有改动 */
  existing: string[];
  /** 其他集群的标注，没有合并 */
  otherCluster: string[];
  pending: number;
}

/**
 * 把候选文件中 confirmed 的标注合并进标注文件：只合并集群与标注文件相同的，id 已存在的不改动；合并后按标注 schema
 * 校验全文件（不通过时抛出、不写文件），保留原有的注释与格式
 */
export function mergeCandidates(candidatesPath: string, labelsPath: string): MergeResult {
  const f = readCandidates(candidatesPath);
  const doc = parseDocument(readFileSync(labelsPath, 'utf8'));
  if (doc.errors.length) {
    throw new Error(`标注文件 ${labelsPath} 不是合法的 YAML：${doc.errors.map((e) => e.message).join('；')}`);
  }
  const current = labelFile.parse(doc.toJS());
  const seq = doc.get('labels');
  if (!isSeq(seq)) {
    throw new Error(`标注文件 ${labelsPath} 的 labels 不是列表`);
  }
  const ids = new Set(current.labels.map((l) => l.id));
  const out: MergeResult = { added: [], existing: [], otherCluster: [], pending: f.pending.length };
  for (const c of f.confirmed) {
    if (c.cluster_id !== current.cluster_id) {
      out.otherCluster.push(c.label.id);
      continue;
    }
    if (ids.has(c.label.id)) {
      out.existing.push(c.label.id);
      continue;
    }
    const node = doc.createNode(c.label);
    if (!isMap(node)) {
      throw new Error(`标注 ${c.label.id} 不是对象`);
    }
    seq.add(node);
    ids.add(c.label.id);
    out.added.push(c.label.id);
  }
  labelFile.parse(doc.toJS());
  if (out.added.length) {
    writeFileSync(labelsPath, doc.toString({ lineWidth: 0 }));
  }
  return out;
}
