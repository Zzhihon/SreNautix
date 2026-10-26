import type { Track } from '../store/migrate.js';

/** 通知层的表（schema server）。notify_messages 是持久化的发送队列：期望状态与已呈现状态不同即待发送或待编辑。 */
export const notifyTrack: Track = {
  track: 'notify',
  migrations: [
    {
      version: 1,
      name: 'messages, storms, buttons, callbacks, replies, results, poll state',
      phase: 'expand',
      sql: `
-- 风暴：同一渠道目标 5 分钟内有 3 个以上新事件消息时开启，期间新事件静默发送并并入汇总消息
CREATE TABLE server.notify_storms (
  id bigserial PRIMARY KEY,
  channel text NOT NULL,
  chat text NOT NULL,
  started_at timestamptz NOT NULL,
  last_member_at timestamptz NOT NULL
);
CREATE INDEX notify_storms_chat_idx ON server.notify_storms (channel, chat, last_member_at DESC);

CREATE TABLE server.notify_storm_members (
  storm_id bigint NOT NULL REFERENCES server.notify_storms (id),
  incident_id uuid NOT NULL,
  joined_at timestamptz NOT NULL,
  PRIMARY KEY (storm_id, incident_id)
);

-- 每个渠道目标里每个事件一条消息、每次风暴一条汇总消息
CREATE TABLE server.notify_messages (
  id bigserial PRIMARY KEY,
  channel text NOT NULL,
  chat text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('incident', 'digest')),
  subject text NOT NULL,
  incident_id uuid,
  storm_id bigint REFERENCES server.notify_storms (id),
  lane text NOT NULL CHECK (lane IN ('urgent', 'digest', 'edit', 'recovery')),
  silent boolean NOT NULL DEFAULT false,
  desired_payload jsonb NOT NULL,
  desired_hash text NOT NULL,
  desired_at timestamptz NOT NULL,
  proposal_ids text[] NOT NULL DEFAULT '{}',
  external_id text,
  delivered_hash text,
  delivered_at timestamptz,
  first_delivered_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL,
  UNIQUE (channel, chat, kind, subject),
  CHECK ((kind = 'incident') = (incident_id IS NOT NULL)),
  CHECK (kind = 'incident' OR storm_id IS NOT NULL)
);
CREATE INDEX notify_messages_pending_idx ON server.notify_messages (channel, next_attempt_at)
  WHERE delivered_hash IS DISTINCT FROM desired_hash;
CREATE INDEX notify_messages_chat_created_idx ON server.notify_messages (channel, chat, created_at DESC);

-- 回调按钮：渠道回调数据只携带 short_id，按钮的作用对象存在这里。
-- claimed_by 记录第一个处理它的回调；反馈类按钮在一次提交结束后释放，可以再次点击
CREATE TABLE server.notify_buttons (
  short_id text PRIMARY KEY CHECK (short_id ~ '^[A-Za-z0-9_-]{16}$'),
  channel text NOT NULL,
  chat text NOT NULL,
  kind text NOT NULL,
  target jsonb NOT NULL,
  owner_user text,
  created_at timestamptz NOT NULL,
  claimed_by text,
  claimed_at timestamptz,
  finished_at timestamptz,
  CHECK ((claimed_by IS NULL) = (claimed_at IS NULL))
);

-- 已收到的回调；同一渠道的回调 id 只处理一次，重复投递只补应答
CREATE TABLE server.notify_callbacks (
  channel text NOT NULL,
  callback_id text NOT NULL,
  chat text NOT NULL,
  channel_user_id text NOT NULL,
  short_id text,
  received_at timestamptz NOT NULL,
  outcome text,
  answer text,
  PRIMARY KEY (channel, callback_id)
);

-- 等待填写的拒绝原因与真实根因（回复式交互，5 分钟有效）
CREATE TABLE server.notify_pending_replies (
  id bigserial PRIMARY KEY,
  channel text NOT NULL,
  chat text NOT NULL,
  short_id text NOT NULL REFERENCES server.notify_buttons (short_id),
  purpose text NOT NULL CHECK (purpose IN ('reject_reason', 'root_component')),
  channel_user_id text NOT NULL,
  principal_id text NOT NULL,
  display_name text NOT NULL,
  prompt_message_id text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('waiting', 'submitted', 'expired')),
  reply text,
  resolved_at timestamptz,
  CHECK ((state = 'waiting') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX notify_pending_replies_prompt_idx ON server.notify_pending_replies (channel, chat, prompt_message_id)
  WHERE prompt_message_id IS NOT NULL;
CREATE UNIQUE INDEX notify_pending_replies_waiting_idx ON server.notify_pending_replies (short_id) WHERE state = 'waiting';

-- 按钮操作的结果，写回消息的“最近操作”
CREATE TABLE server.notify_action_results (
  id bigserial PRIMARY KEY,
  channel text NOT NULL,
  chat text NOT NULL,
  incident_id uuid NOT NULL,
  proposal_id uuid,
  action text NOT NULL,
  actor text NOT NULL,
  ok boolean NOT NULL,
  code text,
  message text NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX notify_action_results_incident_idx ON server.notify_action_results (channel, chat, incident_id, at DESC);

-- Telegram getUpdates 的下一个 offset（单行，只前进）
CREATE TABLE server.telegram_poll_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  next_offset bigint NOT NULL CHECK (next_offset >= 0),
  updated_at timestamptz NOT NULL
);
`,
    },
    {
      version: 2,
      name: 'external upstream digests',
      phase: 'expand',
      // 外部上游的周期汇总（ADR 0147）：notify_messages 增加 kind external_digest（没有风暴），
      // 每个时间段的统计存一份，汇总消息与下一时段的对比用同一份。放宽约束，N-1 版本照常运行
      sql: `
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'server.notify_messages'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) LIKE '%(kind = ANY %' OR pg_get_constraintdef(oid) LIKE '%storm_id IS NOT NULL%')
  LOOP
    EXECUTE format('ALTER TABLE server.notify_messages DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE server.notify_messages
  ADD CONSTRAINT notify_messages_kind_check CHECK (kind IN ('incident', 'digest', 'external_digest')),
  ADD CONSTRAINT notify_messages_storm_check CHECK (kind <> 'digest' OR storm_id IS NOT NULL);

CREATE TABLE server.notify_external_windows (
  window_start timestamptz PRIMARY KEY,
  window_end timestamptz NOT NULL CHECK (window_end > window_start),
  stats jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
`,
    },
    {
      version: 3,
      name: 'render version, ended edits, abandoned messages',
      phase: 'expand',
      // ADR 0145：render_version 记录期望内容由哪一版渲染器产出（旧代码写入的行为 NULL），启动时重新渲染旧版本的待投递内容；
      // ended 与 ended_edits 限制已结束事件的编辑次数；渠道以永久错误拒绝、纯文本降级仍然失败，或已结束事件编辑次数用完时
      // 记 abandoned_at 与原因，这一版期望内容不再投递，期望内容变化后清除。只加列，N-1 版本照常运行
      sql: `
ALTER TABLE server.notify_messages
  ADD COLUMN render_version integer,
  ADD COLUMN ended boolean NOT NULL DEFAULT false,
  ADD COLUMN ended_edits integer NOT NULL DEFAULT 0,
  ADD COLUMN abandoned_at timestamptz,
  ADD COLUMN abandoned_reason text,
  ADD CONSTRAINT notify_messages_abandoned_check CHECK ((abandoned_at IS NULL) = (abandoned_reason IS NULL));
`,
    },
    {
      version: 4,
      name: 'final edit of ended messages',
      phase: 'expand',
      // ADR 0173：已结束事件的消息成功编辑满上限后，期望内容再变化时发出最后一次编辑（精简内容加说明行与控制台链接），
      // 成功后记 final_edited_at，之后不再投递；事件重新触发时清除。ended_edit_cap 表示最后一次编辑被拒绝：
      // 库里已有的 ended_edit_cap 没有尝试过最后一次编辑，清除放弃，由最后一次编辑补上。只加列，N-1 版本照常运行
      sql: `
ALTER TABLE server.notify_messages ADD COLUMN final_edited_at timestamptz;
UPDATE server.notify_messages SET abandoned_at = NULL, abandoned_reason = NULL WHERE abandoned_reason = 'ended_edit_cap';
`,
    },
  ],
};
