import type { Alert, ChangeEvent, EvidenceResult, Feedback, Incident, TopologyEdge } from '@srenautix/contract';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { OutboxListener } from '../events/listener.js';
import { incidentTarget, visible } from '../console-bff/routes-incidents.js';
import { principalOf, type Auth } from '../identity/auth.js';
import { incidentVersion, latestStageA, resolveIncidentRef } from '../incident/read.js';
import { alertsById } from '../ingest/store.js';
import type { Catalog } from '../proposals/catalog.js';
import { cardApplies, cardCheckArgs, cardChecks, parseCardCheckId } from '../stage-a/card-checks.js';
import type { FeedbackService } from '../proposals/feedback.js';
import { LeaseLost, type RouteReport, type Scheduler } from '../scheduler/admission.js';
import type { PackEvidence } from '../stage-a/pack-evidence.js';
import type { CompiledTemplate, PackRuntime } from '../stage-a/packs.js';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';
import { hintOf, isLogicalComponent, type ComponentExpander } from '../topology/expand.js';
import type { TopologyStore } from '../topology/store.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from './errors.js';
import { KubeToolError, type KubeTools } from '../research/kube-tools.js';
import type { StageAService } from '../stage-a/service.js';
import { referenceCases } from './research-materials.js';
import { parseStoredKey } from '../topology/keys.js';

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
  templates: Pick<PackEvidence, 'runTemplate' | 'runCardCheck'>;
  /** 知识条目的语言。 */
  locale: 'zh-CN' | 'en';
  /** 本 server 所在的集群；Kubernetes 只读检查只对这个集群的事件提供 */
  clusterId: string;
  /** 阶段 B 的 Kubernetes 只读检查（ADR 0106）；没有配置集群只读权限时为 null */
  kube?: KubeTools | null;
  /** 研判输入里的相关变更：事件窗口内触及子图或同一命名空间的变更（变更源与从拓扑推导的发布） */
  changes?: (clusterId: string, from: Date, to: Date) => Promise<ChangeEvent[]>;
  /** 阶段 A 的重算（ADR 0107）：人工入口与研判前刷新 */
  stageA?: Pick<StageAService, 'recompute' | 'current'>;
  /** 逻辑组件映射出的候选进入研判的拓扑邻域（ADR 0130）；没有时邻域只按事件的组件与候选根因取 */
  expander?: Pick<ComponentExpander, 'logicalCandidates'>;
}

