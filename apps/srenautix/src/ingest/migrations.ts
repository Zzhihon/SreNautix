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
    {
      version: 2,
      name: 'alert first seen in alertmanager',
      phase: 'expand',
      sql: `
-- 告警第一次在 Alertmanager 中被看到的时刻（ADR 0165）：webhook 到达、完整对账、快速轮询与 reader 快照中最早的一次。
-- 已有的行：Alertmanager、Grafana 与对账来源的告警取第一次写入的时刻（对账来源里规则引擎补写的告警无法区分，同样取这个时刻）
ALTER TABLE server.alert_state ADD COLUMN alertmanager_seen_at timestamptz;
UPDATE server.alert_state SET alertmanager_seen_at = received_at WHERE source IN ('alertmanager', 'grafana', 'reconcile');
`,
    },
  ],
};
