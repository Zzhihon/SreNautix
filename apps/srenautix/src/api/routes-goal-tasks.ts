import { validatorFor, type OptimizationOutput } from '@srenautix/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Auth } from '../identity/auth.js';
import { formatErrors, validatorOf } from '../llm/schema.js';
import { GoalDataUnavailable, type GoalEvidence } from '../optimize/evidence.js';
import type { GoalPublisher } from '../optimize/publisher.js';
import type { GoalRunContext } from '../optimize/runner.js';
import { tx } from '../store/pool.js';
import { badRequest, forbidden, HttpError, notFound } from './errors.js';

// worker 的目标任务接口（ADR 0146 §2.3、§3.1）：目标运行的输入、区分性检查与输出。只有 worker 可以调用。
// 区分性检查只能用这次运行的查询模板（runner 写入 context 的领域模板），参数按模板 schema 校验，在发现挂到的组件上执行；
// 模型输出中的原始查询与未知模板在 worker 的 vetCheck 与这里都被拒绝，不会发出任何后端请求（不变量 13）。

export interface GoalTaskRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  /** 主动优化关闭时为 null：目标任务接口返回 404（队列里不会有目标任务） */
  evidence: GoalEvidence | null;
  publisher: GoalPublisher | null;
  now?: () => number;
}

const validOutput = validatorFor<OptimizationOutput>('schemas/optimization-output.schema.json');

export function registerGoalTaskRoutes(app: FastifyInstance, d: GoalTaskRouteDeps): void {
  const now = d.now ?? Date.now;
  const worker = async (req: FastifyRequest): Promise<void> => {
    const c = await d.auth.required(req);
    if (c.kind !== 'service' || c.caller.kind !== 'worker') {
      throw forbidden('只有 worker 可以调用目标任务接口');
    }
  };

  /** 任务对应的目标运行：research_queue 中 subject_type=goal 的任务，goal_runs 中运行中、已准备输入的运行 */
  const runOf = async (runId: string): Promise<{ ctx: GoalRunContext; state: string }> => {
    const r = await d.pool.query<{ context: GoalRunContext | null; state: string }>(
      `SELECT g.context, g.state FROM server.goal_runs g
         JOIN server.research_queue q ON q.run_id = g.run_id AND q.subject_type = 'goal'
        WHERE g.run_id = $1`,
      [runId],
    );
    const row = r.rows[0];
    if (!row || !row.context) {
      throw notFound('没有这个目标任务');
    }
    return { ctx: row.context, state: row.state };
  };

  app.get('/v1/research/tasks/:run_id/goal-context', async (req) => {
    await worker(req);
    return (await runOf((req.params as { run_id: string }).run_id)).ctx;
  });

  app.post('/v1/research/tasks/:run_id/goal-query', async (req) => {
    await worker(req);
    if (!d.evidence) {
      throw notFound('主动优化没有启用');
    }
    const body = (req.body ?? {}) as { template?: unknown; args?: unknown; finding?: unknown };
    if (typeof body.template !== 'string' || typeof body.finding !== 'string') {
      throw badRequest('需要 template 与 finding');
    }
    const args = body.args ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw badRequest('args 必须是 JSON 对象');
    }
    const { ctx, state } = await runOf((req.params as { run_id: string }).run_id);
    if (state !== 'running') {
      throw new HttpError(409, 'run_finished', `目标运行已经是 ${state}`);
    }
    const template = ctx.templates.find((t) => t.id === body.template);
    if (!template) {
      throw notFound(`这次目标运行没有查询模板 ${body.template}`);
    }
    const valid = validatorOf(template.args);
    if (!valid(args)) {
      throw badRequest(`参数不符合模板 ${template.id} 的 schema：${formatErrors(valid.errors)}`);
    }
    const params: Record<string, number | string | boolean> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
        throw badRequest(`参数 ${k} 必须是数字、字符串或布尔值`);
      }
      params[k] = v;
    }
    const cand = ctx.candidates.find((c) => c.selected && c.finding === body.finding);
    if (!cand) {
      throw badRequest(`发现 ${body.finding} 没有进入这次分析`);
    }
    const node = ctx.topology.nodes.find((n) => n.key === cand.component);
    if (!node) {
      throw badRequest(`发现挂到的组件 ${cand.component} 不在这次运行的拓扑中`);
    }
    try {
      return await d.evidence.template(
        template.id,
        params,
        {
          cluster_id: ctx.goal.cluster_id,
          kind: node.kind,
          namespace: node.namespace,
          name: node.name,
          node: node.kind === 'Node' ? node.name : null,
          uid: node.uid,
        },
        now(),
        AbortSignal.timeout(30_000),
        ctx.run_id,
      );
    } catch (e) {
      if (e instanceof GoalDataUnavailable) {
        throw new HttpError(422, 'query_not_run', e.message);
      }
      throw e;
    }
  });

  app.post('/v1/research/tasks/:run_id/optimization', async (req, reply) => {
    await worker(req);
    if (!d.publisher) {
      throw notFound('主动优化没有启用');
    }
    const output = req.body as OptimizationOutput;
    if (!validOutput(output)) {
      throw badRequest(`运行输出不符合 OptimizationOutput：${formatErrors(validOutput.errors)}`);
    }
    const publisher = d.publisher;
    await tx(d.pool, (c) => publisher.accept(c, (req.params as { run_id: string }).run_id, output));
    return reply.code(204).send();
  });

  app.post('/v1/research/tasks/:run_id/optimization-failed', async (req, reply) => {
    await worker(req);
    if (!d.publisher) {
      throw notFound('主动优化没有启用');
    }
    const body = (req.body ?? {}) as { kind?: unknown; message?: unknown };
    if (typeof body.kind !== 'string' || typeof body.message !== 'string') {
      throw badRequest('需要 kind 与 message');
    }
    await d.publisher.failRun((req.params as { run_id: string }).run_id, body.kind.slice(0, 64), body.message);
    return reply.code(204).send();
  });
}
