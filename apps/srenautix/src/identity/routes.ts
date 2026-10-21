import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../api/errors.js';
import type { ServerMetrics } from '../metrics.js';
import { appendAudit } from '../store/audit.js';
import { tx } from '../store/pool.js';
import type { Auth, Caller } from './auth.js';
import { PERMISSIONS, type Permission, type RoleBinding } from './bindings.js';
import { upsertUser, type ChatLinks } from './chat-links.js';
import { LOCAL_PROVIDER, markLocalAdminSuperseded, type LocalAdmin } from './local-admin.js';
import { OidcError, type Oidc } from './oidc.js';
import {
  clearSessionCookie,
  sessionCookie,
  type AuthenticatedPrincipal,
  type Session,
  type Sessions,
} from './sessions.js';

export type Profile = 'observe' | 'standard' | 'compliance';

export interface AuthRouteDeps {
  pool: pg.Pool;
  sessions: Sessions;
  auth: Auth;
  localAdmin: LocalAdmin | null;
  oidc: Oidc | null;
  chatLinks: ChatLinks;
  profile: Profile;
  /** 控制台的公网地址，例如 https://srenautix.example.com；Origin 校验与 OIDC 回调都以它为准。 */
  publicUrl: string;
  metrics: ServerMetrics;
}

/** 契约 Session。 */
export interface SessionView {
  principal: { id: string; display_name: string; groups: string[] };
  roles: RoleBinding[];
  provider: string;
  profile: Profile;
  local_admin: boolean;
  auth_time: string;
  expires_at: string;
  csrf_token: string;
  break_glass: boolean;
}

// totp 只在 identity.local_admin.totp_required 关闭时可以省略（ADR 0118）；要求 TOTP 时省略按凭据错误处理
const loginBody = z
  .object({
    username: z.string(),
    password: z.string(),
    totp: z
      .string()
      .regex(/^[0-9]{6}$/)
      .optional(),
  })
  .strict();
