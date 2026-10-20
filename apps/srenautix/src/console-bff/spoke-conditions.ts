import { CONDITION_DIRECTIONS, type ConditionDirections } from '@srenautix/contract';
import type { Queryable } from '../store/pool.js';

// 分支角色（gateway、reader）上报的状态条件（ADR 0098 之后的契约 2.10.0，contract/conditions.json）：
// - 方向：每个角色的条件哪个取值表示正常，由契约的方向表给出，server、控制台与 chart 的告警规则都按这张表判断；
// - 替换：心跳带来该角色当前的全部条件，server 只保留这一次心跳里的条件，换 Pod 后旧 Pod 的条件行随之删除；
// - 过期：心跳超过 offline 时长没有到达时清除该角色的条件，reader 另留一条"离线"（TunnelConnected/ReaderOffline）。

type Role = keyof ConditionDirections['roles'];
type RoleSpec = NonNullable<ConditionDirections['roles'][Role]>;

function spec(role: Role): RoleSpec {
  const s = CONDITION_DIRECTIONS.roles[role];
  if (!s) {
    throw new Error(`契约的状态条件方向表里没有角色 ${role}`);
  }
  return s;
}

/** 某个角色的某个条件类型正常时的取值 */
export function healthyValue(role: Role, type: string): string {
  const s = spec(role);
  return s.types[type]?.healthy ?? s.healthy;
}

/** 条件是否正常；Unknown 与方向表之外的取值都算异常 */
export function isHealthy(role: Role, type: string, status: string): boolean {
  return status === healthyValue(role, type);
}

/** 异常时是否告警（冻结之类预期的运行模式为 false，状态条照常显示） */
export function alerts(role: Role, type: string): boolean {
  return spec(role).types[type]?.alert ?? true;
}

/**
 * 分支心跳的条件在状态条上的类型：gateway 按方向表的 strip_type（null 不转发），reader 用原类型。
 * 方向表之外的新类型：reader 原样转发（控制台容忍未知类型），gateway 不转发。
 */
export function stripType(role: 'gateway' | 'reader', type: string): string | null {
  const t = spec(role).types[type];
  if (role === 'reader') {
    return type;
  }
  return t?.strip_type ?? null;
}

export interface HeartbeatCondition {
  type: string;
  status: string;
  reason: string;
  message?: string;
  since: string;
}

/**
 * 用一次心跳的条件替换该角色在该集群的状态条条件：status 按方向表换算（true 表示问题正在发生），
 * subject 是上报的实例（gateway 为 Pod 名，即 Lease 身份；reader 为空，每个集群只有一个 reader 会话）。
 * 这次心跳没有列出的条件（包括其他实例的）一并删除，换 Pod 或换主之后不会留下旧实例的行。
 */
export async function replaceSpokeConditions(
  c: Queryable,
  role: 'gateway' | 'reader',
  clusterId: string,
  subject: string,
  conditions: readonly HeartbeatCondition[],
): Promise<void> {
  const rows = conditions.flatMap((x) => {
    const type = stripType(role, x.type);
    return type === null ? [] : [{ x, type, problem: !isHealthy(role, x.type, x.status) }];
  });
  await c.query(
    `DELETE FROM server.conditions WHERE role = $1 AND cluster_id = $2 AND (subject <> $3 OR NOT (type = ANY($4::text[])))`,
    [role, clusterId, subject, rows.map((r) => r.type)],
  );
  for (const r of rows) {
    await c.query(
      `INSERT INTO server.conditions (role, cluster_id, type, subject, status, reason, message, since, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (role, cluster_id, type, subject) DO UPDATE SET status = excluded.status, reason = excluded.reason,
         message = excluded.message, since = CASE WHEN server.conditions.status = excluded.status THEN server.conditions.since ELSE excluded.since END,
         updated_at = now()`,
      [role, clusterId, r.type, subject, r.problem ? 'true' : 'false', r.x.reason, r.x.message ?? '', r.x.since],
    );
  }
}

/**
 * 分支角色离线后的条件（状态条件循环每 15 秒调用一次），reader 与 gateway 同一套规则：
 * 心跳超过 offlineMs 没有到达的集群，清除该角色之前上报的条件（不再保留旧状态）。reader 另留一条 TunnelConnected
 * （原因 ReaderOffline）说明离线；gateway 离线由集群页的"仅提议"显示（spoke_status 过期）。心跳恢复时由心跳覆盖。
 * 本集群的拓扑不经 reader（例如 reader 已关闭）时，reader 的条件全部清除，不显示离线。
 * 没有任何心跳记录、却还有该角色条件的集群（例如状态表被清理过）同样清除。返回变更的行数。
 */
export async function expireSpokeConditions(
  c: Queryable,
  offlineMs: number,
  local: { clusterId: string; usesReader: boolean },
): Promise<number> {
  const secs = offlineMs / 1000;
  let changed = 0;
  const stale = await c.query<{ cluster_id: string; received_at: Date }>(
    `SELECT cluster_id, received_at FROM server.reader_status WHERE received_at < now() - make_interval(secs => $1)`,
    [secs],
  );
  for (const r of stale.rows) {
    const unused = r.cluster_id === local.clusterId && !local.usesReader;
    const del = await c.query(
      `DELETE FROM server.conditions WHERE role = 'reader' AND cluster_id = $1 AND ($2 OR NOT (type = 'TunnelConnected' AND reason = 'ReaderOffline'))`,
      [r.cluster_id, unused],
    );
    changed += del.rowCount ?? 0;
    if (unused) {
      continue;
    }
    const up = await c.query(
      `INSERT INTO server.conditions (role, cluster_id, type, subject, status, reason, message, since, updated_at)
       VALUES ('reader', $1, 'TunnelConnected', '', 'true', 'ReaderOffline', $2, $3, now())
       ON CONFLICT (role, cluster_id, type, subject) DO NOTHING`,
      [
        r.cluster_id,
        `reader 已离线：自 ${r.received_at.toISOString()} 起没有心跳（超过 ${secs} 秒），它之前上报的条件已清除`,
        r.received_at,
      ],
    );
    changed += up.rowCount ?? 0;
  }
  const gw = await c.query(
    `DELETE FROM server.conditions c WHERE c.role = 'gateway' AND EXISTS (
       SELECT 1 FROM server.spoke_status s WHERE s.cluster_id = c.cluster_id AND s.received_at < now() - make_interval(secs => $1))`,
    [secs],
  );
  changed += gw.rowCount ?? 0;
  const orphan = await c.query(
    `DELETE FROM server.conditions c WHERE
       (c.role = 'reader' AND NOT EXISTS (SELECT 1 FROM server.reader_status r WHERE r.cluster_id = c.cluster_id))
       OR (c.role = 'gateway' AND NOT EXISTS (SELECT 1 FROM server.spoke_status s WHERE s.cluster_id = c.cluster_id))`,
  );
  return changed + (orphan.rowCount ?? 0);
}
