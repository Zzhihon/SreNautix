import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { FeishuAdapter } from '../channels/feishu/adapter.js';
import { registerFeishuCallback } from '../channels/feishu/callback.js';
import { FeishuClient } from '../channels/feishu/client.js';
import { ButtonSigner } from '../channels/feishu/render.js';
import { TelegramAdapter } from '../channels/telegram/adapter.js';
import { TelegramClient } from '../channels/telegram/client.js';
import { TelegramUpdates } from '../channels/telegram/updates.js';
import { parseDuration, readSecretFile } from '../config/files.js';
import type { ServerConfig } from '../config/server.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import type { ChannelAdapter } from './channel.js';
import { NotifyEngine, NotifyFatalError } from './engine.js';
import { Interactions } from './interactions.js';
import type { DesiredIncidentMessage, MessageSource, NotifyActions } from './ports.js';
import { NotifyStore } from './store.js';

export { notifyTrack } from './migrations.js';
export { NotifyFatalError } from './engine.js';
export type * from './ports.js';

export interface NotifyDeps {
  pool: pg.Pool;
  config: ServerConfig['notify'];
  publicUrl: string;
  source: MessageSource;
  actions: NotifyActions;
  metrics: ServerMetrics;
  /** 同步、投递与 Telegram 长轮询只在主实例上运行；回调路由在每个副本上都可以处理。 */
  isLeader: () => boolean;
  /** 成为主实例时 resolve（Leader.acquired）；启动时还不是主实例时，成为主实例之后注册 Telegram webhook */
  acquired?: () => Promise<void>;
  now?: () => number;
}

/** 同步与投递的周期：同步每 5 秒（状态变化时立即），投递每秒（同步后立即）。 */
export const SYNC_INTERVAL_MS = 5_000;
export const DELIVER_INTERVAL_MS = 1_000;

/** 飞书按钮回调值的 HMAC 密钥由应用密钥派生，轮换应用密钥后旧卡片的按钮失效。 */
export function feishuButtonKey(appSecret: string): Buffer {
  return createHash('sha256').update(`srenautix/feishu/button\0${appSecret}`).digest();
}

class Kicker {
  private wake: (() => void) | null = null;
  private pending = false;

  kick(): void {
    this.pending = true;
    this.wake?.();
  }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(tm);
        this.wake = null;
        this.pending = false;
        resolve();
      };
      const tm = setTimeout(done, ms);
      this.wake = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

/**
 * 通知服务（DESIGN §11）：一个事件一条消息、就地编辑；每个渠道一个令牌桶并按优先级通道发送；
 * 发送队列持久化在 notify_messages；状态库不可用时由阶段 A 通道调用 sendDirect 直接发送，恢复后 backfill。
 */
