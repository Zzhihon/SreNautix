import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { TopologyEdge, TopologyEvent, TopologyNode } from '@srenautix/contract';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from '../api/errors.js';
import type { Auth } from '../identity/auth.js';
import { logger } from '../log.js';
import { tx, type Queryable } from '../store/pool.js';
import { ReaderProtocol } from './protocol.js';
import { edgeKey, sameContent, type TopologyChange, type TopologyStore } from './store.js';

/** 协议错误：响应体为 Problem {code, message}。 */
class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HubClock {
  server_time: string;
  restored_at: string | null;
}

const fmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function hubClock(c: Queryable): Promise<HubClock & { restored: Date | null }> {
  const r = await c.query<{ now: Date; restored: string | null }>(
    "SELECT now() AS now, (SELECT value #>> '{}' FROM server.system_state WHERE key = 'restored_at') AS restored",
  );
  const row = r.rows[0] as { now: Date; restored: string | null };
  const restored = row.restored ? new Date(row.restored) : null;
  return { server_time: fmt(row.now), restored_at: restored ? fmt(restored) : null, restored };
}

const clockOnly = (c: HubClock & { restored: Date | null }): HubClock => ({
  server_time: c.server_time,
  restored_at: c.restored_at,
});

/** 告警对账快照（协议 AlertReconcileSnapshot）。status=error 或 truncated=true 的部分不能用来判断告警已消失。 */
export interface AlertReconcileSnapshot {
  cluster_id: string;
  taken_at: string;
  alertmanager: { status: 'ok' | 'error'; error?: string; truncated: boolean; items: unknown[] } | null;
  rules: {
    status: 'ok' | 'error';
    error?: string;
    truncated: boolean;
    items: Array<{ labels: Record<string, string>; state: 'pending' | 'firing'; active_at: string | null }>;
  } | null;
}

export type ReaderRequestKind = 'query' | 'ksm_history' | 'resolve';

export interface ReaderRequestWire {
  request_id: string;
  kind: ReaderRequestKind;
  deadline: string;
  query?: unknown;
  history?: unknown;
  resolve?: unknown;
}

export interface ReaderResultWire {
  request_id: string;
  kind: ReaderRequestKind;
  query?: unknown;
  history?: unknown;
  resolve?: unknown;
}

/** 读取请求的存取（路由只依赖这个接口）。 */
export interface ReaderRequests {
  pull(clusterId: string, max: number, waitMs: number, signal: AbortSignal): Promise<ReaderRequestWire[]>;
  complete(
    clusterId: string,
    results: readonly ReaderResultWire[],
  ): Promise<{ accepted: string[]; duplicates: string[] }>;
}

export class ReaderRequestTimeout extends Error {
  override name = 'ReaderRequestTimeout';
}

const PAYLOAD_SCHEMA: Record<ReaderRequestKind, string> = {
  query: 'DeclaredQuery',
  ksm_history: 'HistoryRequest',
  resolve: 'ResolveRequest',
};
const PAYLOAD_FIELD: Record<ReaderRequestKind, 'query' | 'history' | 'resolve'> = {
  query: 'query',
  ksm_history: 'history',
  resolve: 'resolve',
};

/** 未收到结果的请求在投递 REDELIVER_S 秒后可以再次下发（reader 重启或连接中断时不会丢失）。 */
const REDELIVER_S = 30;

/**
 * 中心下发给 reader 的读取请求（表 server.reader_requests）。request() 写入一条请求并等待结果：
 * 本进程收到结果时立即唤醒，其他副本收到的结果每秒从表中读取一次；过了 deadline 抛出 ReaderRequestTimeout。
 */
export class ReaderRequestQueue implements ReaderRequests {
  private readonly bus = new EventEmitter();

  constructor(
    private readonly pool: pg.Pool,
    private readonly protocol: ReaderProtocol,
  ) {
    this.bus.setMaxListeners(0);
  }

