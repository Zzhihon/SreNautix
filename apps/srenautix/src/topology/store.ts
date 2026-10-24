import { randomUUID } from 'node:crypto';
import type { TopologyEdge, TopologyEvent, TopologyNode } from '@srenautix/contract';
import canonicalize from 'canonicalize';
import type pg from 'pg';
import type { NodeLookup } from '../alerts/resolve.js';
import { tx, type Queryable } from '../store/pool.js';

const TOMBSTONE_MS = 24 * 3600_000;

/**
 * 时间点查询的缓存（ADR 0144）：同一个 (集群, 版本, 时刻) 的结果不会再变，过期时间只为限制内存。
 * 整张拓扑只留几份；子图很小，通知与事件 issue 每一轮为同一批事件版本重复取，留得多一些、久一些。
 */
const AT_CACHE_TTL_MS = 30_000;
const AT_CACHE_MAX = 4;
const SUBGRAPH_CACHE_TTL_MS = 10 * 60_000;
const SUBGRAPH_CACHE_MAX = 512;
/** 每个进程同时执行的时间点查询不超过这个数，其余排队 */
const POINT_IN_TIME_CONCURRENCY = 2;
/** 压缩每批删除的行数 */
const COMPACT_BATCH = 5000;

/** 拓扑查询的耗时观测（srenautix_topology_query_seconds）：source 为 db、cache（命中缓存）或 shared（并入进行中的同一查询） */
export type TopologyQueryObserver = (
  query: 'at' | 'subgraph' | 'neighborhood',
  source: 'db' | 'cache' | 'shared',
  seconds: number,
) => void;

export interface TopologySnapshot {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  version: number;
}

export interface TopologySubgraph {
  version: number;
  /** 每个键的跳数，按发现顺序 */
  hops: Map<string, number>;
  /** 子图里存在的节点，按 seq 排序 */
  nodes: TopologyNode[];
  /** 两端都在子图里的边，按 seq 排序 */
  edges: TopologyEdge[];
}

/** 结果缓存加并发合并：同一个键正在查询时等它的结果，不再发起一次 */
class Memo<T> {
  private readonly cache = new Map<string, { expires: number; value: T }>();
  private readonly inflight = new Map<string, Promise<T>>();
  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  /** stale：存入新结果时一并删除的旧键（同一集群旧版本的"当前"拓扑） */
  async get(
    key: string,
    load: () => Promise<T>,
    stale: (k: string) => boolean = () => false,
  ): Promise<{ value: T; source: 'db' | 'cache' | 'shared' }> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) {
      return { value: hit.value, source: 'cache' };
    }
    const running = this.inflight.get(key);
    if (running) {
      return { value: await running, source: 'shared' };
    }
    const p = load();
    this.inflight.set(key, p);
    try {
      const value = await p;
      for (const [k, e] of this.cache) {
        if (e.expires <= now || stale(k)) {
          this.cache.delete(k);
        }
      }
      this.cache.set(key, { expires: Date.now() + this.ttlMs, value });
      while (this.cache.size > this.max) {
        this.cache.delete(this.cache.keys().next().value as string);
      }
      return { value, source: 'db' };
    } finally {
      this.inflight.delete(key);
    }
  }
}

/** 某个版本、某个时刻存在的行：seq ≤ v、valid_from ≤ t，并且在 t 之后才关闭或在版本 v 之后才被关闭（closed_seq > v） */
const LIVE = (t: string, v: string, alias = '') =>
  `${alias}seq <= ${v} AND ${alias}valid_from <= ${t}
   AND (${alias}valid_to IS NULL OR ${alias}valid_to > ${t} OR ${alias}closed_seq > ${v})`;

