import type { Proposal } from '@srenautix/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { forbidden, HttpError, notFound } from '../api/errors.js';
import { checkBody, openapiValidator } from '../api/openapi-schemas.js';
import type { Auth } from '../identity/auth.js';
import type { OutboxListener } from '../events/listener.js';
import { currentBinding } from '../incident/read.js';
import { appendEvents } from '../store/outbox.js';
import { tx, type Queryable } from '../store/pool.js';
import { bindingMatches, SCHEMA_VERSION } from './service.js';
import type { ApprovalEnvelope } from './assertion.js';
import type { Catalog } from './catalog.js';

const DOC = 'gateway/v1/openapi.yaml';

interface ExecutionEvent {
  event_id: string;
  execution_id: string;
  ticket_id: string;
  proposal_id: string;
  seq: number;
  phase: string;
  at: string;
  reason: string;
  message?: string;
  requires?: 'human_approval' | 'tier_h' | 'reapproval';
  queue_position?: number;
  restore_params?: Record<string, unknown>;
}

interface Heartbeat {
  gateway_id: string;
  version: string;
  leader: boolean;
  propose_only: boolean;
  conditions: Array<{ type: string; status: string; reason: string; message?: string; since: string }>;
  queue: unknown[];
  clock_skew_seconds: { apiserver: number; ntp?: number };
}

const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * 工单协议的中心一侧（contract/gateway/v1/openapi.yaml，ADR 0021）：分支 gateway 长轮询拉取已批准的工单、
 * 推送执行事件、执行前复核绑定、上报心跳。每个分支一个 token，X-SreNautix-Cluster 必须与 token 的集群相同。
 */
export class SpokeRelay {
  constructor(
    private readonly pool: pg.Pool,
    private readonly listener: OutboxListener,
    private readonly catalog: Catalog,
  ) {}

  async clock(c: Queryable): Promise<{ server_time: string; restored_at: string | null }> {
    const r = await c.query<{ now: Date; restored: string | null }>(
      "SELECT now() AS now, (SELECT value #>> '{}' FROM server.system_state WHERE key = 'restored_at') AS restored",
    );
    const row = r.rows[0] as { now: Date; restored: string | null };
    return { server_time: fmt(row.now), restored_at: row.restored ? fmt(new Date(row.restored)) : null };
  }

  async softPaused(c: Queryable): Promise<boolean> {
    const r = await c.query<{ v: boolean | null }>(
      "SELECT (value->>'paused')::boolean AS v FROM server.system_state WHERE key = 'soft_pause'",
    );
    return r.rows[0]?.v ?? false;
  }

  /** 本集群已签发、尚未被确认拉取、审批未过期、提议仍有效的工单。软暂停时扣住不下发。 */
  async tickets(
    clusterId: string,
    max: number,
  ): Promise<{ server_time: string; restored_at: string | null; tickets: unknown[] }> {
    return tx(this.pool, async (c) => {
      const clock = await this.clock(c);
      if (await this.softPaused(c)) {
        return { ...clock, tickets: [] };
      }
      const r = await c.query<{
        assertion_id: string;
        envelope: ApprovalEnvelope;
        body: Proposal;
        ttl_expires_at: Date | null;
        created_at: Date;
      }>(
        `SELECT a.assertion_id, a.envelope, p.body, p.ttl_expires_at, p.created_at FROM server.approval_assertions a
           JOIN server.proposals p ON p.proposal_id = a.proposal_id
          WHERE a.cluster_id = $1 AND a.pulled_at IS NULL AND a.expires_at > now() AND p.state = 'approved'
          ORDER BY a.issued_at LIMIT $2 FOR UPDATE OF a SKIP LOCKED`,
        [clusterId, max],
      );
      const tickets = [];
      for (const row of r.rows) {
        const p = row.body;
        const b = await currentBinding(c, p.incident_id);
        if (!b || !bindingMatches(b, p.binding)) {
          continue;
        }
        const t = p.target;
        await c.query('UPDATE server.approval_assertions SET delivered_at = now() WHERE assertion_id = $1', [
          row.assertion_id,
        ]);
        const ttl = row.ttl_expires_at ?? new Date(row.created_at.getTime() + 24 * 3600_000);
        tickets.push({
          ticket_id: row.assertion_id,
          cluster: clusterId,
          proposal: {
            proposal_id: p.proposal_id,
            action: p.action,
            params: p.params,
            target: {
              ...targetRef(this.catalog, p),
              kind: t.kind,
              ...(t.namespace ? { namespace: t.namespace } : {}),
              name: t.name,
              uid: t.uid,
            },
            incident_id: p.incident_id,
            incident_version: p.binding.incident_version,
            root_component: p.binding.root_component,
            evidence_fingerprint: p.binding.evidence_fingerprint,
            idempotency_key: p.idempotency_key,
            source: p.source,
            proposal_expires_at: fmt(ttl),
          },
          envelope: row.envelope,
          delivered_at: clock.server_time,
        });
      }
      return { ...clock, tickets };
    });
  }

