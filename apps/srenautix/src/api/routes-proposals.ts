import type { Proposal, ProposalCreate } from '@srenautix/contract';
import { validatorFor } from '@srenautix/contract';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Auth, Caller } from '../identity/auth.js';
import { scopeMatches } from '../identity/bindings.js';
import type { Catalog } from '../proposals/catalog.js';
import type { Policies } from '../proposals/policy.js';
import type { Approver, ProposalCaller, ProposalService } from '../proposals/service.js';
import { idempotent } from '../store/idempotency.js';
import { badRequest, forbidden, notFound } from './errors.js';

/**
 * 控制台会话的审批人；H 档的重新认证凭据来自会话的认证时间（OIDC max_age 或本地管理员 TOTP）。
 * 本地管理员不带 TOTP 登录的会话（identity.local_admin.totp_required=false）没有 local_totp 凭据，
 * H 档审批前必须经 POST /v1/auth/reauth 用口令加 TOTP 重新认证（ADR 0118）。
 */
export function approverFromSession(c: Extract<Caller, { kind: 'user' }>): Approver {
  const oidc = c.session.provider === 'oidc';
  return {
    principalId: c.session.principalId,
    channel: 'console',
    subject: c.subject,
    linked: true,
    reauth:
      oidc || c.session.mfa
        ? { authTime: c.session.authTime, method: oidc ? 'oidc_max_age' : 'local_totp', sessionId: c.sessionId }
        : null,
  };
}

async function consoleApprover(auth: Auth, req: FastifyRequest): Promise<Approver> {
  const c = await auth.required(req);
  if (c.kind !== 'user') {
    throw forbidden('审批只能在控制台会话中进行（Grafana 插件与服务调用方没有审批路径）');
  }
  return approverFromSession(c);
}

export interface ProposalRouteDeps {
  pool: pg.Pool;
  auth: Auth;
  proposals: ProposalService;
  catalog: Catalog;
  policies: () => Policies;
}

const UNDO_KIND = {
  restore: 'auto_restore',
  recreate: 'controller_rebuild',
  compensate: 'compensation',
  none: 'none',
} as const;

/**
 * 审批页的提议详情（DESIGN §12.2）：服务端重新执行的检查（带时间戳）、爆炸半径、冲突域与排队位置、校验条件与窗口、
 * 撤销方式、决定档位的规则。目标的实时状态以 gateway 执行前的预检为准，这里给出拓扑中的对象与 UID。
 */
async function proposalDetail(d: ProposalRouteDeps, p: Proposal) {
  const a = d.catalog.get(p.action);
  if (!a) {
    throw new Error(`提议 ${p.proposal_id} 的动作 ${p.action} 不在目录中`);
  }
  const now = await d.pool.query<{ now: Date }>('SELECT now() AS now');
  const rechecks = await d.proposals.recheck(p);
  const verifyQueries = Array.isArray((p.params as { verify?: unknown }).verify)
    ? (p.params as { verify: Array<{ query: string; op: string; threshold: number }> }).verify.map(
        (v) => `${v.query} ${v.op} ${v.threshold}`,
      )
    : [];
  const policyRule =
    p.tier === 'H'
      ? a.level === 'compensable'
        ? '可补偿的动作一律 H 档'
        : a.blast_radius.l_tier_max === 0
          ? '动作的爆炸半径没有 L 档上限'
          : p.policy_checks.some((c) => c.name === 'self_dependency')
            ? '目标属于 SreNautix 自身的依赖'
            : `目录规定的最低档位 ${a.min_tier}`
      : `目录规定的最低档位 ${a.min_tier}`;
  return {
    proposal: p,
    target_state: {
      exists: p.target.uid !== null,
      uid: p.target.uid,
      resource_version: null,
      summary: `${p.target.kind} ${p.target.display}（拓扑中的对象；执行前由 gateway 重新读取实时状态）`,
    },
    prechecks: rechecks,
    prechecked_at: (now.rows[0] as { now: Date }).now.toISOString(),
    blast_radius: { summary: a.blast_radius.method, objects: [p.target.display], within_limit: p.tier === 'L' },
    conflict_domain: `${a.conflict_domain}:${p.target.namespace ?? ''}/${p.target.name}`,
    queue_position: p.execution?.queue_position ?? null,
    verify: {
      condition: [...(a.verify?.checks.map((c) => c.description) ?? []), ...verifyQueries].join('；') || '无',
      window: `${a.verify?.window_seconds ?? 0}s`,
    },
    undo: { kind: UNDO_KIND[a.undo.kind], description: a.undo.description },
    policy_rule: policyRule,
    model_rationale: p.source === 'research' ? p.expected_effect : null,
  };
}