const reauthBody = z.object({ password: z.string(), totp: z.string().regex(/^[0-9]{6}$/) }).strict();
const explainBody = z
  .object({
    subject: z
      .object({ id: z.string().min(1), groups: z.array(z.string()) })
      .strict()
      .nullable()
      .default(null),
    permission: z.enum(PERMISSIONS),
    target: z
      .object({
        cluster: z.string().min(1),
        namespace: z.string().min(1).nullable(),
        labels: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .nullable(),
    tier: z.enum(['L', 'H']).nullable().default(null),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw badRequest(r.error.issues.map((i) => `${i.path.join('.') || '/'}: ${i.message}`).join('；'));
  }
  return r.data;
}

async function audit(pool: pg.Pool, kind: string, actor: string, data: unknown): Promise<void> {
  await tx(pool, (c) => appendAudit(c, kind, actor, data));
}

type UserCaller = Extract<Caller, { kind: 'user' }>;

/**
 * 认证与身份相关的接口：契约中的 /v1/auth/*，以及控制台“用户与角色”页的读取与权限解释
 * （/v1/role-bindings、/v1/permissions/explain、/v1/users、/v1/chat-links）。
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { pool, sessions, auth } = deps;
  const origin = new URL(deps.publicUrl).origin;
  const absoluteS = sessions.policy.absoluteMs / 1000;

  const view = (s: Session): SessionView => ({
    principal: { id: s.principalId, display_name: s.displayName, groups: s.groups },
    roles: auth.currentBindings.forSubject({ id: s.principalId, groups: s.groups }),
    provider: s.provider,
    profile: deps.profile,
    local_admin: s.provider === LOCAL_PROVIDER,
    auth_time: s.authTime.toISOString(),
    expires_at: sessions.effectiveExpiry(s).toISOString(),
    csrf_token: s.csrfToken,
    break_glass: s.breakGlass,
  });

  const sessionCaller = async (req: FastifyRequest): Promise<UserCaller> => {
    const c = await auth.required(req);
    if (c.kind !== 'user') {
      throw unauthorized('这个接口只接受控制台会话');
    }
    return c;
  };

  /** 匿名的登录请求也校验 Origin：浏览器发出的 POST 一定带 Origin，来自其他站点的登录请求一律拒绝。 */
  const checkOrigin = (req: FastifyRequest) => {
    const o = req.headers.origin;
    if (o !== undefined && o !== origin) {
      throw forbidden('Origin 与控制台地址不一致');
    }
  };

  const startSession = async (
    reply: FastifyReply,
    p: AuthenticatedPrincipal,
    breakGlass: boolean,
    kind: 'auth.login' | 'auth.reauth',
  ): Promise<Session> => {
    await upsertUser(pool, p.principal, p.provider, p.external_ids);
    const { id, session } = await sessions.create(p, breakGlass);
    await audit(pool, kind, p.principal.id, { provider: p.provider, break_glass: breakGlass, mfa: p.mfa });
    void reply.header('set-cookie', sessionCookie(id, absoluteS));
    return session;
  };

  app.get('/v1/auth/providers', async () => {
    const superseded = await pool.query("SELECT 1 FROM server.system_state WHERE key = 'local_admin_superseded_at'");
    return {
      local_admin: {
        enabled: deps.localAdmin !== null,
        break_glass: (superseded.rowCount ?? 0) > 0,
        totp_required: deps.localAdmin?.totpRequired ?? true,
      },
      oidc: deps.oidc ? { display_name: deps.oidc.displayName } : null,
      profile: deps.profile,
    };
  });

  app.post('/v1/auth/login', async (req, reply) => {
    checkOrigin(req);
    const local = deps.localAdmin;
    if (!local) {
      throw notFound('本地管理员未启用');
    }
    const b = parse(loginBody, req.body);
    const r = await local.login(b.username, b.password, b.totp);
    if (!r.ok) {
      deps.metrics.logins.inc({ method: 'local', outcome: r.reason });
      await audit(pool, 'auth.login_failed', 'anonymous', {
        provider: LOCAL_PROVIDER,
        username: b.username,
        reason: r.reason,
        locked_until: r.lockedUntil?.toISOString() ?? null,
      });
      if (r.reason === 'locked') {
        throw new HttpError(423, 'locked', `登录失败次数过多，已锁定到 ${r.lockedUntil?.toISOString() ?? '稍后'}`);
      }
      throw new HttpError(
        401,
        'invalid_credentials',
        local.totpRequired ? '用户名、口令或 TOTP 不正确' : '用户名或口令不正确',
      );
    }
    deps.metrics.logins.inc({ method: 'local', outcome: r.breakGlass ? 'break_glass' : 'ok' });
    const s = await startSession(reply, r.principal, r.breakGlass, 'auth.login');
    return view(s);
  });

  app.get('/v1/auth/oidc/start', async (req, reply) => {
    const oidc = deps.oidc;
    if (!oidc) {
      throw notFound('没有配置 OIDC');
    }
    const q = req.query as { return_to?: string; max_age?: string };
    let maxAge: number | null = null;
    if (q.max_age !== undefined) {
      maxAge = Number(q.max_age);
      if (!Number.isInteger(maxAge) || maxAge < 0) {
        throw badRequest('max_age 必须是非负整数');
      }
    }
    let url: URL;
    try {
      url = await oidc.start(q.return_to ?? '/', maxAge);
    } catch (e) {
      if (e instanceof OidcError) {
        throw badRequest(e.message);
      }
      throw e;
    }
    return reply.redirect(url.toString(), 302);
  });

  app.get('/v1/auth/oidc/callback', async (req, reply) => {
    const oidc = deps.oidc;
    if (!oidc) {
      throw notFound('没有配置 OIDC');
    }
    let result: Awaited<ReturnType<Oidc['callback']>>;
    try {
      result = await oidc.callback(new URL(req.url, deps.publicUrl));
    } catch (e) {
      deps.metrics.logins.inc({ method: 'oidc', outcome: 'invalid' });
      await audit(pool, 'auth.login_failed', 'anonymous', { provider: 'oidc', reason: (e as Error).message });
      throw badRequest(`OIDC 登录失败：${(e as Error).message}`);
    }
    await markLocalAdminSuperseded(pool);
    deps.metrics.logins.inc({ method: 'oidc', outcome: result.reauth ? 'reauth' : 'ok' });
    // 身份提供方跳回是跨站导航，SameSite=Strict 的会话 cookie 不会随这次请求发送，重新认证同样新建会话
    await startSession(reply, result.principal, false, result.reauth ? 'auth.reauth' : 'auth.login');
    return reply.redirect(result.returnTo, 302);
  });

  app.get('/v1/auth/session', async (req) => view((await sessionCaller(req)).session));

  app.post('/v1/auth/reauth', async (req) => {
    const c = await sessionCaller(req);
    const b = parse(reauthBody, req.body);
    const local = deps.localAdmin;
    if (c.session.provider !== LOCAL_PROVIDER || !local) {
      throw badRequest('OIDC 用户的重新认证使用 GET /v1/auth/oidc/start?max_age=0');
    }
    const r = await local.reauth(b.password, b.totp);
    if (!r.ok) {
      deps.metrics.logins.inc({ method: 'local_reauth', outcome: r.reason });
      await audit(pool, 'auth.login_failed', c.session.principalId, {
        provider: LOCAL_PROVIDER,
        reason: r.reason,
        reauth: true,
      });
      if (r.reason === 'locked') {
        throw new HttpError(423, 'locked', `失败次数过多，已锁定到 ${r.lockedUntil?.toISOString() ?? '稍后'}`);
      }
      throw new HttpError(401, 'invalid_credentials', '口令或 TOTP 不正确');
    }
    // 重新认证总是校验 TOTP：会话从此带第二因子（H 档审批的 local_totp 凭据）
    await sessions.reauthenticated(c.sessionId, r.principal.auth_time, r.principal.mfa);
    await audit(pool, 'auth.reauth', c.session.principalId, { provider: LOCAL_PROVIDER });
    deps.metrics.logins.inc({ method: 'local_reauth', outcome: 'ok' });
    const s = await sessions.touch(c.sessionId);
    if (!s) {
      throw unauthorized('会话已失效');
    }
    return view(s);
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const c = await sessionCaller(req);
    await sessions.revoke(c.sessionId);
    await audit(pool, 'auth.logout', c.session.principalId, { provider: c.session.provider });
    return reply.header('set-cookie', clearSessionCookie()).code(204).send();
  });

  app.post('/v1/auth/link-code', async (req, reply) => {
    const c = await sessionCaller(req);
    const r = await deps.chatLinks.createCode(c.session.principalId);
    await audit(pool, 'chat.link_code', c.session.principalId, { expires_at: r.expiresAt.toISOString() });
    return reply.code(201).send({ code: r.code, expires_at: r.expiresAt.toISOString() });
  });

  app.get('/v1/role-bindings', async (req) => {
    await auth.user(req, 'users.read');
    const b = auth.currentBindings;
    return { revision: b.revision, bindings: b.entries.map((e) => ({ ...e.binding, file: e.file })) };
  });

  app.post('/v1/permissions/explain', async (req) => {
    const c = await auth.required(req);
    if (c.kind === 'service') {
      throw forbidden('服务调用方不能调用这个接口');
    }
    const b = parse(explainBody, req.body);
    const subject = b.subject ?? c.subject;
    if (subject.id !== c.subject.id && !auth.currentBindings.allowed(c.subject, 'users.read', null)) {
      throw forbidden('解释其他主体的权限需要 users.read');
    }
    const e = auth.currentBindings.explain(subject, b.permission as Permission, b.target, b.tier);
    return {
      allowed: e.allowed,
      subject,
      permission: e.permission,
      target: e.target,
      tier: e.tier,
      revision: auth.currentBindings.revision,
      entries: e.entries.map((x) => ({
        binding: x.binding,
        file: x.file,
        subject_match: x.subject_match,
        grants_permission: x.grants_permission,
        scope_match: x.scope_match,
        tier_ok: x.tier_ok,
        reason: x.reason,
      })),
    };
  });

  app.get('/v1/users', async (req) => {
    await auth.user(req, 'users.read');
    const r = await pool.query<{
      principal_id: string;
      display_name: string;
      provider: string;
      groups: string[];
      first_login_at: Date;
      last_login_at: Date;
      links: Array<{ channel: string; channel_user_id: string; method: string; linked_at: string }>;
    }>(
      `SELECT u.principal_id, u.display_name, u.provider, u.groups, u.first_login_at, u.last_login_at,
              COALESCE(json_agg(json_build_object('channel', l.channel, 'channel_user_id', l.channel_user_id,
                'method', l.method, 'linked_at', l.linked_at) ORDER BY l.linked_at) FILTER (WHERE l.channel IS NOT NULL), '[]') AS links
         FROM server.users u LEFT JOIN server.chat_links l ON l.principal_id = u.principal_id
        GROUP BY u.principal_id ORDER BY u.last_login_at DESC`,
    );
    const b = auth.currentBindings;
    return r.rows.map((u) => ({
      principal_id: u.principal_id,
      display_name: u.display_name,
      provider: u.provider,
      groups: u.groups,
      roles: b.forSubject({ id: u.principal_id, groups: u.groups }),
      chat_links: u.links.map((l) => ({ ...l, linked_at: new Date(l.linked_at).toISOString() })),
      first_login_at: u.first_login_at.toISOString(),
      last_login_at: u.last_login_at.toISOString(),
    }));
  });

  app.get('/v1/chat-links', async (req) => {
    const c = await sessionCaller(req);
    const links = await deps.chatLinks.forPrincipal(c.session.principalId);
    return links.map((l) => ({
      channel: l.channel,
      channel_user_id: l.channelUserId,
      method: l.method,
      linked_at: l.linkedAt.toISOString(),
    }));
  });

  app.delete('/v1/chat-links/:channel/:channel_user_id', async (req, reply) => {
    const c = await sessionCaller(req);
    const p = req.params as { channel: string; channel_user_id: string };
    const link = await deps.chatLinks.lookup(p.channel, p.channel_user_id);
    if (!link) {
      throw notFound('没有这个绑定');
    }
    if (
      link.principalId !== c.session.principalId &&
      !auth.currentBindings.allowed(c.subject, 'settings.write', null)
    ) {
      throw forbidden('只能解除自己的绑定');
    }
    await deps.chatLinks.unlink(p.channel, p.channel_user_id);
    await audit(pool, 'chat.unlink', c.session.principalId, {
      channel: p.channel,
      channel_user_id: p.channel_user_id,
      principal_id: link.principalId,
    });
    return reply.code(204).send();
  });
}
