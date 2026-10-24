import { randomUUID } from 'node:crypto';
import {
  validatorFor,
  type FindingStatus,
  type Goal,
  type GoalCreate,
  type GoalSpec,
  type OptimizationRecommendation,
  type RecommendationState,
} from '@srenautix/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Auth } from '../identity/auth.js';
import { scopeMatches, type RoleBinding, type Target } from '../identity/bindings.js';
import {
  GOALS_PER_PRINCIPAL_PER_DAY,
  GoalRejected,
  goalSpec,
  OPEN_GOALS_PER_CLUSTER,
  type OptimizationCatalog,
} from '../optimize/goals.js';
import { decodeCursor, OPEN_GOAL_STATES, type OptimizationStore } from '../optimize/store.js';
import { durationMs } from '../optimize/stats.js';
import { appendAudit } from '../store/audit.js';
import { appendEvents } from '../store/outbox.js';
import { tx } from '../store/pool.js';
import { parseStoredKey } from '../topology/keys.js';
import { badRequest, conflict, forbidden, HttpError, notFound, unavailable } from './errors.js';

// 主动优化的接口（contract/openapi.yaml 的 optimization 标签，ADR 0146 §5.1）：目标的下达、列表、读取与取消，运行明细，
// 发现与建议的列表，"建议无用"，以及新建目标时的指标与领域目录。主动优化关闭时写接口返回 503。

export const EVENTS_SCHEMA_VERSION = '2.28.0';

export interface GoalRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  store: OptimizationStore;
  /** optimization.enabled */
  enabled: boolean;
  /** 加载的领域包的指标与领域；领域包还没有加载时为 null */
  catalog: () => (OptimizationCatalog & { raw: CatalogBody }) | null;
  /** 领域的冷却期（gates.cooldown，默认 30d） */
  cooldown: (domain: string) => string;
  now?: () => number;
}

export interface CatalogBody {
  indicators: Array<{ id: string; definition: unknown }>;
  domains: Array<{ id: string; title: unknown; packs: string[]; indicators: string[] }>;
}

/** 目标涉及的命名空间：作用域的命名空间与组件所在的命名空间；都没有时为集群级 */
export function goalNamespaces(spec: Pick<GoalSpec, 'subject'>): string[] {
  const scope = spec.subject.scope;
  const out = new Set(scope.namespaces);
  for (const c of scope.components) {
    const ns = parseStoredKey(c).namespace;
    if (ns) {
      out.add(ns);
    }
  }
  return [...out];
}

function goalTargets(clusterId: string, spec: Pick<GoalSpec, 'subject'>): Target[] {
  const ns = goalNamespaces(spec);
  return ns.length
    ? ns.map((n) => ({ cluster: clusterId, namespace: n, labels: {} }))
    : [{ cluster: clusterId, namespace: null, labels: {} }];
}

function visible(scopes: RoleBinding[] | 'all', clusterId: string, spec: Pick<GoalSpec, 'subject'>): boolean {
  return scopes === 'all' || goalTargets(clusterId, spec).every((t) => scopes.some((b) => scopeMatches(b, t)));
}

const limitOf = (v: string | undefined) => Math.min(200, Math.max(1, Number(v ?? 50) || 50));

function cursorOf(v: string | undefined) {
  try {
    return decodeCursor(v);
  } catch {
    throw badRequest('cursor 不合法');
  }
}

