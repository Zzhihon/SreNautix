import { createHash, randomInt } from 'node:crypto';
import type pg from 'pg';
import { tx } from '../store/pool.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_S = 600;

const hashCode = (code: string) => createHash('sha256').update(code).digest();

export interface ChatLink {
  channel: string;
  channelUserId: string;
  principalId: string;
  method: 'code' | 'union_id';
  linkedAt: Date;
}

export type RedeemResult =
  { ok: true; principalId: string } | { ok: false; reason: 'unknown_or_expired' | 'already_used' };

/**
 * 聊天账号绑定（DESIGN §9.2）：控制台登录后取一次性 8 位绑定码，在聊天里发送 `/link <code>`。
 * 绑定码只存哈希，10 分钟有效，用一次即失效；同一个聊天账号再次绑定时覆盖原绑定。
 */
export class ChatLinks {
  constructor(private readonly pool: pg.Pool) {}

  async createCode(principalId: string): Promise<{ code: string; expiresAt: Date }> {
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += ALPHABET[randomInt(ALPHABET.length)];
    }
    const r = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO server.link_codes (code_hash, principal_id, created_at, expires_at)
       VALUES ($1, $2, now(), now() + make_interval(secs => $3)) RETURNING expires_at`,
      [hashCode(code), principalId, CODE_TTL_S],
    );
    return { code, expiresAt: (r.rows[0] as { expires_at: Date }).expires_at };
  }

  async redeem(channel: string, channelUserId: string, code: string): Promise<RedeemResult> {
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(normalized)) {
      return { ok: false, reason: 'unknown_or_expired' };
    }
    return tx(this.pool, async (c) => {
      const r = await c.query<{ principal_id: string; used_at: Date | null; expired: boolean }>(
        'SELECT principal_id, used_at, expires_at < now() AS expired FROM server.link_codes WHERE code_hash = $1 FOR UPDATE',
        [hashCode(normalized)],
      );
      const row = r.rows[0];
      if (!row || row.expired) {
        return { ok: false, reason: 'unknown_or_expired' } as const;
      }
      if (row.used_at) {
        return { ok: false, reason: 'already_used' } as const;
      }
      await c.query('UPDATE server.link_codes SET used_at = now(), used_by = $2 WHERE code_hash = $1', [
        hashCode(normalized),
        `${channel}:${channelUserId}`,
      ]);
      await c.query(
        `INSERT INTO server.chat_links (channel, channel_user_id, principal_id, method, linked_at) VALUES ($1, $2, $3, 'code', now())
         ON CONFLICT (channel, channel_user_id) DO UPDATE SET principal_id = excluded.principal_id, method = 'code', linked_at = now()`,
        [channel, channelUserId, row.principal_id],
      );
      return { ok: true, principalId: row.principal_id } as const;
    });
  }

  /** 聊天账号与控制台使用同一个身份源（例如飞书 union_id）时自动绑定。 */
  async linkByUnionId(channel: string, channelUserId: string, unionId: string): Promise<string | null> {
    const u = await this.pool.query<{ principal_id: string }>(
      "SELECT principal_id FROM server.users WHERE external_ids->>'union_id' = $1",
      [unionId],
    );
    const principal = u.rows[0]?.principal_id;
    if (!principal || (u.rowCount ?? 0) > 1) {
      return null;
    }
    await this.pool.query(
      `INSERT INTO server.chat_links (channel, channel_user_id, principal_id, method, linked_at) VALUES ($1, $2, $3, 'union_id', now())
       ON CONFLICT (channel, channel_user_id) DO NOTHING`,
      [channel, channelUserId, principal],
    );
    return (await this.lookup(channel, channelUserId))?.principalId ?? null;
  }

  async lookup(channel: string, channelUserId: string): Promise<ChatLink | null> {
    const r = await this.pool.query<{
      channel: string;
      channel_user_id: string;
      principal_id: string;
      method: 'code' | 'union_id';
      linked_at: Date;
    }>('SELECT * FROM server.chat_links WHERE channel = $1 AND channel_user_id = $2', [channel, channelUserId]);
    const x = r.rows[0];
    return x
      ? {
          channel: x.channel,
          channelUserId: x.channel_user_id,
          principalId: x.principal_id,
          method: x.method,
          linkedAt: x.linked_at,
        }
      : null;
  }

  async forPrincipal(principalId: string): Promise<ChatLink[]> {
    const r = await this.pool.query<{
      channel: string;
      channel_user_id: string;
      principal_id: string;
      method: 'code' | 'union_id';
      linked_at: Date;
    }>('SELECT * FROM server.chat_links WHERE principal_id = $1 ORDER BY linked_at', [principalId]);
    return r.rows.map((x) => ({
      channel: x.channel,
      channelUserId: x.channel_user_id,
      principalId: x.principal_id,
      method: x.method,
      linkedAt: x.linked_at,
    }));
  }

  async unlink(channel: string, channelUserId: string): Promise<void> {
    await this.pool.query('DELETE FROM server.chat_links WHERE channel = $1 AND channel_user_id = $2', [
      channel,
      channelUserId,
    ]);
  }
}

/** 用户首次或再次登录：记录主体与外部 id（union_id 用于自动绑定）。 */
export async function upsertUser(
  pool: pg.Pool,
  p: { id: string; display_name: string; groups: string[] },
  provider: string,
  externalIds: Record<string, string>,
): Promise<void> {
  await pool.query(
    `INSERT INTO server.users (principal_id, display_name, provider, groups, external_ids, first_login_at, last_login_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (principal_id) DO UPDATE SET display_name = excluded.display_name, groups = excluded.groups,
       external_ids = excluded.external_ids, last_login_at = now()`,
    [p.id, p.display_name, provider, p.groups, JSON.stringify(externalIds)],
  );
}
