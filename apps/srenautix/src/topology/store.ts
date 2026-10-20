import { randomUUID } from 'node:crypto';
import type { TopologyEdge, TopologyEvent, TopologyNode } from '@srenautix/contract';
import canonicalize from 'canonicalize';
import type pg from 'pg';
import type { NodeLookup } from '../alerts/resolve.js';
import { tx, type Queryable } from '../store/pool.js';

const TOMBSTONE_MS = 24 * 3600_000;

export function edgeKey(e: Pick<TopologyEdge, 'from' | 'relation' | 'to'>): string {
  return `${e.from}|${e.relation}|${e.to}`;
}

/** 两个节点或边的内容是否相同（与键的顺序无关）。 */
export function sameContent(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

export interface TopologyChange {
  op: TopologyEvent['op'];
  at: Date;
  source: TopologyEvent['source'];
  node?: TopologyNode;
  edge?: TopologyEdge;
  /** 外部事件（reader 推送）的 event_id；server 自己的 informer 不填，自动生成。 */
  eventId?: string;
}

/**
 * 事件溯源拓扑的存储（DESIGN §4.1）。server 是唯一写入方：单集群时来自内置 informer，多集群时来自各分支 reader 的推送。
 * 同一节点或边的新事件到达时，上一条的 valid_to 设为新事件的 valid_from；删除事件只关闭区间。
 * 内容没有变化的 upsert 不产生新事件。
 */
export class TopologyStore implements NodeLookup {
  constructor(private readonly pool: pg.Pool) {}

  async apply(clusterId: string, changes: readonly TopologyChange[]): Promise<number> {
    if (!changes.length) {
      return 0;
    }
    return tx(this.pool, (c) => this.applyIn(c, clusterId, changes));
  }

  /** 在调用方的事务里应用一批变更（reader 推送时与序号记录写在同一个事务里）；返回实际产生的事件数。 */
  async applyIn(c: Queryable, clusterId: string, changes: readonly TopologyChange[]): Promise<number> {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`srenautix.topology.${clusterId}`]);
    let n = 0;
    for (const ch of changes) {
      if (await this.applyOne(c, clusterId, ch)) {
        n++;
      }
    }
    return n;
  }

  private async applyOne(c: Queryable, clusterId: string, ch: TopologyChange): Promise<boolean> {
    const item = ch.op.startsWith('node') ? 'node' : 'edge';
    const body = item === 'node' ? ch.node : ch.edge;
    if (!body) {
      throw new Error(`拓扑事件 ${ch.op} 缺少 ${item}`);
    }
    const key = item === 'node' ? (body as TopologyNode).key : edgeKey(body as TopologyEdge);
    if (ch.eventId) {
      const dup = await c.query('SELECT 1 FROM server.topology_events WHERE event_id = $1', [ch.eventId]);
      if (dup.rowCount) {
        return false;
      }
    }
    const open = await c.query<{ seq: number; body: unknown; valid_from: Date }>(
      `SELECT seq, body, valid_from FROM server.topology_events
        WHERE cluster_id = $1 AND item = $2 AND key = $3 AND valid_to IS NULL AND op LIKE '%_upsert'
        ORDER BY seq DESC LIMIT 1 FOR UPDATE`,
      [clusterId, item, key],
    );
    const cur = open.rows[0];
    const isUpsert = ch.op.endsWith('_upsert');
    // jsonb 不保留键的顺序，按 JCS 规范化后比较内容
    if (isUpsert && cur && sameContent(cur.body, body)) {
      return false;
    }
    if (!isUpsert && !cur) {
      return false;
    }
    if (cur) {
      const closeAt = ch.at.getTime() < cur.valid_from.getTime() ? cur.valid_from : ch.at;
      await c.query('UPDATE server.topology_events SET valid_to = $2 WHERE seq = $1', [cur.seq, closeAt]);
    }
    const node = item === 'node' ? (body as TopologyNode) : null;
    await c.query(
      `INSERT INTO server.topology_events (event_id, cluster_id, op, item, key, valid_from, valid_to, source, body, kind, namespace, name, uid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        ch.eventId ?? randomUUID(),
        clusterId,
        ch.op,
        item,
        key,
        ch.at,
        isUpsert ? null : ch.at,
        ch.source,
        JSON.stringify(body),
        node?.kind ?? null,
        node?.namespace ?? null,
        node?.name ?? null,
        node?.uid ?? null,
      ],
    );
    return true;
  }

  /** 当前拓扑版本（最大 seq）。 */
  async version(clusterId: string): Promise<number> {
    const r = await this.pool.query<{ v: number | null }>(
      'SELECT max(seq) AS v FROM server.topology_events WHERE cluster_id = $1',
      [clusterId],
    );
    return r.rows[0]?.v ?? 0;
  }

  /** 时刻 t 的全部节点与边；version 不为空时只看 seq ≤ version 的事件（研判引用当时的拓扑版本）。 */
  async at(
    clusterId: string,
    t: Date,
    version: number | null = null,
  ): Promise<{ nodes: TopologyNode[]; edges: TopologyEdge[]; version: number }> {
    const v = version ?? (await this.version(clusterId));
    const r = await this.pool.query<{ item: string; body: TopologyNode | TopologyEdge }>(
      `SELECT item, body FROM server.topology_events
        WHERE cluster_id = $1 AND seq <= $3 AND op LIKE '%_upsert' AND valid_from <= $2
          AND (valid_to IS NULL OR valid_to > $2 OR (valid_to IS NOT NULL AND EXISTS (
            SELECT 1 FROM server.topology_events n2 WHERE n2.cluster_id = $1 AND n2.seq > $3 AND n2.item = server.topology_events.item
              AND n2.key = server.topology_events.key AND n2.valid_from = server.topology_events.valid_to)))
        ORDER BY seq`,
      [clusterId, t, v],
    );
    const nodes: TopologyNode[] = [];
    const edges: TopologyEdge[] = [];
    for (const row of r.rows) {
      if (row.item === 'node') {
        nodes.push(row.body as TopologyNode);
      } else {
        edges.push(row.body as TopologyEdge);
      }
    }
    return { nodes, edges, version: v };
  }

  /** 节点 keys 两跳以内的邻域（边的两个方向）。 */
  async neighborhood(
    clusterId: string,
    keys: readonly string[],
    t: Date,
    hops = 2,
  ): Promise<{ nodes: TopologyNode[]; edges: TopologyEdge[]; version: number }> {
    const all = await this.at(clusterId, t);
    const seen = new Set(keys);
    let frontier = new Set(keys);
    const edges = new Map<string, TopologyEdge>();
    for (let h = 0; h < hops; h++) {
      const next = new Set<string>();
      for (const e of all.edges) {
        if (frontier.has(e.from) || frontier.has(e.to)) {
          edges.set(edgeKey(e), e);
          for (const k of [e.from, e.to]) {
            if (!seen.has(k)) {
              seen.add(k);
              next.add(k);
            }
          }
        }
      }
      frontier = next;
    }
    return { nodes: all.nodes.filter((n) => seen.has(n.key)), edges: [...edges.values()], version: all.version };
  }

  /** 当前节点上由领域包 components.yaml 匹配出的组件类型；节点不存在或没有匹配时为 null。 */
  async componentType(clusterId: string, key: string): Promise<string | null> {
    const r = await this.pool.query<{ t: string | null }>(
      `SELECT body->>'component_type' AS t FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'node' AND key = $2 AND valid_to IS NULL AND op = 'node_upsert'
        ORDER BY seq DESC LIMIT 1`,
      [clusterId, key],
    );
    return r.rows[0]?.t ?? null;
  }

  /** NodeLookup：当前节点，或 24 小时内删除的墓碑。 */
  async find(
    clusterId: string,
    kind: string,
    namespace: string | null,
    name: string,
    at: Date,
  ): Promise<{ key: string; uid: string | null; tombstone: boolean } | null> {
    const r = await this.pool.query<{ key: string; uid: string | null; valid_to: Date | null }>(
      // 告警标签里的 CRD kind 不带 API 组（application），拓扑键带组（Application.argoproj.io）：没有点的 kind 也匹配 <kind>.<组>
      `SELECT key, uid, valid_to FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'node' AND op = 'node_upsert'
          AND (kind = $2 OR (strpos($2, '.') = 0 AND kind LIKE $2 || '.%'))
          AND namespace IS NOT DISTINCT FROM $3 AND name = $4
          AND valid_from <= greatest($5::timestamptz, now())
          AND (valid_to IS NULL OR valid_to > least($5::timestamptz, now()) - make_interval(secs => $6))
        ORDER BY (valid_to IS NULL) DESC, (kind = $2) DESC, valid_from DESC LIMIT 1`,
      [clusterId, kind, namespace, name, at, TOMBSTONE_MS / 1000],
    );
    const row = r.rows[0];
    if (!row) {
      return null;
    }
    const tombstone = row.valid_to !== null && row.valid_to.getTime() <= at.getTime();
    return { key: row.key, uid: row.uid, tombstone };
  }

  /** 当前打开的全部节点 key（informer 全量对账时用来找出已删除的对象）。 */
  async openKeys(
    clusterId: string,
    item: 'node' | 'edge',
    source: TopologyEvent['source'],
    c: Queryable = this.pool,
  ): Promise<Map<string, TopologyNode | TopologyEdge>> {
    const r = await c.query<{ key: string; body: TopologyNode | TopologyEdge }>(
      `SELECT key, body FROM server.topology_events
        WHERE cluster_id = $1 AND item = $2 AND source = $3 AND valid_to IS NULL AND op LIKE '%_upsert'`,
      [clusterId, item, source],
    );
    return new Map(r.rows.map((x) => [x.key, x.body]));
  }
}
