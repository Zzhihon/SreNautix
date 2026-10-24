import type { TopologyEdge, TopologyNode } from '@srenautix/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateExpand } from '../../src/store/migrate.js';
import { createPool, isStatementTimeout } from '../../src/store/pool.js';
import { storeTrack } from '../../src/store/migrations.js';
import { topologyTrack } from '../../src/topology/migrations.js';
import { edgeKey, TopologyStore, type TopologyChange } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 时间点拓扑查询（ADR 0144）：closed_seq、按索引分三部分取、子图逐跳、缓存与并发合并、压缩、语句超时计数

let db: TestDb;
const T0 = Date.parse('2026-10-20T00:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);

const node = (kind: string, name: string, extra: Partial<TopologyNode> = {}): TopologyNode => ({
  key: `${kind}:shop/${name}`,
  kind,
  namespace: 'shop',
  name,
  uid: `uid-${name}`,
  labels: {},
  component_type: null,
  hub: false,
  ...extra,
});
const edge = (from: string, relation: string, to: string, confidence = 1): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: 'structural',
  confidence,
  scope: 'instance',
  evidence: 'test',
});

/** 旧实现（ADR 0144 之前）：在整张拓扑上逐行判断，关闭它的事件在版本之后时仍算打开；用来对照新实现 */
async function oldAt(clusterId: string, t: Date, v: number) {
  const r = await db.admin.query<{ item: string; body: TopologyNode | TopologyEdge }>(
    `SELECT item, body FROM server.topology_events
      WHERE cluster_id = $1 AND seq <= $3 AND op LIKE '%_upsert' AND valid_from <= $2
        AND (valid_to IS NULL OR valid_to > $2 OR (valid_to IS NOT NULL AND EXISTS (
          SELECT 1 FROM server.topology_events n2 WHERE n2.cluster_id = $1 AND n2.seq > $3 AND n2.item = server.topology_events.item
            AND n2.key = server.topology_events.key AND n2.valid_from = server.topology_events.valid_to)))
      ORDER BY seq`,
    [clusterId, t, v],
  );
  return {
    nodes: r.rows.filter((x) => x.item === 'node').map((x) => x.body as TopologyNode),
    edges: r.rows.filter((x) => x.item === 'edge').map((x) => x.body as TopologyEdge),
  };
}

/** 在整张拓扑上逐跳展开（subgraphOf 原来的做法） */
function bfs(edges: TopologyEdge[], seeds: string[], hops: number) {
  const dist = new Map<string, number>(seeds.map((s) => [s, 0]));
  let frontier = [...seeds];
  for (let h = 1; h <= hops; h++) {
    const next: string[] = [];
    for (const e of edges) {
      for (const [a, b] of [
        [e.from, e.to],
        [e.to, e.from],
      ] as const) {
        if (frontier.includes(a) && !dist.has(b)) {
          dist.set(b, h);
          next.push(b);
        }
      }
    }
    frontier = next;
  }
  return { dist, edges: edges.filter((e) => dist.has(e.from) && dist.has(e.to)) };
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, topologyTrack]);
});

afterAll(async () => {
  await db?.close();
});

