import type { ReasonGroupCode } from '@srenautix/contract';
import type pg from 'pg';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { appendEvents } from '../store/outbox.js';
import { tx } from '../store/pool.js';

type FailureKind = ReasonGroupCode<'research_failure'>;

interface WorkerEvent {
  seq: number;
  event_id: string;
  type: string;
  schema_version: string;
  cluster_id: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface ResearchMirrorUpdate {
  type: string;
  incidentId: string;
  incidentVersion: number;
  runId: string;
}

const CONSUMER = 'worker-events';

/**
 * 消费 worker 的 `GET /v1/events`（游标 worker:<seq>），把 research.* 事件按原 event_id 重新发布到 server 的 outbox，
 * 并在 server.research_runs 中保存研判摘要（消息、收件箱与提议绑定用）。游标与写入在同一个事务里，重复投递按 event_id 去重。
 */
export class WorkerEventMirror {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workerUrl: string,
    private readonly token: string,
    private readonly onUpdate: (u: ResearchMirrorUpdate) => void,
    private readonly metrics: Pick<ServerMetrics, 'terminal'>,
  ) {}

  private async cursor(): Promise<string> {
    const r = await this.pool.query<{ cursor: string }>('SELECT cursor FROM server.event_cursors WHERE consumer = $1', [
      CONSUMER,
    ]);
    return r.rows[0]?.cursor ?? 'worker:0';
  }

  async once(waitS: number, signal: AbortSignal): Promise<number> {
    const after = await this.cursor();
    const res = await fetch(`${this.workerUrl}/v1/events?after=${encodeURIComponent(after)}&wait=${waitS}&limit=200`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout((waitS + 15) * 1000)]),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`worker /v1/events HTTP ${res.status}：${text.slice(0, 300)}`);
    }
    const body = JSON.parse(text) as { events: WorkerEvent[]; next?: string; cursor?: string };
    const next = body.next ?? body.cursor ?? after;
    const updates: ResearchMirrorUpdate[] = [];
    // 新进入失败或只出阶段 A 的研判（原因码为失败类型），提交后计数
    const ended: FailureKind[] = [];
    await tx(this.pool, async (c) => {
      for (const e of body.events) {
        if (!e.type.startsWith('research.')) {
          continue;
        }
        await appendEvents(c, 'server', 'server', e.schema_version, [
          { type: e.type, clusterId: e.cluster_id, payload: e.payload, eventId: e.event_id },
        ]);
        const p = e.payload as {
          incident_id: string;
          incident_version: number;
          run_id: string;
          reason?: string;
          evidence_fingerprint?: string;
          output?: {
            disposition: string;
            conclusion: { level: string; root_component: string | null };
            summary: string;
          };
          kind?: FailureKind;
          message?: string;
          state?: 'stage_a_only' | 'failed';
        };
        // 研判状态取 worker 写入的 state（契约 2.39.0，ADR 0172），与 worker 一致；之前的 worker 不写，按失败类型推出
        const state =
          e.type === 'research.concluded'
            ? 'completed'
            : e.type === 'research.failed'
              ? (p.state ?? (p.kind === 'breaker_open' || p.kind === 'budget_exhausted' ? 'stage_a_only' : 'failed'))
              : 'queued';
        // 研判原因取 server 队列里这次任务的入队原因（root_changed、fingerprint_changed、reopened 等）：worker 的
        // research.concluded / research.failed 不带原因（契约里没有这个字段），以前在这里一律记成 new_incident
        const r = await c.query<{ prev: string | null }>(
          `WITH prev AS (SELECT state FROM server.research_runs WHERE run_id = $1)
           INSERT INTO server.research_runs (run_id, incident_id, incident_version, reason, state, disposition, conclusion_level, root_component, summary,
             evidence_fingerprint, output, error, started_at, finished_at, updated_at)
           VALUES ($1, $2, $3, coalesce($4::text, (SELECT q.reason FROM server.research_queue q WHERE q.run_id = $1::uuid), 'new_incident'),
             $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
           ON CONFLICT (run_id) DO UPDATE SET reason = excluded.reason, state = excluded.state, disposition = coalesce(excluded.disposition, server.research_runs.disposition),
             conclusion_level = coalesce(excluded.conclusion_level, server.research_runs.conclusion_level),
             root_component = coalesce(excluded.root_component, server.research_runs.root_component),
             summary = coalesce(excluded.summary, server.research_runs.summary),
             evidence_fingerprint = coalesce(excluded.evidence_fingerprint, server.research_runs.evidence_fingerprint),
             output = coalesce(excluded.output, server.research_runs.output), error = coalesce(excluded.error, server.research_runs.error),
             finished_at = coalesce(excluded.finished_at, server.research_runs.finished_at), updated_at = now()
           RETURNING (SELECT state FROM prev) AS prev`,
          [
            p.run_id,
            p.incident_id,
            p.incident_version,
            p.reason ?? null,
            state,
            p.output?.disposition ?? null,
            p.output?.conclusion.level ?? null,
            p.output?.conclusion.root_component ?? null,
            p.output?.summary ?? null,
            p.evidence_fingerprint ?? null,
            p.output ? JSON.stringify(p.output) : null,
            e.type === 'research.failed' ? JSON.stringify({ kind: p.kind, message: p.message }) : null,
            e.occurred_at,
            state === 'queued' ? null : e.occurred_at,
          ],
        );
        if (e.type === 'research.failed' && p.kind && r.rows[0]?.prev !== state) {
          ended.push(p.kind);
        }
        updates.push({ type: e.type, incidentId: p.incident_id, incidentVersion: p.incident_version, runId: p.run_id });
      }
      await c.query(
        `INSERT INTO server.event_cursors (consumer, cursor, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (consumer) DO UPDATE SET cursor = excluded.cursor, updated_at = now()`,
        [CONSUMER, next],
      );
    });
    for (const kind of ended) {
      this.metrics.terminal('research', kind);
    }
    updates.forEach((u) => this.onUpdate(u));
    return updates.length;
  }

  run(signal: AbortSignal): void {
    const loop = async () => {
      while (!signal.aborted) {
        try {
          await this.once(25, signal);
        } catch (e) {
          if (signal.aborted) {
            return;
          }
          logger.warn('读取 worker 事件流失败，5 秒后重试', { error: e });
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    };
    void loop();
  }
}
