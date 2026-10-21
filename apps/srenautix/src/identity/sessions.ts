import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

export const SESSION_COOKIE = '__Host-srenautix_session';

/** 已认证的主体（契约 identity AuthenticatedPrincipal）。 */
export interface AuthenticatedPrincipal {
  principal: { id: string; display_name: string; groups: string[] };
  provider: string;
  auth_time: Date;
  mfa: boolean;
  external_ids: Record<string, string>;
}

export interface Session {
  idHash: Buffer;
  principalId: string;
  displayName: string;
  provider: string;
  groups: string[];
  mfa: boolean;
  breakGlass: boolean;
  csrfToken: string;
  authTime: Date;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface SessionPolicy {
  idleMs: number;
  absoluteMs: number;
}

const hashId = (id: string) => createHash('sha256').update(id).digest();

interface Row {
  id_hash: Buffer;
  principal_id: string;
  display_name: string;
  provider: string;
  groups: string[];
  mfa: boolean;
  break_glass: boolean;
  csrf_token: string;
  auth_time: Date;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

function fromRow(r: Row): Session {
  return {
    idHash: r.id_hash,
    principalId: r.principal_id,
    displayName: r.display_name,
    provider: r.provider,
    groups: r.groups,
    mfa: r.mfa,
    breakGlass: r.break_glass,
    csrfToken: r.csrf_token,
    authTime: r.auth_time,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
  };
}

/**
 * 服务端会话（DESIGN §13）：空闲 30 分钟或累计 12 小时后失效；cookie 中只有随机 id，库里只存它的哈希。
 * 时间以 PG 的 now() 为准。
 */
export class Sessions {
  constructor(
    private readonly pool: pg.Pool,
    readonly policy: SessionPolicy,
  ) {}

  /** 会话实际失效的时间：空闲截止与累计截止中较早的一个。 */
  effectiveExpiry(s: Session): Date {
    return new Date(Math.min(s.lastSeenAt.getTime() + this.policy.idleMs, s.expiresAt.getTime()));
  }

  async create(p: AuthenticatedPrincipal, breakGlass: boolean): Promise<{ id: string; session: Session }> {
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const r = await this.pool.query<Row>(
      `INSERT INTO server.sessions (id_hash, principal_id, display_name, provider, groups, mfa, break_glass, csrf_token,
         auth_time, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), now() + make_interval(secs => $10))
       RETURNING *`,
      [
        hashId(id),
        p.principal.id,
        p.principal.display_name,
        p.provider,
        p.principal.groups,
        p.mfa,
        breakGlass,
        csrf,
        p.auth_time,
        this.policy.absoluteMs / 1000,
      ],
    );
    return { id, session: fromRow(r.rows[0] as Row) };
  }

  /** 取有效会话并刷新空闲计时；过期、空闲超时或已撤销时返回 null。 */
  async touch(id: string): Promise<Session | null> {
    const r = await this.pool.query<Row>(
      `UPDATE server.sessions SET last_seen_at = now()
        WHERE id_hash = $1 AND revoked_at IS NULL AND expires_at > now()
          AND last_seen_at > now() - make_interval(secs => $2)
        RETURNING *`,
      [hashId(id), this.policy.idleMs / 1000],
    );
    const row = r.rows[0];
    return row ? fromRow(row) : null;
  }

  /** 重新认证成功：更新认证时间（H 档审批要求 5 分钟内）。 */
  /** 重新认证：更新 auth_time；mfa 为 true 时会话从此视为带第二因子（只升不降）。 */
  async reauthenticated(id: string, authTime: Date, mfa = false): Promise<void> {
    await this.pool.query(
      'UPDATE server.sessions SET auth_time = $2, mfa = mfa OR $3 WHERE id_hash = $1 AND revoked_at IS NULL',
      [hashId(id), authTime, mfa],
    );
  }

  async revoke(id: string): Promise<void> {
    await this.pool.query('UPDATE server.sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL', [
      hashId(id),
    ]);
  }

  async revokePrincipal(principalId: string): Promise<number> {
    const r = await this.pool.query(
      'UPDATE server.sessions SET revoked_at = now() WHERE principal_id = $1 AND revoked_at IS NULL',
      [principalId],
    );
    return r.rowCount ?? 0;
  }

  async purgeExpired(): Promise<number> {
    const r = await this.pool.query(
      "DELETE FROM server.sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'",
    );
    return r.rowCount ?? 0;
  }
}

export function csrfMatches(session: Session, header: string | undefined): boolean {
  if (!header) {
    return false;
  }
  const a = Buffer.from(session.csrfToken);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionCookie(id: string, maxAgeS: number): string {
  return `${SESSION_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeS)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}
