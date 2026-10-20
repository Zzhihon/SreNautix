import { createHash } from 'node:crypto';
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
import { FeishuApiError, FeishuTransportError, type FeishuClient } from './client.js';
import { renderCard, renderDigestCard, type ButtonSigner } from './render.js';

/** 发送请求的 uuid（1 小时内去重）：由消息身份与内容哈希决定，重试不会重复发送，内容变化后的重新发送不被去重。 */
export function sendUuid(dedupKey: string): string {
  return createHash('sha256').update(dedupKey).digest('hex').slice(0, 32);
}

export class FeishuAdapter implements ChannelAdapter {
  readonly channel = 'feishu' as const;
  /** 飞书的卡片回调经 server 的回调路由接收（配置飞书时必须给出 verification token） */
  readonly receivesCallbacks = true;

  constructor(
    readonly client: FeishuClient,
    readonly chats: readonly ChatTarget[],
    readonly limits: ChannelLimits,
    private readonly prefix: string,
    readonly signer: ButtonSigner,
  ) {}

  renderIncident(
    chat: ChatTarget,
    msg: DesiredIncidentMessage,
    results: ActionResultView[],
    storm: { startedAt: Date } | null,
    opts: RenderOptions,
  ): Rendered {
    return renderCard(chat, msg, results, storm, opts, this.signer);
  }

  renderDigest(chat: ChatTarget, d: DigestInput): Rendered {
    return renderDigestCard(chat, d, this.prefix);
  }

  /** 飞书没有静默发送，风暴期间的事件卡片照常发送，汇总卡片列出全部事件。 */
  async send(chat: ChatTarget, payload: unknown, _silent: boolean, dedupKey: string): Promise<string> {
    return this.client.sendCard(chat.chat, payload, sendUuid(dedupKey));
  }

  async edit(_chat: ChatTarget, externalId: string, payload: unknown): Promise<void> {
    await this.client.patchCard(externalId, payload);
  }

  classify(err: unknown): DeliveryError {
    if (err instanceof FeishuTransportError) {
      return { kind: 'transport' };
    }
    if (err instanceof FeishuApiError) {
      if (err.rateLimited) {
        return { kind: 'rate_limited', retryAfterMs: 1_000 };
      }
      if (err.editTargetGone) {
        return { kind: 'target_gone' };
      }
      if (err.fatal) {
        return { kind: 'fatal' };
      }
      return { kind: 'api' };
    }
    return { kind: 'fatal' };
  }
}
