import { auditDdl } from './audit.js';
import type { Track } from './migrate.js';
import { outboxDdl } from './outbox.js';

/** server schema 的基础轨道：outbox、幂等键、系统状态、状态条件。 */
export const storeTrack: Track = {
  track: 'store',
  migrations: [
    {
      version: 1,
      name: 'outbox, idempotency, system state, conditions',
      phase: 'expand',
      sql: `
${outboxDdl('server')}

-- 写接口的幂等键（Idempotency-Key 请求头）：同一调用方、同一键在 24 小时内返回第一次的结果
CREATE TABLE server.idempotency_keys (
  caller text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, key)
);
CREATE INDEX idempotency_keys_created_idx ON server.idempotency_keys (created_at);

-- 单值系统状态：恢复标记 restored_at、本地管理员停用时间、软暂停等
CREATE TABLE server.system_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 各角色上报的状态条件（DESIGN §12.4）；(role, cluster_id, type, subject) 唯一
CREATE TABLE server.conditions (
  role text NOT NULL,
  cluster_id text NOT NULL DEFAULT '',
  type text NOT NULL,
  subject text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('true', 'false')),
  reason text NOT NULL,
  message text NOT NULL,
  since timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, cluster_id, type, subject)
);

${auditDdl}
`,
    },
    {
      version: 2,
      name: 'one-time data corrections run by the leader',
      phase: 'expand',
      sql: `
-- 数据修正（ADR 0176）：迁移只改 schema；会被 N-1 版本按旧语义改写的数据修正，由取得主实例之后的本版本执行一次，
-- 每个修正一行。holder 是执行它的实例，rows 是改动的行数
CREATE TABLE server.data_corrections (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  holder text NOT NULL,
  rows integer NOT NULL
);
`,
    },
  ],
};
