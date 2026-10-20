import type { Track } from '../store/migrate.js';

export const detectorTrack: Track = {
  track: 'detector',
  migrations: [
    {
      version: 1,
      name: 'object health reports and detector findings',
      phase: 'expand',
      sql: `
-- 集群状态检测器（ADR 0105）：reader 或 server 的 informer 上报的不健康对象（每个集群最新的一份）
CREATE TABLE server.object_health (
  cluster_id text NOT NULL,
  key text NOT NULL,
  state text NOT NULL,
  since timestamptz NOT NULL,
  body jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (cluster_id, key, state)
);

-- 每个集群最近一次上报：complete 为 true 时这份列表是全部不健康对象
CREATE TABLE server.object_health_reports (
  cluster_id text PRIMARY KEY,
  observed_at timestamptz NOT NULL,
  complete boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- 检测器当前成立的发现（已合成为告警），用于在状态消失或改由告警规则覆盖时恢复告警
CREATE TABLE server.detector_findings (
  cluster_id text NOT NULL,
  key text NOT NULL,
  state text NOT NULL,
  fingerprint text NOT NULL,
  starts_at timestamptz NOT NULL,
  alert jsonb NOT NULL,
  PRIMARY KEY (cluster_id, key, state)
);
`,
    },
  ],
};