/** 计数信号量：时间点拓扑查询排队执行，并发的查询不叠加在数据库上 */
class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((res) => this.waiting.push(res));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

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
  private readonly atMemo = new Memo<TopologySnapshot>(AT_CACHE_TTL_MS, AT_CACHE_MAX);
  private readonly subgraphMemo = new Memo<TopologySubgraph>(SUBGRAPH_CACHE_TTL_MS, SUBGRAPH_CACHE_MAX);
  private readonly limiter = new Limiter(POINT_IN_TIME_CONCURRENCY);

  constructor(
    private readonly pool: pg.Pool,
    private readonly observe: TopologyQueryObserver = () => undefined,
  ) {}

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
    // op 写成 IN 才能用上部分索引 topology_open_idx（LIKE 推不出索引条件，每条变更都会扫全表，ADR 0144）
    const open = await c.query<{ seq: number; body: unknown; valid_from: Date }>(
      `SELECT seq, body, valid_from FROM server.topology_events
        WHERE cluster_id = $1 AND item = $2 AND key = $3 AND valid_to IS NULL AND op IN ('node_upsert', 'edge_upsert')
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
    const node = item === 'node' ? (body as TopologyNode) : null;
    const ins = await c.query<{ seq: number }>(
      `INSERT INTO server.topology_events (event_id, cluster_id, op, item, key, valid_from, valid_to, source, body, kind, namespace, name, uid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING seq`,
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
    if (cur) {
      // 关闭上一条，并记下关闭它的事件（时间点查询按 closed_seq 判断它在某个版本里是否仍然打开）
      const closeAt = ch.at.getTime() < cur.valid_from.getTime() ? cur.valid_from : ch.at;
      await c.query('UPDATE server.topology_events SET valid_to = $2, closed_seq = $3 WHERE seq = $1', [
        cur.seq,
        closeAt,
        (ins.rows[0] as { seq: number }).seq,
      ]);
    }
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

  /** 当前版本与最后一条事件的时刻（不早于它的时刻看到的都是当前打开的行，ADR 0144）。 */
  private async head(clusterId: string): Promise<{ version: number; at: number | null }> {
    const r = await this.pool.query<{ v: number | null; from: Date | null; to: Date | null }>(
      `SELECT (SELECT max(seq) FROM server.topology_events WHERE cluster_id = $1) AS v,
              (SELECT max(valid_from) FROM server.topology_events WHERE cluster_id = $1) AS from,
              (SELECT max(valid_to) FROM server.topology_events WHERE cluster_id = $1 AND valid_to IS NOT NULL) AS to`,
      [clusterId],
    );
    const row = r.rows[0];
    const times = [row?.from, row?.to].filter((x): x is Date => x instanceof Date).map((x) => x.getTime());
    return { version: row?.v ?? 0, at: times.length ? Math.max(...times) : null };
  }

  /**
   * 时刻 t 的全部节点与边；version 不为空时只看 seq ≤ version 的事件（研判引用当时的拓扑版本）。
   * 同一个 (集群, 版本, 时刻) 的并发查询合并为一次，结果短期缓存；不早于最后一条事件的时刻都按"当前"缓存（ADR 0144）。
   */
  async at(clusterId: string, t: Date, version: number | null = null): Promise<TopologySnapshot> {
    const start = performance.now();
    const h = await this.head(clusterId);
    const v = version ?? h.version;
    const current = v >= h.version && (h.at === null || t.getTime() >= h.at);
    const key = `${clusterId}|${v}|${current ? 'head' : t.getTime()}`;
    const { value, source } = await this.atMemo.get(
      key,
      () => this.limiter.run(() => this.atFromDb(clusterId, t, v)),
      (k) => current && k.startsWith(`${clusterId}|`) && k.endsWith('|head'),
    );
    this.observe('at', source, (performance.now() - start) / 1000);
    // 调用方拿到自己的数组，缓存里的不受影响
    return { nodes: [...value.nodes], edges: [...value.edges], version: v };
  }

  /**
   * 三个互不重叠的部分，各走自己的索引，耗时与当时存在的行数加 t 之后关闭的行数成正比，与历史总量无关：
   * 仍然打开的（topology_open_idx）、t 之后才关闭的（topology_closed_idx）、t 之前关闭但关闭它的事件在版本 v 之后的（topology_closed_seq_idx）。
   */
  private async atFromDb(clusterId: string, t: Date, v: number): Promise<TopologySnapshot> {
    const r = await this.pool.query<{ item: string; body: TopologyNode | TopologyEdge }>(
      `SELECT item, body FROM (
         SELECT seq, item, body FROM server.topology_events
          WHERE cluster_id = $1 AND valid_to IS NULL AND op IN ('node_upsert', 'edge_upsert') AND seq <= $3 AND valid_from <= $2
         UNION ALL
         SELECT seq, item, body FROM server.topology_events
          WHERE cluster_id = $1 AND valid_to IS NOT NULL AND valid_to > $2 AND op IN ('node_upsert', 'edge_upsert')
            AND seq <= $3 AND valid_from <= $2
         UNION ALL
         SELECT seq, item, body FROM server.topology_events
          WHERE cluster_id = $1 AND closed_seq > $3 AND valid_to <= $2 AND op IN ('node_upsert', 'edge_upsert')
            AND seq <= $3 AND valid_from <= $2
       ) x ORDER BY seq`,
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

  /** 版本 v、时刻 t 时与 keys 中任一节点相连的边（两个方向），按 seq 排序。 */
  private async edgesTouching(clusterId: string, keys: readonly string[], t: Date, v: number): Promise<TopologyEdge[]> {
    if (!keys.length) {
      return [];
    }
    const r = await this.pool.query<{ body: TopologyEdge }>(
      `SELECT body FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'edge' AND op = 'edge_upsert' AND (body->>'from' = ANY($4::text[]) OR body->>'to' = ANY($4::text[]))
          AND ${LIVE('$2', '$3')}
        ORDER BY seq`,
      [clusterId, t, v, keys],
    );
    return r.rows.map((x) => x.body);
  }

  /** 版本 v、时刻 t 时两端都在 keys 中的边，按 seq 排序。 */
  private async edgesWithin(clusterId: string, keys: readonly string[], t: Date, v: number): Promise<TopologyEdge[]> {
    if (!keys.length) {
      return [];
    }
    const r = await this.pool.query<{ body: TopologyEdge }>(
      `SELECT body FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'edge' AND op = 'edge_upsert' AND body->>'from' = ANY($4::text[]) AND body->>'to' = ANY($4::text[])
          AND ${LIVE('$2', '$3')}
        ORDER BY seq`,
      [clusterId, t, v, keys],
    );
    return r.rows.map((x) => x.body);
  }

  /** 版本 v、时刻 t 时 keys 中存在的节点，按 seq 排序。 */
  private async nodesOf(clusterId: string, keys: readonly string[], t: Date, v: number): Promise<TopologyNode[]> {
    if (!keys.length) {
      return [];
    }
    const r = await this.pool.query<{ body: TopologyNode }>(
      `SELECT body FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'node' AND op = 'node_upsert' AND key = ANY($4::text[]) AND ${LIVE('$2', '$3')}
        ORDER BY seq`,
      [clusterId, t, v, keys],
    );
    return r.rows.map((x) => x.body);
  }

  /**
   * 从 seeds 出发不超过 hops 跳（边的两个方向）的子图，与在 at(t, version) 的整张拓扑上逐跳展开的结果相同（ADR 0144）：
   * hops 为每个键的跳数（按发现顺序），edges 为两端都在子图里的边，nodes 为子图里存在的节点；都按 seq 排序。
   * 每一跳只取与上一跳相连的边，不取整张拓扑。
   */
  async subgraph(
    clusterId: string,
    seeds: readonly string[],
    t: Date,
    version: number | null,
    hops: number,
  ): Promise<TopologySubgraph> {
    const start = performance.now();
    const v = version ?? (await this.head(clusterId)).version;
    const key = JSON.stringify([clusterId, v, t.getTime(), hops, seeds]);
    const { value, source } = await this.subgraphMemo.get(key, () =>
      this.limiter.run(async () => ({ version: v, ...(await this.expand(clusterId, seeds, t, v, hops)) })),
    );
    this.observe('subgraph', source, (performance.now() - start) / 1000);
    return { version: v, hops: new Map(value.hops), nodes: [...value.nodes], edges: [...value.edges] };
  }

  private async expand(
    clusterId: string,
    seeds: readonly string[],
    t: Date,
    v: number,
    hops: number,
  ): Promise<{ hops: Map<string, number>; nodes: TopologyNode[]; edges: TopologyEdge[] }> {
    const dist = new Map<string, number>(seeds.map((s) => [s, 0]));
    let frontier = [...new Set(seeds)];
    for (let h = 1; h <= hops && frontier.length; h++) {
      const inFrontier = new Set(frontier);
      const next: string[] = [];
      for (const e of await this.edgesTouching(clusterId, frontier, t, v)) {
        for (const [a, b] of [
          [e.from, e.to],
          [e.to, e.from],
        ] as const) {
          if (inFrontier.has(a) && !dist.has(b)) {
            dist.set(b, h);
            next.push(b);
          }
        }
      }
      frontier = next;
    }
    const keys = [...dist.keys()];
    const nodes = await this.nodesOf(clusterId, keys, t, v);
    const edges = await this.edgesWithin(clusterId, keys, t, v);
    return { hops: dist, nodes, edges };
  }

  /** 节点 keys 两跳以内的邻域（边的两个方向）：每一跳经过的边与到达的节点，取当前版本。 */
  async neighborhood(
    clusterId: string,
    keys: readonly string[],
    t: Date,
    hops = 2,
  ): Promise<{ nodes: TopologyNode[]; edges: TopologyEdge[]; version: number }> {
    const start = performance.now();
    const out = await this.limiter.run(async () => {
      const v = (await this.head(clusterId)).version;
      const seen = new Set(keys);
      let frontier = new Set(keys);
      const edges = new Map<string, TopologyEdge>();
      for (let h = 0; h < hops && frontier.size; h++) {
        const next = new Set<string>();
        for (const e of await this.edgesTouching(clusterId, [...frontier], t, v)) {
          edges.set(edgeKey(e), e);
          for (const k of [e.from, e.to]) {
            if (!seen.has(k)) {
              seen.add(k);
              next.add(k);
            }
          }
        }
        frontier = next;
      }
      const nodes = await this.nodesOf(clusterId, [...seen], t, v);
      return { nodes, edges: [...edges.values()], version: v };
    });
    this.observe('neighborhood', 'db', (performance.now() - start) / 1000);
    return out;
  }

  /**
   * 压缩（ADR 0144）：删除在 retentionMs 之前已经关闭的行（被新内容替换或删除的状态，以及删除事件本身）。
   * 保留期内任一时刻的拓扑与压缩前相同；更早时刻只剩下保留期开始时仍然存在的对象。
   * 先补齐旧版本二进制关闭、没有记 closed_seq 的行。返回补齐与删除的行数。
   */
  async compact(retentionMs: number): Promise<{ backfilled: number; deleted: number }> {
    const fill = await this.pool.query(
      `UPDATE server.topology_events t SET closed_seq = (
         SELECT min(n.seq) FROM server.topology_events n
          WHERE n.cluster_id = t.cluster_id AND n.item = t.item AND n.key = t.key AND n.seq > t.seq)
        WHERE t.closed_seq IS NULL AND t.valid_to IS NOT NULL AND t.op IN ('node_upsert', 'edge_upsert')`,
    );
    const clusters = await this.pool.query<{ id: string }>(
      `WITH RECURSIVE c(id) AS (
         (SELECT cluster_id FROM server.topology_events ORDER BY cluster_id LIMIT 1)
         UNION ALL
         SELECT (SELECT cluster_id FROM server.topology_events WHERE cluster_id > c.id ORDER BY cluster_id LIMIT 1) FROM c WHERE c.id IS NOT NULL
       ) SELECT id FROM c WHERE id IS NOT NULL`,
    );
    let deleted = 0;
    for (const { id } of clusters.rows) {
      for (;;) {
        const r = await this.pool.query(
          `DELETE FROM server.topology_events WHERE seq IN (
             SELECT seq FROM server.topology_events
              WHERE cluster_id = $1 AND valid_to IS NOT NULL AND valid_to < now() - make_interval(secs => $2)
              LIMIT $3)`,
          [id, retentionMs / 1000, COMPACT_BATCH],
        );
        deleted += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) < COMPACT_BATCH) {
          break;
        }
      }
    }
    return { backfilled: fill.rowCount ?? 0, deleted };
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
  ): Promise<{ key: string; uid: string | null; tombstone: boolean; owner: string | null } | null> {
    const r = await this.pool.query<{
      key: string;
      uid: string | null;
      valid_to: Date | null;
      namespace: string | null;
    }>(
      // 告警标签里的 CRD kind 不带 API 组、大小写也不一定（application、cluster），拓扑键带组（Application.argoproj.io、
      // Cluster.postgresql.cnpg.io）：不区分大小写，没有点的 kind 也匹配 <kind>.<组>。
      // 告警没有命名空间时（聚合掉了 namespace 的规则）也接受按名称唯一的命名空间级对象
      `SELECT key, uid, valid_to, namespace FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'node' AND op = 'node_upsert' AND name = $4
          AND (lower(kind) = lower($2) OR (strpos($2, '.') = 0 AND lower(kind) LIKE lower($2) || '.%'))
          AND (namespace IS NOT DISTINCT FROM $3 OR $3::text IS NULL)
          AND valid_from <= greatest($5::timestamptz, now())
          AND (valid_to IS NULL OR valid_to > least($5::timestamptz, now()) - make_interval(secs => $6))
        ORDER BY (namespace IS NOT DISTINCT FROM $3) DESC, (valid_to IS NULL) DESC, (kind = $2) DESC, valid_from DESC
        LIMIT 20`,
      [clusterId, kind, namespace, name, at, TOMBSTONE_MS / 1000],
    );
    let row = r.rows[0];
    if (row && namespace === null && row.namespace !== null) {
      // 只按名称找到的命名空间级对象：不同命名空间里有同名对象时无法确定，不解析
      const keys = new Set(r.rows.filter((x) => x.namespace !== null).map((x) => x.key));
      row = keys.size === 1 ? row : undefined;
    }
    if (!row) {
      return null;
    }
    const tombstone = row.valid_to !== null && row.valid_to.getTime() <= at.getTime();
    return { key: row.key, uid: row.uid, tombstone, owner: await this.ownerOf(clusterId, row.key, at) };
  }

  /**
   * 对象沿 owned_by 取到的顶层属主（与 TopologyGraph.componentOf 相同，Pod → ReplicaSet → Deployment）；
   * 边按与 find 相同的时间范围取（含 24 小时内删除的），没有属主时为 null。
   */
  async ownerOf(clusterId: string, key: string, at: Date): Promise<string | null> {
    const r = await this.pool.query<{ k: string; depth: number }>(
      `WITH RECURSIVE up(k, depth) AS (
         SELECT $2::text, 0
         UNION ALL
         SELECT nx.t, up.depth + 1 FROM up CROSS JOIN LATERAL (
           SELECT body->>'to' AS t FROM server.topology_events
            WHERE cluster_id = $1 AND item = 'edge' AND body->>'from' = up.k AND op = 'edge_upsert'
              AND body->>'relation' = 'owned_by'
              AND valid_from <= greatest($3::timestamptz, now())
              AND (valid_to IS NULL OR valid_to > least($3::timestamptz, now()) - make_interval(secs => $4))
            ORDER BY (valid_to IS NULL) DESC, valid_from DESC LIMIT 1) nx
         WHERE up.depth < 8 AND nx.t <> $2::text
       )
       SELECT k, depth FROM up ORDER BY depth DESC LIMIT 1`,
      [clusterId, key, at, TOMBSTONE_MS / 1000],
    );
    const top = r.rows[0];
    return top && top.depth > 0 ? top.k : null;
  }

  /**
   * 按名称找节点：kind 在 kinds 中（不区分大小写），namespace 为 null 时不限命名空间；时间范围与 find 相同。
   * 同一个键只出现一次，当前存在的在前，再按键排序。
   */
  async named(
    clusterId: string,
    kinds: readonly string[],
    namespace: string | null,
    name: string,
    at: Date,
  ): Promise<Array<{ key: string; kind: string; namespace: string | null; uid: string | null }>> {
    const r = await this.pool.query<{ key: string; kind: string; namespace: string | null; uid: string | null }>(
      `SELECT DISTINCT ON (key) key, kind, namespace, uid FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'node' AND op = 'node_upsert' AND name = $4
          AND lower(kind) = ANY($2::text[]) AND ($3::text IS NULL OR namespace = $3)
          AND valid_from <= greatest($5::timestamptz, now())
          AND (valid_to IS NULL OR valid_to > least($5::timestamptz, now()) - make_interval(secs => $6))
        ORDER BY key, (valid_to IS NULL) DESC, valid_from DESC`,
      [clusterId, kinds.map((k) => k.toLowerCase()), namespace, name, at, TOMBSTONE_MS / 1000],
    );
    return r.rows;
  }

  /** 从 key 出发、关系为 relation 的边指向的节点键（时间范围与 find 相同），按键排序。 */
  async targets(clusterId: string, key: string, relation: string, at: Date): Promise<string[]> {
    const r = await this.pool.query<{ t: string }>(
      `SELECT DISTINCT body->>'to' AS t FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'edge' AND op = 'edge_upsert' AND body->>'from' = $2 AND body->>'relation' = $3
          AND valid_from <= greatest($4::timestamptz, now())
          AND (valid_to IS NULL OR valid_to > least($4::timestamptz, now()) - make_interval(secs => $5))
        ORDER BY t`,
      [clusterId, key, relation, at, TOMBSTONE_MS / 1000],
    );
    return r.rows.map((x) => x.t);
  }

  /** 节点的 uid（时间范围与 find 相同）；节点不存在时为 undefined。 */
  async uidOf(clusterId: string, key: string, at: Date): Promise<string | null | undefined> {
    const r = await this.pool.query<{ uid: string | null }>(
      `SELECT uid FROM server.topology_events
        WHERE cluster_id = $1 AND item = 'node' AND op = 'node_upsert' AND key = $2
          AND valid_from <= greatest($3::timestamptz, now())
          AND (valid_to IS NULL OR valid_to > least($3::timestamptz, now()) - make_interval(secs => $4))
        ORDER BY (valid_to IS NULL) DESC, valid_from DESC LIMIT 1`,
      [clusterId, key, at, TOMBSTONE_MS / 1000],
    );
    return r.rows.length ? (r.rows[0]!.uid ?? null) : undefined;
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
        WHERE cluster_id = $1 AND item = $2 AND source = $3 AND valid_to IS NULL AND op IN ('node_upsert', 'edge_upsert')`,
      [clusterId, item, source],
    );
    return new Map(r.rows.map((x) => [x.key, x.body]));
  }
}
