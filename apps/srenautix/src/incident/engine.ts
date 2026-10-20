import type { Alert, ChangeEvent, Incident, TopologyEdge, TopologyNode } from '@srenautix/contract';
import {
  computeIncidents,
  reconcileIncidents,
  TopologyGraph,
  type IncidentChange,
  type ProbeResult,
  type ResolvedRcaParams,
} from '@srenautix/core';
import type pg from 'pg';
import { activeAlerts } from '../ingest/store.js';
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
      const changes = await this.d.changes(clusterId, new Date(now.getTime() - params.changeWindowMs - lookback), now);
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
        const result = reconcileIncidents({
          clusterId,
          previous,
          computed,
          topologyVersion: topo.version,
          now: now.getTime(),
        });
        const before = new Map(previous.map((p) => [p.incident_id, p]));
        const sources = new Map(alerts.map((a) => [a.alert_id, a.source]));
        const toReport: Incident[] = [];
        for (const inc of result.incidents) {
          const suppressed = await this.d.suppressedAlertIds(
            c,
            clusterId,
            inc.members.filter((m) => m.left_version === null && m.status === 'firing').map((m) => m.alert_id),
          );
          const firing = inc.members.filter((m) => m.left_version === null && m.status === 'firing');
          if (firing.length > 0 && firing.every((m) => suppressed.has(m.alert_id))) {
            inc.suppressed = true;
          }
          const prev = before.get(inc.incident_id);
          await this.persist(c, inc, prev);
          if (!prev && inc.state === 'firing') {
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
          if (inc.state !== 'merged' && (!prev || prev.incident_version !== inc.incident_version)) {
            toReport.push(inc);
            const b = await currentBinding(c, inc.incident_id);
            if (b) {
              await this.d.stale.markStale(c, b);
            }
          }
        }
        const events: NewEvent[] = result.changes.map((ch) => toEvent(clusterId, ch));
        await appendEvents(c, 'server', 'server', SCHEMA_VERSION, events);
        const current = new Map(previous.map((p) => [p.incident_id, p]));
        for (const inc of result.incidents) {
          current.set(inc.incident_id, inc);
        }
        return {
          changes: result.changes,
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
        [inc.incident_id, inc.incident_version, JSON.stringify(inc), prev ? 'updated' : 'created'],
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
