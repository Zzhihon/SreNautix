import type pg from 'pg';
import type { TargetInfo, TargetResolver } from '../proposals/service.js';

/** 提议目标的机器推导：在当前拓扑中按 kind/namespace/name 找节点的 UID，并判断是否由控制器管理（有 owned_by 边）。 */
export class TopologyTargets implements TargetResolver {
  constructor(private readonly pool: pg.Pool) {}

  async resolve(clusterId: string, kind: string, namespace: string | null, name: string): Promise<TargetInfo> {
    const r = await this.pool.query<{ key: string; uid: string | null }>(
      `SELECT key, uid FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'node' AND op = 'node_upsert' AND valid_to IS NULL
          AND kind = $2 AND namespace IS NOT DISTINCT FROM $3 AND name = $4
        ORDER BY seq DESC LIMIT 1`,
      [clusterId, kind, namespace, name],
    );
    const node = r.rows[0];
    if (!node) {
      return { uid: null, controllerManaged: false };
    }
    const owned = await this.pool.query(
      `SELECT 1 FROM server.topology_events WHERE cluster_id = $1 AND item = 'edge' AND op = 'edge_upsert' AND valid_to IS NULL
         AND body->>'from' = $2 AND body->>'relation' = 'owned_by' LIMIT 1`,
      [clusterId, node.key],
    );
    return { uid: node.uid, controllerManaged: (owned.rowCount ?? 0) > 0 };
  }
}
