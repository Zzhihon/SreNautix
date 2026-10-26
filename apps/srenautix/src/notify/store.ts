import type pg from 'pg';
import { tx } from '../store/pool.js';
import { RENDER_VERSION, type ActionResultView, type RegisteredButton } from './channel.js';
import type { ExternalWindowStats } from './external.js';
import type { ButtonTarget } from './ports.js';

/** 通知层的库访问。所有时间都由调用方给出（引擎的时钟），便于测试控制时间。 */

export type Lane = 'urgent' | 'digest' | 'edit' | 'recovery';

/** incident：事件消息；digest：风暴汇总；external_digest：外部上游的周期汇总（ADR 0147），subject 为时间段起点 */
export type MessageKind = 'incident' | 'digest' | 'external_digest';

export interface MessageRow {
  id: number;
  channel: string;
  chat: string;
  kind: MessageKind;
  subject: string;
  incidentId: string | null;
  stormId: number | null;
  lane: Lane;
  silent: boolean;
  payload: unknown;
  desiredHash: string;
  proposalIds: string[];
  externalId: string | null;
  deliveredHash: string | null;
  deliveredAt: Date | null;
  firstDeliveredAt: Date | null;
  attempts: number;
  createdAt: Date;
  /** 产出期望内容的渲染器版本；旧代码写入的行为 null */
  renderVersion: number | null;
  /** 期望内容是已结束（恢复或合并）事件的消息 */
  ended: boolean;
  /** 事件结束后对这条消息成功编辑的次数 */
  endedEdits: number;
  /** 编辑次数用完后的最后一次编辑（精简内容加说明行）送达的时刻；之后不再投递，事件重新触发时清除（ADR 0173） */
  finalEditedAt: Date | null;
  abandonedAt: Date | null;
  abandonedReason: string | null;
}

interface DbMessage {
  id: number;
  channel: string;
  chat: string;
  kind: MessageKind;
  subject: string;
  incident_id: string | null;
  storm_id: number | null;
  lane: Lane;
  silent: boolean;
  desired_payload: unknown;
  desired_hash: string;
  proposal_ids: string[];
  external_id: string | null;
  delivered_hash: string | null;
  delivered_at: Date | null;
  first_delivered_at: Date | null;
  attempts: number;
  created_at: Date;
  render_version: number | null;
  ended: boolean;
  ended_edits: number;
  final_edited_at: Date | null;
  abandoned_at: Date | null;
  abandoned_reason: string | null;
}

const toMessage = (r: DbMessage): MessageRow => ({
  id: r.id,
  channel: r.channel,
  chat: r.chat,
  kind: r.kind,
  subject: r.subject,
  incidentId: r.incident_id,
  stormId: r.storm_id,
  lane: r.lane,
  silent: r.silent,
  payload: r.desired_payload,
  desiredHash: r.desired_hash,
  proposalIds: r.proposal_ids,
  externalId: r.external_id,
  deliveredHash: r.delivered_hash,
  deliveredAt: r.delivered_at,
  firstDeliveredAt: r.first_delivered_at,
  attempts: r.attempts,
  createdAt: r.created_at,
  renderVersion: r.render_version,
  ended: r.ended,
  endedEdits: r.ended_edits,
  finalEditedAt: r.final_edited_at,
  abandonedAt: r.abandoned_at,
  abandonedReason: r.abandoned_reason,
});

export interface DesiredRow {
  channel: string;
  chat: string;
  kind: MessageKind;
  subject: string;
  incidentId: string | null;
  stormId: number | null;
  lane: Lane;
  silent: boolean;
  payload: unknown;
  hash: string;
  proposalIds: string[];
  /** 已结束（恢复或合并）事件的消息；省略时为 false */
  ended?: boolean;
}

/** 待投递：期望与已呈现不同，这一版期望内容没有被放弃，也没有发出过最后一次编辑（ADR 0173） */
const PENDING = 'delivered_hash IS DISTINCT FROM desired_hash AND abandoned_at IS NULL AND final_edited_at IS NULL';

export interface ButtonRow {
  shortId: string;
  channel: string;
  chat: string;
  kind: string;
  target: ButtonTarget;
  owner: string | null;
  claimedBy: string | null;
  finishedAt: Date | null;
}

