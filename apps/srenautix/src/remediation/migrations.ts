import type { Track } from '../store/migrate.js';

export const remediationTrack: Track = {
  track: 'remediation',
  migrations: [
    {
      version: 1,
      name: 'remediation attempts per research conclusion and pull requests opened by gitops_pr',
      phase: 'expand',
      sql: `
-- 自愈 PR（ADR 0108）：每次结束的研判按模板各处理一次；key 为模板键 <包>/<id>，'-' 表示没有可处理的模板
CREATE TABLE server.remediation_attempts (
  run_id uuid NOT NULL,
  key text NOT NULL,
  incident_id uuid NOT NULL,
  incident_version integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('proposed', 'skipped', 'rejected', 'failed')),
  code text,
  reason text,
  category text,
  repository text,
  branch text,
  base text,
  proposal_id uuid,
  files jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, key)
);
CREATE INDEX remediation_attempts_incident_idx ON server.remediation_attempts (incident_id, created_at DESC);

-- gitops_pr 开出的 PR（自愈 PR 与拓扑覆盖 PR）：从执行事件或按分支查 GitHub 得到，用于事件 issue 的回链与通知
CREATE TABLE server.gitops_pulls (
  proposal_id uuid PRIMARY KEY,
  incident_id uuid NOT NULL,
  repo text NOT NULL,
  branch text NOT NULL,
  url text NOT NULL,
  number integer NOT NULL,
  found_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gitops_pulls_incident_idx ON server.gitops_pulls (incident_id);
`,
    },
    {
      version: 2,
      name: 'retry remediation attempts that hit a stale binding',
      phase: 'expand',
      sql: `
-- 提议因绑定过时（事件在研判与提议之间升了版本）被拒绝的尝试可以重试，有次数上限（ADR 0108 §13）
ALTER TABLE server.remediation_attempts ADD COLUMN retries integer NOT NULL DEFAULT 0;
`,
    },
    {
      version: 3,
      name: 'deduplicate remediation changes and remember the ones people rejected',
      phase: 'expand',
      sql: `
-- 自愈 PR 的修改（ADR 0155）：每个 gitops_pr 提议一行；change_hash 是规范化补丁（路径与增删的行）的哈希。
-- state：pending 提议还没有 PR；open PR 打开；merged 已合并；rejected PR 关闭且没有合并，或提议在审批时被人拒绝；
-- abandoned 提议被策略拒绝、过期、绑定过时或执行失败，没有开出 PR
CREATE TABLE server.remediation_changes (
  proposal_id uuid PRIMARY KEY,
  repository text NOT NULL,
  change_hash text NOT NULL,
  key text NOT NULL,
  files jsonb NOT NULL,
  incident_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'open', 'merged', 'rejected', 'abandoned')),
  pr_number integer,
  pr_url text,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX remediation_changes_hash_idx ON server.remediation_changes (repository, change_hash);
CREATE INDEX remediation_changes_scope_idx ON server.remediation_changes (repository, key);

-- 同一个修改的重复触发：写成 PR 评论，新事件的 issue 关联到 PR；同一个修改的同一个事件只记一次
CREATE TABLE server.remediation_triggers (
  proposal_id uuid NOT NULL REFERENCES server.remediation_changes (proposal_id),
  incident_id uuid NOT NULL,
  run_id uuid NOT NULL,
  body text NOT NULL,
  comment_url text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, incident_id)
);
`,
    },
  ],
};
