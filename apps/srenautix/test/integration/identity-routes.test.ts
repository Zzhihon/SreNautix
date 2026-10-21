import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Secret, TOTP } from 'otpauth';
import { CookieJar } from 'tough-cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/http.js';
import { Auth } from '../../src/identity/auth.js';
import { Bindings } from '../../src/identity/bindings.js';
import { CallerRegistry } from '../../src/identity/callers.js';
import { ChatLinks, upsertUser } from '../../src/identity/chat-links.js';
import { LocalAdmin, recordLocalAdminTotpSetting } from '../../src/identity/local-admin.js';
import { identityTrack } from '../../src/identity/migrations.js';
import { Oidc } from '../../src/identity/oidc.js';
import { hashPassword } from '../../src/identity/password.js';
import { registerAuthRoutes } from '../../src/identity/routes.js';
import { SESSION_COOKIE, Sessions } from '../../src/identity/sessions.js';
import { ServerMetrics } from '../../src/metrics.js';
import { readAudit, verifyRecords, GENESIS_HASH } from '../../src/store/audit.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { browseUntil, startIdp, type TestIdp } from '../support/oidc.js';

const PUBLIC = 'https://console.test';
const ORIGIN = { origin: PUBLIC };
const PASSWORD = 'correct horse battery staple';

let db: TestDb;
let idp: TestIdp;
let app: FastifyInstance;
let totp: TOTP;
let lockTotp: TOTP;
let dir: string;
let lockApp: FastifyInstance;

function code(t: TOTP, offsetSteps = 0): string {
  return t.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
}

function cookieOf(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  if (!c) {
    throw new Error('响应没有会话 cookie');
  }
  return `${SESSION_COOKIE}=${c.value}`;
}

async function buildApp(username: string, t: TOTP, maxFailures: number, totpRequired = true): Promise<FastifyInstance> {
  const sessions = new Sessions(db.server, { idleMs: 30 * 60_000, absoluteMs: 12 * 3_600_000 });
  const auth = new Auth(sessions, new CallerRegistry([]), Bindings.load(dir), PUBLIC);
  const a = await createApp({ bodyLimit: 1 << 20, trustProxy: false });
  registerAuthRoutes(a, {
    pool: db.server,
    sessions,
    auth,
    localAdmin: new LocalAdmin(
      db.server,
      { username, passwordHash: await hashPassword(PASSWORD), totpSecret: t.secret.base32, totpRequired },
      { maxFailures, windowMs: 15 * 60_000, durationMs: 15 * 60_000 },
    ),
    oidc: new Oidc(db.server, {
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      scopes: ['openid', 'profile', 'email', 'groups'],
      groupsClaim: 'groups',
      nameClaim: 'preferred_username',
      redirectUri: `${PUBLIC}/v1/auth/oidc/callback`,
      allowHttp: true,
    }),
    chatLinks: new ChatLinks(db.server),
    profile: 'standard',
    publicUrl: PUBLIC,
    metrics: new ServerMetrics('server', false),
  });
  return a;
}

const apps: FastifyInstance[] = [];

/**
 * 每个 TOTP 时间步对同一用户名只能用一次，校验窗口是前后一步，所以每个需要单独登录的场景用自己的本地管理员用户名
 * （同一个库、同一组角色绑定）。
 */
async function localUser(
  username: string,
  maxFailures = 5,
  totpRequired = true,
): Promise<{ app: FastifyInstance; totp: TOTP }> {
  const t = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
  const a = await buildApp(username, t, maxFailures, totpRequired);
  apps.push(a);
  return { app: a, totp: t };
}

