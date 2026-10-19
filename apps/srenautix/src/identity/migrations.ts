import type { Track } from '../store/migrate.js';

export const identityTrack: Track = {
  track: 'identity',
  migrations: [
    {
      version: 1,
      name: 'users, sessions, lockout, oidc state, chat links',
      phase: 'expand',
      sql: `
CREATE TABLE server.users (
  principal_id text PRIMARY KEY,
  display_name text NOT NULL,
  provider text NOT NULL,
  groups text[] NOT NULL DEFAULT '{}',
  external_ids jsonb NOT NULL DEFAULT '{}',
  first_login_at timestamptz NOT NULL,
  last_login_at timestamptz NOT NULL
);

-- 服务端会话：只保存会话 id 的 sha256；cookie 中是原值
CREATE TABLE server.sessions (
  id_hash bytea PRIMARY KEY,
  principal_id text NOT NULL,
  display_name text NOT NULL,
  provider text NOT NULL,
  groups text[] NOT NULL,
  mfa boolean NOT NULL,
  break_glass boolean NOT NULL,
  csrf_token text NOT NULL,
  auth_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_principal_idx ON server.sessions (principal_id);
CREATE INDEX sessions_expires_idx ON server.sessions (expires_at);

-- 登录失败计数与锁定（按用户名）；last_totp_counter 防止同一个 TOTP 码被重放
CREATE TABLE server.login_attempts (
  username text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL,
  locked_until timestamptz,
  last_totp_counter bigint
);

-- OIDC 授权码流程的一次性状态（PKCE verifier、nonce、跳回地址），10 分钟有效
CREATE TABLE server.oidc_states (
  state text PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  return_to text NOT NULL,
  max_age integer,
  created_at timestamptz NOT NULL
);

-- 聊天账号绑定（DESIGN §9.2）：只有绑定过的账号可以审批与反馈
CREATE TABLE server.chat_links (
  channel text NOT NULL,
  channel_user_id text NOT NULL,
  principal_id text NOT NULL,
  method text NOT NULL CHECK (method IN ('code', 'union_id')),
  linked_at timestamptz NOT NULL,
  PRIMARY KEY (channel, channel_user_id)
);
CREATE INDEX chat_links_principal_idx ON server.chat_links (principal_id);

-- 一次性绑定码：只保存 sha256，10 分钟有效，使用一次即失效
CREATE TABLE server.link_codes (
  code_hash bytea PRIMARY KEY,
  principal_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by text
);
`,
    },
  ],
};
