import type { AuthenticatedPrincipal as ContractPrincipal } from '@srenautix/contract';
import { runIdentityConformance, type IdentitySubject } from '@srenautix/integration-sdk';
import { Secret, TOTP } from 'otpauth';
import { CookieJar } from 'tough-cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityTrack } from '../../src/identity/migrations.js';
import { LocalAdmin } from '../../src/identity/local-admin.js';
import { Oidc } from '../../src/identity/oidc.js';
import { hashPassword } from '../../src/identity/password.js';
import type { AuthenticatedPrincipal } from '../../src/identity/sessions.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { newTestDb, type TestDb } from '../support/db.js';
import { browseUntil, startIdp, type TestAccount, type TestIdp } from '../support/oidc.js';

/**
 * identity/v1 一致性测试（packages/integration-sdk 的 runIdentityConformance）：
 * OIDC 用真实的 node-oidc-provider 走完整的授权码流程，本地管理员用真实的口令哈希与 TOTP，状态在真实 PostgreSQL 中。
 */
const REDIRECT = 'https://srenautix.example.test/v1/auth/oidc/callback';
const ACCOUNTS: TestAccount[] = [
  { sub: 'u-alice', preferred_username: 'alice', email: 'alice@example.test', groups: ['sre'], union_id: 'on_a' },
  { sub: 'u-bob', preferred_username: 'bob', email: 'bob@example.test', groups: ['dev', 'oncall'], union_id: 'on_b' },
];

let db: TestDb;
let idp: TestIdp;

/** server 内部的认证结果（Date）→ 契约形状（RFC 3339 字符串）。 */
function toContract(p: AuthenticatedPrincipal): ContractPrincipal {
  return { ...p, auth_time: p.auth_time.toISOString() } as unknown as ContractPrincipal;
}

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, identityTrack]);
  idp = await startIdp(REDIRECT, ACCOUNTS);
});

afterAll(async () => {
  await idp?.close();
  await db?.close();
});

describe('identity/v1 一致性', () => {
  it('OIDC：授权码流程（PKCE），max_age=0 时身份提供方重新登录', async () => {
    const oidc = new Oidc(db.server, {
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      scopes: ['openid', 'profile', 'email', 'groups'],
      groupsClaim: 'groups',
      nameClaim: 'preferred_username',
      redirectUri: REDIRECT,
      allowHttp: true,
    });
    // 每次登录用新的浏览器会话，身份提供方都会出登录页
    const flow = async (sub: string, maxAge: number | null) => {
      const start = await oidc.start('/', maxAge);
      const back = await browseUntil(start.toString(), REDIRECT, new CookieJar(), sub);
      return toContract((await oidc.callback(back)).principal);
    };
    const subject: IdentitySubject = {
      name: 'oidc（node-oidc-provider）',
      login: (u) => flow(u, null),
      reauthenticate: (u) => flow(u, 0),
      expectedGroups: Object.fromEntries(ACCOUNTS.map((a) => [a.sub, a.groups])),
    };
    const report = await runIdentityConformance(subject, ['u-alice', 'u-bob']);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('本地管理员：口令加 TOTP，同一时间步只能用一次，重新认证更新 auth_time', async () => {
    const lockout = { maxFailures: 5, windowMs: 600_000, durationMs: 600_000 };
    const admins = new Map<string, { admin: LocalAdmin; totp: TOTP; password: string; last: number }>();
    for (const username of ['root', 'breakglass']) {
      const secret = new Secret({ size: 20 });
      const password = `${username}-correct horse battery`;
      admins.set(username, {
        admin: new LocalAdmin(
          db.server,
          { username, passwordHash: await hashPassword(password), totpSecret: secret.base32 },
          lockout,
        ),
        totp: new TOTP({ secret, digits: 6, period: 30, algorithm: 'SHA1' }),
        password,
        last: -1,
      });
    }
    /**
     * 同一时间步的 TOTP 只能用一次（server 拒绝重放）。连续登录时取下一个没用过的时间步：
     * server 接受前后各一个时间步，所以最多等到下一个时间步开始。
     */
    const code = async (a: { totp: TOTP; last: number }) => {
      const want = a.last + 1;
      for (;;) {
        const current = a.totp.counter();
        const step = Math.max(want, current - 1);
        if (step <= current + 1) {
          a.last = step;
          return a.totp.generate({ timestamp: step * 30_000 + 1 });
        }
        await new Promise((r) => setTimeout(r, (current + 1) * 30_000 - Date.now() + 50));
      }
    };
    const signIn = async (username: string, reauth: boolean) => {
      const a = admins.get(username)!;
      const r = reauth
        ? await a.admin.reauth(a.password, await code(a))
        : await a.admin.login(username, a.password, await code(a));
      if (!r.ok) {
        throw new Error(`本地管理员 ${username} 登录失败：${r.reason}`);
      }
      return toContract(r.principal);
    };
    const subject: IdentitySubject = {
      name: '本地管理员',
      login: (u) => signIn(u, false),
      reauthenticate: (u) => signIn(u, true),
      expectedGroups: { root: ['srenautix:local-admin'], breakglass: ['srenautix:local-admin'] },
    };
    const report = await runIdentityConformance(subject, ['root', 'breakglass']);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
  }, 300_000);
});
