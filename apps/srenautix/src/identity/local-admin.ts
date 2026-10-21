import { Secret, TOTP } from 'otpauth';
import type pg from 'pg';
import { appendAudit } from '../store/audit.js';
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
  /**
   * 登录是否要求 TOTP（identity.local_admin.totp_required，默认 true，ADR 0118）。为 false 时登录只校验口令，
   * 会话的 mfa 为 false；TOTP 密钥照常加载，重新认证（H 档审批）仍然要求口令加 TOTP。
   */
  totpRequired?: boolean;
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

  /** 登录是否要求 TOTP。 */
  get totpRequired(): boolean {
    return this.cfg.totpRequired ?? true;
  }

  /**
   * 登录：校验用户名与口令，要求 TOTP 时（默认）再校验 TOTP。失败计数按用户名累计，窗口内达到上限后锁定；
   * 锁定期间即使凭据正确也返回 locked。同一个 TOTP 时间步只能使用一次。不要求 TOTP 时忽略提交的验证码，会话的 mfa 为 false。
   */
  async login(username: string, password: string, code: string | undefined): Promise<LoginResult> {
    return this.authenticate(username, password, code, this.totpRequired);
  }

  /** 已登录的本地管理员用口令加 TOTP 重新认证（H 档审批）；不受 totp_required 影响，总是要求 TOTP。与登录共用失败计数与锁定。 */
  async reauth(password: string, code: string): Promise<LoginResult> {
    return this.authenticate(this.cfg.username, password, code, true);
  }

  private async authenticate(
    username: string,
    password: string,
    code: string | undefined,
    withTotp: boolean,
  ): Promise<LoginResult> {
    const now = await this.dbNow();
    const locked = await this.lockedUntil(username, now);
    if (locked) {
      return { ok: false, reason: 'locked', lockedUntil: locked };
    }
    const passwordOk = username === this.cfg.username && (await verifyPassword(password, this.cfg.passwordHash));
    let secondOk = true;
    if (withTotp) {
      const counter = passwordOk ? this.matchTotp(code ?? '', now) : null;
      secondOk = counter !== null && (await this.consumeCounter(username, counter));
    }
    if (!passwordOk || !secondOk) {
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
        mfa: withTotp,
        external_ids: {},
      },
    };
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

  /** 记一次失败；这次失败触发锁定时返回锁定截止时间，否则为 null。 */
  private async fail(username: string): Promise<Date | null> {
    return tx(this.pool, async (c) => {
      await c.query(
        `INSERT INTO server.login_attempts AS a (username, failures, window_started_at)
         VALUES ($1, 1, now())
         ON CONFLICT (username) DO UPDATE SET
           failures = CASE WHEN a.window_started_at < now() - make_interval(secs => $2) THEN 1 ELSE a.failures + 1 END,
           window_started_at = CASE WHEN a.window_started_at < now() - make_interval(secs => $2) THEN now() ELSE a.window_started_at END`,
        [username, this.lockout.windowMs / 1000],
      );
      const lock = await c.query<{ locked_until: Date }>(
        `UPDATE server.login_attempts SET locked_until = now() + make_interval(secs => $3), failures = 0, window_started_at = now()
          WHERE username = $1 AND failures >= $2 RETURNING locked_until`,
        [username, this.lockout.maxFailures, this.lockout.durationMs / 1000],
      );
      return lock.rows[0]?.locked_until ?? null;
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

const TOTP_STATE_KEY = 'local_admin_totp_required';

/**
 * 记录本地管理员登录是否要求 TOTP（ADR 0118）。与上一次启动记录的值不同（首次启动时与默认值 true 不同）时，
 * 在治理审计链追加一条 identity.local_admin_totp，并更新记录；返回是否发生了变化。并发启动的副本只记录一次。
 */
export async function recordLocalAdminTotpSetting(pool: pg.Pool, required: boolean): Promise<boolean> {
  return tx(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`srenautix.${TOTP_STATE_KEY}`]);
    const r = await c.query<{ value: boolean }>('SELECT value FROM server.system_state WHERE key = $1', [
      TOTP_STATE_KEY,
    ]);
    // 没有记录时视为默认值 true：一直要求 TOTP 的安装不产生审计记录
    const previous = r.rows.length ? r.rows[0]!.value === true : true;
    if (previous === required) {
      return false;
    }
    await c.query(
      `INSERT INTO server.system_state (key, value) VALUES ($1, to_jsonb($2::boolean))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [TOTP_STATE_KEY, required],
    );
    await appendAudit(c, 'identity.local_admin_totp', 'config', {
      setting: 'identity.local_admin.totp_required',
      totp_required: required,
      previous,
    });
    return true;
  });
}

/** 第一次 OIDC 登录成功后记录本地管理员已被取代，此后本地管理员只作为紧急入口（break_glass）。 */
export async function markLocalAdminSuperseded(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO server.system_state (key, value) VALUES ('local_admin_superseded_at', to_jsonb(now()))
     ON CONFLICT (key) DO NOTHING`,
  );
}
