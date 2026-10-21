import { describe, expect, it } from 'vitest';
import { approverFromSession } from '../../src/api/routes-proposals.js';
import type { Caller } from '../../src/identity/auth.js';
import { serverConfigSchema } from '../../src/config/server.js';
import type { Session } from '../../src/identity/sessions.js';

type UserCaller = Extract<Caller, { kind: 'user' }>;

function caller(provider: string, mfa: boolean): UserCaller {
  const now = new Date('2026-10-21T08:00:00Z');
  const session: Session = {
    idHash: Buffer.alloc(32),
    principalId: provider === 'oidc' ? 'oidc:alice' : 'local:admin',
    displayName: 'x',
    provider,
    groups: [],
    mfa,
    breakGlass: false,
    csrfToken: 'c',
    authTime: now,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now,
  };
  return {
    kind: 'user',
    session,
    sessionId: 'sid',
    subject: { id: session.principalId, groups: [] },
    channel: 'console',
  };
}

// 审批断言（ADR 0020）的 H 档重新认证凭据（ADR 0118）：本地管理员只凭口令登录的会话没有 local_totp 凭据，
// H 档审批先要求用口令加 TOTP 重新认证；带 TOTP 登录或重新认证过的会话照旧。
describe('本地管理员 TOTP 开关与审批断言', () => {
  it('带 TOTP 的本地管理员会话提供 local_totp 凭据', () => {
    expect(approverFromSession(caller('local-admin', true)).reauth).toMatchObject({
      method: 'local_totp',
      sessionId: 'sid',
    });
  });

  it('只凭口令登录的本地管理员会话没有重新认证凭据，H 档审批返回 reauth_required', () => {
    expect(approverFromSession(caller('local-admin', false)).reauth).toBeNull();
  });

  it('OIDC 会话不受影响', () => {
    expect(approverFromSession(caller('oidc', false)).reauth).toMatchObject({ method: 'oidc_max_age' });
  });
});

describe('配置 identity.local_admin.totp_required', () => {
  const base = { username: 'admin', password_hash_file: '/s/hash', totp_secret_file: '/s/totp' };
  const parse = (la: Record<string, unknown>) =>
    serverConfigSchema.shape.identity.shape.local_admin.unwrap().parse(la) as { totp_required: boolean };

  it('默认 true', () => {
    expect(parse(base).totp_required).toBe(true);
  });

  it('可以关闭；不是布尔值时拒绝', () => {
    expect(parse({ ...base, totp_required: false }).totp_required).toBe(false);
    expect(() => parse({ ...base, totp_required: 'no' })).toThrow();
  });
});
