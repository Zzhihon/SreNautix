import type { Track } from '../store/migrate.js';

// 主动优化的 server 表（ADR 0146 §1、§4.5、§5.5）。新表都以目标 id 或发现指纹建索引（§6.3）；
// 验证循环只读 verifying 与 recommended 状态的建议。

export const optimizationTrack: Track = {
  track: 'optimization',
  migrations: [
    {
      version: 1,
      name: 'goals, goal runs, findings, recommendations and the subject of research queue entries',
      phase: 'expand',
      sql: `
-- 目标（契约 Goal）：spec 是 GoalSpec；revision 每次修改规格加一
CREATE TABLE server.goals (
  goal_id uuid PRIMARY KEY,
  cluster_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  spec jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'analyzing', 'recommended', 'verifying', 'achieved', 'not_achieved',
    'no_action', 'cancelled', 'expired', 'failed')),
  state_reason text,
  origin_kind text NOT NULL CHECK (origin_kind IN ('manual', 'checkup', 'trend', 'forecast_alert')),
  -- manual 的下达主体（每个主体每天最多 5 个目标）
  principal text,
  -- 目标对象的领域（领域体检）或指标（指标目标），列表过滤用
  domain text,
  indicator text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX goals_cluster_idx ON server.goals (cluster_id, created_at DESC);
CREATE INDEX goals_open_idx ON server.goals (cluster_id) WHERE state IN ('queued', 'analyzing', 'recommended', 'verifying');
CREATE INDEX goals_principal_idx ON server.goals (principal, created_at) WHERE principal IS NOT NULL;

-- 目标的每次运行（契约 GoalRunSummary）：context 是 server 为 worker 准备的输入（基线、候选、诊断卡与份额卡），
-- output 是经代码校验的运行输出（OptimizationOutput）
CREATE TABLE server.goal_runs (
  run_id uuid PRIMARY KEY,
  goal_id uuid NOT NULL REFERENCES server.goals (goal_id) ON DELETE CASCADE,
  goal_revision integer NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'deferred', 'running', 'concluded', 'failed', 'cancelled')),
  result text CHECK (result IN ('no_gap', 'recommended', 'report_only')),
  reason text,
  gap boolean,
  findings integer NOT NULL DEFAULT 0,
  recommendations integer NOT NULL DEFAULT 0,
  context jsonb,
  output jsonb,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX goal_runs_goal_idx ON server.goal_runs (goal_id, queued_at DESC);
CREATE INDEX goal_runs_due_idx ON server.goal_runs (next_attempt_at) WHERE state IN ('queued', 'deferred');

-- 发现（契约 Finding）：指纹是去重的唯一键；gap_at_rejection 是被拒绝时的差距（冷却期内差距扩大 50% 以上才重新生成建议）
CREATE TABLE server.optimization_findings (
  fingerprint text PRIMARY KEY,
  cluster_id text NOT NULL,
  domain text NOT NULL,
  kind text NOT NULL,
  entity_key text NOT NULL,
  component text NOT NULL,
  status text NOT NULL,
  body jsonb NOT NULL,
  gap_at_rejection double precision,
  verifying_until timestamptz,
  last_seen timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX optimization_findings_seen_idx ON server.optimization_findings (cluster_id, last_seen DESC);
CREATE INDEX optimization_findings_component_idx ON server.optimization_findings (component);

-- 建议（契约 OptimizationRecommendation）：target_key 是模板、对象与参数的摘要（G4：同一对象与参数 7 天内合并过 PR 时跳过）
CREATE TABLE server.optimization_recommendations (
  recommendation_id uuid PRIMARY KEY,
  cluster_id text NOT NULL,
  finding text NOT NULL,
  goal_id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ops_pr', 'business_issue')),
  template text NOT NULL,
  state text NOT NULL,
  target_key text,
  repository text,
  body jsonb NOT NULL,
  -- 发布与验证循环的退避
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  delivered_at timestamptz,
  merged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX optimization_recommendations_finding_idx ON server.optimization_recommendations (finding, created_at DESC);
CREATE INDEX optimization_recommendations_goal_idx ON server.optimization_recommendations (goal_id, created_at DESC);
CREATE INDEX optimization_recommendations_active_idx ON server.optimization_recommendations (next_attempt_at)
  WHERE state IN ('open', 'recommended', 'verifying');
CREATE INDEX optimization_recommendations_delivered_idx ON server.optimization_recommendations (kind, repository, delivered_at)
  WHERE delivered_at IS NOT NULL;

-- 建议的门槛记录（与 remediation_attempts 同样的原因码方式，ADR 0146 §2.5）
CREATE TABLE server.recommendation_attempts (
  run_id uuid NOT NULL,
  finding text NOT NULL,
  template text NOT NULL,
  kind text NOT NULL,
  passed boolean NOT NULL,
  gate text,
  code text,
  gates jsonb NOT NULL,
  recommendation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, finding, template)
);

-- 研判队列的主体（契约 Subject）：incident 事件；goal 目标运行，incident_id 取目标 id，incident_version 取 revision
ALTER TABLE server.research_queue ADD COLUMN subject_type text NOT NULL DEFAULT 'incident'
  CHECK (subject_type IN ('incident', 'goal'));
`,
    },
    {
      version: 2,
      name: 'what a recommendation delivers and the issue state used for marker recovery',
      phase: 'expand',
      sql: `
-- 投递所需的内容：ops_pr 为模板键、仓库角色与计划的提交（每次投递前按当前 base 重新计划）；business_issue 为
-- 模板键、锚点、建议与标签（投递时做代码定位并渲染 issue）
ALTER TABLE server.optimization_recommendations ADD COLUMN plan jsonb;
-- 业务 issue 的创建状态（与事件 issue 同一套机制，ADR 0095）：创建请求的结果未知（超时、连接中断、5xx）时为 unknown，
-- 下一轮先按标记 srenautix:recommendation=<id> 在仓库中找回
ALTER TABLE server.optimization_recommendations ADD COLUMN issue_state text
  CHECK (issue_state IN ('pending', 'unknown', 'open', 'closed'));
`,
    },
  ],
};