export class NotifyService {
  readonly store: NotifyStore;
  readonly interactions: Interactions;
  readonly engine: NotifyEngine;
  readonly telegram: {
    adapter: TelegramAdapter;
    updates: TelegramUpdates;
    mode: 'none' | 'webhook' | 'polling';
    secret: string | null;
  } | null = null;
  readonly feishu: {
    adapter: FeishuAdapter;
    client: FeishuClient;
    encryptKey: string | null;
    verificationToken: string;
    autoLink: boolean;
  } | null = null;
  private readonly syncKick = new Kicker();
  private readonly deliverKick = new Kicker();
  private readonly loops: Array<Promise<void>> = [];
  private abort: AbortController | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: NotifyDeps) {
    this.now = deps.now ?? Date.now;
    this.store = new NotifyStore(deps.pool);
    this.interactions = new Interactions(this.store, deps.actions, deps.metrics, () => this.syncNow());
    const adapters: ChannelAdapter[] = [];
    const tg = deps.config.telegram;
    let tgAdapter: TelegramAdapter | null = null;
    if (tg?.enabled) {
      const client = new TelegramClient(
        tg.api_base.replace(/\/+$/, ''),
        readSecretFile('notify.telegram.bot_token_file', tg.bot_token_file),
      );
      const chats = tg.chats.map((c) => ({ channel: 'telegram' as const, chat: String(c.id), language: c.language }));
      tgAdapter = new TelegramAdapter(
        client,
        chats,
        {
          perChatPerMinute: tg.messages_per_minute,
          perAppPerMinute: null,
          perAppPerSecond: null,
          editGapMs: parseDuration('notify.telegram.edit_gap', tg.edit_gap),
        },
        deps.config.prefix,
        tg.updates !== 'none',
      );
      adapters.push(tgAdapter);
    }
    const fs = deps.config.feishu;
    if (fs?.enabled) {
      const appSecret = readSecretFile('notify.feishu.app_secret_file', fs.app_secret_file);
      const client = new FeishuClient(fs.api_base.replace(/\/+$/, ''), fs.app_id, appSecret);
      const chats = fs.chats.map((c) => ({ channel: 'feishu' as const, chat: c.chat_id, language: c.language }));
      const adapter = new FeishuAdapter(
        client,
        chats,
        {
          perChatPerMinute: fs.messages_per_minute,
          perAppPerMinute: fs.messages_per_minute,
          perAppPerSecond: fs.messages_per_second,
          editGapMs: parseDuration('notify.feishu.edit_gap', fs.edit_gap),
        },
        deps.config.prefix,
        new ButtonSigner(feishuButtonKey(appSecret)),
      );
      adapters.push(adapter);
      this.feishu = {
        adapter,
        client,
        encryptKey: fs.encrypt_key_file ? readSecretFile('notify.feishu.encrypt_key_file', fs.encrypt_key_file) : null,
        verificationToken: readSecretFile('notify.feishu.verification_token_file', fs.verification_token_file),
        autoLink: fs.auto_link_union_id,
      };
    }
    this.engine = new NotifyEngine(this.store, adapters, deps.source, this.interactions, deps.metrics, {
      prefix: deps.config.prefix,
      consoleUrl: deps.publicUrl,
      digestRetentionMs: parseDuration('notify.resolved_retention', deps.config.resolved_retention),
      externalDigestPeriodMs: deps.config.digest.external_roots.enabled
        ? parseDuration('notify.digest.external_roots.period', deps.config.digest.external_roots.period)
        : null,
      isLeader: deps.isLeader,
      now: this.now,
    });
    if (tg?.enabled && tgAdapter) {
      this.telegram = {
        adapter: tgAdapter,
        mode: tg.updates,
        secret:
          tg.updates === 'webhook'
            ? readSecretFile('notify.telegram.webhook_secret_file', tg.webhook_secret_file as string)
            : null,
        updates: new TelegramUpdates({
          client: tgAdapter.client,
          store: this.store,
          interactions: this.interactions,
          limiter: this.engine.limiter('telegram'),
          metrics: deps.metrics,
          chats: new Map(tgAdapter.chats.map((c) => [c.chat, c.language])),
          now: this.now,
        }),
      };
    }
  }

  registerRoutes(app: FastifyInstance): void {
    if (this.telegram?.mode === 'webhook') {
      this.telegram.updates.registerWebhook(app, this.telegram.secret as string);
    }
    if (this.feishu) {
      registerFeishuCallback(app, {
        encryptKey: this.feishu.encryptKey,
        verificationToken: this.feishu.verificationToken,
        signer: this.feishu.adapter.signer,
        chats: new Set(this.feishu.adapter.chats.map((c) => c.chat)),
        interactions: this.interactions,
        actions: this.deps.actions,
        store: this.store,
        client: this.feishu.client,
        autoLinkUnionId: this.feishu.autoLink,
        now: this.now,
      });
    }
  }

  /** 启动同步、投递与（长轮询模式下的）Telegram 更新循环。渠道配置错误时循环抛出 NotifyFatalError。 */
  async start(signal: AbortSignal): Promise<void> {
    this.abort = new AbortController();
    const s = AbortSignal.any([signal, this.abort.signal]);
    if (this.telegram?.mode === 'webhook') {
      const tg = this.telegram;
      // 主实例注册 webhook：成为主实例（含数据修正完成，ADR 0176）之后注册
      const register = () => tg.updates.setWebhook(this.deps.publicUrl, tg.secret as string);
      if (this.deps.isLeader()) {
        await register();
      } else if (this.deps.acquired) {
        void this.deps
          .acquired()
          .then(() => (s.aborted ? undefined : register()))
          .catch((e: unknown) => logger.error('注册 Telegram webhook 失败', { error: e }));
      }
    }
    this.loops.push(
      this.loop(s, this.syncKick, SYNC_INTERVAL_MS, async () => {
        await this.engine.syncOnce();
        this.deliverKick.kick();
      }),
    );
    this.loops.push(
      this.loop(s, this.deliverKick, DELIVER_INTERVAL_MS, async () => void (await this.engine.deliverOnce())),
    );
    if (this.telegram?.mode === 'polling') {
      this.loops.push(this.telegram.updates.pollLoop(s, this.deps.isLeader));
    }
  }

  private async loop(signal: AbortSignal, kicker: Kicker, intervalMs: number, fn: () => Promise<void>): Promise<void> {
    while (!signal.aborted) {
      if (this.deps.isLeader()) {
        try {
          await fn();
        } catch (e) {
          if (e instanceof NotifyFatalError) {
            throw e;
          }
          logger.error('通知循环失败，下一轮重试', { error: e });
        }
      }
      await kicker.wait(intervalMs, signal);
    }
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await Promise.allSettled(this.loops);
  }

  /** 事件、提议或反馈变化后立即同步一次。 */
  syncNow(): void {
    this.syncKick.kick();
  }

  sendDirect(msg: DesiredIncidentMessage): Promise<number> {
    return this.engine.sendDirect(msg);
  }

  backfill(): Promise<number> {
    return this.engine.backfill();
  }
}