async function login(
  u: { app: FastifyInstance; totp: TOTP },
  username: string,
): Promise<{ cookie: string; csrf: string }> {
  const r = await u.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: ORIGIN,
    payload: { username, password: PASSWORD, totp: code(u.totp) },
  });
  expect(r.statusCode, r.body).toBe(200);
  return { cookie: cookieOf(r), csrf: r.json().csrf_token };
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, identityTrack]);
  dir = resolve(import.meta.dirname, `../../../../.scratch/bindings-${db.name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'roles.yaml'),
    [
      'bindings:',
      '  - subject: { kind: group, name: "srenautix:local-admin" }',
      '    role: admin',
      '    scope: { clusters: ["*"], namespaces: ["*"], component_labels: {} }',
      '  - subject: { kind: group, name: sre }',
      '    role: approver',
      '    scope: { clusters: [prod], namespaces: [shop], component_labels: {} }',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'REVISION'), '0123456789abcdef\n');
  idp = await startIdp(`${PUBLIC}/v1/auth/oidc/callback`, [
    { sub: 'alice', preferred_username: 'alice', email: 'alice@example.com', groups: ['sre'], union_id: 'on_alice' },
  ]);
  totp = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
  lockTotp = new TOTP({ secret: new Secret({ size: 20 }), digits: 6, period: 30, algorithm: 'SHA1' });
  app = await buildApp('admin', totp, 5);
  lockApp = await buildApp('locky', lockTotp, 3);
});

afterAll(async () => {
  await app.close();
  await lockApp.close();
  for (const a of apps) {
    await a.close();
  }
  await idp.close();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('本地管理员', () => {
  let cookie = '';
  let csrf = '';
  let firstCode = '';

  it('登录方式列出本地管理员与 OIDC', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/auth/providers' });
    expect(r.json()).toEqual({
      local_admin: { enabled: true, break_glass: false, totp_required: true },
      oidc: { display_name: new URL(idp.issuer).host },
      profile: 'standard',
    });
  });

  it('口令与 TOTP 正确时登录，cookie 带 __Host- 前缀、Secure、HttpOnly、SameSite=Strict', async () => {
    firstCode = code(totp);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'admin', password: PASSWORD, totp: firstCode },
    });
    expect(r.statusCode).toBe(200);
    const set = r.headers['set-cookie'] as string;
    expect(set).toMatch(/^__Host-srenautix_session=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    const s = r.json();
    expect(s).toMatchObject({
      principal: { id: 'local:admin', display_name: 'admin', groups: ['srenautix:local-admin'] },
      provider: 'local-admin',
      profile: 'standard',
      local_admin: true,
      break_glass: false,
    });
    expect(s.roles).toHaveLength(1);
    expect(s.roles[0].role).toBe('admin');
    cookie = cookieOf(r);
    csrf = s.csrf_token;
    const again = await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(again.statusCode).toBe(200);
    expect(again.json().csrf_token).toBe(csrf);
  });

  it('同一个 TOTP 码不能再用一次；下一个时间步的码可以', async () => {
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'admin', password: PASSWORD, totp: firstCode },
    });
    expect(r1.statusCode).toBe(401);
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'admin', password: PASSWORD, totp: code(totp, 1) },
    });
    expect(r2.statusCode).toBe(200);
  });

  it('错误的 TOTP 返回 401；其他站点的 Origin 返回 403', async () => {
    const wrong = String((Number(code(totp)) + 1) % 1_000_000).padStart(6, '0');
    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'admin', password: PASSWORD, totp: wrong },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('invalid_credentials');
    const x = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: 'https://evil.test' },
      payload: { username: 'admin', password: PASSWORD, totp: code(totp) },
    });
    expect(x.statusCode).toBe(403);
  });

  it('改变状态的请求必须带正确的 Origin 与 CSRF token', async () => {
    const noCsrf = await app.inject({ method: 'POST', url: '/v1/auth/link-code', headers: { cookie, ...ORIGIN } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/v1/auth/link-code',
      headers: { cookie, origin: 'https://evil.test', 'x-csrf-token': csrf },
    });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/link-code',
      headers: { cookie, ...ORIGIN, 'x-csrf-token': csrf },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().code).toMatch(/^[A-Z0-9]{8}$/);
  });

  it('本地管理员重新认证更新 auth_time', async () => {
    const u = await localUser('reauthy');
    const s = await login(u, 'reauthy');
    const before = (
      await u.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: s.cookie } })
    ).json().auth_time;
    await new Promise((r) => setTimeout(r, 1100));
    const r = await u.app.inject({
      method: 'POST',
      url: '/v1/auth/reauth',
      headers: { cookie: s.cookie, ...ORIGIN, 'x-csrf-token': s.csrf },
      payload: { password: PASSWORD, totp: code(u.totp, 1) },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(Date.parse(r.json().auth_time)).toBeGreaterThan(Date.parse(before));
  });

  it('退出后会话失效', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, ...ORIGIN, 'x-csrf-token': csrf },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers['set-cookie']).toMatch(/Max-Age=0/);
    const s = await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } });
    expect(s.statusCode).toBe(401);
  });
});

describe('TOTP 关闭（identity.local_admin.totp_required=false，ADR 0118）', () => {
  it('登录方式写明 TOTP 已关闭；只凭口令登录，会话不带第二因子', async () => {
    const u = await localUser('nototp', 5, false);
    const p = await u.app.inject({ method: 'GET', url: '/v1/auth/providers' });
    expect(p.json().local_admin).toEqual({ enabled: true, break_glass: false, totp_required: false });
    const r = await u.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'nototp', password: PASSWORD },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ provider: 'local-admin', local_admin: true });
    const s = await db.server.query<{ mfa: boolean }>(
      "SELECT mfa FROM server.sessions WHERE principal_id = 'local:nototp' ORDER BY created_at DESC LIMIT 1",
    );
    expect(s.rows[0]?.mfa).toBe(false);
    // 审计记录里写明这次登录没有第二因子
    const recs = (await readAudit(db.server, 0, 10_000)).filter(
      (x) => x.kind === 'auth.login' && x.actor === 'local:nototp',
    );
    expect(recs.at(-1)?.data).toMatchObject({ provider: 'local-admin', mfa: false });
    // 提交了验证码也不校验
    const withCode = await u.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'nototp', password: PASSWORD, totp: '000000' },
    });
    expect(withCode.statusCode).toBe(200);
  });

  it('口令错误仍然拒绝、计入失败次数并锁定', async () => {
    const u = await localUser('nototp-lock', 2, false);
    for (let i = 0; i < 2; i++) {
      const r = await u.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: ORIGIN,
        payload: { username: 'nototp-lock', password: 'wrong' },
      });
      expect(r.statusCode).toBe(i === 0 ? 401 : 423);
    }
    const ok = await u.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'nototp-lock', password: PASSWORD },
    });
    expect(ok.statusCode).toBe(423);
  });

  it('TOTP 打开时省略验证码按凭据错误处理', async () => {
    const u = await localUser('needs-totp');
    const r = await u.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'needs-totp', password: PASSWORD },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('invalid_credentials');
  });

  it('重新认证（H 档审批）仍然要求 TOTP，通过后会话带第二因子', async () => {
    const u = await localUser('nototp-reauth', 5, false);
    const lr = await u.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'nototp-reauth', password: PASSWORD },
    });
    const cookie = cookieOf(lr);
    const csrf = lr.json().csrf_token as string;
    const headers = { cookie, ...ORIGIN, 'x-csrf-token': csrf };
    const noCode = await u.app.inject({
      method: 'POST',
      url: '/v1/auth/reauth',
      headers,
      payload: { password: PASSWORD },
    });
    expect(noCode.statusCode).toBe(400);
    const wrong = String((Number(code(u.totp)) + 1) % 1_000_000).padStart(6, '0');
    const bad = await u.app.inject({
      method: 'POST',
      url: '/v1/auth/reauth',
      headers,
      payload: { password: PASSWORD, totp: wrong },
    });
    expect(bad.statusCode).toBe(401);
    const ok = await u.app.inject({
      method: 'POST',
      url: '/v1/auth/reauth',
      headers,
      payload: { password: PASSWORD, totp: code(u.totp) },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const s = await db.server.query<{ mfa: boolean }>(
      "SELECT mfa FROM server.sessions WHERE principal_id = 'local:nototp-reauth' ORDER BY created_at DESC LIMIT 1",
    );
    expect(s.rows[0]?.mfa).toBe(true);
  });

  it('开关的变化写入审计链：首次关闭、重复启动不重复记录、重新打开', async () => {
    const changes = async () =>
      (await readAudit(db.server, 0, 10_000)).filter((x) => x.kind === 'identity.local_admin_totp').map((x) => x.data);
    expect(await recordLocalAdminTotpSetting(db.server, true)).toBe(false);
    expect(await changes()).toEqual([]);
    expect(await recordLocalAdminTotpSetting(db.server, false)).toBe(true);
    expect(await recordLocalAdminTotpSetting(db.server, false)).toBe(false);
    expect(await recordLocalAdminTotpSetting(db.server, true)).toBe(true);
    expect(await changes()).toEqual([
      { setting: 'identity.local_admin.totp_required', totp_required: false, previous: true },
      { setting: 'identity.local_admin.totp_required', totp_required: true, previous: false },
    ]);
    expect(verifyRecords(await readAudit(db.server, 0, 10_000), { seq: 0, hash: GENESIS_HASH })).toBeNull();
  });
});

describe('锁定', () => {
  it('连续失败达到上限后锁定，锁定期间凭据正确也返回 423', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await lockApp.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: ORIGIN,
        payload: { username: 'locky', password: 'wrong password!!', totp: code(lockTotp) },
      });
      expect(r.statusCode).toBe(401);
    }
    const third = await lockApp.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'locky', password: 'wrong password!!', totp: code(lockTotp) },
    });
    expect(third.statusCode).toBe(423);
    const right = await lockApp.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: ORIGIN,
      payload: { username: 'locky', password: PASSWORD, totp: code(lockTotp) },
    });
    expect(right.statusCode).toBe(423);
    expect(right.json().error).toBe('locked');
  });
});

describe('会话超时', () => {
  it('空闲超时与累计超时后会话失效', async () => {
    const principal = {
      principal: { id: 'local:t', display_name: 't', groups: [] },
      provider: 'local-admin',
      auth_time: new Date(),
      mfa: true,
      external_ids: {},
    };
    const idle = new Sessions(db.server, { idleMs: 1_000, absoluteMs: 60_000 });
    const a = await idle.create(principal, false);
    expect(await idle.touch(a.id)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1_300));
    expect(await idle.touch(a.id)).toBeNull();

    const absolute = new Sessions(db.server, { idleMs: 60_000, absoluteMs: 1_000 });
    const b = await absolute.create(principal, false);
    await new Promise((r) => setTimeout(r, 600));
    expect(await absolute.touch(b.id)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 600));
    expect(await absolute.touch(b.id)).toBeNull();
  });
});

describe('OIDC（真实的身份提供方）', () => {
  const jar = new CookieJar();
  let firstAuthTime = '';

  async function oidcLogin(maxAge: string): Promise<{ cookie: string; location: string }> {
    const start = await app.inject({ method: 'GET', url: `/v1/auth/oidc/start?return_to=%2Fincidents${maxAge}` });
    expect(start.statusCode).toBe(302);
    const callback = await browseUntil(
      start.headers.location as string,
      `${PUBLIC}/v1/auth/oidc/callback`,
      jar,
      'alice',
    );
    const r = await app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}` });
    expect(r.statusCode, r.body).toBe(302);
    return { cookie: cookieOf(r), location: r.headers.location as string };
  }

  it('授权码 + PKCE 登录，组映射到角色绑定，外部 id 写入用户表', async () => {
    const { cookie, location } = await oidcLogin('');
    expect(location).toBe('/incidents');
    const s = (await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).json();
    expect(s.principal).toEqual({ id: 'oidc:alice', display_name: 'alice', groups: ['sre'] });
    expect(s.provider).toBe('oidc');
    expect(s.local_admin).toBe(false);
    expect(s.roles.map((x: { role: string }) => x.role)).toEqual(['approver']);
    firstAuthTime = s.auth_time;
    const u = await db.admin.query("SELECT external_ids FROM server.users WHERE principal_id = 'oidc:alice'");
    expect(u.rows[0].external_ids).toEqual({ union_id: 'on_alice', email: 'alice@example.com' });
  });

  it('SSO 验证通过后本地管理员只作为紧急入口', async () => {
    const p = await app.inject({ method: 'GET', url: '/v1/auth/providers' });
    expect(p.json().local_admin).toEqual({ enabled: true, break_glass: true, totp_required: true });
    const u = await localUser('glass');
    const s = await login(u, 'glass');
    const r = await u.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie: s.cookie } });
    expect(r.json().break_glass).toBe(true);
  });

  it('max_age=0 重新认证：身份提供方重新登录，auth_time 更新', async () => {
    await new Promise((r) => setTimeout(r, 1_100));
    const { cookie } = await oidcLogin('&max_age=0');
    const s = (await app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } })).json();
    expect(Date.parse(s.auth_time)).toBeGreaterThan(Date.parse(firstAuthTime));
  });

  it('伪造或重放的 state 返回 400', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/auth/oidc/callback?code=x&state=forged' });
    expect(r.statusCode).toBe(400);
  });

  it('return_to 只能是站内路径', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/auth/oidc/start?return_to=https%3A%2F%2Fevil.test' });
    expect(r.statusCode).toBe(400);
  });
});

