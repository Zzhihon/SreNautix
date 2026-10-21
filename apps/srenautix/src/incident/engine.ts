import type { Alert, ChangeEvent, Incident, TopologyEdge, TopologyNode } from '@srenautix/contract';
import {
  changeInputFrom,
  computedLabel,
  computeIncidents,
  reconcileIncidents,
  TopologyGraph,
  type ComputedIncident,
  type IncidentChange,
  type ProbeResult,
  type ResolvedRcaParams,
} from '@srenautix/core';
import type pg from 'pg';
import { activeAlerts } from '../ingest/store.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { appendEvents, type NewEvent } from '../store/outbox.js';
import { tx, type Queryable } from '../store/pool.js';
import type { TopologyStore } from '../topology/store.js';
import { currentBinding } from './read.js';

export const SCHEMA_VERSION = '2.2.0';

/** 版本变化时同一事务内调用：把绑定失效的提议标为 stale（由提议服务实现）。 */
export interface StaleMarker {
  markStale(c: Queryable, b: NonNullable<Awaited<ReturnType<typeof currentBinding>>>): Promise<number>;
}

export interface EngineDeps {
  pool: pg.Pool;
  topology: TopologyStore;
  params: () => ResolvedRcaParams;
  /** 窗口内的变更事件（changes 集成）；没有变更源时返回空数组。 */
  changes(clusterId: string, from: Date, to: Date): Promise<ChangeEvent[]>;
  /** 沉默根因探测卡的结果（阶段 A 的探测卡）；没有时返回空数组。 */
  probes(clusterId: string): Promise<ProbeResult[]>;
  stale: StaleMarker;
  metrics: ServerMetrics;
  /** 抑制规则（SreNautix 自己的，DESIGN §2.1）：返回命中的成员 alert_id 集合。 */
  suppressedAlertIds(c: Queryable, clusterId: string, alertIds: string[]): Promise<Set<string>>;
}

export interface RecomputeResult {
  changes: IncidentChange[];
  /** 新建或版本变化、需要重新出阶段 A 的事件。 */
  toReport: Incident[];
  /** 本轮的输入与对账后的全部未合并事件，降级通道在状态库不可用时以它为起点。 */
  state: {
    alerts: Alert[];
    nodes: TopologyNode[];
    edges: TopologyEdge[];
    topologyVersion: number;
    incidents: Incident[];
  };
}

/**
 * 事件引擎（DESIGN §2.2）：唯一写入方。每次对账按确定性规则重算（packages/core 的收敛与根因排序），
 * 再与已持久化的事件对账（合并写别名、拆分记 split_from），在一个事务里写入事件、版本、成员、别名与 outbox。
 * 超出回看窗口、与本轮分组共享成员或标签的事件也参与对账（重开或占用标签）；每组事件在自己的保存点里写入，
 * 一组失败不影响其余（ADR 0132）。
 */
export class IncidentEngine {
  constructor(private readonly d: EngineDeps) {}

