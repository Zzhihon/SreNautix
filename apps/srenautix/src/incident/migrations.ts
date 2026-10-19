import type { Track } from '../store/migrate.js';

export const incidentTrack: Track = {
  track: 'incident',
  migrations: [
    {
      version: 1,
      name: 'incidents, versions, members, aliases, stage A reports, research mirror and queue',
      phase: 'expand',
      sql: `
-- 事件（DESIGN §2.2）：事件引擎是唯一写入方；body 是契约 Incident 的当前版本全文
CREATE TABLE server.incidents (
  incident_id uuid PRIMARY KEY,
  cluster_id text NOT NULL,
  label text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  state text NOT NULL CHECK (state IN ('firing', 'resolved', 'merged')),
  severity text NOT NULL,
  first_firing_at timestamptz NOT NULL,
  ended_at timestamptz,
  root_component text,
  suppressed boolean NOT NULL DEFAULT false,
  observability_blind boolean NOT NULL DEFAULT false,
  split_from uuid,
  merged_into uuid,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, label)
);
CREATE INDEX incidents_state_idx ON server.incidents (cluster_id, state, first_firing_at DESC);
CREATE INDEX incidents_updated_idx ON server.incidents (updated_at DESC);

-- 每个版本的全文，GET /v1/incidents/{ref}?version= 与研判引用的版本从这里取
CREATE TABLE server.incident_versions (
  incident_id uuid NOT NULL REFERENCES server.incidents (incident_id),
  version integer NOT NULL,
  body jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, version)
);

-- 成员关系按版本（DESIGN §2.2）：left_version 为空表示仍是成员
CREATE TABLE server.incident_members (
  incident_id uuid NOT NULL REFERENCES server.incidents (incident_id),
  alert_id text NOT NULL,
  joined_version integer NOT NULL,
  left_version integer,
  PRIMARY KEY (incident_id, alert_id, joined_version)
);
CREATE INDEX incident_members_alert_idx ON server.incident_members (alert_id) WHERE left_version IS NULL;

-- 合并：from → into；旧 id 与旧标签经此解析
CREATE TABLE server.incident_aliases (
  from_incident_id uuid PRIMARY KEY,
  from_label text NOT NULL,
  cluster_id text NOT NULL,
  into_incident_id uuid NOT NULL,
  at_version integer NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incident_aliases_label_idx ON server.incident_aliases (cluster_id, from_label);
CREATE INDEX incident_aliases_into_idx ON server.incident_aliases (into_incident_id);

-- 阶段 A 报告（DESIGN §7.1）
CREATE TABLE server.stage_a_reports (
  report_id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES server.incidents (incident_id),
  incident_version integer NOT NULL,
  disposition text NOT NULL,
  evidence_fingerprint text NOT NULL,
  degraded boolean NOT NULL,
  body jsonb NOT NULL,
  first_firing_at timestamptz NOT NULL,
  rendered_at timestamptz NOT NULL,
  UNIQUE (incident_id, incident_version)
);
CREATE INDEX stage_a_reports_incident_idx ON server.stage_a_reports (incident_id, incident_version DESC);

-- worker 研判结果在 server 侧的镜像（来自 worker 的 /v1/events），用于消息、收件箱与提议绑定
CREATE TABLE server.research_runs (
  run_id uuid PRIMARY KEY,
  incident_id uuid NOT NULL,
  incident_version integer NOT NULL,
  reason text NOT NULL,
  state text NOT NULL,
  disposition text,
  conclusion_level text,
  root_component text,
  summary text,
  evidence_fingerprint text,
  output jsonb,
  error jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_runs_incident_idx ON server.research_runs (incident_id, started_at DESC);

-- 阶段 B 队列（DESIGN §7.5）：(incident_id, incident_version, reason) 唯一；worker 经 API 认领，server 以 SKIP LOCKED 分配
CREATE TABLE server.research_queue (
  run_id uuid PRIMARY KEY,
  incident_id uuid NOT NULL,
  incident_version integer NOT NULL,
  reason text NOT NULL,
  severity text NOT NULL,
  absorbed integer NOT NULL DEFAULT 0,
  is_new boolean NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'done', 'superseded', 'skipped')),
  skip_reason text,
  worker_id text,
  lease_expires_at timestamptz,
  deadline_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (incident_id, incident_version, reason)
);
CREATE INDEX research_queue_ready_idx ON server.research_queue (state, enqueued_at) WHERE state IN ('queued', 'leased');
CREATE INDEX research_queue_incident_idx ON server.research_queue (incident_id, enqueued_at DESC);

-- worker 事件流的消费游标
CREATE TABLE server.event_cursors (
  consumer text PRIMARY KEY,
  cursor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 抑制规则（DESIGN §12.3）：只影响 SreNautix 自己的消息与研判，必须设过期时间
CREATE TABLE server.suppressions (
  id uuid PRIMARY KEY,
  cluster_id text NOT NULL,
  matchers jsonb NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
`,
    },
  ],
};