/** 提议中转、审批、拒绝、撤销与批量审批（contract/openapi.yaml 的 proposals 标签）。 */
export function registerProposalRoutes(app: FastifyInstance, d: ProposalRouteDeps): void {
  const createBody = validatorFor<ProposalCreate>('schemas/proposal.schema.json#/$defs/ProposalCreate');

  app.get('/v1/proposals', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const q = req.query as { incident_id?: string; state?: string; limit?: string; cluster_id?: string; mine?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 50)));
    const c = await d.auth.required(req);
    const r = await d.pool.query<{ body: Proposal }>(
      `SELECT body FROM server.proposals WHERE ($1::uuid IS NULL OR incident_id = $1) AND ($2::text IS NULL OR state = $2)
         AND ($3::text IS NULL OR cluster_id = $3) AND ($4::text IS NULL OR body->>'caller_id' = $4)
       ORDER BY created_at DESC LIMIT $5`,
      [
        q.incident_id ?? null,
        q.state ?? null,
        q.cluster_id ?? null,
        q.mine === 'true' && c.kind === 'user' ? c.session.principalId : null,
        limit,
      ],
    );
    return r.rows
      .map((x) => x.body)
      .filter(
        (p) =>
          scopes === 'all' ||
          scopes.some((b) => scopeMatches(b, { cluster: p.cluster_id, namespace: p.target.namespace, labels: {} })),
      );
  });

  app.get('/v1/proposals/:id', async (req) => {
    const { scopes } = await d.auth.reader(req);
    const r = await d.pool.query<{ body: Proposal }>('SELECT body FROM server.proposals WHERE proposal_id = $1', [
      (req.params as { id: string }).id,
    ]);
    const p = r.rows[0]?.body;
    if (
      !p ||
      (scopes !== 'all' &&
        !scopes.some((b) => scopeMatches(b, { cluster: p.cluster_id, namespace: p.target.namespace, labels: {} })))
    ) {
      throw notFound('没有这个提议');
    }
    return proposalDetail(d, p);
  });

  app.post('/v1/proposals', async (req, reply) => {
    const c = await d.auth.required(req);
    let caller: ProposalCaller;
    if (c.kind === 'user') {
      caller = { source: 'human', callerId: c.session.principalId, subject: c.subject };
    } else if (c.kind === 'service' && c.caller.kind === 'worker') {
      caller = { source: 'research', callerId: c.caller.id };
    } else if (c.kind === 'service' && c.caller.kind === 'external') {
      caller = {
        source: 'external',
        callerId: c.caller.id,
        actions: c.caller.actions,
        namespaces: c.caller.namespaces,
        perHour: c.caller.proposals_per_hour,
      };
    } else {
      throw forbidden('这个调用方不能提交提议');
    }
    if (!createBody(req.body)) {
      throw badRequest(
        (createBody.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`).join('；'),
      );
    }
    const body = req.body;
    const key = req.headers['idempotency-key'];
    const r = await idempotent(d.pool, caller.callerId, typeof key === 'string' ? key : undefined, body, async () => {
      const out = await d.proposals.create(caller, body);
      return { status: out.status, body: out.proposal };
    });
    return reply.code(r.status).send(r.body);
  });

  app.post('/v1/proposals/:id/approve', async (req) => {
    const who = await consoleApprover(d.auth, req);
    const body = (req.body ?? {}) as { confirm_target?: string | null; webauthn?: unknown };
    const r = await d.proposals.approve(
      who,
      (req.params as { id: string }).id,
      body.confirm_target ?? null,
      body.webauthn ?? null,
    );
    return { proposal: r.proposal, envelope: r.envelope };
  });

  // 合规配置 H 档的通行密钥挑战（PublicKeyCredentialRequestOptionsJSON）
  app.post('/v1/auth/webauthn/assertion-options', async (req) => {
    const who = await consoleApprover(d.auth, req);
    const body = (req.body ?? {}) as { proposal_id?: unknown };
    if (
      typeof body.proposal_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.proposal_id)
    ) {
      throw badRequest('需要 proposal_id（UUID）');
    }
    return d.proposals.webauthnOptions(who, body.proposal_id);
  });

  app.post('/v1/proposals/:id/reject', async (req) => {
    const who = await consoleApprover(d.auth, req);
    const body = (req.body ?? {}) as { reason?: string };
    if (typeof body.reason !== 'string') {
      throw badRequest('拒绝必须填写理由');
    }
    return d.proposals.reject(who, (req.params as { id: string }).id, body.reason);
  });

  app.post('/v1/proposals/:id/undo', async (req, reply) => {
    const who = await consoleApprover(d.auth, req);
    const r = await d.proposals.undo(who, (req.params as { id: string }).id);
    return reply.code(202).send(r.proposal);
  });

  app.post('/v1/approvals/batch', async (req) => {
    const who = await consoleApprover(d.auth, req);
    const body = (req.body ?? {}) as { proposal_ids?: unknown };
    if (!Array.isArray(body.proposal_ids) || body.proposal_ids.length < 1 || body.proposal_ids.length > 20) {
      throw badRequest('proposal_ids 必须是 1–20 个提议 id');
    }
    return { results: await d.proposals.batch(who, body.proposal_ids as string[]) };
  });

  app.get('/v1/catalog/actions', async (req) => {
    await d.auth.reader(req);
    return {
      catalog: d.catalog.raw,
      enabled: d
        .policies()
        .all()
        .flatMap((p) =>
          p.actions.map((a) => ({
            cluster_id: p.cluster,
            action: a.id,
            namespaces: a.namespaces ?? [],
            auto: a.auto_execution !== undefined,
          })),
        ),
    };
  });
}