  async enqueue(clusterId: string, kind: ReaderRequestKind, payload: unknown, deadline: Date): Promise<string> {
    const v = this.protocol.component(PAYLOAD_SCHEMA[kind]);
    if (!v(payload)) {
      throw new Error(`读取请求 ${kind} 的参数不合法：${ReaderProtocol.errors(v)}`);
    }
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO server.reader_requests (request_id, cluster_id, kind, payload, deadline) VALUES ($1, $2, $3, $4, $5)',
      [id, clusterId, kind, JSON.stringify(payload), deadline],
    );
    this.bus.emit(`pending:${clusterId}`);
    return id;
  }

  async request(clusterId: string, kind: ReaderRequestKind, payload: unknown, deadlineMs: number): Promise<unknown> {
    const deadline = new Date(Date.now() + deadlineMs);
    const id = await this.enqueue(clusterId, kind, payload, deadline);
    for (;;) {
      const r = await this.pool.query<{ result: unknown }>(
        'SELECT result FROM server.reader_requests WHERE request_id = $1 AND completed_at IS NOT NULL',
        [id],
      );
      if (r.rows[0]) {
        return r.rows[0].result;
      }
      const left = deadline.getTime() - Date.now();
      if (left <= 0) {
        throw new ReaderRequestTimeout(`读取请求 ${id}（${kind}）在 ${deadline.toISOString()} 前没有结果`);
      }
      await this.waitFor(`done:${id}`, Math.min(left, 1000), undefined);
    }
  }

  private waitFor(event: string, ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.bus.off(event, done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.bus.on(event, done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  async pull(clusterId: string, max: number, waitMs: number, signal: AbortSignal): Promise<ReaderRequestWire[]> {
    const until = Date.now() + waitMs;
    for (;;) {
      const r = await this.pool.query<{
        request_id: string;
        kind: ReaderRequestKind;
        payload: unknown;
        deadline: Date;
      }>(
        `UPDATE server.reader_requests SET delivered_at = now(), deliveries = deliveries + 1
          WHERE request_id IN (
            SELECT request_id FROM server.reader_requests
             WHERE cluster_id = $1 AND completed_at IS NULL AND deadline > now()
               AND (delivered_at IS NULL OR delivered_at < now() - make_interval(secs => $3))
             ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          RETURNING request_id, kind, payload, deadline`,
        [clusterId, max, REDELIVER_S],
      );
      if (r.rows.length || Date.now() >= until || signal.aborted) {
        return r.rows.map((x) => ({
          request_id: x.request_id,
          kind: x.kind,
          deadline: fmt(x.deadline),
          [PAYLOAD_FIELD[x.kind]]: x.payload,
        }));
      }
      await this.waitFor(`pending:${clusterId}`, Math.min(until - Date.now(), 1000), signal);
    }
  }

  async complete(
    clusterId: string,
    results: readonly ReaderResultWire[],
  ): Promise<{ accepted: string[]; duplicates: string[] }> {
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const res of results) {
      const r = await this.pool.query(
        `UPDATE server.reader_requests SET result = $3, completed_at = now()
          WHERE request_id = $1 AND cluster_id = $2 AND kind = $4 AND completed_at IS NULL`,
        [res.request_id, clusterId, JSON.stringify(res), res.kind],
      );
      if (r.rowCount) {
        accepted.push(res.request_id);
        this.bus.emit(`done:${res.request_id}`);
      } else {
        // 已经回传过、已过期清理或不属于本集群的结果：按重复处理，不改变任何状态
        duplicates.push(res.request_id);
      }
    }
    return { accepted, duplicates };
  }

  /** 删除超过 deadline 一天的请求。 */
  async purge(): Promise<number> {
    const r = await this.pool.query("DELETE FROM server.reader_requests WHERE deadline < now() - interval '1 day'");
    return r.rowCount ?? 0;
  }
}

/**
 * apiserver 参考时钟（DESIGN §3.1）：记下每个集群心跳中的 apiserver_time 与收到时的单调时刻。
 * PG 不可用时，中心用 apiserver_time 加上自收到以来经过的单调时长作为当前时间。
 */
export class ReaderClock {
  private readonly last = new Map<string, { apiserver: number; mono: number; offset: number; uncertainty: number }>();

  record(clusterId: string, apiserverTime: Date, offsetSeconds: number, uncertaintySeconds: number): void {
    this.last.set(clusterId, {
      apiserver: apiserverTime.getTime(),
      mono: performance.now(),
      offset: offsetSeconds,
      uncertainty: uncertaintySeconds,
    });
  }

  apiserverNow(clusterId: string): Date | null {
    const l = this.last.get(clusterId);
    return l ? new Date(l.apiserver + (performance.now() - l.mono)) : null;
  }

  offset(clusterId: string): { offsetSeconds: number; uncertaintySeconds: number } | null {
    const l = this.last.get(clusterId);
    return l ? { offsetSeconds: l.offset, uncertaintySeconds: l.uncertainty } : null;
  }
}

export interface ReaderRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  store: TopologyStore;
  protocol: ReaderProtocol;
  requests: ReaderRequests;
  clock: ReaderClock;
  /** 告警对账快照交给接入层；部分来源报错或被截断时由接入层决定不据此结束告警。 */
  onAlertSnapshot(clusterId: string, snapshot: AlertReconcileSnapshot): Promise<void>;
}

