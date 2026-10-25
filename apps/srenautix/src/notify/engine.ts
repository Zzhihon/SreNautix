import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import {
  RENDER_VERSION,
  type ChannelAdapter,
  type ChatTarget,
  type DigestInput,
  type PermanentReason,
} from './channel.js';
import { composeExternalDigest, lastWindow, type ExternalWindowStats } from './external.js';
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
  /** 外部上游周期汇总的周期（ADR 0147）；没有或为 null 时不汇总 */
  externalDigestPeriodMs?: number | null;
  now: () => number;
}

/** Telegram 不可达时多久重试；Bot API 拒绝某条消息（其他 4xx）时多久重试。 */
const TRANSPORT_RETRY_MS = 15_000;
const API_ERROR_RETRY_MS = 5 * 60_000;
const RESULTS_SHOWN = 5;
/**
 * 已结束（恢复或合并）事件的消息最多再编辑这么多次（渠道作出了应答的编辑，含被拒绝的），用完后放弃之后的内容（ADR 0145）。
 * 恢复后的编辑只是补上结果与反馈，不值得无限重试
 */
export const MAX_ENDED_EDITS = 5;
/** 外部上游汇总在周期结束这么久之后才统计（ADR 0147） */
export const EXTERNAL_DIGEST_GRACE_MS = 60_000;

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
  /** 本进程是否已经重新渲染过旧渲染器产出的期望内容（启动后第一次同步时做一次） */
  private staleRendered = false;

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
    if (!this.staleRendered) {
      await this.rerenderStale(now);
      this.staleRendered = true;
    }
    const langs = new Set(this.adapters.flatMap((a) => a.chats.map((c) => c.language)));
    const desired = new Map<string, DesiredIncidentMessage[]>();
    for (const l of langs) {
      desired.set(l, await this.source.desired(l));
    }
    for (const a of this.adapters) {
      for (const chat of a.chats) {
        await this.syncChat(a, chat, desired.get(chat.language) ?? [], now);
      }
    }
    await this.syncExternalDigest(now);
    for (const a of this.adapters) {
      this.metrics.notifyPending.set({ channel: a.channel }, await this.store.pendingCount(a.channel));
    }
  }

  /**
   * 外部上游的周期汇总（ADR 0147）：上一个完整周期 [from, to) 结束后，统计一次并存库（同一周期只统计一次），
   * 有外部上游出过问题时每个渠道目标发一条汇总消息，之后不再编辑。周期结束超过半个周期（例如进程停了）的时段不再补发
   */
  private async syncExternalDigest(now: Date): Promise<void> {
    const period = this.opts.externalDigestPeriodMs;
    if (!period || !this.source.externalWindow) {
      return;
    }
    const { from, to } = lastWindow(now.getTime(), period);
    // 周期结束后等一会儿，让周期末尾的告警与事件写进库；结束太久的时段不再补发
    if (now.getTime() - to < EXTERNAL_DIGEST_GRACE_MS || now.getTime() - to > period / 2) {
      return;
    }
    const statsOf = async (f: number, t: number): Promise<ExternalWindowStats> =>
      (await this.store.externalWindow(new Date(f))) ??
      (await this.store.saveExternalWindow(await this.source.externalWindow!(new Date(f), new Date(t)), now));
    const cur = await statsOf(from, to);
    if (!cur.roots.length) {
      return;
    }
    const prev = await statsOf(from - period, from);
    const subject = new Date(from).toISOString();
    const rows: DesiredRow[] = [];
    for (const a of this.adapters) {
      for (const chat of a.chats) {
        if (await this.store.hasMessage(a.channel, chat.chat, 'external_digest', subject)) {
          continue;
        }
        const view = composeExternalDigest(cur, prev, chat.language, this.opts.consoleUrl);
        const r = a.renderExternalDigest(chat, view);
        rows.push({
          channel: a.channel,
          chat: chat.chat,
          kind: 'external_digest',
          subject,
          incidentId: null,
          stormId: null,
          lane: 'digest',
          // 汇总不打扰：静默发送
          silent: true,
          payload: r.payload,
          hash: r.hash,
          proposalIds: [],
        });
      }
    }
    if (rows.length) {
      logger.info('外部上游汇总', { from: subject, roots: cur.roots.length, chats: rows.length });
      await this.store.upsertDesired(rows, now);
    }
  }

  private async syncChat(a: ChannelAdapter, chat: ChatTarget, all: DesiredIncidentMessage[], now: Date): Promise<void> {
    const existing = await this.store.messages(a.channel, chat.chat, 'incident');
    const byIncident = new Map(existing.map((m) => [m.incidentId as string, m]));
    // 外部上游的事件进入周期汇总，不单独发消息；之前已经发出的消息照常编辑（ADR 0147）
    const desired = all.filter((d) => d.digest !== 'external' || byIncident.has(d.incidentId));
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
        ended: d.state !== 'firing',
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
      const r = a.renderDigest(chat, this.digestInput(st, members));
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

  private digestInput(st: { id: number; startedAt: Date }, members: DesiredIncidentMessage[]): DigestInput {
    return {
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
  }

  /**
   * 启动后第一次同步之前：旧版本渲染器产出、还没有呈现、没有被放弃的期望内容按当前代码重新渲染（ADR 0145）。
   * 同步只渲染还需要消息的事件，恢复后超过保留期的事件不会再被同步，它们的旧内容（例如超出实体预算的）只能在这里换掉。
   * 已结束的事件照样渲染（用已结束状态的模板）；事件、风暴或时间段统计已经不存在的行保持原样。
   */
  private async rerenderStale(now: Date): Promise<void> {
    const stale = await this.store.staleDesired(RENDER_VERSION);
    if (!stale.length) {
      return;
    }
    for (const a of this.adapters) {
      for (const chat of a.chats) {
        const rows = stale.filter((m) => m.channel === a.channel && m.chat === chat.chat);
        if (!rows.length) {
          continue;
        }
        const ids = new Set<string>();
        for (const m of rows) {
          if (m.kind === 'incident') {
            ids.add(m.incidentId as string);
          } else if (m.kind === 'digest' && m.stormId !== null) {
            for (const id of await this.store.stormMembers(m.stormId)) {
              ids.add(id);
            }
          }
        }
        const msgs = ids.size && this.source.byIds ? await this.source.byIds([...ids], chat.language) : [];
        const byId = new Map(msgs.map((d) => [d.incidentId, d]));
        const out: DesiredRow[] = [];
        for (const m of rows) {
          const r = await this.rerender(a, chat, m, byId, now);
          if (r) {
            out.push(r);
          }
        }
        await this.store.upsertDesired(out, now);
        logger.info('按当前渲染器重新渲染旧的期望内容', {
          channel: a.channel,
          chat: chat.chat,
          render_version: RENDER_VERSION,
          rerendered: out.length,
          skipped: rows.length - out.length,
        });
      }
    }
  }

  private async rerender(
    a: ChannelAdapter,
    chat: ChatTarget,
    m: MessageRow,
    byId: ReadonlyMap<string, DesiredIncidentMessage>,
    now: Date,
  ): Promise<DesiredRow | null> {
    const base = {
      channel: a.channel,
      chat: chat.chat,
      kind: m.kind,
      subject: m.subject,
      incidentId: m.incidentId,
      stormId: m.stormId,
      silent: m.silent,
    };
    if (m.kind === 'incident') {
      const d = byId.get(m.incidentId as string);
      if (!d) {
        return null;
      }
      const results = await this.store.results(a.channel, chat.chat, d.incidentId, RESULTS_SHOWN);
      const storm = m.stormId !== null ? await this.store.storm(m.stormId) : null;
      const r = a.renderIncident(chat, d, results, storm, { callbacks: a.receivesCallbacks });
      await this.store.registerButtons(a.channel, chat.chat, r.buttons, now);
      return {
        ...base,
        lane: laneFor(d.lane, m),
        payload: r.payload,
        hash: r.hash,
        proposalIds: proposalIds(d),
        ended: d.state !== 'firing',
      };
    }
    if (m.kind === 'digest') {
      const st = m.stormId !== null ? await this.store.storm(m.stormId) : null;
      if (!st) {
        return null;
      }
      const members = (await this.store.stormMembers(st.id))
        .map((id) => byId.get(id))
        .filter((d): d is DesiredIncidentMessage => d !== undefined);
      if (!members.length) {
        return null;
      }
      const r = a.renderDigest(chat, this.digestInput(st, members));
      return { ...base, lane: 'digest', payload: r.payload, hash: r.hash, proposalIds: [] };
    }
    const cur = await this.store.externalWindow(new Date(m.subject));
    if (!cur) {
      return null;
    }
    const from = Date.parse(cur.from);
    const prev = await this.store.externalWindow(new Date(from - (Date.parse(cur.to) - from)));
    const r = a.renderExternalDigest(chat, composeExternalDigest(cur, prev, chat.language, this.opts.consoleUrl));
    return { ...base, lane: 'digest', payload: r.payload, hash: r.hash, proposalIds: [] };
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
    const edit = row.externalId !== null;
    if (edit && row.ended && row.endedEdits >= MAX_ENDED_EDITS) {
      // 已结束事件的消息编辑次数用完：放弃这一版内容，不再请求渠道
      await this.abandon(a, row, 'ended_edit_cap', `事件结束后已编辑 ${row.endedEdits} 次`, now);
      return 'next';
    }
    if (edit && row.deliveredAt && now < row.deliveredAt.getTime() + a.limits.editGapMs) {
      // 编辑合并：间隔不足时推迟，到时发送届时的最新内容
      await this.store.defer(row.id, new Date(row.deliveredAt.getTime() + a.limits.editGapMs));
      return 'next';
    }
    const slot = limiter.reserve(row.chat, now);
    if (!slot.ok) {
      await this.store.defer(row.id, new Date(slot.retryAt));
      return 'next';
    }
    let externalId: string;
    try {
      externalId = await this.push(a, chat, row, row.payload, '');
    } catch (e) {
      const cls = a.classify(e);
      if (cls.kind === 'not_modified' && edit) {
        // 内容与渠道上的消息相同，视为已呈现
        externalId = row.externalId as string;
      } else if (cls.kind === 'permanent') {
        const r = await this.degrade(a, limiter, chat, row, cls.reason, e);
        if (!('id' in r)) {
          return r.outcome;
        }
        externalId = r.id;
      } else {
        this.metrics.notifyFailures.inc({ channel: a.channel });
        return this.failed(a, limiter, row, cls, e, now);
      }
    }
    const at = new Date(this.opts.now());
    const first = await this.store.markDelivered(row.id, externalId, row.desiredHash, at, edit);
    if (row.kind === 'incident' && first && this.source.firstMessage) {
      const f = await this.source.firstMessage(row.incidentId as string, row.id, at);
      if (f) {
        this.metrics.firstMessageLatency.observe(
          { business_impact: String(f.businessImpact), origin: f.origin },
          Math.max(0, (at.getTime() - f.onsetMs) / 1000),
        );
      }
    }
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

  /** 发出或编辑一条消息，返回渠道消息 id。variant 区分纯文本降级的发送请求（飞书按请求 uuid 去重）。 */
  private async push(
    a: ChannelAdapter,
    chat: ChatTarget,
    row: MessageRow,
    payload: unknown,
    variant: '' | ':plain',
  ): Promise<string> {
    if (row.externalId === null) {
      const id = await a.send(
        chat,
        payload,
        row.silent,
        `${row.channel}:${row.chat}:${row.kind}:${row.subject}:${row.desiredHash}${variant}`,
      );
      this.metrics.notifySent.inc({ channel: a.channel, op: 'send' });
      return id;
    }
    await a.edit(chat, row.externalId, payload);
    this.metrics.notifySent.inc({ channel: a.channel, op: 'edit' });
    return row.externalId;
  }

  /**
   * 渠道以永久错误拒绝了内容（ADR 0145）：去掉实体，按纯文本重试一次。成功时返回渠道消息 id，这一版期望内容以纯文本呈现；
   * 仍是永久错误或无法降级时放弃这一版内容；其他错误（不可达、限流、要编辑的消息不存在）按普通失败处理，下一轮从原内容重试。
   * 永久错误不计入投递失败。
   */
  private async degrade(
    a: ChannelAdapter,
    limiter: ChannelLimiter,
    chat: ChatTarget,
    row: MessageRow,
    reason: PermanentReason,
    first: unknown,
  ): Promise<{ id: string } | { outcome: 'next' | 'stop' }> {
    const now = this.opts.now();
    const firstMsg = (first as Error).message;
    const plain = a.plain(row.payload);
    if (plain === null) {
      await this.abandon(a, row, reason, firstMsg, now);
      return { outcome: 'next' };
    }
    const slot = limiter.reserve(row.chat, now);
    if (!slot.ok) {
      await this.store.defer(row.id, new Date(slot.retryAt));
      return { outcome: 'next' };
    }
    try {
      const id = await this.push(a, chat, row, plain, ':plain');
      logger.warn('渠道拒绝了消息内容，已改为纯文本', {
        channel: a.channel,
        chat: row.chat,
        kind: row.kind,
        subject: row.subject,
        reason,
        error: firstMsg,
      });
      return { id };
    } catch (e) {
      const cls = a.classify(e);
      if (cls.kind === 'not_modified' && row.externalId !== null) {
        return { id: row.externalId };
      }
      if (cls.kind === 'permanent') {
        await this.abandon(a, row, reason, `${firstMsg}；纯文本：${(e as Error).message}`, now);
        return { outcome: 'next' };
      }
      this.metrics.notifyFailures.inc({ channel: a.channel });
      return { outcome: await this.failed(a, limiter, row, cls, e, now) };
    }
  }

  /** 放弃这一版期望内容：不再重试，不计入投递失败；期望内容变化后重新进入待投递。 */
  private async abandon(
    a: ChannelAdapter,
    row: MessageRow,
    reason: PermanentReason | 'ended_edit_cap',
    error: string,
    now: number,
  ): Promise<void> {
    if (!(await this.store.abandon(row.id, row.desiredHash, new Date(now), reason, error))) {
      // 期望内容刚被同步更新：下一轮投递新内容
      return;
    }
    this.metrics.notifyAbandoned.inc({ channel: a.channel, reason });
    logger.error('放弃投递这条消息内容，不再重试', {
      channel: a.channel,
      chat: row.chat,
      kind: row.kind,
      subject: row.subject,
      reason,
      error,
    });
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
      case 'permanent':
      case 'api':
        // 渠道应答了这次编辑（拒绝），已结束事件的编辑计数加一
        await this.store.markAttempt(
          row.id,
          new Date(now),
          new Date(now + API_ERROR_RETRY_MS),
          msg,
          row.externalId !== null,
        );
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
