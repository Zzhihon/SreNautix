import type { Alert, Feedback, Incident } from '@srenautix/contract';
import { parseKey } from '@srenautix/core';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { OutboxListener } from '../events/listener.js';
import { incidentTarget, visible } from '../console-bff/routes-incidents.js';
import { principalOf, type Auth } from '../identity/auth.js';
import { incidentVersion, latestStageA, resolveIncidentRef } from '../incident/read.js';
import { alertsById } from '../ingest/store.js';
import type { Catalog } from '../proposals/catalog.js';
import type { FeedbackService } from '../proposals/feedback.js';
import { LeaseLost, type Scheduler } from '../scheduler/admission.js';
import type { PackEvidence } from '../stage-a/pack-evidence.js';
import type { CompiledTemplate, PackRuntime } from '../stage-a/packs.js';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';
import type { TopologyStore } from '../topology/store.js';
import { badRequest, forbidden, HttpError, notFound } from './errors.js';
import { referenceCases } from './research-materials.js';

export interface ResearchRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  scheduler: Scheduler;
  topology: TopologyStore;
  feedback: FeedbackService;
  catalog: Catalog;
  listener: OutboxListener;
  /** worker 的内部 API 与 server 调用它的 token；未配置时研判明细不可用。 */
  worker: { url: string; token: string } | null;
  /** 领域包：知识条目、查询模板与 pack.lock。 */
  packs: PackRuntime;
  /** 查询模板的执行（阶段 A 的证据卡运行时）。 */
  templates: Pick<PackEvidence, 'runTemplate'>;
  /** 知识条目的语言。 */
  locale: 'zh-CN' | 'en';
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = new WeakMap<CompiledTemplate, ValidateFunction>();

/** 模板参数的校验器（按模板缓存）。 */
function argsValidator(t: CompiledTemplate): ValidateFunction {
  let v = validators.get(t);
  if (!v) {
    v = ajv.compile(t.args);
    validators.set(t, v);
  }
  return v;
}

/**
 * worker 的队列接口（server 代为执行 SKIP LOCKED，worker 没有 server schema 的权限）与研判相关的控制台接口。
 */
