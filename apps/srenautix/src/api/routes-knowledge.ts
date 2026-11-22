import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { principalOf, type Auth } from '../identity/auth.js';
import { resolveIncidentRef } from '../incident/read.js';
import { incidentTarget, visible } from '../incident/target.js';
import { badRequest, forbidden, notFound } from '../kernel/errors.js';
import {
  packKnowledgeCatalog,
  type LearnedKnowledgeService,
  type PromoteIncidentKnowledgeRequest,
} from '../knowledge/service.js';
import type { PackRuntime } from '../stage-a/packs.js';

export interface KnowledgeRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  knowledge: LearnedKnowledgeService;
  packs: PackRuntime;
  locale: 'zh-CN' | 'en';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGINS: ReadonlySet<string> = new Set(['all', 'learned', 'pack']);
const KINDS: ReadonlySet<string> = new Set(['incident', 'benign']);

const promoteBodySchema = z
  .object({
    kind: z.enum(['incident', 'benign']).optional(),
    title: z.string().min(1).max(200).optional(),
    text: z.string().min(1).max(2000).optional(),
    components: z.array(z.string().min(1)).max(20).optional(),
    alertnames: z.array(z.string().min(1)).max(20).optional(),
    feedback_id: z.string().regex(UUID, 'feedback_id 必须是 UUID').nullable().optional(),
  })
  .strict();

/**
 * 知识库接口（contract/openapi.yaml 的 knowledge 标签）：
 * - POST /v1/incidents/:ref/knowledge：一键沉淀事件/反馈为可检索的知识案例（幂等）；
 * - GET /v1/knowledge：列出数据库沉淀案例与领域包静态知识；
 * - DELETE /v1/knowledge/:case_id：管理员软归档人工沉淀的知识案例。
 */
export function registerKnowledgeRoutes(app: FastifyInstance, d: KnowledgeRouteDeps): void {
  app.post('/v1/incidents/:ref/knowledge', async (req, reply) => {
    const { caller, scopes } = await d.auth.reader(req);
    if (caller.kind === 'service') {
      throw forbidden(`服务调用方 ${caller.caller.id} 不能调用这个接口`);
    }
    const inc = await resolveIncidentRef(d.pool, (req.params as { ref: string }).ref);
    if (!inc || !visible(scopes, incidentTarget(inc.body))) {
      throw notFound('没有这个事件');
    }
    const c = await d.auth.user(req, 'feedback', incidentTarget(inc.body));
    const raw = req.body === undefined || req.body === null || req.body === '' ? {} : req.body;
    const parsed = promoteBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => `/${i.path.join('/')} ${i.message}`).join('；'));
    }
    const body = parsed.data as PromoteIncidentKnowledgeRequest;
    const { item, created } = await d.knowledge.promoteIncident(principalOf(c), inc.body, body);
    return reply.code(created ? 201 : 200).send(item);
  });

  app.get('/v1/knowledge', async (req) => {
    const { caller, scopes } = await d.auth.reader(req);
    if (caller.kind === 'service' && caller.caller.kind === 'external') {
      throw forbidden(`外部调用方 ${caller.caller.id} 不能调用这个接口`);
    }
    const q = req.query as { origin?: string; kind?: string; q?: string; limit?: string };
    const origin = q.origin ?? 'all';
    if (!ORIGINS.has(origin)) {
      throw badRequest('origin 只能是 all、learned 或 pack');
    }
    if (q.kind !== undefined && !KINDS.has(q.kind)) {
      throw badRequest('kind 只能是 incident 或 benign');
    }
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw badRequest('limit 必须是 1–500 的整数');
    }
    const packItems = origin === 'learned' ? [] : packKnowledgeCatalog(d.packs, d.locale);
    const items = await d.knowledge.list(
      {
        origin: origin as 'all' | 'learned' | 'pack',
        ...(q.kind ? { kind: q.kind as 'incident' | 'benign' } : {}),
        ...(q.q ? { q: q.q } : {}),
        limit,
        scopes,
      },
      packItems,
    );
    return { items };
  });

  app.delete('/v1/knowledge/:case_id', async (req, reply) => {
    const c = await d.auth.user(req, 'eval.write');
    const caseId = (req.params as { case_id: string }).case_id;
    if (!UUID.test(caseId)) {
      throw notFound(`没有知识案例 ${caseId}`);
    }
    await d.knowledge.archive(principalOf(c), caseId);
    return reply.code(204).send();
  });
}