export function registerGoalRoutes(app: FastifyInstance, d: GoalRouteDeps): void {
  const createBody = validatorFor<GoalCreate>('schemas/goal.schema.json#/$defs/GoalCreate');
  const now = d.now ?? Date.now;
  const requireEnabled = () => {
    if (!d.enabled) {
      throw unavailable('主动优化没有开启（optimization.enabled）');
    }
  };
  const readable = async (req: FastifyRequest, goalId: string): Promise<Goal> => {
    const { scopes } = await d.auth.reader(req);
    const g = await d.store.goal(goalId);
    if (!g || !visible(scopes, g.cluster_id, g.spec)) {
      throw notFound('没有这个目标');
    }
    return g;
  };

  app.get('/v1/goals', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const q = req.query as Record<string, string | undefined>;
    const out = await d.store.listGoals({
      clusterId: q.cluster_id ?? null,
      state: (q.state as Goal['state'] | undefined) ?? null,
      open: q.open === 'true',
      domain: q.domain ?? null,
      cursor: cursorOf(q.cursor),
      limit: limitOf(q.limit),
    });
    return { items: out.items.filter((g) => visible(scopes, g.cluster_id, g.spec)), next_cursor: out.next };
  });

  app.post('/v1/goals', async (req, reply) => {
    requireEnabled();
    if (!createBody(req.body)) {
      throw badRequest(
        (createBody.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`).join('；'),
      );
    }
    const body = req.body;
    const c = await d.auth.required(req);
    let origin: GoalSpec['origin'];
    if (c.kind === 'user') {
      for (const t of goalTargets(body.cluster_id, { subject: body.subject })) {
        await d.auth.user(req, 'research.request', t);
      }
      origin = { kind: 'manual', channel: 'console', principal: c.session.principalId };
    } else if (c.kind === 'service' && c.caller.kind === 'external' && c.caller.channel === 'api') {
      const ns = goalNamespaces({ subject: body.subject });
      const allowed = c.caller.namespaces;
      if (!ns.length && !allowed.includes('*')) {
        throw forbidden(`调用方 ${c.caller.id} 只能为命名空间 ${allowed.join('、')} 下达目标，目标没有限定命名空间`);
      }
      const outside = ns.filter((n) => !allowed.includes('*') && !allowed.includes(n));
      if (outside.length) {
        throw forbidden(`调用方 ${c.caller.id} 不能为命名空间 ${outside.join('、')} 下达目标`);
      }
      origin = { kind: 'manual', channel: 'api', principal: c.caller.id };
    } else {
      throw forbidden('只有控制台会话与外部 API 调用方可以下达目标');
    }
    const catalog = d.catalog();
    if (!catalog) {
      throw unavailable('领域包还没有加载，没有可用的指标与领域');
    }
    let built: ReturnType<typeof goalSpec>;
    try {
      built = goalSpec(body, origin, catalog);
    } catch (e) {
      if (e instanceof GoalRejected) {
        throw badRequest(e.message);
      }
      throw e;
    }
    const principal = origin.principal;
    const goalId = randomUUID();
    const goal = await tx(d.pool, async (x) => {
      // 同一主体与集群的并发创建按顺序计数
      await x.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`goals:${body.cluster_id}`]);
      if ((await d.store.goalsToday(principal, x)) >= GOALS_PER_PRINCIPAL_PER_DAY) {
        throw new HttpError(429, 'goal_limit', `每个主体每天最多下达 ${GOALS_PER_PRINCIPAL_PER_DAY} 个目标`);
      }
      if ((await d.store.openGoals(body.cluster_id, x)) >= OPEN_GOALS_PER_CLUSTER) {
        throw new HttpError(429, 'goal_limit', `每个集群同时最多 ${OPEN_GOALS_PER_CLUSTER} 个未结束的目标`);
      }
      const g = await d.store.createGoal(x, {
        goalId,
        clusterId: body.cluster_id,
        spec: built.spec,
        principal,
        expiresAt: new Date(now() + built.expiresInMs),
        runId: randomUUID(),
      });
      await appendEvents(x, 'server', 'server', EVENTS_SCHEMA_VERSION, [
        { type: 'goal.created', clusterId: g.cluster_id, payload: g },
      ]);
      await appendAudit(x, 'optimization.goal_created', principal, {
        goal_id: g.goal_id,
        cluster_id: g.cluster_id,
        origin: built.spec.origin,
        subject: built.spec.subject,
        objective: built.spec.objective,
        outputs: built.spec.outputs,
      });
      return g;
    });
    return reply.code(201).send(goal);
  });

  app.get('/v1/goals/:goal_id', async (req) => readable(req, (req.params as { goal_id: string }).goal_id));

  app.post('/v1/goals/:goal_id/cancel', async (req) => {
    const goalId = (req.params as { goal_id: string }).goal_id;
    const g = await readable(req, goalId);
    const c = await d.auth.required(req);
    if (c.kind === 'user') {
      for (const t of goalTargets(g.cluster_id, g.spec)) {
        await d.auth.user(req, 'research.request', t);
      }
    } else if (!(c.kind === 'service' && c.caller.kind === 'external' && c.caller.channel === 'api')) {
      throw forbidden('只有控制台会话与外部 API 调用方可以取消目标');
    }
    const actor = c.kind === 'user' ? c.session.principalId : `service:${c.caller.id}`;
    return tx(d.pool, async (x) => {
      const r = await x.query<{ state: Goal['state'] }>(
        'SELECT state FROM server.goals WHERE goal_id = $1 FOR UPDATE',
        [goalId],
      );
      const state = r.rows[0]?.state;
      if (!state || !OPEN_GOAL_STATES.includes(state)) {
        throw conflict('goal_finished', `目标已经结束（${state}），不能取消`);
      }
      await d.store.setGoalState(x, goalId, 'cancelled', 'user');
      // 排队与推迟中的运行直接取消；进行中的运行在下一个检查点停止
      await x.query(
        `UPDATE server.goal_runs SET state = 'cancelled', finished_at = now() WHERE goal_id = $1 AND state IN ('queued', 'deferred')`,
        [goalId],
      );
      await appendAudit(x, 'optimization.goal_cancelled', actor, { goal_id: goalId });
      return d.store.goal(goalId, x);
    });
  });

  app.get('/v1/goals/:goal_id/runs', async (req) => {
    const goalId = (req.params as { goal_id: string }).goal_id;
    await readable(req, goalId);
    return d.store.runs(goalId);
  });

  app.get('/v1/goals/:goal_id/runs/:run_id', async (req) => {
    const p = req.params as { goal_id: string; run_id: string };
    await readable(req, p.goal_id);
    const r = await d.store.run(p.goal_id, p.run_id);
    if (!r) {
      throw notFound('没有这次运行');
    }
    return r;
  });

  app.get('/v1/findings', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const q = req.query as Record<string, string | undefined>;
    const out = await d.store.listFindings({
      clusterId: q.cluster_id ?? null,
      domain: q.domain ?? null,
      status: (q.status as FindingStatus | undefined) ?? null,
      goalId: q.goal_id ?? null,
      component: q.component ?? null,
      cursor: cursorOf(q.cursor),
      limit: limitOf(q.limit),
    });
    const ok = (component: string, clusterId: string) =>
      scopes === 'all' ||
      scopes.some((b) =>
        scopeMatches(b, { cluster: clusterId, namespace: parseStoredKey(component).namespace, labels: {} }),
      );
    return { items: out.items.filter((f) => ok(f.component, f.cluster_id)), next_cursor: out.next };
  });

  app.get('/v1/recommendations', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const q = req.query as Record<string, string | undefined>;
    const out = await d.store.listRecommendations({
      goalId: q.goal_id ?? null,
      finding: q.finding ?? null,
      kind: q.kind ?? null,
      state: (q.state as RecommendationState | undefined) ?? null,
      cursor: cursorOf(q.cursor),
      limit: limitOf(q.limit),
    });
    const goals = new Map<string, Goal | null>();
    const items: OptimizationRecommendation[] = [];
    for (const r of out.items) {
      if (!goals.has(r.goal_id)) {
        goals.set(r.goal_id, await d.store.goal(r.goal_id));
      }
      const g = goals.get(r.goal_id);
      if (g && visible(scopes, g.cluster_id, g.spec)) {
        items.push(r);
      }
    }
    return { items, next_cursor: out.next };
  });

  app.post('/v1/recommendations/:recommendation_id/reject', async (req) => {
    const id = (req.params as { recommendation_id: string }).recommendation_id;
    const body = (req.body ?? {}) as { reason?: unknown };
    if (body.reason !== null && typeof body.reason !== 'string') {
      throw badRequest('reason 必须是字符串或 null');
    }
    const c = await d.auth.required(req);
    if (c.kind !== 'user') {
      throw forbidden('“建议无用”只能在控制台会话中标记');
    }
    const rec = await d.store.recommendation(id);
    const g = rec ? await d.store.goal(rec.goal_id) : null;
    if (!rec || !g) {
      throw notFound('没有这个建议');
    }
    for (const t of goalTargets(g.cluster_id, g.spec)) {
      await d.auth.user(req, 'feedback', t);
    }
    return tx(d.pool, async (x) => {
      const cur = (await d.store.recommendation(id, x)) as OptimizationRecommendation;
      if (cur.state === 'rejected' || cur.state === 'superseded') {
        throw conflict('recommendation_closed', `建议已经是 ${cur.state}`);
      }
      const at = new Date(now()).toISOString();
      const updated: OptimizationRecommendation = { ...cur, state: 'rejected', updated_at: at };
      await d.store.saveRecommendation(x, updated);
      const fs = await d.store.findings([cur.finding], x);
      const f = fs.get(cur.finding);
      const events = [{ type: 'recommendation.updated', clusterId: cur.cluster_id, payload: updated }];
      if (f) {
        const until = new Date(now() + durationMs(d.cooldown(f.body.domain))).toISOString();
        const finding = { ...f.body, status: 'rejected' as const, cooldown_until: until, updated_at: at };
        await d.store.saveFinding(x, finding, { gapAtRejection: f.body.gap });
        events.push({ type: 'finding.updated', clusterId: finding.cluster_id, payload: finding as never });
      }
      await appendEvents(x, 'server', 'server', EVENTS_SCHEMA_VERSION, events);
      await appendAudit(x, 'optimization.recommendation_rejected', c.session.principalId, {
        recommendation_id: id,
        finding: cur.finding,
        reason: body.reason ?? null,
      });
      return updated;
    });
  });

  app.get('/v1/optimization/catalog', async (req) => {
    await d.auth.reader(req);
    const catalog = d.catalog();
    return catalog ? catalog.raw : { indicators: [], domains: [] };
  });
}
