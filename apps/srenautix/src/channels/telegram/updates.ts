import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { unauthorized } from '../../api/errors.js';
import { logger } from '../../log.js';
import type { ServerMetrics } from '../../metrics.js';
import { DISPOSITIONS, type ClickResult, type Interactions } from '../../notify/interactions.js';
import type { ChannelLimiter } from '../../notify/ratelimit.js';
import { shortId } from '../../notify/shortid.js';
import type { NotifyStore } from '../../notify/store.js';
import { t } from '../../notify/text.js';
import { ALLOWED_UPDATES, TelegramApiError, TelegramTransportError, type TelegramClient } from './client.js';
import { CALLBACK_PREFIX } from './render.js';
import type { SendMessageParams, TgCallbackQuery, TgEntity, TgMessage, TgUpdate, TgUser } from './types.js';

export const WEBHOOK_PATH = '/v1/channels/telegram/webhook';
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const LINK = /^\/link(?:@\w+)?\s+(\S+)\s*$/;

export interface TelegramUpdatesDeps {
  client: TelegramClient;
  store: NotifyStore;
  interactions: Interactions;
  limiter: ChannelLimiter;
  metrics: ServerMetrics;
  /** 配置的群；其他群的更新一律不处理（私聊只接受 /link）。 */
  chats: ReadonlyMap<string, 'zh' | 'en'>;
  now: () => number;
}

function displayName(u: TgUser): string {
  return u.username ? `@${u.username}` : `${u.first_name}${u.last_name ? ` ${u.last_name}` : ''}`;
}

/**
 * 提示消息开头的提及：有用户名时 @用户名，否则 text_mention。ForceReply 的 selective 只对提及的用户弹出回复框，
 * 所以提示以提及点击者开头，并且不回复机器人自己的事件消息。
 */
function mention(u: TgUser): { text: string; entity: TgEntity } {
  if (u.username) {
    const text = `@${u.username}`;
    return { text, entity: { type: 'mention', offset: 0, length: text.length } };
  }
  const text = displayName(u);
  return { text, entity: { type: 'text_mention', offset: 0, length: text.length, user: u } };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const tm = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(tm);
        resolve();
      },
      { once: true },
    );
  });

/** Telegram 的更新处理：按钮回调、对提示消息的回复、/link。webhook 与长轮询共用。 */
export class TelegramUpdates {
  constructor(private readonly d: TelegramUpdatesDeps) {}

