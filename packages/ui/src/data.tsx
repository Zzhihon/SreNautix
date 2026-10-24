// 宿主注入的环境（数据端口、链接、权限）与基于 TanStack Query 的数据钩子。查询键集中在 qk，
// 事件流的每种事件对应要失效的键（invalidationKeys），独立控制台用 SSE 驱动，Grafana 插件用长轮询驱动。

import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { EvidenceRef, FeedbackCreate, OutboxEvent } from './contract';
import type { DataPort, IncidentQuery, ProposalQuery } from './port';

export interface LinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
  title?: string;
}

export type IncidentTab = 'evidence' | 'hypotheses' | 'timeline' | 'runs';

/** 页面之间的链接；宿主决定 URL 结构。approval 在 Grafana 插件里是控制台的绝对地址。 */
export interface Links {
  inbox: () => string;
  incident: (ref: string, tab?: IncidentTab) => string;
  run: (runId: string) => string;
  approval: (proposalId: string) => string;
  /** approval 是否在当前宿主之外打开（Grafana 插件跳转到控制台）。 */
  approvalExternal: boolean;
}

export interface Capabilities {
  /** 可以提交反馈（responder、approver、admin）。 */
  feedback: boolean;
  /** 可以实时重跑证据卡（responder、approver、admin，且宿主提供 actions）。 */
  rerun: boolean;
  /** 可以审批（approver、admin，且宿主提供 actions）。 */
  approve: boolean;
  /** 只读时的说明，例如"只读：反馈需要 responder 角色"。 */
  readOnlyReason: string;
}

export interface UiEnv {
  port: DataPort;
  links: Links;
  caps: Capabilities;
  /** 宿主的路由链接组件；默认是普通的 <a>。 */
  Link?: ComponentType<LinkProps>;
}

const EnvContext = createContext<UiEnv | null>(null);

export function UiEnvProvider({ env, children }: { env: UiEnv; children: ReactNode }) {
  return <EnvContext.Provider value={env}>{children}</EnvContext.Provider>;
}

export function useUiEnv(): UiEnv {
  const env = useContext(EnvContext);
  if (!env) {
    throw new Error('UiEnvProvider 缺失');
  }
  return env;
}

function PlainLink({ href, className, children, title, ...rest }: LinkProps) {
  return (
    <a href={href} className={className} title={title} aria-label={rest['aria-label']}>
      {children}
    </a>
  );
}

/** 宿主路由的链接。 */
export function AppLink(props: LinkProps) {
  const env = useUiEnv();
  const L = env.Link ?? PlainLink;
  return <L {...props} />;
}

export const qk = {
  conditions: (cluster?: string) => ['conditions', cluster ?? null] as const,
  incidents: (q?: IncidentQuery) => (q ? (['incidents', q] as const) : (['incidents'] as const)),
  incident: (ref: string) => ['incident', ref] as const,
  stageA: (ref: string) => ['incident', ref, 'stage-a'] as const,
  evidence: (ref: string, runId: string | null) => ['incident', ref, 'evidence', runId] as const,
  timeline: (ref: string) => ['incident', ref, 'timeline'] as const,
  subgraph: (ref: string) => ['incident', ref, 'subgraph'] as const,
  runs: (ref: string) => ['incident', ref, 'runs'] as const,
  feedback: (ref: string) => ['incident', ref, 'feedback'] as const,
  run: (runId: string) => ['run', runId] as const,
  manifest: (runId: string) => ['run', runId, 'manifest'] as const,
  proposals: (q?: ProposalQuery) => (q ? (['proposals', q] as const) : (['proposals'] as const)),
  proposal: (id: string) => ['proposal', id] as const,
};

/**
 * 一条事件要失效的查询键（前缀匹配）。详情页以 URL 里的引用（id 或标签）为键，事件只带 id，
 * 所以事件详情相关的事件同时让全部 ['incident'] 前缀失效，代价是多一次重取。
 */
export function invalidationKeys(e: OutboxEvent): QueryKey[] {
  switch (e.type) {
    case 'incident.created':
    case 'incident.updated':
    case 'incident.resolved':
    case 'incident.merged':
    case 'incident.split':
    case 'stage_a.reported':
    case 'feedback.recorded':
      return [qk.incidents(), ['incident']];
    case 'research.queued':
    case 'research.concluded':
    case 'research.failed':
      return [qk.incidents(), ['incident'], qk.run(e.payload.run_id)];
    case 'proposal.created':
    case 'proposal.updated':
      return [qk.proposals(), qk.proposal(e.payload.proposal_id), qk.incidents(), ['incident']];
    case 'approval.issued':
    case 'execution.updated':
      return [qk.proposals(), qk.proposal(e.payload.proposal_id)];
    case 'condition.changed':
      return [['conditions'], qk.incidents(), ['clusters']];
    // 主动优化（契约 2.28.0）：目标、发现与建议的列表和详情按前缀失效
    case 'goal.created':
      return [['goals'], ['goal', e.payload.goal_id]];
    case 'goal.run.concluded':
      return [['goals'], ['goal', e.payload.goal_id], ['findings'], ['recommendations']];
    case 'finding.updated':
      return [['findings']];
    case 'recommendation.updated':
      return [['recommendations'], ['findings'], ['goal', e.payload.goal_id]];
    case 'outcome.verified':
      return [['recommendations'], ['findings'], ['goals'], ['goal', e.payload.goal_id]];
  }
}

export interface InvalidatorOptions {
  /** 收到第一条事件后等多久再统一失效（合并同一批事件） */
  delayMs: number;
  /** 两次失效之间的最短间隔（节流） */
  minGapMs: number;
  now?: () => number;
}