export function registerResearchRoutes(app: FastifyInstance, d: ResearchRouteDeps): void {
  const worker = async (req: FastifyRequest): Promise<string> => {
    const c = await d.auth.required(req);
    if (c.kind !== 'service' || c.caller.kind !== 'worker') {
      throw forbidden('只有 worker 可以调用研判队列接口');
    }
    return c.caller.id;
  };

  app.post('/v1/research/claim', async (req, reply) => {
    const id = await worker(req);
    const body = (req.body ?? {}) as { worker_id?: string };
    const workerId = `${id}/${body.worker_id ?? 'default'}`;
    const wait = Math.min(30, Math.max(0, Number((req.query as { wait?: string }).wait ?? 0)));
    const deadline = Date.now() + wait * 1000;
    const abort = new AbortController();
    req.raw.on('close', () => abort.abort());
    for (;;) {
      const task = await d.scheduler.claim(workerId);
      if (task) {
        return reply.send({ task: { ...task, worker_id: workerId } });
      }
      if (Date.now() >= deadline || abort.signal.aborted) {
        return reply.code(204).send();
      }
      await d.listener.waitWake('server', Math.min(deadline - Date.now(), 5_000), abort.signal);
    }
  });

  app.post('/v1/research/tasks/:run_id/heartbeat', async (req) => {
    await worker(req);
    const body = (req.body ?? {}) as { worker_id?: string };
    if (!body.worker_id) {
      throw badRequest('需要 worker_id（claim 响应中的值）');
    }
    try {
      return {
        lease_expires_at: await d.scheduler.heartbeat((req.params as { run_id: string }).run_id, body.worker_id),
      };
    } catch (e) {
      if (e instanceof LeaseLost) {
        throw new HttpError(409, 'lease_lost', e.message);
      }
      throw e;
    }
  });

  app.post('/v1/research/tasks/:run_id/finish', async (req, reply) => {
    await worker(req);
    const body = (req.body ?? {}) as { worker_id?: string; state?: string };
    if (!body.worker_id || !['completed', 'stage_a_only', 'failed'].includes(body.state ?? '')) {
      throw badRequest('需要 worker_id 与 state（completed | stage_a_only | failed）');
    }
    try {
      await d.scheduler.finish((req.params as { run_id: string }).run_id, body.worker_id, body.state as 'completed');
    } catch (e) {
      if (e instanceof LeaseLost) {
        throw new HttpError(409, 'lease_lost', e.message);
      }
      throw e;
    }
    return reply.code(204).send();
  });

  app.post('/v1/research/budget', async (req, reply) => {
    await worker(req);
    const body = (req.body ?? {}) as { used_ratio?: number };
    if (typeof body.used_ratio !== 'number' || body.used_ratio < 0) {
      throw badRequest('used_ratio 必须是非负数（当日 token 用量 / 当日上限）');
    }
    d.scheduler.budgetRatio = body.used_ratio;
    return reply.code(204).send();
  });

  /** worker 的研判输入：事件（该版本）、成员告警、阶段 A 报告、研判时刻的两跳拓扑邻域、反馈、动作目录。 */
  /** 研判任务对应的事件版本与研判时刻的两跳拓扑邻域。 */
  const taskInput = async (runId: string) => {
    const r = await d.pool.query<{ incident_id: string; incident_version: number; reason: string }>(
      'SELECT incident_id, incident_version, reason FROM server.research_queue WHERE run_id = $1',
      [runId],
    );
    const t = r.rows[0];
    if (!t) {
      throw notFound('没有这个研判任务');
    }
    const incident = await incidentVersion(d.pool, t.incident_id, t.incident_version);
    if (!incident) {
      throw notFound('事件版本不存在');
    }
    const keys = [...new Set([...incident.components, ...incident.candidates.map((c) => c.component)])];
    const topo = await d.topology.neighborhood(incident.cluster_id, keys, new Date(incident.updated_at), 2);
    return { task: t, incident, topo };
  };

  app.get('/v1/research/tasks/:run_id/context', async (req) => {
    await worker(req);
    const runId = (req.params as { run_id: string }).run_id;
    const { task: t, incident, topo } = await taskInput(runId);
    const alerts: Alert[] = await alertsById(
      d.pool,
      incident.members.filter((m) => m.left_version === null).map((m) => m.alert_id),
    );
    const stageA = await latestStageA(d.pool, t.incident_id, t.incident_version);
    const feedback: Feedback[] = await d.feedback.list(t.incident_id);
    const types = new Set(topo.nodes.map((n) => n.component_type).filter((x): x is string => x !== null));
    const cases = await referenceCases(d.pool, {
      clusterId: incident.cluster_id,
      incidentId: incident.incident_id,
      keys: new Set(topo.nodes.map((n) => n.key)),
      namespaces: new Set(topo.nodes.map((n) => n.namespace).filter((x): x is string => x !== null)),
      before: new Date(),
    });
    return {
      run_id: runId,
      reason: t.reason,
      incident,
      alerts,
      stage_a: stageA,
      topology: { version: topo.version, nodes: topo.nodes, edges: topo.edges },
      feedback,
      catalog: d.catalog.raw,
      knowledge: d.packs.knowledge(types, d.locale),
      cases,
      templates: d.packs.templates.map((x) => ({ id: x.id, description: x.description, args: x.args })),
      pack_lock: d.packs.set.lockDigest,
    };
  });

  /**
   * 区分性检查的查询模板由 server 执行（server 持有领域包运行时与证据数据源，worker 不直接访问数据源）：
   * 在 component（研判子图中的节点，或事件的组件与候选根因；通常是假设的根因）上执行模板附带的卡，
   * 参数按模板的 schema 校验后覆盖卡片默认参数。
   */
  app.post('/v1/research/tasks/:run_id/query', async (req) => {
    await worker(req);
    const body = (req.body ?? {}) as { template?: unknown; args?: unknown; component?: unknown };
    if (typeof body.template !== 'string' || typeof body.component !== 'string') {
      throw badRequest('需要 template 与 component');
    }
    const args = body.args ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw badRequest('args 必须是 JSON 对象');
    }
    const { incident, topo } = await taskInput((req.params as { run_id: string }).run_id);
    const template = d.packs.templates.find((t) => t.id === body.template);
    if (!template) {
      throw notFound(`没有查询模板 ${body.template}`);
    }
    const valid = argsValidator(template);
    if (!valid(args)) {
      throw badRequest(`参数不符合模板 ${template.id} 的 schema：${ajv.errorsText(valid.errors)}`);
    }
    const params: Record<string, number | string | boolean> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
        throw badRequest(`参数 ${k} 必须是数字、字符串或布尔值`);
      }
      params[k] = v;
    }
    // 子图节点，或事件的组件与候选根因（命名空间伪组件 Namespace:<ns> 不是拓扑节点）
    const component = body.component;
    const node = topo.nodes.find((n) => n.key === component);
    const own = incident.components.includes(component) || incident.candidates.some((c) => c.component === component);
    if (!node && !own) {
      throw badRequest(`组件 ${component} 不在本次研判的子图中`);
    }
    const k = parseKey(component);
    const entity = node
      ? { cluster_id: incident.cluster_id, kind: node.kind, namespace: node.namespace, name: node.name, uid: node.uid }
      : { cluster_id: incident.cluster_id, kind: k.kind, namespace: k.namespace, name: k.name, uid: null };
    return d.templates.runTemplate(incident, template.id, params, entity, Date.now(), AbortSignal.timeout(30_000));
  });

  app.get('/v1/incidents/:ref/research', async (req) => {
    await d.auth.reader(req);
    const inc = await resolveIncidentRef(d.pool, (req.params as { ref: string }).ref);
    if (!inc) {
      throw notFound('没有这个事件');
    }
    const r = await d.pool.query<{
      run_id: string;
      incident_id: string;
      incident_version: number;
      reason: string;
      state: string;
      disposition: string | null;
      conclusion_level: string | null;
      root_component: string | null;
      summary: string | null;
      started_at: Date;
      finished_at: Date | null;
    }>('SELECT * FROM server.research_runs WHERE incident_id = $1 ORDER BY started_at DESC', [inc.incident_id]);
    const queued = await d.pool.query<{
      run_id: string;
      incident_version: number;
      reason: string;
      state: string;
      enqueued_at: Date;
      skip_reason: string | null;
    }>(
      "SELECT run_id, incident_version, reason, state, enqueued_at, skip_reason FROM server.research_queue WHERE incident_id = $1 AND state IN ('queued', 'leased', 'skipped') ORDER BY enqueued_at DESC",
      [inc.incident_id],
    );
    const known = new Set(r.rows.map((x) => x.run_id));
    const pending = queued.rows
      .filter((q) => !known.has(q.run_id))
      .map((q) => ({
        run_id: q.run_id,
        incident_id: inc.incident_id,
        incident_version: q.incident_version,
        reason: q.reason,
        state: q.state === 'skipped' ? 'stage_a_only' : 'queued',
        disposition: null,
        conclusion_level: null,
        root_component: null,
        summary: q.skip_reason ? `跳过：${q.skip_reason}` : null,
        started_at: q.enqueued_at.toISOString(),
        finished_at: q.state === 'skipped' ? q.enqueued_at.toISOString() : null,
      }));
    return [
      ...pending,
      ...r.rows.map((x) => ({
        run_id: x.run_id,
        incident_id: x.incident_id,
        incident_version: x.incident_version,
        reason: x.reason,
        state: x.state,
        disposition: x.disposition,
        conclusion_level: x.conclusion_level,
        root_component: x.root_component,
        summary: x.summary,
        started_at: x.started_at.toISOString(),
        finished_at: x.finished_at?.toISOString() ?? null,
      })),
    ];
  });

  app.post('/v1/incidents/:ref/research', async (req, reply) => {
    await d.auth.user(req, 'research.request');
    const inc = await resolveIncidentRef(d.pool, (req.params as { ref: string }).ref);
    if (!inc) {
      throw notFound('没有这个事件');
    }
    const r = await d.scheduler.admit(inc.body as Incident, 'manual');
    if (r.outcome === 'capped') {
      throw new HttpError(429, 'research_capped', '该事件 6 小时内的模型研判已达上限');
    }
    if (!r.runId) {
      throw new HttpError(409, r.outcome, `没有入队：${r.outcome}`);
    }
    return reply.code(202).send({ run_id: r.runId, merged: r.outcome === 'duplicate' });
  });

  /** 研判所属事件的授权对象（经 server 的研判镜像找到事件）；没有这次研判时为 404。 */
  const runTarget = async (runId: string) => {
    const r = await d.pool.query<{ body: Incident }>(
      `SELECT i.body FROM server.research_runs r JOIN server.incidents i ON i.incident_id = r.incident_id
        WHERE r.run_id::text = $1`,
      [runId],
    );
    const row = r.rows[0];
    if (!row) {
      throw notFound('没有这次研判');
    }
    return incidentTarget(row.body);
  };

  /**
   * 研判运行明细由 worker 持有，server 按调用方对研判所属事件的读取作用域转发。
   * 原始提示词只对有 prompt.raw 权限的角色（auditor、admin），每次成功读取都写入治理审计。
   */
  for (const path of [
    '/v1/runs/:run_id',
    '/v1/runs/:run_id/manifest',
    '/v1/runs/:run_id/prompts',
    '/v1/runs/:run_id/prompt/raw',
  ]) {
    app.get(path, async (req, reply) => {
      const runId = (req.params as { run_id: string }).run_id;
      const target = await runTarget(runId);
      let actor: string;
      if (path.endsWith('/prompt/raw')) {
        actor = principalOf(await d.auth.user(req, 'prompt.raw', target));
      } else {
        const { caller, scopes } = await d.auth.reader(req);
        if (!visible(scopes, target)) {
          throw notFound('没有这次研判');
        }
        actor = principalOf(caller);
      }
      if (!d.worker) {
        throw new HttpError(503, 'unavailable', '没有配置 worker，研判明细不可用');
      }
      const res = await fetch(`${d.worker.url}${req.url}`, {
        headers: { authorization: `Bearer ${d.worker.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (path.endsWith('/prompt/raw') && res.ok) {
        await tx(d.pool, (c) => appendAudit(c, 'prompt.raw.read', actor, { run_id: runId }));
      }
      return reply.code(res.status).type('application/json').send(text);
    });
  }
}