  async handle(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      await this.callback(u.callback_query);
    } else if (u.message) {
      await this.message(u.message);
    }
  }

  /** 交互消息（提示、选择、/link 的回复）占用群的发送令牌，没有令牌时等待。 */
  private async sendInteractive(p: SendMessageParams): Promise<TgMessage> {
    for (;;) {
      const slot = this.d.limiter.reserve(String(p.chat_id), this.d.now());
      if (slot.ok) {
        break;
      }
      await sleep(slot.retryAt - this.d.now());
    }
    const m = await this.d.client.sendMessage(p);
    this.d.metrics.notifySent.inc({ channel: 'telegram', op: 'prompt' });
    return m;
  }

  private async answer(id: string, text: string): Promise<void> {
    try {
      await this.d.client.answerCallbackQuery({ callback_query_id: id, text });
    } catch (e) {
      // 回调已过期时再应答也不会成功，按钮操作照常进行
      if (!(e instanceof TelegramApiError && e.queryExpired)) {
        throw e;
      }
    }
  }

  private async callback(cq: TgCallbackQuery): Promise<void> {
    const chat = cq.message ? String(cq.message.chat.id) : '';
    if (!this.d.chats.has(chat)) {
      return;
    }
    const data = cq.data ?? '';
    if (!data.startsWith(CALLBACK_PREFIX)) {
      await this.answer(cq.id, '按钮无效');
      return;
    }
    const res = await this.d.interactions.click({
      channel: 'telegram',
      chat,
      callbackId: cq.id,
      channelUserId: String(cq.from.id),
      displayName: displayName(cq.from),
      shortId: data.slice(CALLBACK_PREFIX.length),
      form: null,
      at: new Date(this.d.now()),
    });
    // 先应答，客户端不会长时间转圈；之后再调用 server 的操作
    await this.answer(cq.id, res.answer);
    await this.followUp(chat, cq.from, res);
  }

  private async followUp(chat: string, from: TgUser, res: ClickResult): Promise<void> {
    const lang = this.d.chats.get(chat) ?? 'zh';
    if (res.type === 'run') {
      await res.run();
    } else if (res.type === 'prompt') {
      const m = mention(from);
      const until = `${res.expiresAt.toISOString().slice(11, 16)} UTC`;
      const text =
        res.purpose === 'reject_reason'
          ? `${m.text}，请回复本消息填写拒绝原因（${until} 前有效，不回复则不提交）。`
          : `${m.text}，请回复本消息填写真实根因组件，可选：${res.button.target.choices.join('、') || '（无）'}；不知道时回复 -（${until} 前有效）。`;
      const msg = await this.sendInteractive({
        chat_id: Number(chat),
        text,
        entities: [m.entity],
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: res.purpose === 'reject_reason' ? '拒绝原因' : '组件 原因',
        },
      });
      await this.d.store.setPrompt(res.replyId, String(msg.message_id));
    } else if (res.type === 'choose') {
      const owner = String(from.id);
      const buttons = DISPOSITIONS.map((disp) => {
        const target = { ...res.button.target, key: `pick:${disp}`, disposition: disp };
        return {
          shortId: shortId('telegram', chat, 'disposition_pick', target, owner),
          kind: 'disposition_pick',
          target,
          owner,
        };
      });
      await this.d.store.registerButtons('telegram', chat, buttons, new Date(this.d.now()));
      const m = mention(from);
      await this.sendInteractive({
        chat_id: Number(chat),
        text: `${m.text}，请选择正确的处置判断：`,
        entities: [m.entity],
        reply_markup: {
          inline_keyboard: [
            buttons.map((b) => ({
              text: t.disposition(lang, b.target.disposition as string),
              callback_data: CALLBACK_PREFIX + b.shortId,
            })),
          ],
        },
      });
    }
  }

  private async message(msg: TgMessage): Promise<void> {
    const chat = String(msg.chat.id);
    const allowed = this.d.chats.has(chat);
    const text = msg.text ?? '';
    const link = LINK.exec(text.trim());
    if (link && msg.from && (allowed || msg.chat.type === 'private')) {
      const reply = await this.d.interactions.link('telegram', String(msg.from.id), link[1] as string);
      await this.sendInteractive({
        chat_id: msg.chat.id,
        text: reply,
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      });
      return;
    }
    if (!allowed || !msg.reply_to_message || !msg.from) {
      return;
    }
    const r = await this.d.interactions.reply({
      channel: 'telegram',
      chat,
      promptMessageId: String(msg.reply_to_message.message_id),
      channelUserId: String(msg.from.id),
      text,
      at: new Date(this.d.now()),
    });
    if (typeof r === 'string') {
      await this.sendInteractive({
        chat_id: msg.chat.id,
        text: r,
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      });
    }
  }

  /** webhook 模式：Telegram 推送更新，X-Telegram-Bot-Api-Secret-Token 必须等于 setWebhook 时给出的 secret_token。 */
  registerWebhook(app: FastifyInstance, secret: string): void {
    const want = Buffer.from(secret);
    app.post(WEBHOOK_PATH, async (req, reply) => {
      const got = req.headers[SECRET_HEADER];
      const g = Buffer.from(typeof got === 'string' ? got : '');
      if (g.length !== want.length || !timingSafeEqual(g, want)) {
        throw unauthorized('webhook secret 不匹配');
      }
      await this.handle(req.body as TgUpdate);
      return reply.send({});
    });
  }

  async setWebhook(publicUrl: string, secret: string): Promise<void> {
    await this.d.client.setWebhook({
      url: `${publicUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`,
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
    });
  }

  /**
   * 长轮询模式（只在主实例上运行）：处理完一个更新就把 offset 写进库，重启不会重放已处理的更新。
   * token 无效、另有 webhook 或另一个 getUpdates 使用同一个 bot 时抛出（配置错误）。
   */
  async pollLoop(signal: AbortSignal, isLeader: () => boolean): Promise<void> {
    while (!signal.aborted) {
      if (!isLeader()) {
        await sleep(5_000, signal);
        continue;
      }
      const offset = await this.d.store.pollOffset();
      let ups: TgUpdate[];
      try {
        ups = await this.d.client.getUpdates(offset, signal);
      } catch (e) {
        if (signal.aborted) {
          return;
        }
        if (e instanceof TelegramApiError && e.fatal) {
          throw e;
        }
        const wait = e instanceof TelegramApiError && e.retryAfterS ? e.retryAfterS * 1000 : 5_000;
        logger.warn('getUpdates 失败，稍后重试', { error: (e as Error).message, wait_ms: wait });
        if (!(e instanceof TelegramApiError || e instanceof TelegramTransportError)) {
          throw e;
        }
        await sleep(wait, signal);
        continue;
      }
      for (const u of ups) {
        try {
          await this.handle(u);
        } catch (e) {
          // 处理失败的更新不确认，稍后重新处理（回调按 id 去重，不会重复执行）
          logger.error('处理 Telegram 更新失败，稍后重试', { update_id: u.update_id, error: e });
          await sleep(5_000, signal);
          break;
        }
        await this.d.store.savePollOffset(u.update_id + 1, new Date(this.d.now()));
      }
    }
  }
}
