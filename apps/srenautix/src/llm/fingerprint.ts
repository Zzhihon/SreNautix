import { createHash } from 'node:crypto';
import type { LlmTurn } from './types.js';

// 服务方漂移检测（DESIGN §8.5）：服务方返回的模型 ID 与系统指纹组成路由的指纹。
// 新指纹连续出现 confirmAfter 次才视为变化，避免服务方按请求轮换的指纹造成误报。

export function turnFingerprint(turn: Pick<LlmTurn, 'responseModel' | 'systemFingerprint'>): string | null {
  if (turn.responseModel === null && turn.systemFingerprint === null) {
    return null;
  }
  const raw = `${turn.responseModel ?? ''}|${turn.systemFingerprint ?? ''}`;
  return `fp:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

export interface Drift {
  routeId: string;
  from: string | null;
  to: string;
}

export class FingerprintTracker {
  private pending: string | null = null;
  private streak = 0;

  constructor(
    readonly routeId: string,
    private known: string | null,
    private readonly confirmAfter = 3,
  ) {}

  get current(): string | null {
    return this.known;
  }

  /** 记录一次成功调用的指纹；确认发生变化时返回漂移 */
  observe(fp: string | null): Drift | null {
    if (fp === null || fp === this.known) {
      this.pending = null;
      this.streak = 0;
      return null;
    }
    if (this.known === null) {
      this.known = fp;
      return null;
    }
    if (fp === this.pending) {
      this.streak++;
    } else {
      this.pending = fp;
      this.streak = 1;
    }
    if (this.streak < this.confirmAfter) {
      return null;
    }
    const drift: Drift = { routeId: this.routeId, from: this.known, to: fp };
    this.known = fp;
    this.pending = null;
    this.streak = 0;
    return drift;
  }
}