  async recompute(clusterId: string): Promise<RecomputeResult> {
    const end = this.d.metrics.incidentRecomputeDuration.startTimer();
    try {
      const params = this.d.params();
      const nowRow = await this.d.pool.query<{ now: Date }>('SELECT now() AS now');
      const now = (nowRow.rows[0] as { now: Date }).now;
      const lookback = params.adjacencyMs;
      const alerts = await activeAlerts(this.d.pool, clusterId, lookback);
      const topo = await this.d.topology.at(clusterId, now);
      const graph = new TopologyGraph(topo.nodes, topo.edges, topo.version);
      // 仍在触发或回看窗口内的告警可以关联到它开始之前一个窗口内的变更：输入从最早的告警往前算（ADR 0104）
      const changes = await this.d.changes(clusterId, new Date(changeInputFrom(alerts, now.getTime(), params)), now);
      const computed = computeIncidents({
        alerts,
        changes,
        graph,
        params,
        now: now.getTime(),
        probes: await this.d.probes(clusterId),
      });
      return await tx(this.d.pool, async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`srenautix.incident-engine.${clusterId}`]);
        const prevRows = await c.query<{ body: Incident }>(
          `SELECT body FROM server.incidents WHERE cluster_id = $1 AND state <> 'merged'
             AND (state = 'firing' OR ended_at > $2::timestamptz - make_interval(secs => $3))`,
          [clusterId, now, lookback / 1000],
        );
        const previous = prevRows.rows.map((r) => r.body);
        const dormant = await dormantIncidents(c, clusterId, previous, computed);
        const result = reconcileIncidents({
          clusterId,
          previous,
          dormant,
          computed,
          topologyVersion: topo.version,
          now: now.getTime(),
        });
        const before = new Map([...dormant, ...previous].map((p) => [p.incident_id, p]));
        const sources = new Map(alerts.map((a) => [a.alert_id, a.source]));
        const toReport: Incident[] = [];
        const failed = new Set<string>();
        // 每组（合并、拆分牵连的事件为一组）在自己的保存点里写入：一组失败只回滚这一组，其余照常写入（ADR 0132）
        for (const unit of persistUnits(result.incidents)) {
          const reported: Incident[] = [];
          const detected: Incident[] = [];
          await c.query('SAVEPOINT incident_persist');
          try {
            for (const inc of unit) {
              const firing = inc.members.filter((m) => m.left_version === null && m.status === 'firing');
              const suppressed = await this.d.suppressedAlertIds(
                c,
                clusterId,
                firing.map((m) => m.alert_id),
              );
              if (firing.length > 0 && firing.every((m) => suppressed.has(m.alert_id))) {
                inc.suppressed = true;
              }
              const prev = before.get(inc.incident_id);
              await this.persist(c, inc, prev);
              if (!prev && inc.state === 'firing') {
                detected.push(inc);
              }
              if (inc.state !== 'merged' && (!prev || prev.incident_version !== inc.incident_version)) {
                reported.push(inc);
                const b = await currentBinding(c, inc.incident_id);
                if (b) {
                  await this.d.stale.markStale(c, b);
                }
              }
            }
            await c.query('RELEASE SAVEPOINT incident_persist');
          } catch (e) {
            await c.query('ROLLBACK TO SAVEPOINT incident_persist');
            await c.query('RELEASE SAVEPOINT incident_persist');
            for (const inc of unit) {
              failed.add(inc.incident_id);
            }
            this.d.metrics.incidentPersistErrors.inc({ cluster_id: clusterId });
            logger.error('事件写入失败，本组回滚，其余事件照常写入，下一轮重试', {
              cluster_id: clusterId,
              incidents: unit.map((i) => ({ incident_id: i.incident_id, label: i.label, version: i.incident_version })),
              error: e,
            });
            continue;
          }
          toReport.push(...reported);
          for (const inc of detected) {
            // 检测延迟：首个症状到事件创建（验收 p95 ≤ 2 分钟）；最早的成员是检测器发现时记为 detector
            const first = [...inc.members].sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
            if (first) {
              const source = sources.get(first.alert_id) === 'detector' ? 'detector' : 'alert';
              this.d.metrics.incidentDetection.observe(
                { source },
                Math.max(0, (now.getTime() - Date.parse(first.starts_at)) / 1000),
              );
            }
          }
        }
        // 没有写入的事件不发事件流，也不进本轮状态（保持写入前的样子）
        const changes = result.changes
          .map((ch) => writtenChange(ch, failed))
          .filter((ch): ch is IncidentChange => ch !== null);
        const events: NewEvent[] = changes.map((ch) => toEvent(clusterId, ch));
        await appendEvents(c, 'server', 'server', SCHEMA_VERSION, events);
        const current = new Map(previous.map((p) => [p.incident_id, p]));
        for (const inc of result.incidents) {
          if (!failed.has(inc.incident_id)) {
            current.set(inc.incident_id, inc);
          }
        }
        return {
          changes,
          toReport,
          state: {
            alerts,
            nodes: topo.nodes,
            edges: topo.edges,
            topologyVersion: topo.version,
            incidents: [...current.values()].filter((x) => x.state !== 'merged'),
          },
        };
      });
    } finally {
      end();
    }
  }

  private async persist(c: Queryable, inc: Incident, prev: Incident | undefined): Promise<void> {
    await c.query(
      `INSERT INTO server.incidents (incident_id, cluster_id, label, version, state, severity, first_firing_at, ended_at, root_component,
         suppressed, observability_blind, split_from, merged_into, body, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (incident_id) DO UPDATE SET version = excluded.version, state = excluded.state, severity = excluded.severity,
         first_firing_at = excluded.first_firing_at, ended_at = excluded.ended_at, root_component = excluded.root_component,
         suppressed = excluded.suppressed, observability_blind = excluded.observability_blind, split_from = excluded.split_from,
         merged_into = excluded.merged_into, body = excluded.body, updated_at = excluded.updated_at`,
      [
        inc.incident_id,
        inc.cluster_id,
        inc.label,
        inc.incident_version,
        inc.state,
        inc.severity,
        inc.first_firing_at,
        inc.ended_at,
        inc.root.component,
        inc.suppressed,
        inc.observability_blind,
        inc.split_from,
        inc.merged_into,
        JSON.stringify(inc),
        inc.created_at,
        inc.updated_at,
      ],
    );
    if (!prev || prev.incident_version !== inc.incident_version) {
      await c.query(
        'INSERT INTO server.incident_versions (incident_id, version, body, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [
          inc.incident_id,
          inc.incident_version,
          JSON.stringify(inc),
          !prev ? 'created' : prev.state === 'resolved' && inc.state === 'firing' ? 'reopened' : 'updated',
        ],
      );
    }
    await c.query('DELETE FROM server.incident_members WHERE incident_id = $1', [inc.incident_id]);
    for (const m of inc.members) {
      await c.query(
        'INSERT INTO server.incident_members (incident_id, alert_id, joined_version, left_version) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [inc.incident_id, m.alert_id, m.joined_version, m.left_version],
      );
    }
    for (const a of inc.aliases) {
      await c.query(
        `INSERT INTO server.incident_aliases (from_incident_id, from_label, cluster_id, into_incident_id, at_version, merged_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (from_incident_id) DO UPDATE SET into_incident_id = excluded.into_incident_id`,
        [a.from_incident_id, a.from_label, inc.cluster_id, inc.incident_id, a.at_version, a.merged_at],
      );
    }
  }
}