export interface PendingReply {
  id: number;
  channel: string;
  chat: string;
  shortId: string;
  purpose: 'reject_reason' | 'root_component';
  channelUserId: string;
  principalId: string;
  displayName: string;
  promptMessageId: string | null;
  expiresAt: Date;
  state: 'waiting' | 'submitted' | 'expired';
}

interface DbPending {
  id: number;
  channel: string;
  chat: string;
  short_id: string;
  purpose: 'reject_reason' | 'root_component';
  channel_user_id: string;
  principal_id: string;
  display_name: string;
  prompt_message_id: string | null;
  expires_at: Date;
  state: 'waiting' | 'submitted' | 'expired';
}

const toPending = (r: DbPending): PendingReply => ({
  id: r.id,
  channel: r.channel,
  chat: r.chat,
  shortId: r.short_id,
  purpose: r.purpose,
  channelUserId: r.channel_user_id,
  principalId: r.principal_id,
  displayName: r.display_name,
  promptMessageId: r.prompt_message_id,
  expiresAt: r.expires_at,
  state: r.state,
});

const LANE_ORDER = `CASE lane WHEN 'urgent' THEN 0 WHEN 'digest' THEN 1 WHEN 'edit' THEN 2 ELSE 3 END`;

export class NotifyStore {
  constructor(readonly pool: pg.Pool) {}

  async messages(channel: string, chat: string, kind: MessageKind): Promise<MessageRow[]> {
    const r = await this.pool.query<DbMessage>(
      'SELECT * FROM server.notify_messages WHERE channel = $1 AND chat = $2 AND kind = $3 ORDER BY id',
      [channel, chat, kind],
    );
    return r.rows.map(toMessage);
  }