describe('权限与用户', () => {
  it('角色绑定带版本；权限解释给出每条绑定的判定原因；用户列表带角色', async () => {
    const u = await localUser('perm');
    const { cookie, csrf } = await login(u, 'perm');
    const b = await app.inject({ method: 'GET', url: '/v1/role-bindings', headers: { cookie } });
    expect(b.json().revision).toBe('0123456789abcdef');
    expect(b.json().bindings).toHaveLength(2);
    const e = await app.inject({
      method: 'POST',
      url: '/v1/permissions/explain',
      headers: { cookie, ...ORIGIN, 'x-csrf-token': csrf },
      payload: {
        subject: { id: 'oidc:alice', groups: ['sre'] },
        permission: 'approve',
        target: { cluster: 'prod', namespace: 'pay', labels: {} },
        tier: 'L',
      },
    });
    expect(e.statusCode).toBe(200);
    expect(e.json().allowed).toBe(false);
    expect(e.json().entries.map((x: { reason: string }) => x.reason)).toEqual(['主体不匹配', '目标不在绑定的作用域内']);
    const users = await app.inject({ method: 'GET', url: '/v1/users', headers: { cookie } });
    const alice = users.json().find((x: { principal_id: string }) => x.principal_id === 'oidc:alice');
    expect(alice.roles.map((x: { role: string }) => x.role)).toEqual(['approver']);
  });
});

