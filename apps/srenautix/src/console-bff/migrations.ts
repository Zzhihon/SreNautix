import type { Track } from '../store/migrate.js';

export const consoleTrack: Track = {
  track: 'console',
  migrations: [
    {
      version: 1,
      name: 'condition spans, api tokens',
      phase: 'expand',
      sql: `
-- 状态条件成立的时段（收件箱的盲区色带）：条件从 false 变为 true 时开一段，变回 false 时关闭
CREATE TABLE server.condition_spans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role text NOT NULL,
  cluster_id text NOT NULL,
  type text NOT NULL,
  subject text NOT NULL,
  reason text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);
CREATE INDEX condition_spans_open_idx ON server.condition_spans (role, cluster_id, type, subject) WHERE ended_at IS NULL;
CREATE INDEX condition_spans_time_idx ON server.condition_spans (started_at);

-- 控制台创建的 API token（只有提议权限，DESIGN §9.3、§12.2 设置页）；只存 sha256
CREATE TABLE server.api_tokens (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  token_sha256 text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
`,
    },
  ],
};
