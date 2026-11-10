import type { Queryable } from '../kernel/store/pool.js';

// 事件的认领（ADR 0195）：server.incident_claim_events 只追加，每个事件最近一条为 claim 时它的主体是处理人。
// 认领时已有处理人就是接手；放下记 release。认领与放下都进入事件时间线。

export type ClaimChannel = 'console' | 'grafana' | 'telegram' | 'feishu';

export interface IncidentClaim {
  principal_id: string;
  channel: ClaimChannel;
  claimed_at: string;
}

export interface ClaimEvent {
  action: 'claim' | 'release';
  principal_id: string;
  channel: ClaimChannel;
  at: Date;
}

/** 认领：调用方成为处理人，返回当前处理人 */
export async function claimIncident(
  db: Queryable,
  incidentId: string,
  principalId: string,
  channel: ClaimChannel,
): Promise<IncidentClaim> {
  const r = await db.query<{ at: Date }>(
    `INSERT INTO server.incident_claim_events (incident_id, action, principal_id, channel)
     VALUES ($1, 'claim', $2, $3) RETURNING at`,
    [incidentId, principalId, channel],
  );
  return { principal_id: principalId, channel, claimed_at: r.rows[0]!.at.toISOString() };
}

/** 放下：有处理人时记一条 release；没有处理人时不做事，返回 false */
export async function releaseIncident(
  db: Queryable,
  incidentId: string,
  principalId: string,
  channel: ClaimChannel,
): Promise<boolean> {
  const current = (await currentClaims(db, [incidentId])).get(incidentId);
  if (!current) {
    return false;
  }
  await db.query(
    `INSERT INTO server.incident_claim_events (incident_id, action, principal_id, channel) VALUES ($1, 'release', $2, $3)`,
    [incidentId, principalId, channel],
  );
  return true;
}

/** 一批事件的当前处理人；没有处理人的事件不在结果里 */
export async function currentClaims(
  db: Queryable,
  incidentIds: readonly string[],
): Promise<Map<string, IncidentClaim>> {
  if (!incidentIds.length) {
    return new Map();
  }
  const r = await db.query<{
    incident_id: string;
    action: string;
    principal_id: string;
    channel: ClaimChannel;
    at: Date;
  }>(
    `SELECT DISTINCT ON (incident_id) incident_id, action, principal_id, channel, at FROM server.incident_claim_events
      WHERE incident_id = ANY($1::uuid[]) ORDER BY incident_id, id DESC`,
    [incidentIds],
  );
  return new Map(
    r.rows
      .filter((x) => x.action === 'claim')
      .map((x) => [
        x.incident_id,
        { principal_id: x.principal_id, channel: x.channel, claimed_at: x.at.toISOString() },
      ]),
  );
}

/** 一个事件的全部认领与放下，按时间先后（时间线用） */
export async function claimEvents(db: Queryable, incidentId: string): Promise<ClaimEvent[]> {
  const r = await db.query<ClaimEvent>(
    `SELECT action, principal_id, channel, at FROM server.incident_claim_events WHERE incident_id = $1 ORDER BY id`,
    [incidentId],
  );
  return r.rows;
}
