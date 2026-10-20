import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import type { ChannelAdapter, ChatTarget, DigestInput } from './channel.js';
import type { Interactions } from './interactions.js';
import type { DesiredIncidentMessage, MessageSource } from './ports.js';
import { ChannelLimiter } from './ratelimit.js';
import { decideStorm, STORM_WINDOW_MS } from './storm.js';
import type { DesiredRow, Lane, MessageRow, NotifyStore } from './store.js';

/** 渠道配置或凭据错误：继续运行没有意义，由进程退出暴露出来。 */
export class NotifyFatalError extends Error {
  override name = 'NotifyFatalError';
}

export interface EngineOptions {
  /** 汇总消息之外的消息前缀（例如影子部署的标记）；事件消息的前缀由 NotifyMessage.prefix 给出。 */
  prefix: string;
  /** 汇总消息的控制台链接。 */
  consoleUrl: string | null;
  /** 风暴结束后汇总消息继续编辑的时长。 */
  digestRetentionMs: number;
  now: () => number;
}

/** Telegram 不可达时多久重试；Bot API 拒绝某条消息（其他 4xx）时多久重试。 */
const TRANSPORT_RETRY_MS = 15_000;
const API_ERROR_RETRY_MS = 5 * 60_000;
const RESULTS_SHOWN = 5;

const msgKey = (channel: string, chat: string, incidentId: string) => `${channel}|${chat}|${incidentId}`;

interface DirectSent {
  row: DesiredRow;
  externalId: string;
  at: Date;
}

/**
 * 渠道无关的投递引擎（DESIGN §11）。同步：读取期望消息、做风暴判定、按渠道渲染、写入期望状态；
 * 投递：把期望与已呈现不同的消息发出或编辑，按优先级通道取用每个渠道的令牌桶，同一条消息的编辑合并到最新内容。
 */
export class NotifyEngine {
  private readonly limiters = new Map<string, ChannelLimiter>();
  /** 已知的渠道消息 id（同步与投递时更新），状态库降级时直接发送用它编辑原消息。 */
  private readonly known = new Map<string, { externalId: string; hash: string | null }>();
  /** 状态库降级期间直接发送的消息，恢复后补写。 */
  private readonly direct = new Map<string, DirectSent>();

  constructor(
    private readonly store: NotifyStore,
    readonly adapters: readonly ChannelAdapter[],
    private readonly source: MessageSource,
    private readonly interactions: Interactions,
    private readonly metrics: ServerMetrics,
    private readonly opts: EngineOptions,
  ) {
    for (const a of adapters) {
      this.limiters.set(a.channel, new ChannelLimiter(a.limits, opts.now()));
    }
  }

  limiter(channel: string): ChannelLimiter {
    const l = this.limiters.get(channel);
    if (!l) {
      throw new Error(`没有渠道 ${channel} 的限速器`);
    }
    return l;
  }

  async syncOnce(): Promise<void> {
    const now = new Date(this.opts.now());
    await this.interactions.expire(now);
    const langs = new Set(this.adapters.flatMap((a) => a.chats.map((c) => c.language)));
    const desired = new Map<string, DesiredIncidentMessage[]>();
    for (const l of langs) {
      desired.set(l, await this.source.desired(l));
    }
    for (const a of this.adapters) {
      for (const chat of a.chats) {
        await this.syncChat(a, chat, desired.get(chat.language) ?? [], now);
      }
      this.metrics.notifyPending.set({ channel: a.channel }, await this.store.pendingCount(a.channel));
    }
  }

