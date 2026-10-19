// 每个调用方独立的速率限制与熔断（DESIGN §9.3）：
// - 读取与提议各一个令牌桶；
// - 行为异常的调用方熔断：10 分钟内被提议中转拒绝（参数、授权或绑定不符）达到阈值时，30 分钟内拒绝该调用方的全部请求。

export interface QuotaLimits {
  readsPerMinute: number;
  proposalsPerHour: number;
  rejectionThreshold: number;
  rejectionWindowMs: number;
  blockMs: number;
}

class Bucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly perMs: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

interface CallerState {
  reads: Bucket;
  proposals: Bucket;
  rejections: number[];
  blockedUntil: number;
}

export type QuotaDecision = { ok: true } | { ok: false; reason: 'blocked' | 'rate_limited'; retryAfterMs: number };

export class Quotas {
  private readonly state = new Map<string, CallerState>();

  constructor(private readonly limits: (clientId: string) => QuotaLimits) {}

  private get(clientId: string, now: number): CallerState {
    let s = this.state.get(clientId);
    if (!s) {
      const l = this.limits(clientId);
      s = {
        reads: new Bucket(l.readsPerMinute, l.readsPerMinute / 60_000, now),
        proposals: new Bucket(l.proposalsPerHour, l.proposalsPerHour / 3_600_000, now),
        rejections: [],
        blockedUntil: 0,
      };
      this.state.set(clientId, s);
    }
    return s;
  }

  check(clientId: string, kind: 'read' | 'propose', now = Date.now()): QuotaDecision {
    const s = this.get(clientId, now);
    if (now < s.blockedUntil) {
      return { ok: false, reason: 'blocked', retryAfterMs: s.blockedUntil - now };
    }
    const ok = kind === 'read' ? s.reads.take(now) : s.proposals.take(now);
    return ok
      ? { ok: true }
      : { ok: false, reason: 'rate_limited', retryAfterMs: kind === 'read' ? 60_000 : 3_600_000 };
  }

  /** 记录一次被拒绝的提议；达到阈值时熔断该调用方，返回是否刚刚熔断 */
  rejected(clientId: string, now = Date.now()): boolean {
    const l = this.limits(clientId);
    const s = this.get(clientId, now);
    s.rejections = [...s.rejections.filter((t) => now - t < l.rejectionWindowMs), now];
    if (s.rejections.length >= l.rejectionThreshold) {
      s.blockedUntil = now + l.blockMs;
      s.rejections = [];
      return true;
    }
    return false;
  }
}