export const DEFAULT_INVALIDATOR: InvalidatorOptions = { delayMs: 300, minGapMs: 2_000 };

/** 失效的执行者：只需要 QueryClient 的 invalidateQueries */
interface Invalidates {
  invalidateQueries(filters?: { queryKey?: QueryKey }, options?: { cancelRefetch?: boolean }): Promise<void>;
}

/**
 * 事件驱动的失效：合并与节流。一批事件里的键按前缀去重后统一失效一次，两次失效之间至少隔 minGapMs；
 * 已经在途的重取不被取消重发（cancelRefetch: false），所以事件再多，每个查询同一时刻最多一个请求。
 * all() 让全部查询失效（事件流重连后的全量对账），同样经过合并与节流。
 */
export function createInvalidator(qc: Invalidates, o: InvalidatorOptions = DEFAULT_INVALIDATOR) {
  const now = o.now ?? Date.now;
  const pending = new Map<string, QueryKey>();
  let everything = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = Number.NEGATIVE_INFINITY;
  let flushes = 0;
  const flush = () => {
    timer = null;
    last = now();
    flushes++;
    const keys = everything ? [] : [...pending.values()];
    const all = everything;
    pending.clear();
    everything = false;
    if (all) {
      void qc.invalidateQueries(undefined, { cancelRefetch: false });
      return;
    }
    // 去掉被更短前缀覆盖的键
    const hashes = keys.map((k) => JSON.stringify(k));
    keys.forEach((k, i) => {
      const h = hashes[i] as string;
      const covered = hashes.some(
        (p, j) => j !== i && p.length < h.length && h.startsWith(p.slice(0, -1)) && h[p.length - 1] === ',',
      );
      if (!covered) {
        void qc.invalidateQueries({ queryKey: k }, { cancelRefetch: false });
      }
    });
  };
  const schedule = () => {
    if (timer !== null) {
      return;
    }
    timer = setTimeout(flush, Math.max(o.delayMs, last + o.minGapMs - now()));
  };
  return {
    keys(keys: readonly QueryKey[]): void {
      for (const k of keys) {
        pending.set(JSON.stringify(k), k);
      }
      schedule();
    },
    all(): void {
      everything = true;
      schedule();
    },
    get flushes(): number {
      return flushes;
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * 读查询的重试：网络错误、408 与 429 最多重试 4 次（连接耗尽、限流都会很快恢复）；5xx 最多 2 次
 * （例如没有配置 worker 的 503 是持续状态，不让页面等太久才显示原因）；其他 4xx 不重试。
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status !== 'number' || status === 408 || status === 429) {
    return failureCount < 4;
  }
  return status >= 500 && failureCount < 2;
}

/** 指数退避加抖动：1、2、4、8 秒……上限 30 秒，每次乘以 0.5–1 的随机系数 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + random() / 2);
}

export function useConditions(cluster?: string) {
  const { port } = useUiEnv();
  return useQuery({
    queryKey: qk.conditions(cluster),
    queryFn: () => port.listConditions(cluster),
    refetchInterval: 60_000,
  });
}

export function useIncidents(q: IncidentQuery) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.incidents(q), queryFn: () => port.listIncidents(q) });
}

export function useIncident(ref: string) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.incident(ref), queryFn: () => port.getIncident(ref) });
}

export function useStageA(ref: string) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.stageA(ref), queryFn: () => port.getStageAReport(ref) });
}

export function useEvidence(ref: string, runId: string | null) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.evidence(ref, runId), queryFn: () => port.getEvidenceSnapshot(ref, runId) });
}

export function useTimeline(ref: string) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.timeline(ref), queryFn: () => port.getIncidentTimeline(ref) });
}

export function useSubgraph(ref: string) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.subgraph(ref), queryFn: () => port.getIncidentSubgraph(ref) });
}

export function useRuns(ref: string) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.runs(ref), queryFn: () => port.listResearchRuns(ref) });
}

export function useRun(runId: string | null) {
  const { port } = useUiEnv();
  return useQuery({
    queryKey: qk.run(runId ?? ''),
    queryFn: () => port.getResearchRun(runId as string),
    enabled: runId !== null,
  });
}

export function useManifest(runId: string | null) {
  const { port } = useUiEnv();
  return useQuery({
    queryKey: qk.manifest(runId ?? ''),
    queryFn: () => port.getResearchManifest(runId as string),
    enabled: runId !== null,
  });
}

export function useFeedback(ref: string) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.feedback(ref), queryFn: () => port.listFeedback(ref) });
}

export function useProposals(q: ProposalQuery) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.proposals(q), queryFn: () => port.listProposals(q) });
}

export function useProposal(id: string) {
  const { port } = useUiEnv();
  return useQuery({ queryKey: qk.proposal(id), queryFn: () => port.getProposal(id) });
}

export function useCreateFeedback(ref: string) {
  const { port } = useUiEnv();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FeedbackCreate) => port.createFeedback(ref, body),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.incident(ref) }),
        qc.invalidateQueries({ queryKey: qk.incidents() }),
      ]),
  });
}

export function useRerunEvidence(ref: string) {
  const { port } = useUiEnv();
  return useMutation({
    mutationFn: (body: { run_id: string | null; refs: EvidenceRef[]; window_to: string }) => {
      if (!port.actions) {
        throw new Error('当前宿主不提供实时重跑');
      }
      return port.actions.rerunEvidence(ref, body);
    },
  });
}
