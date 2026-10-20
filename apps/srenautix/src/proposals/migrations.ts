import type { Track } from '../store/migrate.js';

export const proposalsTrack: Track = {
  track: 'proposals',
  migrations: [
    {
      version: 1,
      name: 'proposals, approval assertions, spoke execution events and status, feedback',
      phase: 'expand',
      sql: `
-- 提议（DESIGN §2.4、§9）：body 是契约 Proposal 全文；幂等键在未结束的提议中唯一
CREATE TABLE server.proposals (
  proposal_id uuid PRIMARY KEY,
  idempotency_key text NOT NULL,
  cluster_id text NOT NULL,
  incident_id uuid NOT NULL,
  action text NOT NULL,
  level text NOT NULL,
  tier text NOT NULL CHECK (tier IN ('auto', 'L', 'H')),
  source text NOT NULL,
  state text NOT NULL,
  target_namespace text,
  params jsonb NOT NULL,
  body jsonb NOT NULL,
  ttl_expires_at timestamptz,
  first_delivered_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX proposals_open_idem_idx ON server.proposals (idempotency_key)
  WHERE state IN ('awaiting_approval', 'approved', 'held', 'dispatched');
CREATE INDEX proposals_incident_idx ON server.proposals (incident_id, created_at DESC);
CREATE INDEX proposals_state_idx ON server.proposals (cluster_id, state, created_at DESC);

-- 签发的审批断言（DESIGN §9.2）；工单 = 已签发、gateway 尚未确认拉取的断言
CREATE TABLE server.approval_assertions (
  assertion_id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES server.proposals (proposal_id),
  cluster_id text NOT NULL,
  tier text NOT NULL,
  channel text NOT NULL,
  principal_id text NOT NULL,
  assertion_hash text NOT NULL,
  execution_id text NOT NULL,
  envelope jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  pulled_at timestamptz,
  delivered_at timestamptz
);
CREATE INDEX approval_assertions_ticket_idx ON server.approval_assertions (cluster_id, issued_at) WHERE pulled_at IS NULL;
CREATE INDEX approval_assertions_proposal_idx ON server.approval_assertions (proposal_id);

-- gateway 推回的执行事件（工单协议 pushEvents），按 event_id 去重
CREATE TABLE server.execution_events (
  event_id text PRIMARY KEY,
  cluster_id text NOT NULL,
  execution_id text NOT NULL,
  ticket_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  seq integer NOT NULL,
  phase text NOT NULL,
  at timestamptz NOT NULL,
  reason text NOT NULL,
  body jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execution_events_proposal_idx ON server.execution_events (proposal_id, seq);

-- 各集群 gateway 的最近一次心跳
CREATE TABLE server.spoke_status (
  cluster_id text PRIMARY KEY,
  gateway_id text NOT NULL,
  version text NOT NULL,
  leader boolean NOT NULL,
  propose_only boolean NOT NULL,
  conditions jsonb NOT NULL,
  queue jsonb NOT NULL,
  clock_skew jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- 反馈（DESIGN §11，契约 Feedback）：只追加
CREATE TABLE server.feedback (
  feedback_id uuid PRIMARY KEY,
  incident_id uuid NOT NULL,
  incident_version integer NOT NULL,
  research_run_id uuid,
  verdict text CHECK (verdict IN ('confirmed', 'rejected')),
  root_component text,
  disposition_verdict text CHECK (disposition_verdict IN ('confirmed', 'rejected')),
  disposition text,
  mechanism text CHECK (char_length(mechanism) <= 600),
  reason text CHECK (char_length(reason) <= 500),
  principal_id text NOT NULL,
  channel text NOT NULL,
  linked boolean NOT NULL,
  implicit text CHECK (implicit IN ('approved', 'rejected', 'undone', 'resolved_confirm')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (verdict IS NOT NULL OR disposition_verdict IS NOT NULL OR implicit IS NOT NULL)
);
CREATE INDEX feedback_incident_idx ON server.feedback (incident_id, created_at DESC);
`,
    },
    {
      version: 2,
      name: 'webauthn challenges for compliance H-tier approvals',
      phase: 'expand',
      sql: `
-- 合规配置 H 档的通行密钥挑战（ADR 0020 第 4 条）：挑战 = sha256(JCS(待签名的断言))，只能用一次
CREATE TABLE server.webauthn_challenges (
  challenge text PRIMARY KEY,
  proposal_id uuid NOT NULL,
  principal_id text NOT NULL,
  assertion jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX webauthn_challenges_proposal_idx ON server.webauthn_challenges (proposal_id, principal_id);
`,
    },
  ],
};