  private async syncChat(
    a: ChannelAdapter,
    chat: ChatTarget,
    desired: DesiredIncidentMessage[],
    now: Date,
  ): Promise<void> {
    const existing = await this.store.messages(a.channel, chat.chat, 'incident');
    const byIncident = new Map(existing.map((m) => [m.incidentId as string, m]));
    for (const m of existing) {
      if (m.externalId) {
        this.known.set(msgKey(a.channel, chat.chat, m.incidentId as string), {
          externalId: m.externalId,
          hash: m.deliveredHash,
        });
      }
    }
    const fresh = desired.filter((d) => !byIncident.has(d.incidentId));
    const active = await this.store.activeStorm(a.channel, chat.chat, new Date(now.getTime() - STORM_WINDOW_MS));
    const decision = decideStorm(
      now.getTime(),
      existing.map((m) => m.createdAt.getTime()),
      fresh.length,
      active !== null,
    );
    const stormOf = new Map<string, { id: number; startedAt: Date }>();
    let joining: { storm: { id: number; startedAt: Date }; ids: string[] } | null = null;
    if (decision === 'start') {
      const st = await this.store.createStorm(a.channel, chat.chat, now);
      const ids = [
        ...existing
          .filter((m) => m.stormId === null && m.createdAt.getTime() >= now.getTime() - STORM_WINDOW_MS)
          .map((m) => m.incidentId as string),
        ...fresh.map((d) => d.incidentId),
      ];
      joining = { storm: st, ids };
      logger.info('事件风暴开始', { channel: a.channel, chat: chat.chat, storm: st.id, new: fresh.length });
    } else if (decision === 'join' && active) {
      joining = { storm: active, ids: fresh.map((d) => d.incidentId) };
    }
    const storms = await this.store.recentStorms(
      a.channel,
      chat.chat,
      new Date(now.getTime() - this.opts.digestRetentionMs),
    );
    const stormById = new Map(storms.map((s) => [s.id, s]));
    if (joining) {
      stormById.set(joining.storm.id, joining.storm);
      for (const id of joining.ids) {
        stormOf.set(id, joining.storm);
      }
    }
    for (const m of existing) {
      const st = m.stormId !== null ? stormById.get(m.stormId) : undefined;
      if (st) {
        stormOf.set(m.incidentId as string, st);
      }
    }

    const rows: DesiredRow[] = [];
    const freshIds = new Set(fresh.map((d) => d.incidentId));
    for (const d of desired) {
      const ex = byIncident.get(d.incidentId);
      const results = await this.store.results(a.channel, chat.chat, d.incidentId, RESULTS_SHOWN);
      const storm = stormOf.get(d.incidentId) ?? null;
      const r = a.renderIncident(chat, d, results, storm, { callbacks: a.receivesCallbacks });
      await this.store.registerButtons(a.channel, chat.chat, r.buttons, now);
      rows.push({
        channel: a.channel,
        chat: chat.chat,
        kind: 'incident',
        subject: d.incidentId,
        incidentId: d.incidentId,
        stormId: storm?.id ?? null,
        lane: laneFor(d.lane, ex),
        silent: decision !== 'none' && freshIds.has(d.incidentId),
        payload: r.payload,
        hash: r.hash,
        proposalIds: proposalIds(d),
      });
    }
    await this.store.upsertDesired(rows, now);
    if (joining) {
      await this.store.joinStorm(joining.storm.id, joining.ids, now);
    }

    const byId = new Map(desired.map((d) => [d.incidentId, d]));
    const digests: DesiredRow[] = [];
    for (const st of stormById.values()) {
      const members = (await this.store.stormMembers(st.id))
        .map((id) => byId.get(id))
        .filter((d): d is DesiredIncidentMessage => d !== undefined);
      if (!members.length) {
        continue;
      }
      const input: DigestInput = {
        stormId: st.id,
        startedAt: st.startedAt,
        members: members.map((d) => ({
          incidentId: d.incidentId,
          label: d.label,
          severity: d.severity,
          state: d.state,
          title: d.message.title,
          pendingApprovals: new Set(
            d.targets.filter((x) => x.kind === 'approve' && x.proposalId).map((x) => x.proposalId),
          ).size,
        })),
        consoleUrl: this.opts.consoleUrl,
      };
      const r = a.renderDigest(chat, input);
      digests.push({
        channel: a.channel,
        chat: chat.chat,
        kind: 'digest',
        subject: String(st.id),
        incidentId: null,
        stormId: st.id,
        lane: 'digest',
        silent: false,
        payload: r.payload,
        hash: r.hash,
        proposalIds: [],
      });
    }
    await this.store.upsertDesired(digests, now);
  }

