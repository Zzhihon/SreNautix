import type { Track } from '../store/migrate.js';

export const githubTrack: Track = {
  track: 'github',
  migrations: [
    {
      version: 1,
      name: 'incident issues, their progress comments and linked pull requests',
      phase: 'expand',
      sql: `
-- 每个事件最多一个 issue（ADR 0095）：pending 等待开出或重试，open 已开，skipped 因限速只记录，failed 重试用尽
CREATE TABLE server.github_issues (
  incident_id uuid PRIMARY KEY,
  repo text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'open', 'skipped', 'failed')),
  reason text NOT NULL CHECK (reason IN ('escalate', 'repo_change')),
  number integer,
  url text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_issues_opened_idx ON server.github_issues (repo, opened_at) WHERE state = 'open';
CREATE INDEX github_issues_due_idx ON server.github_issues (next_attempt_at) WHERE state = 'pending';

-- issue 上的进展评论：按 (事件, 键) 去重，失败按退避重试
CREATE TABLE server.github_issue_comments (
  incident_id uuid NOT NULL,
  key text NOT NULL,
  body text NOT NULL,
  posted_at timestamptz,
  url text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, key)
);
CREATE INDEX github_issue_comments_due_idx ON server.github_issue_comments (next_attempt_at) WHERE posted_at IS NULL;

-- 与事件关联的 PR（server 的拓扑覆盖 PR、gateway 的 gitops_pr 提议）：PR 描述写 Refs，issue 里回链
CREATE TABLE server.github_issue_links (
  incident_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pull', 'proposal')),
  url text NOT NULL,
  repo text,
  number integer,
  title text NOT NULL,
  refs_in_body boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, url)
);
`,
    },
    {
      version: 2,
      name: 'hash of the issue body last written, so the body is updated in place when the report changes',
      phase: 'expand',
      sql: `
-- 上次写入的 issue 正文的 sha256（ADR 0125）：报告变化时就地更新正文；按标记找回的 issue 为 null，下一轮更新
ALTER TABLE server.github_issues ADD COLUMN body_hash text;
`,
    },
    {
      version: 3,
      name: 'issue title last written and when it was last changed, so the title follows the root and headline symptoms',
      phase: 'expand',
      sql: `
-- issue 标题跟随事件的根因与头条症状（ADR 0142）：上次写入的标题（按标记找回、或这一版之前开出的 issue 为 null，
-- 下一轮读回 GitHub 上的标题）与上次修改标题的时刻（同一事件每小时最多改 1 次；开出时不算修改）
ALTER TABLE server.github_issues ADD COLUMN title text;
ALTER TABLE server.github_issues ADD COLUMN title_updated_at timestamptz;
`,
    },
  ],
};