  async hasMessage(channel: string, chat: string, kind: MessageKind, subject: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM server.notify_messages WHERE channel = $1 AND chat = $2 AND kind = $3 AND subject = $4',
      [channel, chat, kind, subject],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** 外部上游汇总的时间段统计（ADR 0147）；没有时为 null */
  async externalWindow(from: Date): Promise<ExternalWindowStats | null> {
    const r = await this.pool.query<{ stats: ExternalWindowStats }>(
      'SELECT stats FROM server.notify_external_windows WHERE window_start = $1',
      [from],
    );
    return r.rows[0]?.stats ?? null;
  }

  /** 写入时间段统计；已有时不覆盖，返回库中的那一份（同一时间段只统计一次，汇总消息与下一时段的对比用同一份） */
  async saveExternalWindow(s: ExternalWindowStats, now: Date): Promise<ExternalWindowStats> {
    await this.pool.query(
      `INSERT INTO server.notify_external_windows (window_start, window_end, stats, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (window_start) DO NOTHING`,
      [new Date(s.from), new Date(s.to), JSON.stringify(s), now],
    );
    return (await this.externalWindow(new Date(s.from))) ?? s;
  }

  async message(id: number): Promise<MessageRow | null> {
    const r = await this.pool.query<DbMessage>('SELECT * FROM server.notify_messages WHERE id = $1', [id]);
    return r.rows[0] ? toMessage(r.rows[0]) : null;
  }

  async activeStorm(channel: string, chat: string, since: Date): Promise<{ id: number; startedAt: Date } | null> {
    const r = await this.pool.query<{ id: number; started_at: Date }>(
      `SELECT id, started_at FROM server.notify_storms WHERE channel = $1 AND chat = $2 AND last_member_at >= $3
        ORDER BY last_member_at DESC LIMIT 1`,
      [channel, chat, since],
    );
    const row = r.rows[0];
    return row ? { id: row.id, startedAt: row.started_at } : null;
  }

  async createStorm(channel: string, chat: string, now: Date): Promise<{ id: number; startedAt: Date }> {
    const r = await this.pool.query<{ id: number }>(
      'INSERT INTO server.notify_storms (channel, chat, started_at, last_member_at) VALUES ($1, $2, $3, $3) RETURNING id',
      [channel, chat, now],
    );
    return { id: (r.rows[0] as { id: number }).id, startedAt: now };
  }

  async joinStorm(stormId: number, incidentIds: string[], now: Date): Promise<void> {
    if (!incidentIds.length) {
      return;
    }
    await tx(this.pool, async (c) => {
      for (const id of incidentIds) {
        await c.query(
          'INSERT INTO server.notify_storm_members (storm_id, incident_id, joined_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [stormId, id, now],
        );
      }
      await c.query('UPDATE server.notify_storms SET last_member_at = $2 WHERE id = $1', [stormId, now]);
      await c.query(
        `UPDATE server.notify_messages SET storm_id = $1 WHERE kind = 'incident' AND storm_id IS NULL AND incident_id = ANY($2::uuid[])
           AND (channel, chat) = (SELECT channel, chat FROM server.notify_storms WHERE id = $1)`,
        [stormId, incidentIds],
      );
    });
  }

  async recentStorms(channel: string, chat: string, since: Date): Promise<Array<{ id: number; startedAt: Date }>> {
    const r = await this.pool.query<{ id: number; started_at: Date }>(
      'SELECT id, started_at FROM server.notify_storms WHERE channel = $1 AND chat = $2 AND last_member_at >= $3 ORDER BY id',
      [channel, chat, since],
    );
    return r.rows.map((x) => ({ id: x.id, startedAt: x.started_at }));
  }

  async stormMembers(stormId: number): Promise<string[]> {
    const r = await this.pool.query<{ incident_id: string }>(
      'SELECT incident_id FROM server.notify_storm_members WHERE storm_id = $1 ORDER BY joined_at, incident_id',
      [stormId],
    );
    return r.rows.map((x) => x.incident_id);
  }

  async results(channel: string, chat: string, incidentId: string, limit: number): Promise<ActionResultView[]> {
    const r = await this.pool.query<{
      at: Date;
      actor: string;
      action: string;
      ok: boolean;
      code: string | null;
      message: string;
    }>(
      `SELECT at, actor, action, ok, code, message FROM server.notify_action_results
        WHERE channel = $1 AND chat = $2 AND incident_id = $3 ORDER BY at DESC, id DESC LIMIT $4`,
      [channel, chat, incidentId, limit],
    );
    return r.rows;
  }

  async addResult(r: {
    channel: string;
    chat: string;
    incidentId: string;
    proposalId: string | null;
    action: string;
    actor: string;
    ok: boolean;
    code: string | null;
    message: string;
    at: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO server.notify_action_results (channel, chat, incident_id, proposal_id, action, actor, ok, code, message, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [r.channel, r.chat, r.incidentId, r.proposalId, r.action, r.actor, r.ok, r.code, r.message, r.at],
    );
  }

  /**
   * 写入期望状态。内容变化时立即进入待投递，并清除对上一版内容的放弃；silent 与创建时间只在第一次写入时确定。
   * 记录当前渲染器版本；事件重新触发（不再是已结束）时编辑计数与最后一次编辑清零。最后一次编辑被拒绝的放弃
   * （ended_edit_cap）在事件仍是已结束时保留，不因内容变化重新尝试（ADR 0173）。
   */
  async upsertDesired(rows: DesiredRow[], now: Date): Promise<void> {
    if (!rows.length) {
      return;
    }
    await tx(this.pool, async (c) => {
      for (const d of rows) {
        await c.query(
          `INSERT INTO server.notify_messages AS m (channel, chat, kind, subject, incident_id, storm_id, lane, silent,
             desired_payload, desired_hash, desired_at, proposal_ids, next_attempt_at, created_at, render_version, ended)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $11, $13, $14)
           ON CONFLICT (channel, chat, kind, subject) DO UPDATE SET
             desired_payload = excluded.desired_payload,
             desired_at = CASE WHEN m.desired_hash IS DISTINCT FROM excluded.desired_hash THEN excluded.desired_at ELSE m.desired_at END,
             next_attempt_at = CASE WHEN m.desired_hash IS DISTINCT FROM excluded.desired_hash THEN excluded.next_attempt_at ELSE m.next_attempt_at END,
             abandoned_at = CASE WHEN m.desired_hash IS DISTINCT FROM excluded.desired_hash
                                  AND NOT (m.abandoned_reason = 'ended_edit_cap' AND excluded.ended) THEN NULL ELSE m.abandoned_at END,
             abandoned_reason = CASE WHEN m.desired_hash IS DISTINCT FROM excluded.desired_hash
                                  AND NOT (m.abandoned_reason = 'ended_edit_cap' AND excluded.ended) THEN NULL ELSE m.abandoned_reason END,
             desired_hash = excluded.desired_hash,
             lane = excluded.lane,
             proposal_ids = excluded.proposal_ids,
             storm_id = COALESCE(m.storm_id, excluded.storm_id),
             render_version = excluded.render_version,
             ended = excluded.ended,
             ended_edits = CASE WHEN excluded.ended THEN m.ended_edits ELSE 0 END,
             final_edited_at = CASE WHEN excluded.ended THEN m.final_edited_at ELSE NULL END`,
          [
            d.channel,
            d.chat,
            d.kind,
            d.subject,
            d.incidentId,
            d.stormId,
            d.lane,
            d.silent,
            JSON.stringify(d.payload),
            d.hash,
            now,
            d.proposalIds,
            RENDER_VERSION,
            d.ended ?? false,
          ],
        );
      }
    });
  }

  /** 旧版本渲染器产出、还没有呈现、没有被放弃的期望内容（启动时按当前代码重新渲染） */
  async staleDesired(renderVersion: number): Promise<MessageRow[]> {
    const r = await this.pool.query<DbMessage>(
      `SELECT * FROM server.notify_messages
        WHERE ${PENDING} AND (render_version IS NULL OR render_version < $1) ORDER BY id`,
      [renderVersion],
    );
    return r.rows.map(toMessage);
  }

  async storm(id: number): Promise<{ id: number; startedAt: Date } | null> {
    const r = await this.pool.query<{ id: number; started_at: Date }>(
      'SELECT id, started_at FROM server.notify_storms WHERE id = $1',
      [id],
    );
    const row = r.rows[0];
    return row ? { id: row.id, startedAt: row.started_at } : null;
  }

  /**
   * 放弃这一版期望内容：以后不再投递，直到期望内容变化。只在期望内容没有被并发更新时生效，返回是否生效。
   */
  async abandon(id: number, hash: string, now: Date, reason: string, error: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE server.notify_messages SET abandoned_at = $3, abandoned_reason = $4, last_attempt_at = $3, last_error = $5
        WHERE id = $1 AND desired_hash = $2`,
      [id, hash, now, reason, error],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async registerButtons(channel: string, chat: string, buttons: RegisteredButton[], now: Date): Promise<void> {
    for (const b of buttons) {
      await this.pool.query(
        `INSERT INTO server.notify_buttons (short_id, channel, chat, kind, target, owner_user, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (short_id) DO NOTHING`,
        [b.shortId, channel, chat, b.kind, JSON.stringify(b.target), b.owner, now],
      );
    }
  }

  async pending(channel: string, now: Date, limit: number): Promise<MessageRow[]> {
    const r = await this.pool.query<DbMessage>(
      `SELECT * FROM server.notify_messages
        WHERE channel = $1 AND ${PENDING} AND next_attempt_at <= $2
        ORDER BY ${LANE_ORDER}, next_attempt_at, id LIMIT $3`,
      [channel, now, limit],
    );
    return r.rows.map(toMessage);
  }

  async pendingCount(channel: string): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM server.notify_messages WHERE channel = $1 AND ${PENDING}`,
      [channel],
    );
    return (r.rows[0] as { n: number }).n;
  }

  /**
   * 记录送达。edit 为 true 时这是一次编辑，已结束事件的编辑计数加一（只计成功的编辑）；final 为 true 时这是编辑次数
   * 用完后的最后一次编辑，记 final_edited_at（ADR 0173）。返回是否为第一次送达。
   */
  async markDelivered(
    id: number,
    externalId: string,
    hash: string,
    now: Date,
    edit = false,
    final = false,
  ): Promise<boolean> {
    const r = await this.pool.query<{ first: boolean }>(
      `UPDATE server.notify_messages SET external_id = $2, delivered_hash = $3, delivered_at = $4,
         first_delivered_at = COALESCE(first_delivered_at, $4), last_attempt_at = $4, attempts = 0, last_error = NULL,
         ended_edits = ended_edits + CASE WHEN ended AND $5 THEN 1 ELSE 0 END,
         final_edited_at = CASE WHEN $6 THEN $4 ELSE final_edited_at END
       WHERE id = $1 RETURNING (first_delivered_at = $4) AS first`,
      [id, externalId, hash, now, edit, final],
    );
    return r.rows[0]?.first ?? false;
  }

  async defer(id: number, at: Date): Promise<void> {
    await this.pool.query('UPDATE server.notify_messages SET next_attempt_at = $2 WHERE id = $1', [id, at]);
  }

  /** 记录一次失败的尝试（不计入已结束事件的编辑次数） */
  async markAttempt(id: number, now: Date, next: Date, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE server.notify_messages SET last_attempt_at = $2, next_attempt_at = $3, attempts = attempts + 1, last_error = $4
       WHERE id = $1`,
      [id, now, next, error],
    );
  }

  /** 这些事件中在任一渠道目标上已有事件消息的 */
  async incidentsWithMessages(incidentIds: readonly string[]): Promise<Set<string>> {
    if (!incidentIds.length) {
      return new Set();
    }
    const r = await this.pool.query<{ incident_id: string }>(
      "SELECT DISTINCT incident_id FROM server.notify_messages WHERE kind = 'incident' AND incident_id = ANY($1::uuid[])",
      [incidentIds],
    );
    return new Set(r.rows.map((x) => x.incident_id));
  }

  /** 要编辑的消息已被删除：清掉渠道消息 id，下一轮作为新消息发送最新内容。 */
  async forgetExternal(id: number, now: Date, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE server.notify_messages SET external_id = NULL, delivered_hash = NULL, last_attempt_at = $2, next_attempt_at = $2,
         last_error = $3 WHERE id = $1`,
      [id, now, error],
    );
  }

  /** 状态库恢复后补写降级期间直接发送的消息。 */
  async backfillDelivered(d: DesiredRow, externalId: string, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO server.notify_messages AS m (channel, chat, kind, subject, incident_id, lane, silent, desired_payload, desired_hash,
         desired_at, proposal_ids, next_attempt_at, created_at, external_id, delivered_hash, delivered_at, first_delivered_at,
         render_version)
       VALUES ($1, $2, 'incident', $3, $4, $5, false, $6, $7, $8, $9, $8, $8, $10, $7, $8, $8, $11)
       ON CONFLICT (channel, chat, kind, subject) DO UPDATE SET external_id = excluded.external_id,
         delivered_hash = excluded.delivered_hash, delivered_at = excluded.delivered_at,
         first_delivered_at = COALESCE(m.first_delivered_at, excluded.first_delivered_at)`,
      [
        d.channel,
        d.chat,
        d.subject,
        d.incidentId,
        d.lane,
        JSON.stringify(d.payload),
        d.hash,
        at,
        d.proposalIds,
        externalId,
        RENDER_VERSION,
      ],
    );
  }

  // 回调

  /** 登记一个回调；已经登记过时返回第一次的处理结论与应答。 */
  async recordCallback(c: {
    channel: string;
    callbackId: string;
    chat: string;
    channelUserId: string;
    shortId: string | null;
    at: Date;
  }): Promise<{ fresh: boolean; outcome: string | null; answer: string | null }> {
    const ins = await this.pool.query(
      `INSERT INTO server.notify_callbacks (channel, callback_id, chat, channel_user_id, short_id, received_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [c.channel, c.callbackId, c.chat, c.channelUserId, c.shortId, c.at],
    );
    if (ins.rowCount) {
      return { fresh: true, outcome: null, answer: null };
    }
    const r = await this.pool.query<{ outcome: string | null; answer: string | null }>(
      'SELECT outcome, answer FROM server.notify_callbacks WHERE channel = $1 AND callback_id = $2',
      [c.channel, c.callbackId],
    );
    const row = r.rows[0] as { outcome: string | null; answer: string | null };
    return { fresh: false, outcome: row.outcome, answer: row.answer };
  }

  async setCallbackOutcome(channel: string, callbackId: string, outcome: string, answer: string): Promise<void> {
    await this.pool.query(
      'UPDATE server.notify_callbacks SET outcome = $3, answer = $4 WHERE channel = $1 AND callback_id = $2',
      [channel, callbackId, outcome, answer],
    );
  }

  async button(shortId: string): Promise<ButtonRow | null> {
    const r = await this.pool.query<{
      short_id: string;
      channel: string;
      chat: string;
      kind: string;
      target: ButtonTarget;
      owner_user: string | null;
      claimed_by: string | null;
      finished_at: Date | null;
    }>('SELECT * FROM server.notify_buttons WHERE short_id = $1', [shortId]);
    const x = r.rows[0];
    return x
      ? {
          shortId: x.short_id,
          channel: x.channel,
          chat: x.chat,
          kind: x.kind,
          target: x.target,
          owner: x.owner_user,
          claimedBy: x.claimed_by,
          finishedAt: x.finished_at,
        }
      : null;
  }

  /** 第一个回调独占按钮；已完成或被占用时返回 false。 */
  async claim(shortId: string, by: string, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      'UPDATE server.notify_buttons SET claimed_by = $2, claimed_at = $3 WHERE short_id = $1 AND claimed_by IS NULL AND finished_at IS NULL',
      [shortId, by, now],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async release(shortId: string, by: string): Promise<void> {
    await this.pool.query(
      'UPDATE server.notify_buttons SET claimed_by = NULL, claimed_at = NULL WHERE short_id = $1 AND claimed_by = $2',
      [shortId, by],
    );
  }

  async finish(shortId: string, by: string, now: Date): Promise<void> {
    await this.pool.query('UPDATE server.notify_buttons SET finished_at = $3 WHERE short_id = $1 AND claimed_by = $2', [
      shortId,
      by,
      now,
    ]);
  }

  // 回复式交互

  async createReply(p: {
    channel: string;
    chat: string;
    shortId: string;
    purpose: PendingReply['purpose'];
    channelUserId: string;
    principalId: string;
    displayName: string;
    now: Date;
    expiresAt: Date;
  }): Promise<number> {
    const r = await this.pool.query<{ id: number }>(
      `INSERT INTO server.notify_pending_replies (channel, chat, short_id, purpose, channel_user_id, principal_id, display_name,
         created_at, expires_at, state) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'waiting') RETURNING id`,
      [p.channel, p.chat, p.shortId, p.purpose, p.channelUserId, p.principalId, p.displayName, p.now, p.expiresAt],
    );
    return (r.rows[0] as { id: number }).id;
  }

  async setPrompt(id: number, promptMessageId: string): Promise<void> {
    await this.pool.query('UPDATE server.notify_pending_replies SET prompt_message_id = $2 WHERE id = $1', [
      id,
      promptMessageId,
    ]);
  }

  async replyByPrompt(channel: string, chat: string, promptMessageId: string): Promise<PendingReply | null> {
    const r = await this.pool.query<DbPending>(
      'SELECT * FROM server.notify_pending_replies WHERE channel = $1 AND chat = $2 AND prompt_message_id = $3',
      [channel, chat, promptMessageId],
    );
    return r.rows[0] ? toPending(r.rows[0]) : null;
  }

  /** 提交与过期互斥：只有仍在等待的记录才能提交。 */
  async submitReply(id: number, reply: string, now: Date): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE server.notify_pending_replies SET state = 'submitted', reply = $2, resolved_at = $3 WHERE id = $1 AND state = 'waiting'",
      [id, reply, now],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async expireReplies(now: Date): Promise<PendingReply[]> {
    const r = await this.pool.query<DbPending>(
      `UPDATE server.notify_pending_replies SET state = 'expired', resolved_at = $1
        WHERE state = 'waiting' AND expires_at <= $1 RETURNING *`,
      [now],
    );
    return r.rows.map(toPending);
  }

  // Telegram 长轮询

  async pollOffset(): Promise<number> {
    const r = await this.pool.query<{ next_offset: number }>('SELECT next_offset FROM server.telegram_poll_state');
    return r.rows[0]?.next_offset ?? 0;
  }

  async savePollOffset(offset: number, now: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO server.telegram_poll_state (id, next_offset, updated_at) VALUES (true, $1, $2)
       ON CONFLICT (id) DO UPDATE SET next_offset = GREATEST(server.telegram_poll_state.next_offset, excluded.next_offset),
         updated_at = excluded.updated_at`,
      [offset, now],
    );
  }
}
