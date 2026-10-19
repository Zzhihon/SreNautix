/** 令牌桶：容量 capacity，每 periodMs 补满。take 成功时扣一个令牌；失败时给出下一个令牌可用的时间。 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly periodMs: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number): void {
    if (now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) * this.capacity) / this.periodMs);
      this.last = now;
    }
  }

  /** 不扣令牌，只看能否立即发送；不能时返回可以再试的时间。 */
  peek(now: number): { ok: boolean; retryAt: number } {
    this.refill(now);
    if (this.tokens >= 1) {
      return { ok: true, retryAt: now };
    }
    return { ok: false, retryAt: now + Math.ceil(((1 - this.tokens) * this.periodMs) / this.capacity) };
  }

  consume(): void {
    this.tokens -= 1;
  }
}

export interface ChannelLimits {
  /** 每个渠道目标（群）每分钟的发送与编辑次数。 */
  perChatPerMinute: number;
  /** 整个应用每分钟与每秒的调用次数（飞书）；没有应用级限制时为 null。 */
  perAppPerMinute: number | null;
  perAppPerSecond: number | null;
  /** 同一条消息两次编辑的最小间隔；期间的变化合并，到时只发送最新内容。 */
  editGapMs: number;
}

/**
 * 一个渠道的出站限速（DESIGN §11）：每个群一个令牌桶，飞书另有应用级的分钟桶与秒桶；
 * 收到 429 时按 retry_after 暂停整个渠道。发送与编辑共用令牌，按优先级通道依次取用。
 */
export class ChannelLimiter {
  private readonly chats = new Map<string, TokenBucket>();
  private readonly app: TokenBucket[] = [];
  private pausedUntil = 0;

  constructor(
    readonly limits: ChannelLimits,
    now: number,
  ) {
    if (limits.perAppPerMinute !== null) {
      this.app.push(new TokenBucket(limits.perAppPerMinute, 60_000, now));
    }
    if (limits.perAppPerSecond !== null) {
      this.app.push(new TokenBucket(limits.perAppPerSecond, 1_000, now));
    }
  }

  pause(until: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, until);
  }

  paused(now: number): number | null {
    return now < this.pausedUntil ? this.pausedUntil : null;
  }

  /** 为群 chat 占用一个令牌；不能发送时返回 ok=false 与可以再试的时间。 */
  reserve(chat: string, now: number): { ok: boolean; retryAt: number } {
    const p = this.paused(now);
    if (p !== null) {
      return { ok: false, retryAt: p };
    }
    let bucket = this.chats.get(chat);
    if (!bucket) {
      bucket = new TokenBucket(this.limits.perChatPerMinute, 60_000, now);
      this.chats.set(chat, bucket);
    }
    const all = [bucket, ...this.app];
    let retryAt = now;
    for (const b of all) {
      const r = b.peek(now);
      if (!r.ok) {
        retryAt = Math.max(retryAt, r.retryAt);
      }
    }
    if (retryAt > now) {
      return { ok: false, retryAt };
    }
    for (const b of all) {
      b.consume();
    }
    return { ok: true, retryAt: now };
  }
}
