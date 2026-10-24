import type { PermanentReason } from '../../notify/channel.js';

/** 飞书开放平台返回 code ≠ 0，或 HTTP 状态不是 2xx。 */
export class FeishuApiError extends Error {
  constructor(
    readonly op: string,
    readonly httpStatus: number,
    readonly code: number,
    readonly msg: string,
  ) {
    super(`feishu ${op}: HTTP ${httpStatus} code ${code} ${msg}`);
  }

  /** 230020：单条消息或群发送频率超限；99991400：应用请求频率超限；HTTP 429。 */
  get rateLimited(): boolean {
    return this.code === 230020 || this.code === 99991400 || this.httpStatus === 429;
  }

  /** 230011：消息已撤回；230031：超过 14 天不能更新。改为发送新消息。 */
  get editTargetGone(): boolean {
    return this.code === 230011 || this.code === 230031;
  }

  /**
   * 飞书拒绝这张卡片的内容本身，原样重试永远不会成功（ADR 0145）：230001 请求参数无效、230025 消息内容超长、
   * 230099 卡片内容创建失败。返回原因，不是永久错误时返回 null。
   */
  get permanentReason(): PermanentReason | null {
    switch (this.code) {
      case 230001:
        return 'invalid_param';
      case 230025:
        return 'content_too_long';
      case 230099:
        return 'invalid_card';
      default:
        return null;
    }
  }

  /** 应用凭证无效（99991663 tenant_access_token 无效，10003 / 10014 app_id 或 app_secret 错误）。 */
  get fatal(): boolean {
    return this.code === 10003 || this.code === 10014;
  }
}

export class FeishuTransportError extends Error {
  constructor(
    readonly op: string,
    message: string,
  ) {
    super(`feishu ${op} 不可达：${message}`);
  }
}

interface Envelope<T> {
  code: number;
  msg: string;
  data?: T;
  tenant_access_token?: string;
  expire?: number;
}

/** 飞书机器人客户端：tenant_access_token 自动获取与续期，发送与更新消息卡片。 */
export class FeishuClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly base: string,
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly timeoutMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  private async request<T>(
    op: string,
    method: string,
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<Envelope<T>> {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (auth) {
      headers.authorization = `Bearer ${await this.tenantToken()}`;
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new FeishuTransportError(op, (e as Error).message);
    }
    const text = await res.text();
    let env: Envelope<T>;
    try {
      env = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new FeishuTransportError(op, `HTTP ${res.status}，响应不是 JSON`);
    }
    if (!res.ok || env.code !== 0) {
      if (env.code === 99991663 || env.code === 99991661) {
        // tenant_access_token 失效：丢弃缓存，下一次请求重新获取
        this.token = null;
      }
      throw new FeishuApiError(op, res.status, env.code, env.msg);
    }
    return env;
  }

  /** 自建应用的 tenant_access_token，有效期内复用，剩余不足 5 分钟时刷新。 */
  async tenantToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() > 5 * 60_000) {
      return this.token.value;
    }
    const env = await this.request<never>(
      'tenant_access_token',
      'POST',
      '/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: this.appId, app_secret: this.appSecret },
      false,
    );
    if (!env.tenant_access_token || !env.expire) {
      throw new FeishuApiError('tenant_access_token', 200, -1, '响应缺少 tenant_access_token 或 expire');
    }
    this.token = { value: env.tenant_access_token, expiresAt: this.now() + env.expire * 1000 };
    return env.tenant_access_token;
  }

  /** 向群发送一张卡片，返回 message_id。uuid 在 1 小时内去重，重试不会重复发送。 */
  async sendCard(chatId: string, card: unknown, uuid: string): Promise<string> {
    const env = await this.request<{ message_id: string }>(
      'send',
      'POST',
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid },
      true,
    );
    if (!env.data?.message_id) {
      throw new FeishuApiError('send', 200, -1, '响应缺少 message_id');
    }
    return env.data.message_id;
  }

  /** 更新已发送的共享卡片（卡片 config.update_multi=true）。 */
  async patchCard(messageId: string, card: unknown): Promise<void> {
    await this.request(
      'patch',
      'PATCH',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { content: JSON.stringify(card) },
      true,
    );
  }

  /** 在群里发送一条文本消息（回复卡片按钮的提示）。 */
  async sendText(chatId: string, text: string, uuid: string): Promise<string> {
    const env = await this.request<{ message_id: string }>(
      'send_text',
      'POST',
      '/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid },
      true,
    );
    return env.data?.message_id ?? '';
  }
}
