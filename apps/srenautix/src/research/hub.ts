import type {
  Alert,
  Feedback,
  Incident,
  Proposal,
  ProposalCreate,
  StageAReport,
  TopologyEdge,
  TopologyNode,
} from '@srenautix/contract';
import type { CatalogAction } from '../proposals/catalog.js';

// worker 调用中心 server 的内部接口（worker 的服务 token；server 代为执行队列的 SKIP LOCKED，worker 没有 server schema 的权限）。

export interface ClaimedTask {
  run_id: string;
  worker_id: string;
  incident_id: string;
  incident_version: number;
  reason: string;
  priority: number;
  lease_expires_at: string;
  deadline_at: string;
}

export interface TaskContext {
  run_id: string;
  reason: string;
  incident: Incident;
  alerts: Alert[];
  stage_a: StageAReport;
  topology: { version: number; nodes: TopologyNode[]; edges: TopologyEdge[] };
  feedback: Feedback[];
  catalog: { version: 1; actions: CatalogAction[] };
}

export class HubError extends Error {
  override name = 'HubError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class HubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body: unknown,
    opts: { timeoutMs?: number; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<{ status: number; body: T | null }> {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 30_000), ...(opts.signal ? [opts.signal] : [])];
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opts.headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    const text = await res.text();
    if (res.status >= 400) {
      let code = 'http';
      let message = text.slice(0, 500);
      if (text.startsWith('{')) {
        const e = JSON.parse(text) as { error?: string; message?: string };
        code = e.error ?? code;
        message = e.message ?? message;
      }
      throw new HubError(res.status, code, `${method} ${path} HTTP ${res.status}：${message}`);
    }
    return { status: res.status, body: text ? (JSON.parse(text) as T) : null };
  }

  /** 认领一个阶段 B 任务；没有任务时长轮询 waitS 秒后返回 null */
  async claim(workerId: string, waitS: number, signal: AbortSignal): Promise<ClaimedTask | null> {
    const r = await this.call<{ task: ClaimedTask }>(
      'POST',
      `/v1/research/claim?wait=${waitS}`,
      { worker_id: workerId },
      { timeoutMs: (waitS + 15) * 1000, signal },
    );
    return r.status === 204 || !r.body ? null : r.body.task;
  }

  async heartbeat(runId: string, workerId: string): Promise<string> {
    const r = await this.call<{ lease_expires_at: string }>('POST', `/v1/research/tasks/${runId}/heartbeat`, {
      worker_id: workerId,
    });
    return (r.body as { lease_expires_at: string }).lease_expires_at;
  }

  async finish(runId: string, workerId: string, state: 'completed' | 'stage_a_only' | 'failed'): Promise<void> {
    await this.call('POST', `/v1/research/tasks/${runId}/finish`, { worker_id: workerId, state });
  }

  async context(runId: string): Promise<TaskContext> {
    const r = await this.call<TaskContext>('GET', `/v1/research/tasks/${runId}/context`, undefined);
    return r.body as TaskContext;
  }

  async reportBudget(usedRatio: number): Promise<void> {
    await this.call('POST', '/v1/research/budget', { used_ratio: usedRatio });
  }

  /** 提议中转（POST /v1/proposals，带幂等键）；绑定与事件当前状态不一致时返回 null 与原因 */
  async propose(
    create: ProposalCreate,
    idempotencyKey: string,
  ): Promise<{ proposal: Proposal | null; rejected: string | null }> {
    try {
      const r = await this.call<Proposal>('POST', '/v1/proposals', create, {
        headers: { 'idempotency-key': idempotencyKey },
      });
      return { proposal: r.body, rejected: null };
    } catch (e) {
      if (e instanceof HubError && (e.status === 409 || e.status === 400 || e.status === 403)) {
        return { proposal: null, rejected: e.message };
      }
      throw e;
    }
  }
}