  /** 执行事件：按 event_id 去重；pulled 之后不再下发该工单；进度写回提议并发布 execution.updated。 */
  async events(clusterId: string, events: ExecutionEvent[]): Promise<{ accepted: string[]; duplicates: string[] }> {
    const accepted: string[] = [];
    const duplicates: string[] = [];
    await tx(this.pool, async (c) => {
      for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
        const own = await c.query(
          'SELECT 1 FROM server.approval_assertions WHERE assertion_id = $1 AND cluster_id = $2',
          [e.ticket_id, clusterId],
        );
        if (!own.rowCount) {
          throw new HttpError(403, 'forbidden', `工单 ${e.ticket_id} 不属于集群 ${clusterId}`);
        }
        const ins = await c.query(
          `INSERT INTO server.execution_events (event_id, cluster_id, execution_id, ticket_id, proposal_id, seq, phase, at, reason, body)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (event_id) DO NOTHING`,
          [
            e.event_id,
            clusterId,
            e.execution_id,
            e.ticket_id,
            e.proposal_id,
            e.seq,
            e.phase,
            e.at,
            e.reason,
            JSON.stringify(e),
          ],
        );
        if (!ins.rowCount) {
          duplicates.push(e.event_id);
          continue;
        }
        accepted.push(e.event_id);
        if (e.phase === 'pulled') {
          await c.query(
            'UPDATE server.approval_assertions SET pulled_at = coalesce(pulled_at, now()) WHERE assertion_id = $1',
            [e.ticket_id],
          );
        }
        const pr = await c.query<{ body: Proposal }>(
          'SELECT body FROM server.proposals WHERE proposal_id = $1 FOR UPDATE',
          [e.proposal_id],
        );
        const p = pr.rows[0]?.body;
        if (!p) {
          continue;
        }
        const last = await c.query<{ seq: number }>(
          'SELECT max(seq) AS seq FROM server.execution_events WHERE execution_id = $1',
          [e.execution_id],
        );
        if ((last.rows[0]?.seq ?? 0) > e.seq) {
          continue;
        }
        p.execution = {
          execution_id: e.execution_id,
          phase: e.phase,
          queue_position: e.queue_position ?? null,
          updated_at: e.at,
        };
        if (p.state === 'approved' || p.state === 'held') {
          p.state = 'dispatched';
        }
        if (['stale', 'expired', 'rejected'].includes(e.phase) && p.state === 'dispatched') {
          p.state = e.phase === 'rejected' ? 'rejected' : (e.phase as 'stale' | 'expired');
        }
        if (e.requires) {
          p.policy_checks.push({ name: `gateway_${e.requires}`, passed: false, detail: e.message ?? e.reason });
        }
        p.updated_at = new Date().toISOString();
        await c.query(
          'UPDATE server.proposals SET state = $2, body = $3, updated_at = now(), dispatched_at = coalesce(dispatched_at, now()) WHERE proposal_id = $1',
          [p.proposal_id, p.state, JSON.stringify(p)],
        );
        await appendEvents(c, 'server', 'server', SCHEMA_VERSION, [
          { type: 'execution.updated', clusterId, payload: { proposal_id: p.proposal_id, execution: p.execution } },
          { type: 'proposal.updated', clusterId, payload: p },
        ]);
      }
    });
    return { accepted, duplicates };
  }

  async binding(clusterId: string, proposalId: string) {
    const c = this.pool;
    const r = await c.query<{ body: Proposal; cluster_id: string }>(
      'SELECT body, cluster_id FROM server.proposals WHERE proposal_id = $1',
      [proposalId],
    );
    const row = r.rows[0];
    if (!row || row.cluster_id !== clusterId) {
      throw notFound(`没有提议 ${proposalId}`);
    }
    const p = row.body;
    const b = await currentBinding(c, p.incident_id);
    const clock = await this.clock(c);
    let state: 'current' | 'stale' | 'withdrawn' | 'expired';
    if (p.state === 'expired') {
      state = 'expired';
    } else if (p.state === 'rejected' || p.state === 'rejected_by_policy') {
      state = 'withdrawn';
    } else if (p.state === 'stale' || !b || !bindingMatches(b, p.binding)) {
      state = 'stale';
    } else {
      state = 'current';
    }
    return {
      ...clock,
      proposal_id: proposalId,
      state,
      incident_version: b?.version ?? p.binding.incident_version,
      root_component: b?.rootComponent ?? p.binding.root_component ?? '',
      evidence_fingerprint:
        state === 'current'
          ? p.binding.evidence_fingerprint
          : ([...(b?.fingerprints ?? [])][0] ?? p.binding.evidence_fingerprint),
    };
  }

  async heartbeat(clusterId: string, hb: Heartbeat) {
    return tx(this.pool, async (c) => {
      await c.query(
        `INSERT INTO server.spoke_status (cluster_id, gateway_id, version, leader, propose_only, conditions, queue, clock_skew, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (cluster_id) DO UPDATE SET gateway_id = excluded.gateway_id, version = excluded.version, leader = excluded.leader,
           propose_only = excluded.propose_only, conditions = excluded.conditions, queue = excluded.queue, clock_skew = excluded.clock_skew, received_at = now()`,
        [
          clusterId,
          hb.gateway_id,
          hb.version,
          hb.leader,
          hb.propose_only,
          JSON.stringify(hb.conditions),
          JSON.stringify(hb.queue),
          JSON.stringify(hb.clock_skew_seconds),
        ],
      );
      for (const cond of hb.conditions) {
        const type = GATEWAY_CONDITIONS[cond.type];
        if (!type) {
          continue;
        }
        // gateway 的条件 True 表示功能正常；状态条的条件 true 表示问题正在发生
        const bad = type.badWhen === cond.status;
        await c.query(
          `INSERT INTO server.conditions (role, cluster_id, type, subject, status, reason, message, since, updated_at)
           VALUES ('gateway', $1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (role, cluster_id, type, subject) DO UPDATE SET status = excluded.status, reason = excluded.reason,
             message = excluded.message, since = CASE WHEN server.conditions.status = excluded.status THEN server.conditions.since ELSE excluded.since END,
             updated_at = now()`,
          [clusterId, type.type, hb.gateway_id, bad ? 'true' : 'false', cond.reason, cond.message ?? '', cond.since],
        );
      }
      return { ...(await this.clock(c)), soft_paused: await this.softPaused(c) };
    });
  }

  registerRoutes(app: FastifyInstance, auth: Auth): void {
    const ticketBody = openapiValidator<{ events: ExecutionEvent[] }>(DOC, 'ExecutionEvent');
    const hbBody = openapiValidator<Heartbeat>(DOC, 'Heartbeat');
    const cluster = async (req: FastifyRequest): Promise<string> => {
      const c = await auth.required(req);
      if (c.kind !== 'service' || c.caller.kind !== 'spoke' || c.caller.role !== 'gateway') {
        throw forbidden('只有分支 gateway 可以调用工单协议');
      }
      if (req.headers['x-srenautix-cluster'] !== c.caller.cluster_id) {
        throw forbidden('X-SreNautix-Cluster 与 token 的集群不一致');
      }
      return c.caller.cluster_id;
    };
    app.get('/v1/spoke/tickets', async (req) => {
      const clusterId = await cluster(req);
      const q = req.query as { wait?: string; max?: string };
      const wait = Math.min(60, Math.max(0, Number(q.wait ?? 30)));
      const max = Math.min(100, Math.max(1, Number(q.max ?? 20)));
      const deadline = Date.now() + wait * 1000;
      const abort = new AbortController();
      req.raw.on('close', () => abort.abort());
      for (;;) {
        const r = await this.tickets(clusterId, max);
        if (r.tickets.length || Date.now() >= deadline || abort.signal.aborted) {
          return r;
        }
        await this.listener.waitWake('server', Math.min(deadline - Date.now(), 5_000), abort.signal);
      }
    });
    app.post('/v1/spoke/events', async (req) => {
      const clusterId = await cluster(req);
      const body = req.body as { events?: unknown[] };
      if (!body || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 500) {
        throw new HttpError(400, 'bad_request', 'events 必须是 1–500 个执行事件');
      }
      for (const e of body.events) {
        checkBody(ticketBody, e);
      }
      return this.events(clusterId, body.events as ExecutionEvent[]);
    });
    app.get('/v1/spoke/proposals/:proposal_id/binding', async (req) => {
      const clusterId = await cluster(req);
      return this.binding(clusterId, (req.params as { proposal_id: string }).proposal_id);
    });
    app.post('/v1/spoke/heartbeat', async (req) => {
      const clusterId = await cluster(req);
      return this.heartbeat(clusterId, checkBody(hbBody, req.body));
    });
  }
}

/** gateway 心跳条件到状态条条件的映射。 */
const GATEWAY_CONDITIONS: Record<string, { type: string; badWhen: string }> = {
  AdmissionSelfCheck: { type: 'AdmissionSelfTestFailed', badWhen: 'False' },
  Freeze: { type: 'Frozen', badWhen: 'True' },
  AuditSink: { type: 'AuditExportLagging', badWhen: 'False' },
  ClockSkew: { type: 'ClockSkew', badWhen: 'True' },
};

/** 目标的 group/version 取自动作目录（同一动作允许多种 kind 时按目标 kind 选）。 */
function targetRef(catalog: Catalog, p: Proposal): { group: string; version: string } {
  const a = catalog.get(p.action);
  if (!a) {
    throw new Error(`提议 ${p.proposal_id} 的动作 ${p.action} 不在目录中`);
  }
  const k = a.target.kinds?.find((x) => x.kind === p.target.kind) ?? a.target;
  return { group: k.group, version: k.version };
}
