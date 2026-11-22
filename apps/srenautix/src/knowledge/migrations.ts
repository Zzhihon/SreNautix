import type { Track } from '../kernel/store/migrate.js';

export const knowledgeTrack: Track = {
  track: 'knowledge',
  migrations: [
    {
      version: 1,
      name: 'learned knowledge cases from online feedback',
      phase: 'expand',
      sql: `
-- 在线反馈沉淀的知识案例：支持真实根因（incident）与确认的良性/误报模式（benign）。
-- incident_id 与 feedback_id 为软引用，不建跨轨道外键；只追加、软归档（archived_at），
-- 同一集群、同一事件、同一种类最多一条未归档记录（一键沉淀幂等）。只加表与索引（ADR 0176），N-1 版本照常运行
CREATE TABLE server.learned_knowledge (
  case_id uuid PRIMARY KEY,
  cluster_id text NOT NULL,
  incident_id uuid,
  feedback_id uuid,
  kind text NOT NULL CHECK (kind IN ('incident', 'benign')),
  title text NOT NULL CHECK (char_length(title) <= 200),
  components text[] NOT NULL DEFAULT '{}',
  alertnames text[] NOT NULL DEFAULT '{}',
  text text NOT NULL CHECK (char_length(text) <= 2000),
  source text NOT NULL DEFAULT 'human' CHECK (source IN ('human', 'model')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX learned_knowledge_active_incident_idx
  ON server.learned_knowledge (cluster_id, incident_id, kind)
  WHERE incident_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX learned_knowledge_active_cluster_idx
  ON server.learned_knowledge (cluster_id, created_at DESC)
  WHERE archived_at IS NULL;
CREATE INDEX learned_knowledge_components_idx
  ON server.learned_knowledge USING gin (components)
  WHERE archived_at IS NULL;
CREATE INDEX learned_knowledge_alertnames_idx
  ON server.learned_knowledge USING gin (alertnames)
  WHERE archived_at IS NULL;
`,
    },
  ],
};
