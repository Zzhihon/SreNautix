import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  CONTRACT_VERSION,
  type ProposalCreate,
  type ResearchManifest,
  type ResearchOutput,
  type Severity,
} from '@srenautix/contract';
import { logger } from '../log.js';
import { dailyGate, type BudgetConfig } from '../llm/budget.js';
import { REDACTION_VERSION } from '../llm/redact.js';
import type { ModelLayer } from '../llm/session.js';
import type { NewEvent } from '../store/outbox.js';
import type { Tool } from '../tools/box.js';
import { runStageB, type ResearchLimits, type ResearchRunResult, type ResearchState } from './controller.js';
import { HubError, type ClaimedTask, type HubClient, type TaskContext } from './hub.js';
import { HubQueryRunner } from './hub-query.js';
import type { WorkerMetrics } from './metrics.js';
import type { Language } from '../prompts/index.js';
import type { WorkerStore } from './store.js';
import type { ResearchCase, Subgraph } from './types.js';

// worker 的阶段 B 循环：认领 → 读取输入 → 预算门控 → 研判（续租）→ 提议中转 → 写结果与事件 → 释放任务。
// 一次研判的任何错误只影响这一个任务：记为 failed 并发布 research.failed，阶段 A 的消息依然有效。

export interface WorkerDeps {
  hub: HubClient;
  store: WorkerStore;
  layer: ModelLayer;
  metrics: WorkerMetrics;
  language: Language;
  limits: ResearchLimits;
  budget: BudgetConfig;
  tools: () => Promise<{ tools: Tool[]; close(): Promise<void> }>;
  workerId: string;
  clusterId: string;
  codeSha: string;
  claimWaitS: number;
}

/** 两跳拓扑邻域 → 研判子图：从根因出发按无向边计算跳数 */
export function toSubgraph(ctx: TaskContext): Subgraph {
  const inc = ctx.incident;
  const root = inc.root.component;
  const candidates = new Set(inc.candidates.map((c) => c.component));
  const members = new Set(inc.components);
  const hops = new Map<string, number>();
  const starts = root ? [root] : inc.components;
  for (const s of starts) {
    hops.set(s, 0);
  }
  let frontier = [...starts];
  for (let h = 1; h <= 2 && frontier.length; h++) {
    const next: string[] = [];
    for (const e of ctx.topology.edges) {
      for (const [a, b] of [
        [e.from, e.to],
        [e.to, e.from],
      ] as const) {
        if (frontier.includes(a) && !hops.has(b)) {
          hops.set(b, h);
          next.push(b);
        }
      }
    }
    frontier = next;
  }
  const alertsByComponent = new Map<string, string[]>();
  for (const m of inc.members.filter((x) => x.left_version === null)) {
    if (m.component) {
      alertsByComponent.set(m.component, [...(alertsByComponent.get(m.component) ?? []), m.alert_id]);
    }
  }
  const nodes = ctx.topology.nodes.map((n) => ({
    component: n.key,
    kind: n.kind,
    namespace: n.namespace,
    name: n.name,
    role: (n.key === root
      ? 'root'
      : candidates.has(n.key)
        ? 'candidate'
        : members.has(n.key)
          ? 'member'
          : 'neighbor') as Subgraph['nodes'][number]['role'],
    alerts: alertsByComponent.get(n.key) ?? [],
    hops: Math.min(2, hops.get(n.key) ?? 2),
  }));
  // 事件涉及、但拓扑中没有对象的组件（例如命名空间伪组件）也作为节点
  const known = new Set(nodes.map((n) => n.component));
  for (const k of new Set([...inc.components, ...candidates, ...(root ? [root] : [])])) {
    if (!known.has(k)) {
      const i = k.indexOf(':');
      const rest = k.slice(i + 1);
      const slash = rest.indexOf('/');
      nodes.push({
        component: k,
        kind: k.slice(0, i),
        namespace: slash < 0 ? null : rest.slice(0, slash),
        name: slash < 0 ? rest : rest.slice(slash + 1),
        role: k === root ? 'root' : candidates.has(k) ? 'candidate' : 'member',
        alerts: alertsByComponent.get(k) ?? [],
        hops: hops.get(k) ?? 0,
      });
    }
  }
  return {
    topology_version: ctx.topology.version,
    root: root ?? null,
    nodes,
    edges: ctx.topology.edges.map((e) => ({
      from: e.from,
      to: e.to,
      relation: e.relation,
      provenance: e.provenance,
      confidence: e.confidence,
      scope: e.scope,
    })),
  };
}

