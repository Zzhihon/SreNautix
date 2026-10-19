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
  ],
};