describe('时间点拓扑', () => {
  // 一段随机历史：Pod 反复替换、边的内容变化、删除；在每个 (时刻, 版本) 上新旧实现的结果逐项相同（含顺序）
  it('任意时刻与版本的结果与旧实现相同，子图与在整张拓扑上逐跳展开相同', async () => {
    const store = new TopologyStore(db.server);
    const C = 'pit';
    let seed = 7;
    const rand = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const base: TopologyChange[] = [
      { op: 'node_upsert', at: at(0), source: 'informer', node: node('Deployment', 'api') },
      { op: 'node_upsert', at: at(0), source: 'informer', node: node('Service', 'api') },
      {
        op: 'node_upsert',
        at: at(0),
        source: 'informer',
        node: node('Node', 'n1', { namespace: null, key: 'Node:n1' }),
      },
      {
        op: 'node_upsert',
        at: at(0),
        source: 'informer',
        node: node('Node', 'n2', { namespace: null, key: 'Node:n2' }),
      },
    ];
    await store.apply(C, base);
    const pods: string[] = [];
    const versions: number[] = [await store.version(C)];
    for (let i = 1; i <= 120; i++) {
      const t = at(i);
      const changes: TopologyChange[] = [];
      if (pods.length > 3 || (pods.length && rand() < 0.3)) {
        const gone = pods.splice(Math.floor(rand() * pods.length), 1)[0] as string;
        changes.push(
          { op: 'edge_delete', at: t, source: 'informer', edge: edge(gone, 'owned_by', 'Deployment:shop/api') },
          { op: 'node_delete', at: t, source: 'informer', node: node('Pod', gone.split('/')[1] as string) },
        );
      }
      const name = `api-${i}`;
      const key = `Pod:shop/${name}`;
      pods.push(key);
      changes.push(
        { op: 'node_upsert', at: t, source: 'informer', node: node('Pod', name) },
        { op: 'edge_upsert', at: t, source: 'informer', edge: edge(key, 'owned_by', 'Deployment:shop/api') },
        {
          op: 'edge_upsert',
          at: t,
          source: 'informer',
          edge: edge(key, 'runs_on', rand() < 0.5 ? 'Node:n1' : 'Node:n2'),
        },
        { op: 'edge_upsert', at: t, source: 'informer', edge: edge('Service:shop/api', 'selects', key) },
        // 内容变化：置信度
        {
          op: 'edge_upsert',
          at: t,
          source: 'informer',
          edge: edge('Service:shop/api', 'calls', 'Deployment:shop/api', Math.round(rand() * 100) / 100),
        },
      );
      await store.apply(C, changes);
      versions.push(await store.version(C));
    }
    // 每一条被关闭的 upsert 都记下了关闭它的事件
    const unclosed = await db.admin.query(
      "SELECT count(*)::int AS n FROM server.topology_events WHERE cluster_id = $1 AND valid_to IS NOT NULL AND op LIKE '%_upsert' AND closed_seq IS NULL",
      [C],
    );
    expect(unclosed.rows[0].n).toBe(0);
    let checked = 0;
    for (const ti of [0, 5, 37, 60, 61, 99, 120, 200]) {
      for (const vi of [0, 3, 37, 60, 90, 120]) {
        const t = at(ti);
        const v = versions[vi] as number;
        const want = await oldAt(C, t, v);
        const got = await store.at(C, t, v);
        expect(got.nodes).toEqual(want.nodes);
        expect(got.edges).toEqual(want.edges);
        const seeds = ['Deployment:shop/api'];
        const ref = bfs(want.edges, seeds, 2);
        const sg = await store.subgraph(C, seeds, t, v, 2);
        expect([...sg.hops]).toEqual([...ref.dist]);
        expect(sg.edges.map(edgeKey)).toEqual(ref.edges.map(edgeKey));
        expect(sg.nodes.map((n) => n.key).sort()).toEqual(
          want.nodes
            .filter((n) => ref.dist.has(n.key))
            .map((n) => n.key)
            .sort(),
        );
        checked++;
      }
    }
    expect(checked).toBe(48);
    // 两跳邻域（研判上下文）：与在当前整张拓扑上展开相同
    const now = await oldAt(C, at(500), versions.at(-1) as number);
    const n = await store.neighborhood(C, ['Node:n1'], at(500), 2);
    const ref = bfs(now.edges, ['Node:n1'], 2);
    expect(n.nodes.map((x) => x.key).sort()).toEqual(
      now.nodes
        .filter((x) => ref.dist.has(x.key))
        .map((x) => x.key)
        .sort(),
    );
  });

  it('同一个 (版本, 时刻) 的并发查询只查一次库，之后命中缓存；不早于最后一条事件的时刻共用"当前"', async () => {
    const seen: string[] = [];
    const store = new TopologyStore(db.server, (q, source) => seen.push(`${q}:${source}`));
    const C = 'memo';
    await store.apply(C, [{ op: 'node_upsert', at: at(0), source: 'informer', node: node('Deployment', 'api') }]);
    await store.apply(C, [{ op: 'node_upsert', at: at(10), source: 'informer', node: node('Service', 'web') }]);
    const v = await store.version(C);
    const rs = await Promise.all(Array.from({ length: 6 }, () => store.at(C, at(5), v)));
    expect(rs.every((r) => r.nodes.length === 1)).toBe(true);
    expect(seen.filter((s) => s === 'at:db')).toHaveLength(1);
    // 其余五条并入进行中的查询，或在它结束之后命中缓存
    expect(seen.filter((s) => s === 'at:shared' || s === 'at:cache')).toHaveLength(5);
    // 调用方改自己的数组不影响缓存
    rs[0]!.nodes.pop();
    expect((await store.at(C, at(5), v)).nodes).toHaveLength(1);
    expect(seen.at(-1)).toBe('at:cache');
    // 当前：不同的时刻共用一份
    seen.length = 0;
    await store.at(C, new Date());
    await store.at(C, new Date(Date.now() + 1000));
    expect(seen).toEqual(['at:db', 'at:cache']);
    // 新事件之后版本变了，重新查
    await store.apply(C, [{ op: 'node_upsert', at: at(20), source: 'informer', node: node('Service', 'api') }]);
    const after = await store.at(C, new Date());
    expect(after.nodes).toHaveLength(3);
    expect(seen.at(-1)).toBe('at:db');
    // 子图同样缓存
    seen.length = 0;
    await store.subgraph(C, ['Deployment:shop/api'], at(20), null, 2);
    await store.subgraph(C, ['Deployment:shop/api'], at(20), null, 2);
    expect(seen).toEqual(['subgraph:db', 'subgraph:cache']);
  });

  it('同一时刻最多两条时间点查询在库上执行，其余排队', async () => {
    const C = 'limit';
    const s0 = new TopologyStore(db.server);
    await s0.apply(C, [{ op: 'node_upsert', at: at(0), source: 'informer', node: node('Deployment', 'api') }]);
    let active = 0;
    let peak = 0;
    const pool = db.server;
    const orig = pool.query.bind(pool);
    // 只统计取整张拓扑的查询
    const spy = new Proxy(pool, {
      get(target, prop, recv) {
        if (prop === 'query') {
          return async (...args: Parameters<typeof orig>) => {
            const big = typeof args[0] === 'string' && args[0].includes('UNION ALL');
            if (big) {
              active++;
              peak = Math.max(peak, active);
              await new Promise((r) => setTimeout(r, 30));
            }
            try {
              return await (orig as (...a: unknown[]) => Promise<unknown>)(...args);
            } finally {
              if (big) {
                active--;
              }
            }
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const store = new TopologyStore(spy as typeof pool);
    const v = await store.version(C);
    // 早于最后一条事件的时刻各是一个键，不会合并
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.at(C, at(-1 - i), v)));
    expect(peak).toBe(2);
  });

  it('压缩删除保留期之前关闭的行，保留期内各时刻的拓扑不变；旧版本二进制没记 closed_seq 的行先补齐', async () => {
    const store = new TopologyStore(db.server);
    const C = 'compact';
    const old = new Date(Date.now() - 30 * 86400_000);
    const mid = new Date(Date.now() - 20 * 86400_000);
    const recent = new Date(Date.now() - 3600_000);
    await store.apply(C, [
      { op: 'node_upsert', at: old, source: 'informer', node: node('Pod', 'a') },
      { op: 'node_upsert', at: old, source: 'informer', node: node('Deployment', 'api', { labels: { v: '1' } }) },
    ]);
    await store.apply(C, [
      { op: 'node_delete', at: mid, source: 'informer', node: node('Pod', 'a') },
      { op: 'node_upsert', at: mid, source: 'informer', node: node('Deployment', 'api', { labels: { v: '2' } }) },
    ]);
    await store.apply(C, [
      { op: 'node_upsert', at: recent, source: 'informer', node: node('Deployment', 'api', { labels: { v: '3' } }) },
    ]);
    // N-1 二进制关闭的行：没有 closed_seq
    await db.admin.query(
      "UPDATE server.topology_events SET closed_seq = NULL WHERE cluster_id = $1 AND key = 'Deployment:shop/api' AND valid_to IS NOT NULL",
      [C],
    );
    const inRetention = new Date(Date.now() - 5 * 86400_000);
    const before = await new TopologyStore(db.server).at(C, inRetention);
    const r = await store.compact(14 * 86400_000);
    expect(r.backfilled).toBe(2);
    // Pod a 的 upsert 与删除事件、Deployment 的 v1（20 天前关闭）
    expect(r.deleted).toBe(3);
    const after = await new TopologyStore(db.server).at(C, inRetention);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.nodes.map((n) => n.labels.v)).toEqual(['2']);
    const left = await db.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM server.topology_events WHERE cluster_id = $1 AND valid_to IS NOT NULL AND closed_seq IS NULL',
      [C],
    );
    expect(left.rows[0]!.n).toBe(0);
    expect(await store.compact(14 * 86400_000)).toEqual({ backfilled: 0, deleted: 0 });
  });

  it('扩展迁移为已有的历史补齐 closed_seq', async () => {
    const t = await newTestDb();
    try {
      await migrateExpand(t.server, 'server', [
        storeTrack,
        { ...topologyTrack, migrations: topologyTrack.migrations.slice(0, 3) },
      ]);
      const ins = (key: string, op: string, from: Date, to: Date | null) =>
        t.server.query(
          `INSERT INTO server.topology_events (event_id, cluster_id, op, item, key, valid_from, valid_to, source, body)
           VALUES (gen_random_uuid(), 'm', $2, 'node', $1, $3, $4, 'informer', '{}')`,
          [key, op, from, to],
        );
      await ins('Pod:x/a', 'node_upsert', at(0), at(5));
      await ins('Pod:x/a', 'node_upsert', at(5), at(9));
      await ins('Pod:x/a', 'node_delete', at(9), at(9));
      await ins('Pod:x/b', 'node_upsert', at(1), null);
      await migrateExpand(t.server, 'server', [storeTrack, topologyTrack]);
      const r = await t.server.query<{ seq: number; closed_seq: number | null }>(
        'SELECT seq, closed_seq FROM server.topology_events ORDER BY seq',
      );
      const s = r.rows.map((x) => x.seq);
      expect(r.rows.map((x) => x.closed_seq)).toEqual([s[1], s[2], null, null]);
    } finally {
      await t.close();
    }
  });

  it('语句超时计入回调，其他错误不计', async () => {
    let n = 0;
    const pool = createPool(db.serverConfig, 'timeout-test', 2, () => n++);
    try {
      const err = await pool.query('SET statement_timeout = 50; SELECT pg_sleep(1)').catch((e: unknown) => e);
      expect(isStatementTimeout(err)).toBe(true);
      expect(n).toBe(1);
      const c = await pool.connect();
      try {
        await c.query('SET statement_timeout = 50');
        await expect(c.query('SELECT pg_sleep(1)')).rejects.toThrow(/statement timeout/);
        await expect(c.query('SELECT 1/0')).rejects.toThrow(/division by zero/);
        await c.query('SET statement_timeout = 30000');
      } finally {
        c.release();
      }
      expect(n).toBe(2);
    } finally {
      await pool.end();
    }
  });
});