/** 中心返回的研判输入 → 阶段 B 的输入；动作只保留目标类型出现在子图中的 */
export function toResearchCase(ctx: TaskContext, tools: Tool[], now: number): ResearchCase {
  const subgraph = toSubgraph(ctx);
  const kinds = new Set(subgraph.nodes.map((n) => n.kind));
  const actions = ctx.catalog.actions.filter(
    (a) => kinds.has(a.target.kind) || (a.target.kinds ?? []).some((k) => kinds.has(k.kind)),
  );
  return {
    incident: ctx.incident,
    stageA: ctx.stage_a,
    subgraph,
    feedback: ctx.feedback,
    actions: actions as unknown as ResearchCase['actions'],
    runbooks: ctx.stage_a.runbooks,
    knowledge: ctx.knowledge,
    // 只用研判开始之前已解决的案例（与回放的防泄漏规则相同）
    cases: ctx.cases.filter((c) => Date.parse(c.resolved_at) < now),
    templates: ctx.templates,
    tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    asOf: new Date(now).toISOString(),
  };
}

/** 提议的幂等键：hash(incident_id, run_id, action, canonical_params)（DESIGN §2.4） */
export function proposalKey(incidentId: string, runId: string, action: string, params: unknown): string {
  return createHash('sha256')
    .update(`${incidentId}\n${runId}\n${action}\n${canonicalize(params)}`)
    .digest('hex');
}

export class WorkerService {
  private stopped = false;

  constructor(private readonly d: WorkerDeps) {}

  stop(): void {
    this.stopped = true;
  }

  /** 认领循环，直到 stop()；每次只处理一个任务（多副本横向扩展） */
  async run(signal: AbortSignal): Promise<void> {
    while (!this.stopped && !signal.aborted) {
      let task: ClaimedTask | null;
      try {
        task = await this.d.hub.claim(this.d.workerId, this.d.claimWaitS, signal);
      } catch (e) {
        if (signal.aborted) {
          return;
        }
        logger.warn('认领研判任务失败，5 秒后重试', { error: e });
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      if (task) {
        await this.handle(task, signal);
      }
    }
  }

  /** 处理一个任务；返回写入的研判状态 */
  async handle(task: ClaimedTask, outer: AbortSignal): Promise<'completed' | 'stage_a_only' | 'failed'> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(outer.reason);
    outer.addEventListener('abort', onAbort, { once: true });
    const beat = setInterval(() => {
      this.d.hub.heartbeat(task.run_id, task.worker_id).catch((e: unknown) => {
        if (e instanceof HubError && e.status === 409) {
          logger.warn('研判任务租约丢失，中止', { run_id: task.run_id });
          ctrl.abort(new Error('lease_lost'));
          return;
        }
        logger.warn('研判任务续租失败', { run_id: task.run_id, error: e });
      });
    }, 60_000);
    beat.unref();
    try {
      return await this.research(task, ctrl.signal);
    } finally {
      clearInterval(beat);
      outer.removeEventListener('abort', onAbort);
    }
  }

