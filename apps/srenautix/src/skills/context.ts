import type { SkillCall, SkillCapability, SkillCapabilityParams, SkillUsage } from '@srenautix/contract';
import type { SkillMetrics } from './metrics.js';

// 一次运行的访问控制（ADR 0181 §7.1、§7.2，不变量 17）：步骤只能经 SkillContext 访问外部系统，宿主的数据源、Kubernetes
// 客户端与 GitHub 客户端都不交给步骤。每次访问在发出请求之前依次检查：能力在有效能力中、请求在运行的作用范围内、
// 预算有余量、后端的并发名额；任何一项不满足时请求不发出，记一条被拒绝的访问，运行结束。

export class SkillDenied extends Error {
  override name = 'SkillDenied';
}

export class SkillBudgetExceeded extends Error {
  override name = 'SkillBudgetExceeded';
}

/** 运行的预算：清单的 budgets.run 与 skills.limits 取较小者 */
export type RunBudget = SkillUsage;

export type Backend = 'metrics' | 'logs' | 'kube' | 'github';

/** 技能共用的后端并发：等待者按到达顺序 */
export class Semaphore {
  private used = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly capacity: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.used < this.capacity) {
      this.used++;
    } else {
      await new Promise<void>((res, rej) => {
        const w = () => res();
        this.waiting.push(w);
        signal.addEventListener(
          'abort',
          () => {
            const i = this.waiting.indexOf(w);
            if (i >= 0) {
              this.waiting.splice(i, 1);
              rej(signal.reason);
            }
          },
          { once: true },
        );
      });
    }
    let done = false;
    return () => {
      if (done) {
        return;
      }
      done = true;
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.used--;
      }
    };
  }
}

export interface ContextOptions {
  skill: string;
  capabilities: Partial<Record<SkillCapability, SkillCapabilityParams>>;
  /** 运行对象：Kubernetes 读取只限它的命名空间与 Pod */
  namespace: string;
  pods: () => ReadonlySet<string>;
  budget: RunBudget;
  semaphores: Record<Backend, Semaphore>;
  metrics: SkillMetrics;
  signal: AbortSignal;
  now?: () => number;
}

const BUDGET_KEY: Record<string, keyof SkillUsage> = {
  metrics: 'metrics_queries',
  logs: 'logs_queries',
  kube: 'kube_reads',
  github: 'github_requests',
};

export class SkillContext {
  readonly usage: SkillUsage = {
    metrics_queries: 0,
    logs_queries: 0,
    log_lines: 0,
    kube_reads: 0,
    github_requests: 0,
    code_files: 0,
    code_bytes: 0,
  };
  readonly calls: SkillCall[] = [];
  /** 当前执行的步骤（写进访问记录） */
  step: string | null = null;
  private readonly now: () => number;

  constructor(private readonly o: ContextOptions) {
    this.now = o.now ?? Date.now;
  }

  get signal(): AbortSignal {
    return this.o.signal;
  }

  params(cap: SkillCapability): SkillCapabilityParams {
    const p = this.o.capabilities[cap];
    if (!p) {
      throw new SkillDenied(`能力 ${cap} 没有授予`);
    }
    return p;
  }

  private record(c: Omit<SkillCall, 'seq' | 'at' | 'step'>, at: number): void {
    this.calls.push({ seq: this.calls.length + 1, at: new Date(at).toISOString(), step: this.step, ...c });
    this.o.metrics.calls.inc({ skill: this.o.skill, capability: c.capability, outcome: c.outcome });
  }

  /** 访问被拒绝：记录并抛出（运行以 capability_denied 结束） */
  deny(capability: SkillCapability, operation: string, request: Record<string, unknown>, why: string): never {
    this.record(
      {
        capability,
        operation,
        request,
        result_bytes: 0,
        truncated: false,
        duration_ms: 0,
        outcome: 'denied',
        error: why,
      },
      this.now(),
    );
    throw new SkillDenied(`${capability} ${operation}：${why}`);
  }

  /** 预算的增量检查；超出时记录并抛出（运行以 budget_exhausted 结束） */
  charge(
    capability: SkillCapability,
    operation: string,
    key: keyof SkillUsage,
    n: number,
    request: Record<string, unknown>,
  ): void {
    if (this.usage[key] + n > this.o.budget[key]) {
      this.record(
        {
          capability,
          operation,
          request,
          result_bytes: 0,
          truncated: false,
          duration_ms: 0,
          outcome: 'budget',
          error: `${key} 将超过运行预算 ${this.o.budget[key]}`,
        },
        this.now(),
      );
      this.o.metrics.budgetExhausted.inc({ skill: this.o.skill, budget: key });
      throw new SkillBudgetExceeded(`${key} 超过运行预算 ${this.o.budget[key]}`);
    }
    this.usage[key] += n;
  }

  /** 预算项的余量 */
  remaining(key: keyof SkillUsage): number {
    return this.o.budget[key] - this.usage[key];
  }

  /** 检查命名空间与 Pod 在运行对象之内 */
  inScope(capability: SkillCapability, operation: string, namespace: string, pod: string | null): void {
    if (namespace !== this.o.namespace) {
      this.deny(
        capability,
        operation,
        { namespace, pod },
        `命名空间 ${namespace} 不是运行对象的命名空间 ${this.o.namespace}`,
      );
    }
    if (pod !== null && !this.o.pods().has(pod)) {
      this.deny(capability, operation, { namespace, pod }, `Pod ${pod} 不属于运行对象`);
    }
  }

  /**
   * 执行一次外部访问：能力 → 预算 → 并发名额 → 请求。size 给出结果的字节数与是否截断，写进访问记录
   */
  async call<T>(
    capability: SkillCapability,
    backend: Backend,
    operation: string,
    request: Record<string, unknown>,
    fn: () => Promise<T>,
    size: (v: T) => { bytes: number; truncated: boolean } = () => ({ bytes: 0, truncated: false }),
  ): Promise<T> {
    if (!this.o.capabilities[capability]) {
      this.deny(capability, operation, request, `能力 ${capability} 没有授予`);
    }
    this.charge(capability, operation, BUDGET_KEY[backend]!, 1, request);
    const release = await this.o.semaphores[backend].acquire(this.o.signal);
    const started = this.now();
    try {
      const v = await fn();
      const s = size(v);
      this.record(
        {
          capability,
          operation,
          request,
          result_bytes: s.bytes,
          truncated: s.truncated,
          duration_ms: this.now() - started,
          outcome: 'ok',
          error: null,
        },
        started,
      );
      return v;
    } catch (e) {
      this.record(
        {
          capability,
          operation,
          request,
          result_bytes: 0,
          truncated: false,
          duration_ms: this.now() - started,
          outcome: 'error',
          error: (e instanceof Error ? e.message : String(e)).slice(0, 1000),
        },
        started,
      );
      throw e;
    } finally {
      release();
    }
  }
}
