// 模型路由的两种熔断器（DESIGN §8.1），所有研判共用：
// - 失败型：60 秒内失败 5 次打开；打开后每 30 秒放行一次探测，探测成功关闭，失败继续打开；
// - 延迟型：最近的调用延迟 p50 超过单次超时的一半时打开，同样每 30 秒放行一次探测。

export interface BreakerOptions {
  failureWindowMs: number;
  failureThreshold: number;
  probeIntervalMs: number;
  /** 单次调用超时；延迟型熔断的阈值是它的一半 */
  callTimeoutMs: number;
  /** 计算 p50 的样本数与有效期 */
  latencySamples: number;
  latencyMaxAgeMs: number;
  /** 至少有这么多样本才判断延迟 */
  latencyMinSamples: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
  failureWindowMs: 60_000,
  failureThreshold: 5,
  probeIntervalMs: 30_000,
  callTimeoutMs: 90_000,
  latencySamples: 20,
  latencyMaxAgeMs: 10 * 60_000,
  latencyMinSamples: 5,
};

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface Admission {
  allowed: boolean;
  /** 本次是打开状态下放行的探测 */
  probe: boolean;
  reason: 'closed' | 'failure_open' | 'latency_open' | 'probe';
}

export class RouteBreaker {
  private failures: number[] = [];
  private latencies: Array<{ at: number; ms: number }> = [];
  private openedBy: 'failure' | 'latency' | null = null;
  private lastProbeAt = 0;
  private probeInFlight = false;
  private newlyOpened = false;

  constructor(
    readonly routeId: string,
    private readonly opts: BreakerOptions = DEFAULT_BREAKER,
  ) {}

  state(now: number): BreakerState {
    if (!this.openedBy) {
      return 'closed';
    }
    return !this.probeInFlight && now - this.lastProbeAt >= this.opts.probeIntervalMs ? 'half_open' : 'open';
  }

  get openReason(): 'failure' | 'latency' | null {
    return this.openedBy;
  }

  /** 发起调用前询问；打开时每个探测间隔只放行一次 */
  admit(now: number): Admission {
    if (!this.openedBy) {
      return { allowed: true, probe: false, reason: 'closed' };
    }
    if (!this.probeInFlight && now - this.lastProbeAt >= this.opts.probeIntervalMs) {
      this.probeInFlight = true;
      this.lastProbeAt = now;
      return { allowed: true, probe: true, reason: 'probe' };
    }
    return { allowed: false, probe: false, reason: this.openedBy === 'failure' ? 'failure_open' : 'latency_open' };
  }

  /** 调用成功（拿到了服务方响应）；latencyMs 进入延迟样本 */
  success(now: number, latencyMs: number, probe: boolean): void {
    this.pushLatency(now, latencyMs);
    if (probe) {
      this.probeInFlight = false;
      if (this.openedBy === 'failure' || (this.openedBy === 'latency' && latencyMs <= this.opts.callTimeoutMs / 2)) {
        this.close();
        return;
      }
    }
    this.evaluateLatency(now);
  }

  /** 计入失败型熔断的失败（网络、超时、408/429/5xx） */
  failure(now: number, latencyMs: number, probe: boolean): void {
    this.pushLatency(now, latencyMs);
    if (probe) {
      this.probeInFlight = false;
      this.openedBy ??= 'failure';
      return;
    }
    this.failures = this.failures.filter((t) => now - t < this.opts.failureWindowMs);
    this.failures.push(now);
    if (this.failures.length >= this.opts.failureThreshold) {
      this.open('failure', now);
      return;
    }
    this.evaluateLatency(now);
  }

  /** 与熔断无关的结束（例如请求本身被服务方拒绝、调用方中止）：释放探测名额 */
  neutral(probe: boolean): void {
    if (probe) {
      this.probeInFlight = false;
    }
  }

  /** 当前样本的 p50（毫秒）；样本不足时为 null */
  p50(now: number): number | null {
    const recent = this.latencies.filter((l) => now - l.at <= this.opts.latencyMaxAgeMs).map((l) => l.ms);
    if (recent.length < this.opts.latencyMinSamples) {
      return null;
    }
    const sorted = [...recent].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }

  private pushLatency(now: number, ms: number): void {
    this.latencies.push({ at: now, ms });
    if (this.latencies.length > this.opts.latencySamples) {
      this.latencies = this.latencies.slice(-this.opts.latencySamples);
    }
  }

  private evaluateLatency(now: number): void {
    const p = this.p50(now);
    if (p !== null && p > this.opts.callTimeoutMs / 2 && !this.openedBy) {
      this.open('latency', now);
    }
  }

  /** 自上次读取以来是否新打开过一次（用于打开次数计数） */
  consumeOpened(): boolean {
    const v = this.newlyOpened;
    this.newlyOpened = false;
    return v;
  }

  private open(by: 'failure' | 'latency', now: number): void {
    this.newlyOpened = true;
    this.openedBy = by;
    this.lastProbeAt = now;
    this.probeInFlight = false;
  }

  private close(): void {
    this.openedBy = null;
    this.failures = [];
    this.latencies = [];
  }
}

/**
 * 故障域提前熔断：事件涉及的组件落在路由的 failure_domain 内时，这条路由对本次研判视为打开。
 * 组件键完全相等，或者事件组件是 failure_domain 中某个命名空间伪组件（Namespace:<ns>）下的对象。
 */
export function touchesFailureDomain(
  incidentComponents: Iterable<string>,
  failureDomain: readonly string[],
): string | null {
  const domain = new Set(failureDomain);
  const namespaces = new Set(
    failureDomain.filter((k) => k.startsWith('Namespace:')).map((k) => k.slice('Namespace:'.length)),
  );
  for (const c of incidentComponents) {
    if (domain.has(c)) {
      return c;
    }
    const m = /^[^:]+:([^/]+)\//.exec(c);
    if (m && namespaces.has(m[1] as string)) {
      return c;
    }
  }
  return null;
}
