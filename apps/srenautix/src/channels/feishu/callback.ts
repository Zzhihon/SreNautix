import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest, unauthorized } from '../../api/errors.js';
import { rawBody } from '../../api/http.js';
import { logger } from '../../log.js';
import type { Interactions } from '../../notify/interactions.js';
import type { NotifyActions } from '../../notify/ports.js';
import type { NotifyStore } from '../../notify/store.js';
import type { FeishuClient } from './client.js';
import { decryptFeishu, sameToken, verifyFeishuSignature } from './crypto.js';
import type { ButtonSigner } from './render.js';

export const CALLBACK_PATH = '/v1/channels/feishu/callback';

/** 回调与事件的时间与当前时间相差超过这个值就拒绝（防重放）。 */
export const MAX_SKEW_MS = 5 * 60_000;

const LINK = /\/link\s+([A-Za-z0-9]{8})\b/;

export interface FeishuCallbackDeps {
  encryptKey: string | null;
  verificationToken: string;
  signer: ButtonSigner;
  chats: ReadonlySet<string>;
  interactions: Interactions;
  actions: NotifyActions;
  store: NotifyStore;
  client: FeishuClient;
  autoLinkUnionId: boolean;
  now: () => number;
}

interface Envelope {
  schema?: string;
  type?: string;
  token?: string;
  challenge?: string;
  header?: { event_id?: string; token?: string; create_time?: string; event_type?: string };
  event?: Record<string, unknown>;
}

/** create_time 在事件中为毫秒，在卡片回调示例中为微秒；按位数换算成毫秒。 */
function createTimeMs(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return raw.length >= 16 ? Math.floor(n / 1000) : raw.length <= 10 ? n * 1000 : n;
}

const toast = (content: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') => ({
  toast: { type, content },
});

/**
 * 飞书的卡片回调与事件订阅（同一个请求地址）：
 * - 配置了 Encrypt Key 时，必须带正确的 X-Lark-Signature 且时间戳在 5 分钟内，载荷是加密的 {encrypt}；
 * - url_verification 回应 challenge；其余请求的 verification token 必须匹配；
 * - 同一个 event_id 只处理一次，create_time 超过 5 分钟的拒绝；
 * - card.action.trigger 在 3 秒内应答 toast，server 的操作在应答之后执行；
 * - im.message.receive_v1 只处理 /link <绑定码>。
 */
export function registerFeishuCallback(app: FastifyInstance, d: FeishuCallbackDeps): void {
  app.post(CALLBACK_PATH, async (req, reply) => {
    const env = open(req, d);
    if (env.type === 'url_verification') {
      if (!env.token || !sameToken(env.token, d.verificationToken)) {
        throw unauthorized('verification token 不匹配');
      }
      return reply.send({ challenge: env.challenge });
    }
    if (env.schema !== '2.0' || !env.header) {
      throw badRequest('只接受 schema 2.0 的回调与事件');
    }
    if (!env.header.token || !sameToken(env.header.token, d.verificationToken)) {
      throw unauthorized('verification token 不匹配');
    }
    const created = createTimeMs(env.header.create_time);
    if (created !== null && Math.abs(d.now() - created) > MAX_SKEW_MS) {
      throw unauthorized('回调已过期');
    }
    const eventId = env.header.event_id;
    if (!eventId) {
      throw badRequest('缺少 event_id');
    }
    const ev = env.event ?? {};
    if (env.header.event_type === 'card.action.trigger') {
      return reply.send(await cardAction(d, eventId, ev));
    }
    if (env.header.event_type === 'im.message.receive_v1') {
      await linkMessage(d, eventId, ev);
      return reply.send({});
    }
    return reply.send({});
  });
}