interface Cursor {
  topology_seq: number;
  updated_at: Date;
}

async function lockCursor(c: Queryable, clusterId: string): Promise<Cursor> {
  await c.query(
    'INSERT INTO server.spoke_topology_cursor (cluster_id) VALUES ($1) ON CONFLICT (cluster_id) DO NOTHING',
    [clusterId],
  );
  const r = await c.query<Cursor>(
    'SELECT topology_seq, updated_at FROM server.spoke_topology_cursor WHERE cluster_id = $1 FOR UPDATE',
    [clusterId],
  );
  return r.rows[0] as Cursor;
}

/**
 * reader 离线后的条件（状态条件循环每 15 秒调用一次）：心跳超过 offlineMs 没有到达的集群，清除 reader 之前上报的条件
 * （不再保留旧状态），只留一条 TunnelConnected（原因 ReaderOffline）说明 reader 离线；reader 恢复心跳时由心跳覆盖。
 * 本集群的拓扑不经 reader（topology.source 不是 reader，例如 reader 已关闭）时，reader 的条件全部清除，不显示离线。
 */
export async function expireReaderConditions(
  c: Queryable,
  offlineMs: number,
  local: { clusterId: string; usesReader: boolean },
): Promise<number> {
  const secs = offlineMs / 1000;
  const stale = await c.query<{ cluster_id: string; received_at: Date }>(
    `SELECT cluster_id, received_at FROM server.reader_status WHERE received_at < now() - make_interval(secs => $1)`,
    [secs],
  );
  let changed = 0;
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
  // 没有任何心跳记录、却还有 reader 条件的集群（例如状态表被清理过）：同样清除
  const orphan = await c.query(
    `DELETE FROM server.conditions c WHERE c.role = 'reader'
       AND NOT EXISTS (SELECT 1 FROM server.reader_status r WHERE r.cluster_id = c.cluster_id)`,
  );
  return changed + (orphan.rowCount ?? 0);
}

/** reader 的状态条件（InformersFresh 等）写入 server.conditions：条件不为 True 时问题正在发生（status=true）。 */
async function upsertConditions(
  c: Queryable,
  clusterId: string,
  conditions: Array<{ type: string; status: string; reason: string; message?: string; since: string }>,
): Promise<void> {
  for (const x of conditions) {
    await c.query(
      `INSERT INTO server.conditions (role, cluster_id, type, subject, status, reason, message, since, updated_at)
       VALUES ('reader', $1, $2, '', $3, $4, $5, $6, now())
       ON CONFLICT (role, cluster_id, type, subject) DO UPDATE SET status = excluded.status, reason = excluded.reason,
         message = excluded.message, since = excluded.since, updated_at = now()`,
      [clusterId, x.type, x.status === 'True' ? 'false' : 'true', x.reason, x.message ?? '', x.since],
    );
  }
}

/**
 * 中心与分支 reader 的协议（contract/gateway/v1/reader.openapi.yaml）：会话、拓扑快照与事件、告警对账、
 * 读取请求与结果、心跳。每个 reader 一个服务 token（调用方文件中 kind=spoke、role=reader），
 * 请求头 X-SreNautix-Cluster 必须等于 token 对应的集群。
 */
