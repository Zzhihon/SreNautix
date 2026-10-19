import type { Track } from '../store/migrate.js';

export const ingestTrack: Track = {
  track: 'ingest',
  migrations: [
    {
      version: 1,
      name: 'ingest log and alert state',
      phase: 'expand',
      sql: `
-- 接入日志：每次 webhook 或对账的原文与结果（保留期由 retention 循环清理）
CREATE TABLE server.ingest_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL,
  cluster_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  alert_count integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'invalid', 'reconcile')),
  error text,
  payload jsonb NOT NULL
);
CREATE INDEX ingest_log_received_idx ON server.ingest_log (received_at);

-- 告警实例的当前状态：一个标签集的一次触发一行（alert_id = <fingerprint>@<starts_at 秒>）
CREATE TABLE server.alert_state (
  alert_id text PRIMARY KEY,
  cluster_id text NOT NULL,
  fingerprint text NOT NULL,
  source text NOT NULL,
  alertname text NOT NULL,
  labels jsonb NOT NULL,
  annotations jsonb NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  status text NOT NULL CHECK (status IN ('firing', 'resolved')),
  suppressed text NOT NULL CHECK (suppressed IN ('none', 'silenced', 'inhibited')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  generator_url text,
  classification jsonb NOT NULL,
  entity jsonb,
  entity_resolution text NOT NULL,
  component text,
  received_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX alert_state_firing_idx ON server.alert_state (cluster_id, status, starts_at);
CREATE INDEX alert_state_fp_idx ON server.alert_state (fingerprint, starts_at DESC);
CREATE INDEX alert_state_ends_idx ON server.alert_state (ends_at) WHERE ends_at IS NOT NULL;

-- 各接入源最近一次收到有效载荷的时间（接入静默条件）
CREATE TABLE server.ingest_sources (
  source_id text PRIMARY KEY,
  kind text NOT NULL,
  last_received_at timestamptz NOT NULL
);
`,
    },
  ],
};
