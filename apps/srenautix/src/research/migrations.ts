import type { Track } from '../store/migrate.js';
import { outboxDdl } from '../store/outbox.js';

/**
 * worker schema（DESIGN §2.1：research_runs、hypotheses、llm_calls、tool_calls、evidence_snapshots、research_manifests、outbox）。
 * 假设账本随研判输出保存在 research_runs.output；区分性检查产生的卡保存在 evidence_snapshots；
 * llm_calls 只保存脱敏后的请求与输出。另有路由状态（方言档案、估算校准、服务方指纹）与每日 token 用量。
 */
export const researchTrack: Track = {
  track: 'research',
  migrations: [
    {
      version: 1,
      name: 'research runs, model and tool calls, manifests, route state, daily usage, outbox',
      phase: 'expand',
      sql: `
${outboxDdl('worker')}

CREATE TABLE worker.research_runs (
  run_id uuid PRIMARY KEY,
  incident_id uuid NOT NULL,
  incident_version integer NOT NULL,
  cluster_id text NOT NULL,
  reason text NOT NULL,
  state text NOT NULL CHECK (state IN ('hypothesize', 'discriminate', 'conclude', 'completed', 'stage_a_only', 'failed', 'superseded')),
  stop_reason text,
  evidence_fingerprint text NOT NULL,
  disposition text,
  conclusion_level text,
  root_component text,
  summary text,
  output jsonb,
  error jsonb,
  still_consistent boolean NOT NULL DEFAULT false,
  estimated_input_tokens integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost double precision NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  steps jsonb NOT NULL DEFAULT '[]',
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE INDEX research_runs_incident_idx ON worker.research_runs (incident_id, started_at DESC);
CREATE INDEX research_runs_finished_idx ON worker.research_runs (finished_at);

-- 区分性检查产生的证据卡（阶段 A 的卡由 server 保存）
CREATE TABLE worker.evidence_snapshots (
  run_id uuid NOT NULL REFERENCES worker.research_runs (run_id),
  ref text NOT NULL,
  hypothesis_id text NOT NULL,
  judged_by text NOT NULL CHECK (judged_by IN ('rule', 'model')),
  result jsonb NOT NULL,
  PRIMARY KEY (run_id, ref)
);

CREATE TABLE worker.llm_calls (
  run_id uuid NOT NULL REFERENCES worker.research_runs (run_id),
  seq integer NOT NULL,
  phase text NOT NULL,
  route_id text NOT NULL,
  model text NOT NULL,
  prompt_hash text NOT NULL,
  outcome text NOT NULL,
  repair_step text,
  error_kind text,
  http_status integer,
  input_tokens integer NOT NULL,
  cached_input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  reasoning_tokens integer NOT NULL,
  estimated_input_tokens integer NOT NULL,
  cost double precision NOT NULL,
  duration_ms integer NOT NULL,
  bytes integer NOT NULL,
  redaction_hits jsonb NOT NULL,
  categories text[] NOT NULL,
  fingerprint text,
  request_redacted text NOT NULL,
  response_redacted text,
  note text,
  at timestamptz NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE worker.tool_calls (
  run_id uuid NOT NULL REFERENCES worker.research_runs (run_id),
  seq integer NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE worker.research_manifests (
  run_id uuid PRIMARY KEY REFERENCES worker.research_runs (run_id),
  manifest jsonb NOT NULL
);

-- 路由状态：探测得到的方言档案、估算校准、已确认的服务方指纹与指纹变化时间
CREATE TABLE worker.route_state (
  route_id text PRIMARY KEY,
  profile jsonb,
  calibration jsonb,
  fingerprint text,
  fingerprint_changed_at timestamptz,
  probe jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 每天（UTC）全部模型调用的 token 用量（输入 + 输出），覆盖研判、回放与评测
CREATE TABLE worker.daily_usage (
  day date PRIMARY KEY,
  tokens bigint NOT NULL DEFAULT 0,
  cost double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
    },
    {
      version: 2,
      name: 'goal runs and model usage by purpose',
      phase: 'expand',
      // 主动优化（ADR 0146 §5.3、§5.5）：目标运行与事件研判共用 research_runs，incident_id 存目标 id、incident_version 存目标
      // revision，subject_type 区分两者；按用途的每日用量是新表，daily_usage 仍是全部用途的合计（旧版本照常写入）
      sql: `
ALTER TABLE worker.research_runs ADD COLUMN subject_type text NOT NULL DEFAULT 'incident'
  CHECK (subject_type IN ('incident', 'goal'));

CREATE TABLE worker.daily_usage_purpose (
  day date NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('research', 'optimization', 'eval')),
  tokens bigint NOT NULL DEFAULT 0,
  cost double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, purpose)
);
`,
    },
  ],
};

export const workerTracks: readonly Track[] = [researchTrack];
