import type { Track } from '../store/migrate.js';

export const changesTrack: Track = {
  track: 'changes',
  migrations: [
    {
      version: 1,
      name: 'change events and source status',
      phase: 'expand',
      sql: `
-- 变更事件（changes/v1 的 ChangeEvent）：按 change_id 去重，事件引擎按集群与时间窗口读取
CREATE TABLE server.change_events (
  change_id text PRIMARY KEY,
  cluster_id text NOT NULL,
  source text NOT NULL,
  time timestamptz NOT NULL,
  targets text[] NOT NULL,
  body jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_events_window_idx ON server.change_events (cluster_id, time);

-- 每个变更源最近一次同步的结果（状态条件 DatasourceUnavailable 与集成页使用）
CREATE TABLE server.change_sources (
  source_id text PRIMARY KEY,
  last_synced_at timestamptz,
  last_error text,
  last_error_at timestamptz
);
`,
    },
  ],
};
