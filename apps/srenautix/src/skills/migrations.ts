import type { Track } from '../store/migrate.js';

// 技能（ADR 0181）的状态：暂停、运行与外部访问的记录、按指纹去重的发现、发现的评论、已报告过的发生、触发的游标
export const skillsTrack: Track = {
  track: 'skills',
  migrations: [
    {
      version: 1,
      name: 'skill pauses, runs, calls, findings, comments, reported occurrences and trigger cursors',
      phase: 'expand',
      sql: `
CREATE TABLE server.skill_overrides (
  skill text PRIMARY KEY,
  paused boolean NOT NULL,
  reason text,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 一次运行；pending 等待 settle、coalesce 或每小时上限。同一 (集群, 技能, 对象) 最多一个 pending 的运行
CREATE TABLE server.skill_runs (
  run_id uuid PRIMARY KEY,
  cluster_id text NOT NULL,
  skill text NOT NULL,
  subject jsonb NOT NULL,
  subject_key text NOT NULL,
  triggers jsonb NOT NULL DEFAULT '[]',
  inputs jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
  reason text,
  requested_by text,
  at timestamptz,
  not_before timestamptz NOT NULL,
  version text,
  digest text,
  steps jsonb NOT NULL DEFAULT '[]',
  usage jsonb,
  finding jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE UNIQUE INDEX skill_runs_pending_idx ON server.skill_runs (cluster_id, skill, subject_key) WHERE state = 'pending';
CREATE INDEX skill_runs_due_idx ON server.skill_runs (not_before) WHERE state = 'pending';
CREATE INDEX skill_runs_skill_idx ON server.skill_runs (skill, created_at DESC);

-- 每次外部访问（含被拒绝的访问），契约 SkillCall
CREATE TABLE server.skill_run_calls (
  run_id uuid NOT NULL REFERENCES server.skill_runs (run_id) ON DELETE CASCADE,
  seq integer NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- 按指纹去重的发现：每一代对应业务仓库的一个 issue。completed 关闭之后同一指纹再次出现时开下一代
CREATE TABLE server.skill_findings (
  cluster_id text NOT NULL,
  skill text NOT NULL,
  fingerprint text NOT NULL,
  generation integer NOT NULL,
  subject jsonb NOT NULL,
  repo text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'unknown', 'open', 'completed', 'not_planned', 'failed')),
  number integer,
  url text,
  title text NOT NULL,
  body text NOT NULL,
  labels jsonb NOT NULL,
  occurrences integer NOT NULL DEFAULT 1,
  previous_number integer,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz,
  closed_at timestamptz,
  cooldown_until timestamptz,
  checked_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  PRIMARY KEY (cluster_id, skill, fingerprint, generation)
);
CREATE INDEX skill_findings_due_idx ON server.skill_findings (next_attempt_at) WHERE state IN ('pending', 'unknown');
CREATE INDEX skill_findings_opened_idx ON server.skill_findings (repo, opened_at);

-- 再次出现的评论：每次运行一条，结果写进打开的 issue；issue 还没有开出时等它开出
CREATE TABLE server.skill_finding_comments (
  run_id uuid PRIMARY KEY,
  cluster_id text NOT NULL,
  skill text NOT NULL,
  fingerprint text NOT NULL,
  generation integer NOT NULL,
  body text NOT NULL,
  posted_at timestamptz,
  url text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_finding_comments_due_idx ON server.skill_finding_comments (next_attempt_at) WHERE posted_at IS NULL;

-- 已经报告过的发生：同一工作负载上以后的运行只投递新的发生
CREATE TABLE server.skill_occurrences (
  cluster_id text NOT NULL,
  skill text NOT NULL,
  subject_key text NOT NULL,
  occurrence text NOT NULL,
  run_id uuid NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, skill, subject_key, occurrence)
);

-- 告警触发的游标：只看游标之后开始触发的告警
CREATE TABLE server.skill_cursors (
  name text PRIMARY KEY,
  at timestamptz NOT NULL
);
`,
    },
  ],
};