  /** 一轮投递；返回本轮发出或编辑的消息数。 */
  async deliverOnce(): Promise<number> {
    let n = 0;
    for (const a of this.adapters) {
      const limiter = this.limiter(a.channel);
      if (limiter.paused(this.opts.now()) !== null) {
        continue;
      }
      const rows = await this.store.pending(a.channel, new Date(this.opts.now()), 50);
      for (const row of rows) {
        const r = await this.deliverRow(a, limiter, row);
        if (r === 'sent') {
          n++;
        } else if (r === 'stop') {
          break;
        }
      }
    }
    return n;
  }

  private async deliverRow(
    a: ChannelAdapter,
    limiter: ChannelLimiter,
    row: MessageRow,
  ): Promise<'sent' | 'next' | 'stop'> {
    const now = this.opts.now();
    const chat = a.chats.find((c) => c.chat === row.chat);
    if (!chat) {
      // 渠道目标已从配置中删除：不再投递
      await this.store.markAttempt(row.id, new Date(now), new Date(now + 24 * 3_600_000), '渠道目标不在配置中');
      return 'next';
    }
    if (row.externalId !== null && row.deliveredAt && now < row.deliveredAt.getTime() + a.limits.editGapMs) {
      // 编辑合并：间隔不足时推迟，到时发送届时的最新内容
      await this.store.defer(row.id, new Date(row.deliveredAt.getTime() + a.limits.editGapMs));
      return 'next';
    }
    const slot = limiter.reserve(row.chat, now);
    if (!slot.ok) {
      await this.store.defer(row.id, new Date(slot.retryAt));
      return 'next';
    }
    let externalId = row.externalId;
    try {
      if (externalId === null) {
        externalId = await a.send(
          chat,
          row.payload,
          row.silent,
          `${row.channel}:${row.chat}:${row.kind}:${row.subject}:${row.desiredHash}`,
        );
        this.metrics.notifySent.inc({ channel: a.channel, op: 'send' });
      } else {
        await a.edit(chat, externalId, row.payload);
        this.metrics.notifySent.inc({ channel: a.channel, op: 'edit' });
      }
    } catch (e) {
      const cls = a.classify(e);
      if (cls.kind === 'not_modified' && externalId !== null) {
        // 内容与渠道上的消息相同，视为已呈现
      } else {
        this.metrics.notifyFailures.inc({ channel: a.channel });
        return this.failed(a, limiter, row, cls, e, now);
      }
    }
    const at = new Date(this.opts.now());
    await this.store.markDelivered(row.id, externalId, row.desiredHash, at);
    if (row.kind === 'incident') {
      this.known.set(msgKey(a.channel, row.chat, row.incidentId as string), { externalId, hash: row.desiredHash });
      // 每次发出或编辑成功都报告消息中的提议：后来加入已有消息（编辑）的提议也要开始计算 TTL。
      // 提议中转只记录每个提议第一次送达的时间，重复报告没有影响
      if (row.proposalIds.length) {
        await this.source.delivered(row.incidentId as string, row.proposalIds, at);
      }
    }
    return 'sent';
  }

  private async failed(
    a: ChannelAdapter,
    limiter: ChannelLimiter,
    row: MessageRow,
    cls: ReturnType<ChannelAdapter['classify']>,
    e: unknown,
    now: number,
  ): Promise<'next' | 'stop'> {
    const msg = (e as Error).message;
    switch (cls.kind) {
      case 'rate_limited':
        limiter.pause(now + cls.retryAfterMs);
        await this.store.defer(row.id, new Date(now + cls.retryAfterMs));
        logger.warn('渠道限流，暂停发送', { channel: a.channel, retry_after_ms: cls.retryAfterMs });
        return 'stop';
      case 'transport':
        await this.store.markAttempt(row.id, new Date(now), new Date(now + TRANSPORT_RETRY_MS), msg);
        logger.warn('渠道不可达，消息保留在库中', { channel: a.channel, error: msg });
        return 'stop';
      case 'target_gone':
        await this.store.forgetExternal(row.id, new Date(now), msg);
        logger.warn('要编辑的消息已不存在，改为重新发送', { channel: a.channel, chat: row.chat, subject: row.subject });
        return 'next';
      case 'not_modified':
      case 'api':
        await this.store.markAttempt(row.id, new Date(now), new Date(now + API_ERROR_RETRY_MS), msg);
        logger.error('渠道拒绝了消息', { channel: a.channel, chat: row.chat, subject: row.subject, error: msg });
        return 'next';
      case 'fatal':
        throw new NotifyFatalError(`${a.channel} 渠道配置或凭据错误：${msg}`);
    }
  }

