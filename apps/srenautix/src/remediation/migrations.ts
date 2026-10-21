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
  ],
};
