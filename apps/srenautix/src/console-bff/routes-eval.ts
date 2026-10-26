import type { Incident } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { badRequest, notFound } from '../api/errors.js';
import { checkBody, openapiValidator } from '../api/openapi-schemas.js';
import type { Auth } from '../identity/auth.js';
import type { CandidateState, EvalCandidateConfirm, EvalCandidates } from '../proposals/candidates.js';
import { incidentTarget } from './routes-incidents.js';

export interface EvalRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  candidates: EvalCandidates;
}

const STATES: ReadonlySet<string> = new Set(['pending', 'confirmed', 'dropped', 'all']);

/**
 * 评测候选（contract/openapi.yaml 的 eval 标签，ADR 0175）：控制台的"加入评测"写入来源 console 的候选；
 * 管理员（eval.write）列出、确认或放弃候选。
 */
export function registerEvalRoutes(app: FastifyInstance, d: EvalRouteDeps): void {
  const confirmBody = openapiValidator<EvalCandidateConfirm>('openapi.yaml', 'EvalCandidateConfirm');

  app.post('/v1/runs/:run_id/eval-case', async (req, reply) => {
    const runId = (req.params as { run_id: string }).run_id;
    const r = await d.pool.query<{ body: Incident }>(
      `SELECT i.body FROM (SELECT run_id, incident_id FROM server.research_runs
                           UNION SELECT run_id, incident_id FROM server.research_queue) r
         JOIN server.incidents i ON i.incident_id = r.incident_id
        WHERE r.run_id::text = $1`,
      [runId],
    );
    const inc = r.rows[0]?.body;
    if (!inc) {
      throw notFound(`没有研判 ${runId}`);
    }
    const c = await d.auth.user(req, 'feedback', incidentTarget(inc));
    const body = parse(promoteBody, req.body);
    const out = await d.candidates.promote(c.subject.id, runId, body.case_type, body.suite);
    return reply.code(201).send(out);
  });

  app.get('/v1/eval/candidates', async (req) => {
    await d.auth.user(req, 'eval.write');
    const q = req.query as { state?: string; limit?: string };
    const state = q.state ?? 'pending';
    if (!STATES.has(state)) {
      throw badRequest('state 只能是 pending、confirmed、dropped 或 all');
    }
    const limit = q.limit === undefined ? 200 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw badRequest('limit 必须是 1–500 的整数');
    }
    return d.candidates.list(state as CandidateState | 'all', limit);
  });

  app.post('/v1/eval/candidates/:id/confirm', async (req) => {
    const c = await d.auth.user(req, 'eval.write');
    const body = checkBody(confirmBody, req.body);
    return d.candidates.confirm(c.subject.id, uuidParam(req.params), body);
  });

  app.post('/v1/eval/candidates/:id/drop', async (req) => {
    const c = await d.auth.user(req, 'eval.write');
    const body = parse(dropBody, req.body);
    return d.candidates.drop(c.subject.id, uuidParam(req.params), body.reason);
  });
}

/** promoteEvalCase 与 dropEvalCandidate 的请求体（contract/openapi.yaml 中写在操作里，不是具名组件） */
const promoteBody = z
  .object({ case_type: z.enum(['incident', 'benign', 'abstain']), suite: z.string().min(1) })
  .strict();
const dropBody = z.object({ reason: z.string().max(500).nullable() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw badRequest(r.error.issues.map((i) => `/${i.path.join('/')} ${i.message}`).join('；'));
  }
  return r.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam(params: unknown): string {
  const id = (params as { id: string }).id;
  if (!UUID.test(id)) {
    throw notFound(`没有评测候选 ${id}`);
  }
  return id;
}
