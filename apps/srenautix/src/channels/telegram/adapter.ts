import type {
  ActionResultView,
  ChannelAdapter,
  ChatTarget,
  DeliveryError,
  DigestInput,
  Rendered,
  RenderOptions,
} from '../../notify/channel.js';
import type { DesiredIncidentMessage } from '../../notify/ports.js';
import type { ChannelLimits } from '../../notify/ratelimit.js';
import { TelegramApiError, TelegramTransportError, type TelegramClient } from './client.js';
import { renderDigest, renderIncident, type TelegramPayload } from './render.js';

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = 'telegram' as const;

  constructor(
    readonly client: TelegramClient,
    readonly chats: readonly ChatTarget[],
    readonly limits: ChannelLimits,
    private readonly prefix: string,
    /** updates 为 webhook 或 polling 时为 true；none 时只发送，不渲染回调按钮 */
    readonly receivesCallbacks = true,
  ) {}

  renderIncident(
    chat: ChatTarget,
    msg: DesiredIncidentMessage,
    results: ActionResultView[],
    storm: { startedAt: Date } | null,
    opts: RenderOptions,
  ): Rendered {
    return renderIncident(chat, msg, results, storm, opts);
  }

  renderDigest(chat: ChatTarget, d: DigestInput): Rendered {
    return renderDigest(chat, d, this.prefix);
  }

  async send(chat: ChatTarget, payload: unknown, silent: boolean): Promise<string> {
    const p = payload as TelegramPayload;
    const m = await this.client.sendMessage({
      chat_id: Number(chat.chat),
      text: p.text,
      parse_mode: p.parse_mode,
      link_preview_options: { is_disabled: true },
      ...(silent ? { disable_notification: true } : {}),
      ...(p.reply_markup.inline_keyboard.length ? { reply_markup: p.reply_markup } : {}),
    });
    return String(m.message_id);
  }

  /** 编辑时总是带上键盘：没有按钮时为空键盘，去掉旧按钮。 */
  async edit(chat: ChatTarget, externalId: string, payload: unknown): Promise<void> {
    const p = payload as TelegramPayload;
    await this.client.editMessageText({
      chat_id: Number(chat.chat),
      message_id: Number(externalId),
      text: p.text,
      parse_mode: p.parse_mode,
      link_preview_options: { is_disabled: true },
      reply_markup: p.reply_markup,
    });
  }

  classify(err: unknown): DeliveryError {
    if (err instanceof TelegramTransportError) {
      return { kind: 'transport' };
    }
    if (err instanceof TelegramApiError) {
      if (err.rateLimited) {
        return { kind: 'rate_limited', retryAfterMs: (err.retryAfterS ?? 5) * 1000 };
      }
      if (err.notModified) {
        return { kind: 'not_modified' };
      }
      if (err.editTargetGone) {
        return { kind: 'target_gone' };
      }
      if (err.fatal || err.migrateToChatId !== null) {
        return { kind: 'fatal' };
      }
      return { kind: 'api' };
    }
    return { kind: 'fatal' };
  }
}
