import { validatorFor, type SkillPatch, type SkillRunCreate } from '@srenautix/contract';
import type { FastifyInstance } from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { badRequest, conflict, HttpError, notFound } from '../api/errors.js';
import type { Auth } from '../identity/auth.js';
import { SkillRejected, type SkillService } from './service.js';

// 技能的接口（contract/openapi.yaml 的 skills 标签，ADR 0181 §8）：宿主、技能列表与状态、暂停与恢复、手动运行、运行明细。
// 技能没有启用（service 为 null）时读取接口返回空列表，写接口返回 409。

export interface SkillRouteDeps {
  auth: Auth;
  skills: SkillService | null;
  clusterId: string;
}

const MAX_AGE_MS = 7 * 24 * 3600_000;

export function registerSkillRoutes(app: FastifyInstance, d: SkillRouteDeps): void {
  const patchBody = validatorFor<SkillPatch>('schemas/skill-run.schema.json#/$defs/SkillPatch');
  const runBody = validatorFor<SkillRunCreate>('schemas/skill-run.schema.json#/$defs/SkillRunCreate');
  const errs = (v: { errors?: Array<{ instancePath: string; message?: string; keyword: string }> | null }) =>
    (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`).join('；');
  const svc = () => {
    if (!d.skills) {
      throw conflict('skills_disabled', 'server 没有技能服务');
    }
    return d.skills;
  };
  const rethrow = (e: unknown): never => {
    if (e instanceof SkillRejected) {
      throw new HttpError(
        e.status,
        e.status === 409
          ? 'skill_unavailable'
          : e.status === 403
            ? 'forbidden'
            : e.status === 404
              ? 'not_found'
              : 'bad_request',
        e.message,
      );
    }
    throw e;
  };

  app.get('/v1/skill-host', async (req) => {
    await d.auth.reader(req);
    return svc().host();
  });

  app.get('/v1/skills', async (req) => {
    await d.auth.reader(req);
    return d.skills ? d.skills.summaries() : [];
  });

  app.get('/v1/skills/:name', async (req) => {
    await d.auth.reader(req);
    const s = d.skills?.summary((req.params as { name: string }).name) ?? null;
    if (!s) {
      throw notFound('没有这个技能');
    }
    return s;
  });

  app.patch('/v1/skills/:name', async (req) => {
    const c = await d.auth.user(req, 'pause.write');
    if (!patchBody(req.body)) {
      throw badRequest(errs(patchBody));
    }
    const b = req.body;
    try {
      return await svc().setPaused((req.params as { name: string }).name, b.paused, b.reason ?? null, c.subject.id);
    } catch (e) {
      return rethrow(e);
    }
  });

  app.get('/v1/skills/:name/runs', async (req) => {
    await d.auth.reader(req);
    const name = (req.params as { name: string }).name;
    if (!d.skills?.summary(name)) {
      throw notFound('没有这个技能');
    }
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit ?? 50) || 50));
    return d.skills.runs(name, limit);
  });

  app.post('/v1/skills/:name/runs', async (req, reply) => {
    if (!runBody(req.body)) {
      throw badRequest(errs(runBody));
    }
    const b = req.body;
    const cluster = b.cluster_id ?? d.clusterId;
    if (cluster !== d.clusterId) {
      throw badRequest(`技能只在本集群 ${d.clusterId} 上运行`);
    }
    const c = await d.auth.user(req, 'research.request', { cluster, namespace: b.subject.namespace, labels: {} });
    const name = (req.params as { name: string }).name;
    const s = svc();
    const e = s.registry.get(name);
    if (!e?.skill) {
      throw notFound('没有这个技能');
    }
    const inputs = b.inputs ?? {};
    const v = new Ajv2020({ allErrors: true, strict: false }).compile(e.skill.manifest.inputs);
    if (!v(inputs)) {
      throw badRequest(`inputs 不符合技能 ${name} 的 inputs：${errs(v)}`);
    }
    if (b.at) {
      const t = Date.parse(b.at);
      if (t > Date.now() || Date.now() - t > MAX_AGE_MS) {
        throw badRequest('at 不能晚于现在，不能早于 7 天前');
      }
    }
    if (!e.skill.manifest.triggers.some((t) => t.kind === 'manual')) {
      throw conflict('skill_unavailable', `技能 ${name} 没有声明手动触发`);
    }
    try {
      const run = await s.enqueue(
        name,
        b.subject,
        {
          trigger: 'manual',
          kind: 'manual',
          at: new Date().toISOString(),
          detail: `手动运行（${c.subject.id}）`,
          pod: null,
          container: null,
          cause: null,
        },
        { manual: true, requestedBy: c.subject.id, at: b.at ?? null, inputs, clusterId: cluster },
      );
      return reply.code(202).send(run);
    } catch (err) {
      return rethrow(err);
    }
  });

  app.get('/v1/skill-runs/:run_id', async (req) => {
    await d.auth.reader(req);
    const id = (req.params as { run_id: string }).run_id;
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      throw badRequest('run_id 不是 UUID');
    }
    const r = await svc().run(id);
    if (!r) {
      throw notFound('没有这个运行');
    }
    return r;
  });
}
