import type {
  ChangeEvent,
  Alert,
  EvidenceResult,
  Feedback,
  Incident,
  Proposal,
  ProposalCreate,
  StageAReport,
  TopologyEdge,
  TopologyNode,
} from '@srenautix/contract';
import type { CatalogAction } from '../proposals/catalog.js';
import type { RouteReport } from '../scheduler/admission.js';
import type { CheckTemplate, DispositionFacts, KnowledgeItem, ReferenceCase } from './types.js';

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
  /** 与子图组件类型相关的知识条目 */
  knowledge: KnowledgeItem[];
  /** 同集群已解决、经人工确认根因的参考案例 */
  cases: ReferenceCase[];
  /** 区分性检查可用的查询模板（由 server 执行，见 runTemplate） */
  templates: CheckTemplate[];
  /** 加载的领域包的 pack.lock 摘要，写入研判清单 */
  pack_lock: string;
  /** server 提供的只读工具（Kubernetes 只读检查，ADR 0106）；旧版 server 没有这个字段 */
  hub_tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  /** 事件窗口内触及子图或事件命名空间、但不在事件里的变更 */
  related_changes?: ChangeEvent[];
  /** 处置推导的确定性依据（ADR 0138）；旧版 server 没有这个字段 */
  disposition_facts?: DispositionFacts;
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
    // 大事件的上下文要在 server 上重建子图与时间点拓扑，给足 120 秒；超时由认领循环兜住（不让进程退出）
    const r = await this.call<TaskContext>('GET', `/v1/research/tasks/${runId}/context`, undefined, {
      timeoutMs: 120_000,
    });
    return r.body as TaskContext;
  }

  /** 区分性检查的查询模板由 server 执行：在 component 上执行模板附带的卡，返回判定后的卡（ref 由证据簿重新分配） */
  async runTemplate(
    runId: string,
    template: string,
    args: Record<string, unknown>,
    component: string,
    signal: AbortSignal,
  ): Promise<EvidenceResult> {
    const r = await this.call<EvidenceResult>(
      'POST',
      `/v1/research/tasks/${runId}/query`,
      { template, args, component },
      { timeoutMs: 45_000, signal },
    );
    return r.body as EvidenceResult;
  }

  /** server 提供的只读工具（POST /v1/research/tasks/{run_id}/tool） */
  async runTool(
    runId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ text: string; truncated: boolean; bytes: number }> {
    const r = await this.call<{ text: string; truncated: boolean; bytes: number }>(
      'POST',
      `/v1/research/tasks/${runId}/tool`,
      { name, args },
      { timeoutMs: 30_000, signal },
    );
    return r.body as { text: string; truncated: boolean; bytes: number };
  }

  async reportBudget(usedRatio: number): Promise<void> {
    await this.call('POST', '/v1/research/budget', { used_ratio: usedRatio });
  }

  /** 上报本 worker 的模型路由可用情况：server 据此发布状态条件，没有可用路由时阶段 B 直接跳过 */
  async reportRoutes(report: RouteReport): Promise<void> {
    await this.call('POST', '/v1/research/routes', report);
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