describe('聊天账号绑定', () => {
  it('绑定码用一次即失效，过期的绑定码无效，union_id 自动绑定', async () => {
    const links = new ChatLinks(db.server);
    const a = await links.createCode('oidc:alice');
    expect(await links.redeem('telegram', '1001', a.code.toLowerCase())).toEqual({
      ok: true,
      principalId: 'oidc:alice',
    });
    expect(await links.redeem('telegram', '1002', a.code)).toEqual({ ok: false, reason: 'already_used' });
    expect((await links.lookup('telegram', '1001'))?.principalId).toBe('oidc:alice');

    const b = await links.createCode('oidc:alice');
    await db.admin.query("UPDATE server.link_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL");
    expect(await links.redeem('telegram', '1003', b.code)).toEqual({ ok: false, reason: 'unknown_or_expired' });
    expect(await links.redeem('telegram', '1003', 'not-a-code')).toEqual({ ok: false, reason: 'unknown_or_expired' });

    await upsertUser(db.server, { id: 'oidc:bob', display_name: 'bob', groups: [] }, 'oidc', { union_id: 'on_bob' });
    expect(await links.linkByUnionId('feishu', 'ou_bob', 'on_bob')).toBe('oidc:bob');
    expect(await links.linkByUnionId('feishu', 'ou_x', 'on_unknown')).toBeNull();
  });
});

describe('治理审计', () => {
  it('登录、失败、重新认证、退出与绑定码都写入哈希链', async () => {
    const recs = await readAudit(db.server, 0, 1000);
    const kinds = new Set(recs.map((r) => r.kind));
    for (const k of ['auth.login', 'auth.login_failed', 'auth.reauth', 'auth.logout', 'chat.link_code']) {
      expect(kinds.has(k), k).toBe(true);
    }
    expect(verifyRecords(recs, { seq: 0, hash: GENESIS_HASH })).toBeNull();
  });
});
