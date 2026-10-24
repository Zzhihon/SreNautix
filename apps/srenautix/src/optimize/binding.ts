import type { Proposal } from '@srenautix/contract';
import type pg from 'pg';
import { currentBinding, type CurrentBinding } from '../incident/read.js';
import type { Queryable } from '../store/pool.js';
import { OPEN_GOAL_STATES } from './store.js';

// 提议的绑定对象扩展为事件或目标（ADR 0146 §8，契约 Subject）。主体为 goal 时沿用的绑定字段语义为：
// incident_id 取目标 id，incident_version 取目标的 revision，root_component 取发现挂到的组件，evidence_fingerprint 取
// 发现的证据指纹。目标结束（达成、取消、到期、失败）、规格修改或发现的证据变化之后，提议即过时。
// 审批断言 v1 与 gateway 的绑定核对不变。

/** 仍然有效的发现状态：这些状态的发现可以作为提议的依据 */
const LIVE_FINDINGS = ['open', 'recommended', 'accepted', 'verifying'];

export async function goalBinding(
  db: pg.Pool | Queryable,
  goalId: string,
  rootComponent: string,
): Promise<CurrentBinding | null> {
  const g = await db.query<{ cluster_id: string; revision: number; state: string }>(
    'SELECT cluster_id, revision, state FROM server.goals WHERE goal_id = $1',
    [goalId],
  );
  const row = g.rows[0];
  if (!row) {
    return null;
  }
  const f = await db.query<{ fp: string | null }>(
    `SELECT body->>'evidence_fingerprint' AS fp FROM server.optimization_findings
      WHERE body->>'last_goal_id' = $1 AND component = $2 AND status = ANY($3)`,
    [goalId, rootComponent, LIVE_FINDINGS],
  );
  const fps = f.rows.map((x) => x.fp).filter((x): x is string => x !== null);
  return {
    incidentId: goalId,
    clusterId: row.cluster_id,
    version: row.revision,
    rootComponent: fps.length ? rootComponent : null,
    fingerprints: new Set(fps),
    // 结束的目标与已合并的事件同样不能再绑定提议
    state: OPEN_GOAL_STATES.includes(row.state as never) ? 'firing' : 'merged',
  };
}

/** 提议的当前绑定：主体为目标时按目标与发现，否则按事件 */
export async function subjectBinding(
  db: pg.Pool | Queryable,
  p: Pick<Proposal, 'incident_id' | 'binding'> & { subject?: { type: 'incident' | 'goal'; id: string } },
): Promise<CurrentBinding | null> {
  if (p.subject?.type === 'goal') {
    return goalBinding(db, p.subject.id, p.binding.root_component);
  }
  return currentBinding(db, p.incident_id);
}
