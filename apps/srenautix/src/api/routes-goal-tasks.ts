import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Auth } from '../identity/auth.js';
import { forbidden, notFound } from '../kernel/errors.js';

// worker 的目标任务接口桩（主动优化已退役）：保留路由鉴权，并在旧任务上报失败时干净收敛，不崩溃或无限重试。

export interface GoalTaskRouteDeps {
  pool: pg.Pool;
  auth: Auth;
}

export function registerGoalTaskRoutes(app: FastifyInstance, d: GoalTaskRouteDeps): void {
  const worker = async (req: FastifyRequest): Promise<void> => {
    const c = await d.auth.required(req);
    if (c.kind !== 'service' || c.caller.kind !== 'worker') {
      throw forbidden('只有 worker 可以调用目标任务接口');
    }
  };

  app.get('/v1/research/tasks/:run_id/goal-context', async (req) => {
    await worker(req);
    throw notFound('主动优化已退役');
  });

  app.post('/v1/research/tasks/:run_id/goal-query', async (req) => {
    await worker(req);
    throw notFound('主动优化已退役');
  });

  app.post('/v1/research/tasks/:run_id/optimization', async (req) => {
    await worker(req);
    throw notFound('主动优化已退役');
  });

  app.post('/v1/research/tasks/:run_id/optimization-failed', async (req, reply) => {
    await worker(req);
    const runId = (req.params as { run_id: string }).run_id;
    const body = (req.body ?? {}) as { message?: unknown };
    const reason = typeof body.message === 'string' && body.message ? body.message.slice(0, 500) : '主动优化已退役';
    await d.pool.query(
      `UPDATE server.goal_runs
          SET state = 'failed', reason = $2, finished_at = COALESCE(finished_at, now())
        WHERE run_id = $1 AND state IN ('queued', 'deferred', 'running')`,
      [runId, reason],
    );
    return reply.code(204).send();
  });
}