/**
 * 不在 previous 里、但与本轮分组相关的已持久化事件（超出回看窗口的 resolved 与 merged）：共享仍在的成员告警，
 * 或标签是某个分组的标签（含去重后缀）。对账据此重开事件、避开已占用的标签（ADR 0132）
 */
async function dormantIncidents(
  c: Queryable,
  clusterId: string,
  previous: readonly Incident[],
  computed: readonly ComputedIncident[],
): Promise<Incident[]> {
  if (computed.length === 0) {
    return [];
  }
  const labels = [...new Set(computed.map(computedLabel))];
  const alertIds = [...new Set(computed.flatMap((x) => x.group.alerts.map((a) => a.alert.alert_id)))];
  const r = await c.query<{ body: Incident }>(
    `SELECT i.body FROM server.incidents i
      WHERE i.cluster_id = $1 AND NOT (i.incident_id = ANY($2::uuid[]))
        AND (i.label = ANY($3::text[])
             OR EXISTS (SELECT 1 FROM unnest($3::text[]) b WHERE starts_with(i.label, b || '~'))
             OR i.incident_id IN (SELECT m.incident_id FROM server.incident_members m
                                   WHERE m.alert_id = ANY($4::text[]) AND m.left_version IS NULL))
      ORDER BY i.created_at, i.incident_id`,
    [clusterId, previous.map((p) => p.incident_id), labels, alertIds],
  );
  return r.rows.map((x) => x.body);
}

/** 写入的分组：合并（merged_into、别名）与拆分（split_from）牵连的事件在同一组，保持按 incident_id 的顺序 */
export function persistUnits(incidents: readonly Incident[]): Incident[][] {
  const parent = new Map(incidents.map((i) => [i.incident_id, i.incident_id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) {
      r = parent.get(r)!;
    }
    parent.set(id, r);
    return r;
  };
  const union = (a: string, b: string | null) => {
    if (b !== null && parent.has(b)) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) {
        parent.set(rb, ra);
      }
    }
  };
  for (const i of incidents) {
    union(i.incident_id, i.merged_into);
    union(i.incident_id, i.split_from);
    for (const a of i.aliases) {
      union(i.incident_id, a.from_incident_id);
    }
  }
  const units = new Map<string, Incident[]>();
  for (const i of incidents) {
    const root = find(i.incident_id);
    units.set(root, [...(units.get(root) ?? []), i]);
  }
  return [...units.values()];
}

/** 去掉牵涉没有写入的事件的变化；拆分只去掉没有写入的新事件 */
function writtenChange(ch: IncidentChange, failed: ReadonlySet<string>): IncidentChange | null {
  switch (ch.type) {
    case 'incident.created':
    case 'incident.updated':
    case 'incident.resolved':
      return failed.has(ch.incident.incident_id) ? null : ch;
    case 'incident.merged':
      return failed.has(ch.from_incident_id) || failed.has(ch.into_incident_id) ? null : ch;
    case 'incident.split': {
      const ids = ch.new_incident_ids.filter((id) => !failed.has(id));
      return failed.has(ch.from_incident_id) || ids.length === 0 ? null : { ...ch, new_incident_ids: ids };
    }
  }
}

function toEvent(clusterId: string, ch: IncidentChange): NewEvent {
  switch (ch.type) {
    case 'incident.created':
    case 'incident.updated':
    case 'incident.resolved':
      return { type: ch.type, clusterId, payload: ch.incident };
    case 'incident.merged':
      return {
        type: ch.type,
        clusterId,
        payload: {
          from_incident_id: ch.from_incident_id,
          into_incident_id: ch.into_incident_id,
          into_version: ch.into_version,
        },
      };
    case 'incident.split':
      return {
        type: ch.type,
        clusterId,
        payload: {
          from_incident_id: ch.from_incident_id,
          from_version: ch.from_version,
          new_incident_ids: ch.new_incident_ids,
        },
      };
  }
}
