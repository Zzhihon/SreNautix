import type {
  AnswerCallbackQueryParams,
  EditMessageTextParams,
  SendMessageParams,
  SetWebhookParams,
  TgMessage,
  TgUpdate,
} from './types.js';

/** getUpdates 长轮询的秒数。 */
export const POLL_TIMEOUT_S = 30;

/** 本渠道订阅的更新：超级群里的普通消息（拒绝原因、真实根因与 /link 的回复）与按钮回调。 */
export const ALLOWED_UPDATES = ['message', 'callback_query'];

/** Bot API 返回 ok=false。 */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfterS: number | null,
    readonly migrateToChatId: number | null,
  ) {
    super(`telegram ${method}: ${code} ${description}${retryAfterS ? `（retry_after ${retryAfterS}s）` : ''}`);
  }

  get rateLimited(): boolean {
    return this.code === 429;
  }

  /** editMessageText 的内容与现有消息完全相同。 */
  get notModified(): boolean {
    return this.code === 400 && this.description.includes('message is not modified');
  }

  /** 要编辑的消息已被删除或不可编辑。 */
  get editTargetGone(): boolean {
    return (
      this.code === 400 &&
      (this.description.includes('message to edit not found') || this.description.includes("message can't be edited"))
    );
  }

  /** 回调查询已过期，再应答也不会成功。 */
  get queryExpired(): boolean {
    return (
      this.code === 400 &&
      (this.description.includes('query is too old') || this.description.includes('query ID is invalid'))
    );
  }

  /** bot token 无效，或另有 webhook / getUpdates 使用者：配置错误，进程应退出。 */
  get fatal(): boolean {
    return this.code === 401 || this.code === 404 || this.code === 409;
  }
}

/** 请求没有得到 Bot API 的应答（网络、超时、非 JSON 响应）。 */
export class TelegramTransportError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`telegram ${method} 不可达：${message}`);
  }
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

/** Bot API 客户端。token 只出现在请求 URL 中，错误信息里会被替换为 <token>。 */
export class TelegramClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly timeoutMs = (POLL_TIMEOUT_S + 15) * 1000,
  ) {}

  private redact(s: string): string {
    return s.split(this.token).join('<token>');
  }

  async call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      const cause = (e as { cause?: unknown }).cause;
      throw new TelegramTransportError(
        method,
        this.redact(`${(e as Error).message}${cause instanceof Error ? `（${cause.message}）` : ''}`),
      );
    }
    const text = await res.text();
    let body: ApiResponse<T>;
    try {
      body = JSON.parse(text) as ApiResponse<T>;
    } catch {
      throw new TelegramTransportError(method, `HTTP ${res.status}，响应不是 Bot API JSON`);
    }
    if (!body.ok) {
      throw new TelegramApiError(
        method,
        body.error_code ?? res.status,
        this.redact(body.description ?? ''),
        body.parameters?.retry_after ?? null,
        body.parameters?.migrate_to_chat_id ?? null,
      );
    }
    return body.result as T;
  }

  sendMessage(p: SendMessageParams, signal?: AbortSignal): Promise<TgMessage> {
    return this.call('sendMessage', p, signal);
  }

  /** 非 inline 消息编辑成功时返回 Message。 */
  editMessageText(p: EditMessageTextParams, signal?: AbortSignal): Promise<TgMessage> {
    return this.call('editMessageText', p, signal);
  }

  async answerCallbackQuery(p: AnswerCallbackQueryParams, signal?: AbortSignal): Promise<void> {
    const ok = await this.call<boolean>('answerCallbackQuery', p, signal);
    if (ok !== true) {
      throw new TelegramApiError('answerCallbackQuery', 0, 'result=false', null, null);
    }
  }

  getUpdates(offset: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call(
      'getUpdates',
      { offset, limit: 100, timeout: POLL_TIMEOUT_S, allowed_updates: ALLOWED_UPDATES },
      signal,
    );
  }

  async setWebhook(p: SetWebhookParams, signal?: AbortSignal): Promise<void> {
    await this.call<boolean>('setWebhook', p, signal);
  }
}