function open(req: FastifyRequest, d: FeishuCallbackDeps): Envelope {
  const body = req.body as (Envelope & { encrypt?: unknown }) | undefined;
  if (!body || typeof body !== 'object') {
    throw badRequest('请求体不是 JSON 对象');
  }
  if (d.encryptKey === null) {
    if (body.encrypt !== undefined) {
      throw badRequest('收到加密载荷，但没有配置 encrypt_key_file');
    }
    return body;
  }
  const h = req.headers;
  const ts = typeof h['x-lark-request-timestamp'] === 'string' ? h['x-lark-request-timestamp'] : undefined;
  const ok = verifyFeishuSignature(
    {
      timestamp: ts,
      nonce: typeof h['x-lark-request-nonce'] === 'string' ? h['x-lark-request-nonce'] : undefined,
      signature: typeof h['x-lark-signature'] === 'string' ? h['x-lark-signature'] : undefined,
    },
    d.encryptKey,
    rawBody(req),
  );
  if (!ok) {
    throw unauthorized('X-Lark-Signature 校验失败');
  }
  if (!ts || !/^\d+$/.test(ts) || Math.abs(d.now() - Number(ts) * 1000) > MAX_SKEW_MS) {
    throw unauthorized('请求时间戳超出 5 分钟');
  }
  if (typeof body.encrypt !== 'string') {
    throw badRequest('配置了 encrypt_key_file 时载荷必须加密');
  }
  try {
    return JSON.parse(decryptFeishu(d.encryptKey, body.encrypt)) as Envelope;
  } catch (e) {
    throw badRequest(`解密失败：${(e as Error).message}`);
  }
}

interface CardEvent {
  operator?: { open_id?: string; union_id?: string };
  action?: { value?: unknown; form_value?: Record<string, unknown> };
  context?: { open_chat_id?: string; open_message_id?: string };
}

async function cardAction(d: FeishuCallbackDeps, eventId: string, raw: Record<string, unknown>): Promise<unknown> {
  const ev = raw as CardEvent;
  const chat = ev.context?.open_chat_id ?? '';
  if (!d.chats.has(chat)) {
    return toast('这个群不是已配置的通知渠道', 'error');
  }
  const sid = d.signer.verify(ev.action?.value);
  if (!sid) {
    return toast('按钮无效', 'error');
  }
  const openId = ev.operator?.open_id;
  if (!openId) {
    return toast('回调缺少操作人', 'error');
  }
  const unionId = ev.operator?.union_id;
  if (d.autoLinkUnionId && unionId && !(await d.actions.linkedPrincipal('feishu', openId))) {
    await d.actions.linkByUnionId('feishu', openId, unionId);
  }
  const res = await d.interactions.click({
    channel: 'feishu',
    chat,
    callbackId: eventId,
    channelUserId: openId,
    displayName: '',
    shortId: sid,
    // 飞书的拒绝与反馈都通过卡片表单提交，没有表单值时按空表单校验
    form: ev.action?.form_value ?? {},
    at: new Date(d.now()),
  });
  if (res.type === 'run') {
    // 3 秒内必须应答：操作在应答之后执行，结果写回卡片
    void res.run().catch((e: unknown) => logger.error('飞书按钮操作失败', { error: e, event_id: eventId }));
  }
  return toast(res.answer);
}

interface MessageEvent {
  sender?: { sender_id?: { open_id?: string } };
  message?: { chat_id?: string; chat_type?: string; message_type?: string; content?: string };
}

async function linkMessage(d: FeishuCallbackDeps, eventId: string, raw: Record<string, unknown>): Promise<void> {
  const ev = raw as MessageEvent;
  const chat = ev.message?.chat_id ?? '';
  const openId = ev.sender?.sender_id?.open_id;
  if (!openId || ev.message?.message_type !== 'text' || !(d.chats.has(chat) || ev.message.chat_type === 'p2p')) {
    return;
  }
  const rec = await d.store.recordCallback({
    channel: 'feishu',
    callbackId: eventId,
    chat,
    channelUserId: openId,
    shortId: null,
    at: new Date(d.now()),
  });
  if (!rec.fresh) {
    return;
  }
  // 文本消息的 content 是 JSON 字符串 {"text": "..."}（飞书 im.message.receive_v1）
  const text = String((JSON.parse(ev.message.content ?? '{}') as { text?: unknown }).text ?? '');
  const m = LINK.exec(text);
  if (!m) {
    return;
  }
  const answer = await d.interactions.link('feishu', openId, (m[1] as string).toUpperCase());
  await d.store.setCallbackOutcome('feishu', eventId, 'link', answer);
  await d.client.sendText(chat, answer, eventId);
}