  private async research(task: ClaimedTask, signal: AbortSignal): Promise<'completed' | 'stage_a_only' | 'failed'> {
    const d = this.d;
    const ctx = await d.hub.context(task.run_id);
    const inc = ctx.incident;
    await d.store.startRun({
      runId: task.run_id,
      incidentId: inc.incident_id,
      incidentVersion: inc.incident_version,
      clusterId: inc.cluster_id,
      reason: task.reason,
      evidenceFingerprint: ctx.stage_a.evidence_fingerprint,
    });
    const base = { incident_id: inc.incident_id, incident_version: inc.incident_version, run_id: task.run_id };
    const used = await d.store.dailyTokens();
    d.metrics.budgetUsedRatio.set({ scope: 'daily' }, used / d.budget.dailyTokens);
    const gate = dailyGate(d.budget, used, inc.severity as Severity);
    if (!gate.allowed) {
      d.metrics.budgetStops.inc({ reason: gate.reason });
      const msg =
        gate.reason === 'daily_warn'
          ? `当日模型 token 已用 ${used}，达到上限的 ${d.budget.dailyWarnRatio * 100}%，warning 及以下事件只出阶段 A`
          : `当日模型 token 已用 ${used}，达到上限 ${d.budget.dailyTokens}`;
      await this.finishFailed(task, ctx, 'stage_a_only', 'budget_exhausted', msg, null);
      return 'stage_a_only';
    }
    const previous = await d.store.previous(inc.incident_id);
    const toolSet = await d.tools();
    let res: ResearchRunResult;
    const steps: Array<{ state: string; started_at: string; finished_at: string | null }> = [];
    const rc = toResearchCase(ctx, toolSet.tools, Date.now());
    try {
      const deadline = Math.min(d.limits.deadlineMs, Date.parse(task.deadline_at) - Date.now());
      res = await runStageB(
        { runId: task.run_id, rc, previous, signal },
        {
          layer: d.layer,
          metrics: d.metrics,
          language: d.language,
          limits: { ...d.limits, deadlineMs: deadline },
          tools: toolSet.tools,
          query: new HubQueryRunner(d.hub, task.run_id),
          replay: false,
          now: () => Date.now(),
        },
        {
          step: async (state: ResearchState, startedAt: string, finishedAt: string | null) => {
            steps.push({ state, started_at: startedAt, finished_at: finishedAt });
            await d.store.step(task.run_id, state);
          },
          llmCall: (r) => d.store.llmCall(r),
          toolCall: (r) => d.store.toolCall(task.run_id, r),
        },
      );
    } catch (e) {
      await toolSet.close();
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      logger.error('研判内部错误', { run_id: task.run_id, error: e });
      await this.finishFailed(task, ctx, 'failed', signal.aborted ? 'deadline' : 'internal', message, null);
      return 'failed';
    }
    await toolSet.close();
    const output = res.output ? await this.submitProposals(task, ctx, res.output) : null;
    const manifest = this.manifest(task, ctx, rc, res);
    const events: NewEvent[] = output
      ? [
          {
            type: 'research.concluded',
            clusterId: inc.cluster_id,
            payload: { ...base, evidence_fingerprint: ctx.stage_a.evidence_fingerprint, output },
          },
        ]
      : [
          {
            type: 'research.failed',
            clusterId: inc.cluster_id,
            payload: {
              ...base,
              kind: res.error?.kind ?? 'internal',
              message: (res.error?.message ?? '').slice(0, 2000),
            },
          },
        ];
    await d.store.finishRun({
      runId: task.run_id,
      clusterId: inc.cluster_id,
      state: res.state,
      stopReason: res.stopReason,
      output,
      error: res.error,
      stillConsistent: res.stillConsistent,
      estimatedInput: 0,
      input: res.ledger.input,
      output_tokens: res.ledger.output,
      cost: res.ledger.cost,
      currency: d.layer.routes[0]?.route.price.currency ?? 'USD',
      steps,
      manifest,
      checkCards: res.book.allCards
        .filter((c) => c.hypothesisId !== null)
        .map((c) => ({ ref: c.ref, hypothesisId: c.hypothesisId as string, judgedBy: c.judgedBy, result: c.result })),
      events,
    });
    await d.hub.finish(task.run_id, task.worker_id, res.state);
    await this.reportBudget();
    const ratios = await d.store.weeklyRatios();
    if (ratios.untested !== null) {
      d.metrics.untestedCompetitorRatio.set(ratios.untested);
    }
    if (ratios.zeroTool !== null) {
      d.metrics.zeroToolRatio.set(ratios.zeroTool);
    }
    logger.info('研判完成', {
      run_id: task.run_id,
      incident_id: inc.incident_id,
      state: res.state,
      stop: res.stopReason,
      conclusion_level: output?.conclusion.level ?? null,
      tokens: res.ledger.input + res.ledger.output,
    });
    return res.state;
  }

