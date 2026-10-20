import type pg from 'pg';
import { parseStoredKey } from '../topology/keys.js';

/** 阶段 B 输入中的参考案例（与 contract/schemas/eval-snapshot.schema.json 的 ReferenceCase 同形）。 */
export interface ReferenceCase {
  incident_id: string;
  label: string;
  root_component: string;
  mechanism: string | null;
  resolved_at: string;
  source: 'human' | 'model';
}

export const MAX_REFERENCE_CASES = 10;

/**
 * 参考案例（DESIGN §11）：同一集群中已经结束、经人工确认根因的历史事件。
 * - 每个事件取最新一条带根因结论（verdict）的已绑定账号反馈：confirmed 时根因为反馈给出的组件，没有给出时为反馈所评价版本的根因；
 *   rejected 时为反馈给出的真实根因，没有给出（真实根因未知）的不作为参考案例。
 * - 只取根因在本次研判子图中、或与子图节点同一命名空间的事件，按结束时间从新到旧最多 10 个。
 * - 只取 before 之前结束的事件（研判开始之前已解决）。
 */
export async function referenceCases(
  pool: pg.Pool,
  o: {
    clusterId: string;
    incidentId: string;
    keys: ReadonlySet<string>;
    namespaces: ReadonlySet<string>;
    before: Date;
  },
): Promise<ReferenceCase[]> {
  const r = await pool.query<{
    incident_id: string;
    label: string;
    root: string | null;
    mechanism: string | null;
    ended_at: Date;
  }>(
    `SELECT incident_id, label, root, mechanism, ended_at FROM (
       SELECT DISTINCT ON (f.incident_id) f.incident_id, i.label, f.verdict, f.mechanism, i.ended_at,
              CASE WHEN f.verdict = 'confirmed' THEN coalesce(f.root_component, v.body #>> '{root,component}')
                   ELSE f.root_component END AS root
         FROM server.feedback f
         JOIN server.incidents i ON i.incident_id = f.incident_id
         LEFT JOIN server.incident_versions v ON v.incident_id = f.incident_id AND v.version = f.incident_version
        WHERE i.cluster_id = $1 AND i.incident_id <> $2 AND i.state = 'resolved' AND i.ended_at < $3
          AND f.verdict IS NOT NULL AND f.linked
        ORDER BY f.incident_id, f.created_at DESC
     ) latest
     WHERE root IS NOT NULL
     ORDER BY ended_at DESC`,
    [o.clusterId, o.incidentId, o.before],
  );
  const namespaceOf = (key: string) => {
    const p = parseStoredKey(key);
    return p.namespace ?? (p.kind === 'Namespace' ? p.name : null);
  };
  return r.rows
    .filter((x) => {
      const ns = namespaceOf(x.root as string);
      return o.keys.has(x.root as string) || (ns !== null && o.namespaces.has(ns));
    })
    .slice(0, MAX_REFERENCE_CASES)
    .map((x) => ({
      incident_id: x.incident_id,
      label: x.label,
      root_component: x.root as string,
      mechanism: x.mechanism,
      resolved_at: x.ended_at.toISOString(),
      source: 'human',
    }));
}
