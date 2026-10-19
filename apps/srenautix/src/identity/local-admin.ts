import { Secret, TOTP } from 'otpauth';
import type pg from 'pg';
import { tx } from '../store/pool.js';
import { verifyPassword } from './password.js';
import type { AuthenticatedPrincipal } from './sessions.js';

export interface LockoutPolicy {
  maxFailures: number;
  windowMs: number;
  durationMs: number;
}

export interface LocalAdminConfig {
  username: string;
  passwordHash: string;
  totpSecret: string;
}

export type LoginResult =
  | { ok: true; principal: AuthenticatedPrincipal; breakGlass: boolean }
  | { ok: false; reason: 'invalid' | 'locked'; lockedUntil: Date | null };

export const LOCAL_PROVIDER = 'local-admin';

/** 本地管理员（DESIGN §13）：只用于首次引导；SSO 验证通过后作为紧急入口保留，要求 TOTP，使用时显示横幅并审计。 */
export class LocalAdmin {
  private readonly totp: TOTP;

  constructor(
    private readonly pool: pg.Pool,
    private readonly cfg: LocalAdminConfig,
    private readonly lockout: LockoutPolicy,
  ) {
    this.totp = new TOTP({
      issuer: 'SreNautix',
      label: cfg.username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(cfg.totpSecret),
    });
  }

  get username(): string {
    return this.cfg.username;
  }

  /**
   * 校验用户名、口令与 TOTP。失败计数按用户名累计，窗口内达到上限后锁定；
   * 锁定期间即使凭据正确也返回 locked。同一个 TOTP 时间步只能使用一次。
   */
  async login(username: string, password: string, code: string): Promise<LoginResult> {
    const now = await this.dbNow();
    const locked = await this.lockedUntil(username, now);
    if (locked) {
      return { ok: false, reason: 'locked', lockedUntil: locked };
    }
    const passwordOk = username === this.cfg.username && (await verifyPassword(password, this.cfg.passwordHash));
    const counter = passwordOk ? this.matchTotp(code, now) : null;
    if (!passwordOk || counter === null || !(await this.consumeCounter(username, counter))) {
      const until = await this.fail(username);
      return { ok: false, reason: until ? 'locked' : 'invalid', lockedUntil: until };
    }
    await this.pool.query('UPDATE server.login_attempts SET failures = 0, locked_until = NULL WHERE username = $1', [
      username,
    ]);
    const disabled = await this.pool.query("SELECT 1 FROM server.system_state WHERE key = 'local_admin_superseded_at'");
    return {
      ok: true,
      breakGlass: (disabled.rowCount ?? 0) > 0,
      principal: {
        principal: { id: `local:${username}`, display_name: username, groups: ['srenautix:local-admin'] },
        provider: LOCAL_PROVIDER,
        auth_time: now,
        mfa: true,
        external_ids: {},
      },
    };
  }

  /** 已登录的本地管理员用 TOTP 重新认证（H 档审批）。 */
  async reauth(code: string): Promise<Date | null> {
    const now = await this.dbNow();
    const counter = this.matchTotp(code, now);
    if (counter === null || !(await this.consumeCounter(this.cfg.username, counter))) {
      await this.fail(this.cfg.username);
      return null;
    }
    return now;
  }

  private matchTotp(code: string, now: Date): number | null {
    if (!/^\d{6}$/.test(code)) {
      return null;
    }
    const delta = this.totp.validate({ token: code, timestamp: now.getTime(), window: 1 });
    if (delta === null) {
      return null;
    }
    return this.totp.counter({ timestamp: now.getTime() }) + delta;
  }

  private async dbNow(): Promise<Date> {
    const r = await this.pool.query<{ now: Date }>('SELECT now() AS now');
    return (r.rows[0] as { now: Date }).now;
  }

  private async lockedUntil(username: string, now: Date): Promise<Date | null> {
    const r = await this.pool.query<{ locked_until: Date | null }>(
      'SELECT locked_until FROM server.login_attempts WHERE username = $1',
      [username],
    );
    const until = r.rows[0]?.locked_until ?? null;
    return until && until > now ? until : null;
  }

  /** 记一次失败，返回锁定截止时间（未锁定为 null）。 */
  private async fail(username: string): Promise<Date | null> {
    return tx(this.pool, async (c) => {
      const r = await c.query<{ locked_until: Date | null }>(
        `INSERT INTO server.login_attempts AS a (username, failures, window_started_at)
         VALUES ($1, 1, now())
         ON CONFLICT (username) DO UPDATE SET
           failures = CASE WHEN a.window_started_at < now() - make_interval(secs => $2) THEN 1 ELSE a.failures + 1 END,
           window_started_at = CASE WHEN a.window_started_at < now() - make_interval(secs => $2) THEN now() ELSE a.window_started_at END
         RETURNING locked_until`,
        [username, this.lockout.windowMs / 1000],
      );
      const lock = await c.query<{ locked_until: Date | null }>(
        `UPDATE server.login_attempts SET locked_until = now() + make_interval(secs => $3), failures = 0, window_started_at = now()
          WHERE username = $1 AND failures >= $2 RETURNING locked_until`,
        [username, this.lockout.maxFailures, this.lockout.durationMs / 1000],
      );
      return lock.rows[0]?.locked_until ?? r.rows[0]?.locked_until ?? null;
    });
  }

  /** 原子地登记 TOTP 时间步，比已用的大才算有效。 */
  private async consumeCounter(username: string, counter: number): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO server.login_attempts AS a (username, failures, window_started_at, last_totp_counter)
       VALUES ($1, 0, now(), $2)
       ON CONFLICT (username) DO UPDATE SET last_totp_counter = $2
         WHERE a.last_totp_counter IS NULL OR a.last_totp_counter < $2`,
      [username, counter],
    );
    return (r.rowCount ?? 0) === 1;
  }
}

/** 第一次 OIDC 登录成功后记录本地管理员已被取代，此后本地管理员只作为紧急入口（break_glass）。 */
export async function markLocalAdminSuperseded(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO server.system_state (key, value) VALUES ('local_admin_superseded_at', to_jsonb(now()))
     ON CONFLICT (key) DO NOTHING`,
  );
}
