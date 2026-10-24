import type { Track } from '../store/migrate.js';

export const topologyTrack: Track = {
  track: 'topology',
  migrations: [
    {
      version: 1,
      name: 'event-sourced topology',
      phase: 'expand',
      sql: `
-- 事件溯源拓扑（DESIGN §4.1）：每行一个节点或边在 [valid_from, valid_to) 内的状态；seq 也是拓扑版本号
CREATE TABLE server.topology_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  cluster_id text NOT NULL,
  op text NOT NULL CHECK (op IN ('node_upsert', 'node_delete', 'edge_upsert', 'edge_delete')),
  item text NOT NULL CHECK (item IN ('node', 'edge')),
  key text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  source text NOT NULL,
  body jsonb NOT NULL,
  -- 节点的 kind/namespace/name，用于实体解析
  kind text,
  namespace text,
  name text,
  uid text
);
CREATE INDEX topology_open_idx ON server.topology_events (cluster_id, item, key) WHERE valid_to IS NULL AND op IN ('node_upsert', 'edge_upsert');
CREATE INDEX topology_time_idx ON server.topology_events (cluster_id, valid_from);
CREATE INDEX topology_node_lookup_idx ON server.topology_events (cluster_id, kind, namespace, name, valid_from DESC) WHERE item = 'node';
CREATE INDEX topology_edge_from_idx ON server.topology_events (cluster_id, (body->>'from')) WHERE item = 'edge';
CREATE INDEX topology_edge_to_idx ON server.topology_events (cluster_id, (body->>'to')) WHERE item = 'edge';
`,
    },
    {
      version: 2,
      name: 'reader protocol state',
      phase: 'expand',
      sql: `
-- 每个集群 reader 已连续接受的拓扑序号（与 topology_events.seq 相互独立）
CREATE TABLE server.spoke_topology_cursor (
  cluster_id text PRIMARY KEY,
  topology_seq bigint NOT NULL DEFAULT 0,
  snapshot_id uuid,
  reader_id text,
  boot_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 拓扑快照的分段，全部到齐后一次应用并删除
CREATE TABLE server.reader_snapshot_parts (
  snapshot_id uuid NOT NULL,
  part integer NOT NULL,
  cluster_id text NOT NULL,
  parts integer NOT NULL,
  seq bigint NOT NULL,
  taken_at timestamptz NOT NULL,
  nodes jsonb NOT NULL,
  edges jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, part)
);

-- reader 的最近一次心跳
CREATE TABLE server.reader_status (
  cluster_id text PRIMARY KEY,
  reader_id text NOT NULL,
  version text NOT NULL,
  boot_id uuid NOT NULL,
  topology_seq bigint NOT NULL,
  conditions jsonb NOT NULL,
  clock jsonb NOT NULL,
  query_manifest jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- 中心下发给 reader 的读取请求：只有模板 id、内容哈希与参数，查询文本由 reader 渲染
CREATE TABLE server.reader_requests (
  request_id uuid PRIMARY KEY,
  cluster_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('query', 'ksm_history', 'resolve')),
  payload jsonb NOT NULL,
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  deliveries integer NOT NULL DEFAULT 0,
  result jsonb,
  completed_at timestamptz
);
CREATE INDEX reader_requests_pending_idx ON server.reader_requests (cluster_id, created_at) WHERE completed_at IS NULL;
`,
    },
    {
      version: 3,
      name: 'node lookup by name',
      phase: 'expand',
      sql: `
-- 告警解析按名称查找节点（kind 不区分大小写、不带 API 组，命名空间可以缺省）
CREATE INDEX IF NOT EXISTS topology_node_name_idx ON server.topology_events (cluster_id, name, valid_from DESC) WHERE item = 'node';
`,
    },
    {
      version: 4,
      name: 'point-in-time topology indexes',
      phase: 'expand',
      sql: `
-- 时间点拓扑查询（ADR 0144）：closed_seq 是关闭这一行的事件的 seq，"版本 v 时仍然打开"即 closed_seq > v，
-- 不再为每一条已关闭的行查找关闭它的事件；查询按打开的、t 之后关闭的、版本 v 之后关闭的三部分分别走索引
SET LOCAL statement_timeout = 0;
ALTER TABLE server.topology_events ADD COLUMN IF NOT EXISTS closed_seq bigint;
UPDATE server.topology_events t SET closed_seq = n.next
  FROM (SELECT seq, lead(seq) OVER (PARTITION BY cluster_id, item, key ORDER BY seq) AS next FROM server.topology_events) n
 WHERE n.seq = t.seq AND n.next IS NOT NULL AND t.valid_to IS NOT NULL AND t.op IN ('node_upsert', 'edge_upsert');
CREATE INDEX IF NOT EXISTS topology_closed_idx ON server.topology_events (cluster_id, valid_to, valid_from) WHERE valid_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS topology_closed_seq_idx ON server.topology_events (cluster_id, closed_seq, seq) WHERE closed_seq IS NOT NULL;
-- 子图与实体解析按键取节点的各个版本
CREATE INDEX IF NOT EXISTS topology_key_idx ON server.topology_events (cluster_id, item, key, seq);
-- N-1 版本的二进制关闭的行不记 closed_seq，压缩时补齐
CREATE INDEX IF NOT EXISTS topology_unclosed_idx ON server.topology_events (seq)
  WHERE closed_seq IS NULL AND valid_to IS NOT NULL AND op IN ('node_upsert', 'edge_upsert');
ANALYZE server.topology_events;
`,
    },
  ],
};