  /**
   * 状态库不可用时直接发送（DESIGN §7.1）：不经过 notify_messages，不登记按钮，只保留 URL 按钮；
   * 已知渠道消息 id 时编辑原消息。返回发出或编辑的消息数。
   */
  async sendDirect(msg: DesiredIncidentMessage): Promise<number> {
    let n = 0;
    for (const a of this.adapters) {
      const limiter = this.limiter(a.channel);
      for (const chat of a.chats.filter((c) => c.language === msg.language)) {
        const key = msgKey(a.channel, chat.chat, msg.incidentId);
        const r = a.renderIncident(chat, msg, [], null, { callbacks: false });
        const prev = this.direct.get(key)?.externalId ?? this.known.get(key)?.externalId ?? null;
        if (this.direct.get(key)?.row.hash === r.hash || (prev !== null && this.known.get(key)?.hash === r.hash)) {
          continue;
        }
        const now = this.opts.now();
        const slot = limiter.reserve(chat.chat, now);
        if (!slot.ok) {
          continue;
        }
        let externalId: string;
        try {
          if (prev !== null) {
            await a.edit(chat, prev, r.payload);
            externalId = prev;
          } else {
            externalId = await a.send(
              chat,
              r.payload,
              false,
              `${a.channel}:${chat.chat}:incident:${msg.incidentId}:${r.hash}`,
            );
          }
        } catch (e) {
          const cls = a.classify(e);
          if (cls.kind === 'target_gone') {
            externalId = await a.send(
              chat,
              r.payload,
              false,
              `${a.channel}:${chat.chat}:incident:${msg.incidentId}:${r.hash}`,
            );
          } else if (cls.kind === 'not_modified' && prev !== null) {
            externalId = prev;
          } else if (cls.kind === 'rate_limited') {
            limiter.pause(now + cls.retryAfterMs);
            continue;
          } else if (cls.kind === 'fatal') {
            throw new NotifyFatalError(`${a.channel} 渠道配置或凭据错误：${(e as Error).message}`);
          } else {
            throw e;
          }
        }
        const at = new Date(this.opts.now());
        this.direct.set(key, {
          externalId,
          at,
          row: {
            channel: a.channel,
            chat: chat.chat,
            kind: 'incident',
            subject: msg.incidentId,
            incidentId: msg.incidentId,
            stormId: null,
            lane: msg.lane,
            silent: false,
            payload: r.payload,
            hash: r.hash,
            proposalIds: proposalIds(msg),
          },
        });
        this.known.set(key, { externalId, hash: r.hash });
        this.metrics.notifySent.inc({ channel: a.channel, op: prev !== null ? 'edit' : 'send' });
        n++;
      }
    }
    return n;
  }

  /** 状态库恢复后补写降级期间直接发送的消息；之后的同步按期望状态编辑这些消息（补上按钮）。 */
  async backfill(): Promise<number> {
    let n = 0;
    for (const [key, d] of this.direct) {
      await this.store.backfillDelivered(d.row, d.externalId, d.at);
      await this.source.delivered(d.row.incidentId as string, d.row.proposalIds, d.at);
      this.direct.delete(key);
      n++;
    }
    return n;
  }

  get directPending(): number {
    return this.direct.size;
  }
}

function laneFor(lane: Lane, existing: MessageRow | undefined): Lane {
  if (!existing?.externalId) {
    return lane;
  }
  return lane === 'urgent' || lane === 'recovery' ? lane : 'edit';
}

function proposalIds(d: DesiredIncidentMessage): string[] {
  return [...new Set(d.targets.map((x) => x.proposalId).filter((x): x is string => x !== null))];
}
