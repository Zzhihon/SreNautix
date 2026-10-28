import {
  reasonEntry,
  type ReasonCodeOf,
  type ReasonLevel,
  type ReasonStage,
  type RuleConclusion,
} from '@srenautix/contract';
import type { ServerMetrics } from '../metrics.js';
import type { Queryable } from '../store/pool.js';

// 终态记录（ADR 0172）：server.incident_reasons 保存没有别的表承载的终态，每条带登记表里的原因码。
// 研判（server.research_runs、research_queue）与自愈 PR（server.remediation_attempts）的终态在各自的表里，
// 写入处同样经 ServerMetrics.terminal 计数。

/** 一条终态记录；stage 与 code 按登记表成对检查 */
export type ReasonRecord = {
  [S in ReasonStage]: {
    incidentId: string;
    incidentVersion?: number | null;
    stage: S;
    code: ReasonCodeOf<S>;
    /** 说明（错误摘要、抑制原因等），最多 1000 字 */
    detail?: string | null;
    /** 关联对象（渠道与渠道目标、run_id 等） */
    ref?: string | null;
    /** 不为空时同一事件、同一阶段、同一原因码、同一 once 只写一次 */
    once?: string | null;
    at?: Date;
  };
}[ReasonStage];

/** 在调用方的连接（可以是事务）里写入；返回是否写入（once 重复时为 false）。事务提交后由调用方计数 */
export async function writeReason(c: Queryable, r: ReasonRecord): Promise<boolean> {
  const q = await c.query(
    `INSERT INTO server.incident_reasons (incident_id, incident_version, stage, code, detail, ref, once_key, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
     ON CONFLICT (incident_id, stage, code, once_key) WHERE once_key IS NOT NULL DO NOTHING`,
    [
      r.incidentId,
      r.incidentVersion ?? null,
      r.stage,
      r.code,
      r.detail === undefined || r.detail === null ? null : r.detail.slice(0, 1000),
      r.ref ?? null,
      r.once ?? null,
      r.at ?? null,
    ],
  );
  return (q.rowCount ?? 0) > 0;
}

/**
 * 事件版本没有阶段 B 结论（研判失败、只出阶段 A、入队跳过或不进入阶段 B）时的“只有规则判定”（ADR 0178）：这个版本的
 * 阶段 A 报告有规则结论时写一条 research/rule_only（同一版本一次），说明列出规则与根因候选。返回是否写入；
 * 写入方在提交后计数
 */
export async function writeRuleOnly(c: Queryable, incidentId: string, version: number): Promise<boolean> {
  const r = await c.query<{ rules: RuleConclusion[] | null }>(
    `SELECT body->'rule_conclusions' AS rules FROM server.stage_a_reports WHERE incident_id = $1 AND incident_version = $2`,
    [incidentId, version],
  );
  const rules = r.rows[0]?.rules ?? [];
  if (!rules.length) {
    return false;
  }
  return writeReason(c, {
    incidentId,
    incidentVersion: version,
    stage: 'research',
    code: 'rule_only',
    detail: rules.map((x) => `${x.rule_id} → ${x.root_component}`).join('；'),
    once: `v${version}`,
  });
}

/** 写入（自己的语句）并在写入时计数 */
export async function recordReason(
  c: Queryable,
  metrics: Pick<ServerMetrics, 'terminal'>,
  r: ReasonRecord,
): Promise<boolean> {
  const written = await writeReason(c, r);
  if (written) {
    countReasons(metrics, [r]);
  }
  return written;
}

/** 已提交的记录计数 */
export function countReasons(metrics: Pick<ServerMetrics, 'terminal'>, rs: readonly ReasonRecord[]): void {
  for (const r of rs) {
    metrics.terminal(r.stage, r.code);
  }
}

export interface StoredReason {
  id: number;
  incidentVersion: number | null;
  stage: ReasonStage;
  code: string;
  level: ReasonLevel;
  detail: string | null;
  ref: string | null;
  at: Date;
}

/** 一个事件的全部终态记录，按时间；原因码不在登记表中时抛出 */
export async function reasonsOf(c: Queryable, incidentId: string): Promise<StoredReason[]> {
  const r = await c.query<{
    id: string;
    incident_version: number | null;
    stage: ReasonStage;
    code: string;
    detail: string | null;
    ref: string | null;
    at: Date;
  }>(
    'SELECT id, incident_version, stage, code, detail, ref, at FROM server.incident_reasons WHERE incident_id = $1 ORDER BY at, id',
    [incidentId],
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    incidentVersion: x.incident_version,
    stage: x.stage,
    code: x.code,
    level: reasonEntry(x.stage, x.code).level,
    detail: x.detail,
    ref: x.ref,
    at: x.at,
  }));
}