export function registerReaderRoutes(app: FastifyInstance, deps: ReaderRouteDeps): void {
  const { pool, protocol } = deps;

  const handle =
    (fn: (clusterId: string, req: FastifyRequest) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const caller = await deps.auth.required(req);
        if (caller.kind !== 'service' || caller.caller.kind !== 'spoke' || caller.caller.role !== 'reader') {
          throw new Problem(403, 'forbidden', '只有分支 reader 的服务身份可以调用 reader 协议');
        }
        const header = req.headers['x-srenautix-cluster'];
        if (header !== caller.caller.cluster_id) {
          throw new Problem(
            403,
            'cluster_mismatch',
            `X-SreNautix-Cluster 必须等于 token 对应的集群 ${caller.caller.cluster_id}`,
          );
        }
        return reply.send(await fn(caller.caller.cluster_id, req));
      } catch (e) {
        if (e instanceof Problem) {
          return reply.code(e.status).send({ code: e.code, message: e.message });
        }
        if (e instanceof HttpError) {
          return reply.code(e.status).send({ code: e.code, message: e.message });
        }
        throw e;
      }
    };

  const body = <T>(req: FastifyRequest, v: ReturnType<ReaderProtocol['component']>): T => {
    if (!v(req.body)) {
      throw new Problem(400, 'bad_request', ReaderProtocol.errors(v));
    }
    return req.body as T;
  };

  app.post(
    '/v1/spoke/reader/hello',
    handle(async (clusterId, req) => {
      const b = body<{ reader_id: string; version: string; boot_id: string }>(req, protocol.component('ReaderHello'));
      return tx(pool, async (c) => {
        const cur = await lockCursor(c, clusterId);
        await c.query('UPDATE server.spoke_topology_cursor SET reader_id = $2, boot_id = $3 WHERE cluster_id = $1', [
          clusterId,
          b.reader_id,
          b.boot_id,
        ]);
        logger.info('reader 建立会话', {
          cluster_id: clusterId,
          reader_id: b.reader_id,
          version: b.version,
          topology_seq: cur.topology_seq,
        });
        return { ...clockOnly(await hubClock(c)), topology_seq: cur.topology_seq };
      });
    }),
  );

  app.post(
    '/v1/spoke/reader/topology/events',
    handle(async (clusterId, req) => {
      const b = body<{ events: TopologyEvent[] }>(
        req,
        protocol.requestBody('/v1/spoke/reader/topology/events', 'post'),
      );
      return tx(pool, async (c) => {
        const clock = await hubClock(c);
        const cur = await lockCursor(c, clusterId);
        if (clock.restored && cur.updated_at.getTime() < clock.restored.getTime()) {
          throw new Problem(409, 'resync_required', '中心的拓扑状态已从备份恢复，重新上传快照');
        }
        const events = [...b.events].sort((x, y) => x.seq - y.seq);
        for (const e of events) {
          if (e.cluster_id !== clusterId) {
            throw new Problem(
              400,
              'bad_request',
              `事件 ${e.event_id} 的 cluster_id ${e.cluster_id} 与集群 ${clusterId} 不一致`,
            );
          }
        }
        if ((events[0] as TopologyEvent).seq > cur.topology_seq + 1) {
          throw new Problem(
            409,
            'topology_seq_gap',
            `第一条事件的 seq ${(events[0] as TopologyEvent).seq} 大于 ${cur.topology_seq + 1}`,
          );
        }
        let last = cur.topology_seq;
        const changes: TopologyChange[] = [];
        for (const e of events) {
          if (e.seq <= last) {
            continue;
          }
          if (e.seq !== last + 1) {
            throw new Problem(409, 'topology_seq_gap', `事件 seq 从 ${last} 跳到 ${e.seq}`);
          }
          last = e.seq;
          changes.push({
            op: e.op,
            at: new Date(e.valid_from),
            source: e.source,
            eventId: e.event_id,
            ...(e.node ? { node: e.node } : {}),
            ...(e.edge ? { edge: e.edge } : {}),
          });
        }
        await deps.store.applyIn(c, clusterId, changes);
        await c.query(
          'UPDATE server.spoke_topology_cursor SET topology_seq = $2, updated_at = now() WHERE cluster_id = $1',
          [clusterId, last],
        );
        return { ...clockOnly(clock), topology_seq: last, complete: true };
      });
    }),
  );

  app.put(
    '/v1/spoke/reader/topology/snapshot',
    handle(async (clusterId, req) => {
      const b = body<{
        snapshot_id: string;
        seq: number;
        taken_at: string;
        part: number;
        parts: number;
        nodes: Array<{ node: TopologyNode; valid_from: string }>;
        edges: Array<{ edge: TopologyEdge; valid_from: string }>;
      }>(req, protocol.component('TopologySnapshotPart'));
      if (b.part > b.parts) {
        throw new Problem(400, 'bad_request', `part ${b.part} 大于 parts ${b.parts}`);
      }
      return tx(pool, async (c) => {
        const clock = await hubClock(c);
        const prev = await c.query<{ cluster_id: string; parts: number; seq: number; taken_at: Date }>(
          'SELECT cluster_id, parts, seq, taken_at FROM server.reader_snapshot_parts WHERE snapshot_id = $1 LIMIT 1',
          [b.snapshot_id],
        );
        const p = prev.rows[0];
        if (
          p &&
          (p.cluster_id !== clusterId ||
            p.parts !== b.parts ||
            Number(p.seq) !== b.seq ||
            p.taken_at.getTime() !== new Date(b.taken_at).getTime())
        ) {
          throw new Problem(400, 'bad_request', `快照 ${b.snapshot_id} 的分段与已收到的分段不一致`);
        }
        await c.query(
          `INSERT INTO server.reader_snapshot_parts (snapshot_id, part, cluster_id, parts, seq, taken_at, nodes, edges)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (snapshot_id, part) DO NOTHING`,
          [
            b.snapshot_id,
            b.part,
            clusterId,
            b.parts,
            b.seq,
            b.taken_at,
            JSON.stringify(b.nodes),
            JSON.stringify(b.edges),
          ],
        );
        const cur = await lockCursor(c, clusterId);
        const got = await c.query<{
          nodes: Array<{ node: TopologyNode; valid_from: string }>;
          edges: Array<{ edge: TopologyEdge; valid_from: string }>;
        }>('SELECT nodes, edges FROM server.reader_snapshot_parts WHERE snapshot_id = $1 ORDER BY part', [
          b.snapshot_id,
        ]);
        if (got.rows.length < b.parts) {
          return { ...clockOnly(clock), topology_seq: cur.topology_seq, complete: false };
        }
        if (b.seq < cur.topology_seq) {
          await c.query('DELETE FROM server.reader_snapshot_parts WHERE snapshot_id = $1', [b.snapshot_id]);
          throw new Problem(409, 'snapshot_behind', `快照 seq ${b.seq} 小于中心已接受的 ${cur.topology_seq}`);
        }
        const takenAt = new Date(b.taken_at);
        const nodes = got.rows.flatMap((r) => r.nodes);
        const edges = got.rows.flatMap((r) => r.edges);
        const wantNodes = new Map(nodes.map((n) => [n.node.key, n]));
        const wantEdges = new Map(edges.map((e) => [edgeKey(e.edge), e]));
        const openNodes = await deps.store.openKeys(clusterId, 'node', 'informer', c);
        const openEdges = await deps.store.openKeys(clusterId, 'edge', 'informer', c);
        const changes: TopologyChange[] = [];
        for (const [k, e] of openEdges) {
          if (!wantEdges.has(k)) {
            changes.push({ op: 'edge_delete', at: takenAt, source: 'informer', edge: e as TopologyEdge });
          }
        }
        for (const [k, n] of openNodes) {
          if (!wantNodes.has(k)) {
            changes.push({ op: 'node_delete', at: takenAt, source: 'informer', node: n as TopologyNode });
          }
        }
        for (const [k, n] of wantNodes) {
          const cur2 = openNodes.get(k);
          if (!cur2 || !sameContent(cur2, n.node)) {
            changes.push({ op: 'node_upsert', at: new Date(n.valid_from), source: 'informer', node: n.node });
          }
        }
        for (const [k, e] of wantEdges) {
          const cur2 = openEdges.get(k);
          if (!cur2 || !sameContent(cur2, e.edge)) {
            changes.push({ op: 'edge_upsert', at: new Date(e.valid_from), source: 'informer', edge: e.edge });
          }
        }
        const applied = await deps.store.applyIn(c, clusterId, changes);
        await c.query(
          'UPDATE server.spoke_topology_cursor SET topology_seq = $2, snapshot_id = $3, updated_at = now() WHERE cluster_id = $1',
          [clusterId, b.seq, b.snapshot_id],
        );
        await c.query('DELETE FROM server.reader_snapshot_parts WHERE snapshot_id = $1', [b.snapshot_id]);
        logger.info('reader 拓扑快照已应用', {
          cluster_id: clusterId,
          snapshot_id: b.snapshot_id,
          seq: b.seq,
          nodes: nodes.length,
          edges: edges.length,
          changes: applied,
        });
        return { ...clockOnly(clock), topology_seq: b.seq, complete: true };
      });
    }),
  );

  app.post(
    '/v1/spoke/reader/alerts',
    handle(async (clusterId, req) => {
      const b = body<AlertReconcileSnapshot>(req, protocol.component('AlertReconcileSnapshot'));
      if (b.cluster_id !== clusterId) {
        throw new Problem(400, 'bad_request', `快照的 cluster_id ${b.cluster_id} 与集群 ${clusterId} 不一致`);
      }
      await deps.onAlertSnapshot(clusterId, b);
      return clockOnly(await hubClock(pool));
    }),
  );

  app.get(
    '/v1/spoke/reader/requests',
    handle(async (clusterId, req) => {
      const q = req.query as Record<string, string | undefined>;
      const wait = q.wait === undefined ? 30 : Number(q.wait);
      const max = q.max === undefined ? 20 : Number(q.max);
      if (!Number.isInteger(wait) || wait < 0 || wait > 60 || !Number.isInteger(max) || max < 1 || max > 100) {
        throw new Problem(400, 'bad_request', 'wait 为 0–60 的整数，max 为 1–100 的整数');
      }
      const abort = new AbortController();
      req.raw.on('close', () => abort.abort());
      const requests = await deps.requests.pull(clusterId, max, wait * 1000, abort.signal);
      return { ...clockOnly(await hubClock(pool)), requests };
    }),
  );

  app.post(
    '/v1/spoke/reader/results',
    handle(async (clusterId, req) => {
      const b = body<{ results: ReaderResultWire[] }>(req, protocol.requestBody('/v1/spoke/reader/results', 'post'));
      return deps.requests.complete(clusterId, b.results);
    }),
  );

  app.post(
    '/v1/spoke/reader/heartbeat',
    handle(async (clusterId, req) => {
      const b = body<{
        reader_id: string;
        version: string;
        boot_id: string;
        topology_seq: number;
        conditions: Array<{ type: string; status: string; reason: string; message?: string; since: string }>;
        clock: { apiserver_time: string; offset_seconds: number; uncertainty_seconds: number; measured_at: string };
        query_manifest?: unknown;
      }>(req, protocol.component('ReaderHeartbeat'));
      deps.clock.record(
        clusterId,
        new Date(b.clock.apiserver_time),
        b.clock.offset_seconds,
        b.clock.uncertainty_seconds,
      );
      return tx(pool, async (c) => {
        await c.query(
          `INSERT INTO server.reader_status (cluster_id, reader_id, version, boot_id, topology_seq, conditions, clock, query_manifest, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (cluster_id) DO UPDATE SET reader_id = excluded.reader_id, version = excluded.version, boot_id = excluded.boot_id,
             topology_seq = excluded.topology_seq, conditions = excluded.conditions, clock = excluded.clock,
             query_manifest = excluded.query_manifest, received_at = now()`,
          [
            clusterId,
            b.reader_id,
            b.version,
            b.boot_id,
            b.topology_seq,
            JSON.stringify(b.conditions),
            JSON.stringify(b.clock),
            b.query_manifest === undefined ? null : JSON.stringify(b.query_manifest),
          ],
        );
        await upsertConditions(c, clusterId, b.conditions);
        return clockOnly(await hubClock(c));
      });
    }),
  );
}