  private async reportBudget(): Promise<void> {
    const used = await this.d.store.dailyTokens();
    const ratio = used / this.d.budget.dailyTokens;
    this.d.metrics.budgetUsedRatio.set({ scope: 'daily' }, ratio);
    await this.d.hub.reportBudget(ratio);
  }

  private async finishFailed(
    task: ClaimedTask,
    ctx: TaskContext,
    state: 'stage_a_only' | 'failed',
    kind: string,
    message: string,
    output: ResearchOutput | null,
  ): Promise<void> {
    const inc = ctx.incident;
    await this.d.store.finishRun({
      runId: task.run_id,
      clusterId: inc.cluster_id,
      state,
      stopReason: kind === 'budget_exhausted' ? 'budget' : null,
      output,
      error: { kind, message },
      stillConsistent: false,
      estimatedInput: 0,
      input: 0,
      output_tokens: 0,
      cost: 0,
      currency: this.d.layer.routes[0]?.route.price.currency ?? 'USD',
      steps: [],
      manifest: null,
      checkCards: [],
      events: [
        {
          type: 'research.failed',
          clusterId: inc.cluster_id,
          payload: {
            incident_id: inc.incident_id,
            incident_version: inc.incident_version,
            run_id: task.run_id,
            kind,
            message: message.slice(0, 2000),
          },
        },
      ],
    });
    await this.d.hub.finish(task.run_id, task.worker_id, state);
    await this.reportBudget();
  }

  /** 研判产出的提议经 server 的提议中转写入；接受后把 proposal_id 填回输出 */
  private async submitProposals(task: ClaimedTask, ctx: TaskContext, out: ResearchOutput): Promise<ResearchOutput> {
    const inc = ctx.incident;
    const notes = [...out.validation_notes];
    const proposals: ResearchOutput['proposals'] = [];
    for (const p of out.proposals) {
      const create: ProposalCreate = {
        incident_id: inc.incident_id,
        binding: {
          incident_version: inc.incident_version,
          root_component: inc.root.component ?? '',
          evidence_fingerprint: ctx.stage_a.evidence_fingerprint,
        },
        action: p.action_id,
        params: p.params,
        research_run_id: task.run_id,
        rule_id: null,
        hypothesis_id: p.hypothesis_id,
        evidence_refs: out.hypotheses.find((h) => h.id === p.hypothesis_id)?.supporting ?? [],
        expected_effect: p.expected_effect,
      };
      const r = await this.d.hub.propose(create, proposalKey(inc.incident_id, task.run_id, p.action_id, p.params));
      if (r.rejected) {
        notes.push(`提议 ${p.action_id} 被提议中转拒绝：${r.rejected}`);
      }
      proposals.push({ ...p, proposal_id: r.proposal?.proposal_id ?? null });
    }
    return { ...out, proposals, validation_notes: notes };
  }

  private manifest(task: ClaimedTask, ctx: TaskContext, rc: ResearchCase, res: ResearchRunResult): ResearchManifest {
    const phases = Object.keys(res.promptHashes);
    return {
      run_id: task.run_id,
      incident_id: ctx.incident.incident_id,
      incident_version: ctx.incident.incident_version,
      code_sha: this.d.codeSha,
      pack_lock: ctx.pack_lock,
      contract_version: CONTRACT_VERSION,
      prompt_hashes: Object.fromEntries(phases.map((p) => [p, res.promptHashes[p] as string])),
      routes: res.session.routeUses,
      topology_version: ctx.topology.version,
      snapshot_id: null,
      redaction_version: REDACTION_VERSION,
      retrieved_cases: rc.cases.map((c) => c.incident_id),
      retrieved_knowledge: rc.knowledge.map((k) => k.id),
      evidence_map: res.book.evidenceMap(),
      egress: res.session.egress,
    };
  }
}