/** 逻辑组件到候选的映射边（ADR 0130）：命名来源，置信度 0.3，低于归并阈值 τ */
export function logicalEdge(from: string, to: string): TopologyEdge {
  return {
    from,
    to,
    relation: 'maps_to',
    provenance: 'naming',
    confidence: 0.3,
    scope: 'service',
    evidence: '逻辑组件按同名对象、告警的 service 标签与 Service 选中的工作负载映射',
  };
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const toolValidators = new Map<string, ValidateFunction>();

/** 事件涉及的命名空间：组件、候选根因、成员告警的实体、事件的变更目标与子图里的对象 */
function namespacesOf(incident: Incident, nodes: readonly { namespace: string | null }[]): Set<string> {
  const out = new Set<string>();
  const add = (key: string | null) => {
    if (!key) {
      return;
    }
    try {
      const k = parseStoredKey(key);
      const ns = k.kind === 'Namespace' ? k.name : k.namespace;
      if (ns) {
        out.add(ns);
      }
    } catch {
      // 不是组件键（逻辑组件等）
    }
  };
  incident.components.forEach(add);
  incident.candidates.forEach((c) => add(c.component));
  incident.changes.forEach((c) => c.targets.forEach(add));
  for (const n of nodes) {
    if (n.namespace) {
      out.add(n.namespace);
    }
  }
  return out;
}
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

  app.post('/v1/research/routes', async (req, reply) => {
    await worker(req);
    const body = (req.body ?? {}) as Partial<RouteReport>;
    const ok =
      typeof body.worker_id === 'string' &&
      body.worker_id.length > 0 &&
      Array.isArray(body.routes) &&
      body.routes.every(
        (r) =>
          typeof r?.id === 'string' &&
          typeof r.enabled === 'boolean' &&
          (r.reason === null || typeof r.reason === 'string') &&
          (r.message === null || typeof r.message === 'string'),
      );
    if (!ok) {
      throw badRequest('需要 worker_id 与 routes[]（id、enabled、reason、message）');
    }
    const r = body as RouteReport;
    d.scheduler.reportRoutes({
      workerId: r.worker_id,
      at: Date.now(),
      routes: r.routes.map((x) => ({
        id: x.id,
        enabled: x.enabled,
        reason: x.reason?.slice(0, 64) ?? null,
        message: x.message?.slice(0, 500) ?? null,
      })),
    });
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
    const own = [...new Set([...incident.components, ...incident.candidates.map((c) => c.component)])];
    // 逻辑组件（例如 component:catalog）不在拓扑里：映射出的候选工作负载与 Service 作为邻域的起点（ADR 0130），
    // 阶段 B 的子图、组件枚举与卡片检查因此包含它们
    const mapped: TopologyEdge[] = [];
    if (d.expander && own.some((k) => isLogicalComponent(k))) {
      const alerts = await alertsById(
        d.pool,
        incident.members.filter((m) => m.left_version === null).map((m) => m.alert_id),
      );
      for (const k of own.filter((x) => isLogicalComponent(x))) {
        const hints = alerts.filter((a) => a.component === k).map((a) => hintOf(a.labels));
        const at = new Date(incident.updated_at);
        for (const to of await d.expander.logicalCandidates(incident.cluster_id, k, hints, at)) {
          mapped.push(logicalEdge(k, to));
        }
      }
    }
    const keys = [...new Set([...own, ...mapped.map((e) => e.to)])];
    const near = await d.topology.neighborhood(incident.cluster_id, keys, new Date(incident.updated_at), 2);
    // 映射本身作为邻域里的边（maps_to，置信度低于归并阈值，不进入假设的范围）
    const topo = { ...near, edges: [...mapped, ...near.edges] };
    return { task: t, incident, topo };
  };

  app.get('/v1/research/tasks/:run_id/context', async (req) => {
    await worker(req);
    const runId = (req.params as { run_id: string }).run_id;
    const { task: t, incident, topo } = await taskInput(runId);
    // 研判用的报告是用旧的领域包算出来的（领域包增加、减少或升级之后）：先按当前领域包重算（ADR 0107）
    if (d.stageA && !(await d.stageA.current(incident.incident_id, incident.incident_version))) {
      await d.stageA.recompute(incident.incident_id, 'before_research', incident);
    }
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
      // 领域包的查询模板，加上子图组件 × 适用的证据链卡（卡片即检查，ADR 0116）
      templates: [
        ...d.packs.templates.map((x) => ({ id: x.id, description: x.description, args: x.args })),
        ...cardChecks(d.packs, incident, topo.nodes, stageA?.cards ?? [], d.locale, topo.edges),
      ],
      pack_lock: d.packs.set.lockDigest,
      hub_tools: d.kube && incident.cluster_id === d.clusterId ? d.kube.specs() : [],
      related_changes: await relatedChanges(incident, topo.nodes),
    };
  });

  /** 事件窗口（首次触发前 2 小时到现在）内触及子图对象、或落在事件命名空间里的变更，不含已经在事件里的 */
  const relatedChanges = async (incident: Incident, nodes: readonly { key: string; namespace: string | null }[]) => {
    if (!d.changes) {
      return [];
    }
    const from = new Date(Date.parse(incident.first_firing_at) - 2 * 3600_000);
    const all = await d.changes(incident.cluster_id, from, new Date());
    const own = new Set(incident.changes.map((c) => c.change_id));
    const keys = new Set(nodes.map((n) => n.key));
    const namespaces = namespacesOf(incident, nodes);
    return all
      .filter((c) => !own.has(c.change_id))
      .filter((c) =>
        c.targets.some((t) => {
          if (keys.has(t)) {
            return true;
          }
          try {
            const ns = parseStoredKey(t).namespace;
            return ns !== null && namespaces.has(ns);
          } catch {
            return false;
          }
        }),
      )
      .slice(-20);
  };

  /**
   * 阶段 B 的 Kubernetes 只读检查（ADR 0106）：worker 以区分性检查调用，server 用自己的只读凭证读取当前状态。
   * 只对本集群的事件、只在事件涉及的命名空间里；参数按工具的 schema 校验。
   */
  app.post('/v1/research/tasks/:run_id/tool', async (req) => {
    await worker(req);
    const body = (req.body ?? {}) as { name?: unknown; args?: unknown };
    if (typeof body.name !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) {
      throw badRequest('需要 name 与 args（JSON 对象）');
    }
    const { incident, topo } = await taskInput((req.params as { run_id: string }).run_id);
    if (!d.kube || incident.cluster_id !== d.clusterId) {
      throw conflict(
        'kube_unavailable',
        '本 server 不能读取这个集群的 Kubernetes 状态（只读检查只对 server 所在的集群提供）',
      );
    }
    const spec = d.kube.specs().find((t) => t.name === body.name);
    if (!spec) {
      throw notFound(`没有工具 ${body.name}`);
    }
    let valid = toolValidators.get(spec.name);
    if (!valid) {
      valid = ajv.compile(spec.parameters);
      toolValidators.set(spec.name, valid);
    }
    if (!valid(body.args)) {
      throw badRequest(`参数不符合工具 ${spec.name} 的 schema：${ajv.errorsText(valid.errors)}`);
    }
    try {
      return await d.kube.run(spec.name, body.args as Record<string, unknown>, namespacesOf(incident, topo.nodes));
    } catch (e) {
      if (e instanceof KubeToolError) {
        throw new HttpError(422, 'tool_rejected', e.message);
      }
      throw e;
    }
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
    // 卡片检查（ADR 0116）：按 id 里的组件执行，不按请求体的 component（假设的根因）
    const cardCheck = parseCardCheckId(body.template);
    if (cardCheck) {
      const e = d.packs.set.cards.get(cardCheck.card);
      if (!e || e.chain === null) {
        throw notFound(`没有证据链的卡 ${cardCheck.card}`);
      }
      const valid = ajv.compile(cardCheckArgs(e));
      if (!valid(args)) {
        throw badRequest(`参数不符合卡片检查 ${body.template} 的 schema：${ajv.errorsText(valid.errors)}`);
      }
      const entity = entityIn(incident, topo, cardCheck.component);
      if (!cardApplies(e, entity.kind)) {
        throw badRequest(`卡 ${cardCheck.card} 不适用于 ${entity.kind}`);
      }
      return d.templates.runCardCheck(
        incident,
        e.key,
        args as Record<string, unknown>,
        entity,
        Date.now(),
        AbortSignal.timeout(30_000),
      );
    }
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
    const entity = entityIn(incident, topo, body.component);
    return d.templates.runTemplate(incident, template.id, params, entity, Date.now(), AbortSignal.timeout(30_000));
  });

  /** 子图节点，或事件的组件与候选根因（命名空间伪组件 Namespace:<ns> 不是拓扑节点）→ 实体；不在其中时 400 */
  const entityIn = (
    incident: Incident,
    topo: {
      nodes: ReadonlyArray<{ key: string; kind: string; namespace: string | null; name: string; uid: string | null }>;
    },
    component: string,
  ) => {
    const node = topo.nodes.find((n) => n.key === component);
    const own = incident.components.includes(component) || incident.candidates.some((c) => c.component === component);
    if (!node && !own) {
      throw badRequest(`组件 ${component} 不在本次研判的子图中`);
    }
    const k = parseStoredKey(component);
    return node
      ? { cluster_id: incident.cluster_id, kind: node.kind, namespace: node.namespace, name: node.name, uid: node.uid }
      : { cluster_id: incident.cluster_id, kind: k.kind, namespace: k.namespace, name: k.name, uid: null };
  };

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

  /** 按当前领域包与拓扑重算阶段 A（ADR 0107）：只算阶段 A，不触发模型；写入治理审计 */
  app.post('/v1/incidents/:ref/stage-a/recompute', async (req) => {
    const caller = await d.auth.user(req, 'research.request');
    if (!d.stageA) {
      throw conflict('unavailable', '阶段 A 不可用');
    }
    const inc = await resolveIncidentRef(d.pool, (req.params as { ref: string }).ref);
    if (!inc) {
      throw notFound('没有这个事件');
    }
    const out = await d.stageA.recompute(inc.incident_id, 'manual');
    await tx(d.pool, (c) =>
      appendAudit(c, 'stage_a.recompute', principalOf(caller), {
        incident_id: inc.incident_id,
        incident_version: out.report.incident_version,
        report_id: out.report.report_id,
        cards: out.report.cards.length,
        disposition: out.report.disposition,
      }),
    );
    return out.report;
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
      if (path === '/v1/runs/:run_id' && res.ok) {
        return reply.type('application/json').send(await withStageACards(JSON.parse(text) as RunDetail));
      }
      return reply.code(res.status).type('application/json').send(text);
    });
  }

  /**
   * worker 的运行明细只含区分性检查产生的卡；控制台需要整次研判的证据，server 在前面合并该事件版本的阶段 A 卡。
   * 阶段 A 卡保留报告中的编号，检查卡的编号在其后，按 ref 去重。
   */
  const withStageACards = async (run: RunDetail): Promise<RunDetail> => {
    const report = await latestStageA(d.pool, run.incident_id, run.incident_version);
    const stageA = report?.cards ?? [];
    const refs = new Set(stageA.map((c) => c.ref));
    return { ...run, evidence: [...stageA, ...run.evidence.filter((c) => !refs.has(c.ref))] };
  };
}

interface RunDetail {
  incident_id: string;
  incident_version: number;
  evidence: EvidenceResult[];
}
