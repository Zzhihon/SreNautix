import type { ConcludeOutput, HypothesizeOutput, ReasonGroupCode, ResearchOutput } from '@srenautix/contract';
import { bindSchema, modelSchema, type DynamicEnums } from '../llm/schema.js';
import type { LlmCallRecord, ModelLayer, ModelSession, StructuredResult } from '../llm/session.js';
import { ResearchLedger } from '../llm/budget.js';
import { isLastResort } from '../llm/routes.js';
import type { LlmPhase } from '../llm/types.js';
import { promptHash, type Language } from '../prompts/index.js';
import { ToolBox, type Tool, type ToolCallRecord } from '../tools/box.js';
import type { Window } from '../tools/limits.js';
import {
  checkKey,
  inferCheckTemplates,
  runCheck,
  vetCheck,
  type ExecutedCheck,
  type NextCheck,
  type QueryRunner,
} from './checks.js';
import { changeCap } from './change-cap.js';
import { controlCap } from './common-cause.js';
import type { EvidenceBook } from './evidence.js';
import { deriveDisposition } from './disposition.js';
import { incidentBook, incidentCorpus, incidentSupplement } from './incident.js';
import { judgeLadder, requiredCap } from './ladder.js';
import { missingRequired } from '../stage-a/required.js';
import { Ledger, subgraphFrame } from './ledger.js';
import type { WorkerMetrics } from './metrics.js';
import { componentChoices, concludeItems, hypothesizeItems, promptParts } from './prompt.js';
import type { PreviousRun, ResearchCase } from './types.js';
import { auditModelText, correctCauseScope, renumberRecommendations, validateConclusion } from './validate.js';

// 阶段 B 控制器（DESIGN §7.2–§7.4）：hypothesize → discriminate（可多轮）→ conclude。
// 模型只提出假设、检查与结论文字；账本状态、停止规则、结论阶梯与校验都由代码决定。

export type ResearchState = 'hypothesize' | 'discriminate' | 'conclude' | 'completed' | 'stage_a_only' | 'failed';
/** 检验循环的停止原因：原因码登记表的 research_stop 分组 */
export type StopReason = ReasonGroupCode<'research_stop'>;
/** 研判失败类型：原因码登记表的 research_failure 分组（ResearchFailed.kind） */
export type FailureKind = ReasonGroupCode<'research_failure'>;

export interface ResearchLimits {
  /** 阶段 B 的硬期限（DESIGN §7.2 默认 8 分钟） */
  deadlineMs: number;
  /** discriminate 的最多轮数 */
  maxSteps: number;
  /** 每轮最多执行的检查数（排名前 N 的假设各一项） */
  checksPerStep: number;
  /** 每次研判最多的工具调用次数 */
  toolCalls: number;
  /** conclude 预留的时间：剩余时间少于它时不再开始新一轮检查 */
  concludeReserveMs: number;
}

export const DEFAULT_LIMITS: ResearchLimits = {
  deadlineMs: 8 * 60_000,
  maxSteps: 3,
  checksPerStep: 3,
  toolCalls: 12,
  concludeReserveMs: 120_000,
};

export interface RunSink {
  step(state: ResearchState, startedAt: string, finishedAt: string | null): Promise<void>;
  llmCall(r: LlmCallRecord): Promise<void>;
  toolCall(r: ToolCallRecord): Promise<void>;
}

export interface ResearchEnv {
  layer: ModelLayer;
  metrics: WorkerMetrics;
  language: Language;
  limits: ResearchLimits;
  tools: Tool[];
  query: QueryRunner | null;
  /** 回放时为 true：只读当前状态的工具（live）不可用，工具只能查询快照窗口 */
  replay: boolean;
  now(): number;
}

export interface ResearchRunInput {
  runId: string;
  rc: ResearchCase;
  previous: PreviousRun | null;
  signal: AbortSignal;
  /** 兜底路由的每日额度（ADR 0152）；不给出时本次研判不使用兜底路由 */
  lastResort?: { dailyTokens: number; usedToday: number };
}

export interface ResearchRunResult {
  state: 'completed' | 'stage_a_only' | 'failed';
  stopReason: StopReason | null;
  output: ResearchOutput | null;
  error: { kind: FailureKind; message: string } | null;
  book: EvidenceBook;
  checks: ExecutedCheck[];
  session: ModelSession;
  ledger: ResearchLedger;
  /** 本次运行实际使用的模型调用阶段 → 提示词哈希 */
  promptHashes: Record<string, string>;
  stillConsistent: boolean;
}

/** 允许工具查询的时间窗口：日常研判为事件窗口前后各 24 小时（不晚于当前），回放为快照窗口 */
export function toolBounds(rc: ResearchCase, replay: boolean, now: number): Window {
  const first = Date.parse(rc.incident.first_firing_at);
  const end = rc.incident.ended_at ? Date.parse(rc.incident.ended_at) : Date.parse(rc.asOf);
  if (replay) {
    return { from: first - 60 * 60_000, to: Math.min(end, Date.parse(rc.asOf)) };
  }
  return { from: first - 24 * 3600_000, to: Math.min(now, end + 24 * 3600_000) };
}

/** 结构化调用失败 → 运行的失败类型与停止原因（主动优化的控制器共用） */
export function failure(r: Extract<StructuredResult<unknown>, { ok: false }>): {
  kind: FailureKind;
  message: string;
  stop: StopReason | null;
  stageAOnly: boolean;
} {
  switch (r.reason) {
    case 'budget':
      return { kind: 'budget_exhausted', message: r.detail, stop: 'budget', stageAOnly: true };
    case 'deadline':
      return { kind: 'deadline', message: r.detail, stop: 'deadline', stageAOnly: false };
    case 'failure_domain':
      return { kind: 'breaker_open', message: r.detail, stop: 'model_unavailable', stageAOnly: true };
    case 'egress_blocked':
      return { kind: 'model_unavailable', message: r.detail, stop: 'model_unavailable', stageAOnly: true };
    case 'model_output_invalid':
      return {
        kind: 'invalid_output',
        message: `模型输出无效：${r.attempts.join('；')}`.slice(0, 2000),
        stop: 'model_unavailable',
        stageAOnly: false,
      };
    case 'model_unavailable':
      return {
        kind: 'model_unavailable',
        message: r.detail.slice(0, 2000),
        stop: 'model_unavailable',
        stageAOnly: false,
      };
  }
}

/** 结论所用的路由是兜底路由时，研判输出的 last_resort_route；常规路由为空对象 */
export function lastResortRoute(
  layer: ModelLayer,
  routeId: string,
): Pick<ResearchOutput, 'last_resort_route'> | Record<string, never> {
  const r = layer.route(routeId).route;
  return isLastResort(r) ? { last_resort_route: { route_id: r.id, model: r.model } } : {};
}

export async function runStageB(input: ResearchRunInput, env: ResearchEnv, sink: RunSink): Promise<ResearchRunResult> {
  const { rc, previous, runId } = input;
  const started = env.now();
  const deadline = started + env.limits.deadlineMs;
  const book = incidentBook(rc);
  const ledger = new Ledger(book, subgraphFrame(rc.subgraph));
  const budgetLedger = new ResearchLedger(env.layer.opts.budget);
  const notes: string[] = [];
  const checks: ExecutedCheck[] = [];
  const promptHashes: Record<string, string> = {};
  const incidentComponents = [
    ...new Set([...rc.incident.components, ...rc.incident.candidates.map((c) => c.component)]),
  ];
  const session = env.layer.session({
    runId,
    incidentComponents,
    deadline,
    signal: input.signal,
    ledger: budgetLedger,
    record: (r) => sink.llmCall(r),
    ...(input.lastResort ? { lastResort: input.lastResort } : {}),
  });
  const base = { book, checks, session, ledger: budgetLedger, promptHashes };
  let state: ResearchState = 'hypothesize';
  let stepStart = new Date(started).toISOString();
  const move = async (to: ResearchState) => {
    const now = new Date(env.now()).toISOString();
    await sink.step(state, stepStart, now);
    state = to;
    stepStart = now;
  };
  const finish = async (r: Omit<ResearchRunResult, keyof typeof base>): Promise<ResearchRunResult> => {
    // 指纹门控直接结束时没有执行任何步骤
    if (state !== 'completed') {
      await sink.step(state, stepStart, new Date(env.now()).toISOString());
    }
    env.metrics.researchRuns.inc({ outcome: r.state, stop: r.stopReason ?? '' });
    env.metrics.researchDuration.observe((env.now() - started) / 1000);
    return { ...base, ...r };
  };

  // 指纹门控（DESIGN §7.4）：证据指纹不变、之后没有新的反馈时，只刷新证据卡并追加"仍然一致"，不调用模型
  if (previous && previous.evidenceFingerprint === rc.stageA.evidence_fingerprint) {
    const newFeedback = rc.feedback.some((f) => f.linked && Date.parse(f.created_at) > Date.parse(previous.finishedAt));
    if (!newFeedback) {
      const output: ResearchOutput = {
        ...previous.output,
        validation_notes: [
          ...previous.output.validation_notes,
          `证据指纹 ${rc.stageA.evidence_fingerprint.slice(0, 19)} 与上一次研判相同，仍然一致，没有调用模型`,
        ],
        stop_reason: 'no_change',
      };
      state = 'completed';
      return finish({ state: 'completed', stopReason: 'no_change', output, error: null, stillConsistent: true });
    }
  }

  // 本次研判可能使用的路由中最小的上下文：常规路由，或全部常规路由因故障域提前熔断时的兜底路由（ADR 0152）
  const contextTokens = Math.min(...session.pool.map((r) => r.profile.context_tokens));
  const parts = promptParts(env.language, rc, book, contextTokens, previous);
  const bounds = toolBounds(rc, env.replay, env.now());
  const tools = env.replay ? env.tools.filter((t) => !t.live) : env.tools;
  const box = new ToolBox(tools, env.metrics, env.limits.toolCalls);
  const enums = (): DynamicEnums => ({
    components: componentChoices(rc),
    evidence_refs: book.refs(),
    sample_refs: book.sampleRefs(),
    check_templates: [...rc.templates.map((t) => t.id), ...box.tools.map((t) => t.name)],
    runbooks: rc.runbooks,
    actions: rc.actions.map((a) => a.id),
  });
  const output = (name: 'hypothesize' | 'conclude') => {
    const e = enums();
    const b = bindSchema(modelSchema(name), e);
    return {
      name: `${name}_output`,
      schema: b.portable,
      full: b.full,
      // next_checks 缺少 template 时按条目里的检查 id 补全，补不出才删除这一条（ADR 0127）
      // conclude 的 recommendations id 不合规时按顺序重新编号，不删除建议
      prepare:
        name === 'hypothesize'
          ? (v: unknown, n: string[]) => inferCheckTemplates(v, e.check_templates ?? [], n)
          : (v: unknown, n: string[]) => renumberRecommendations(v, n),
    };
  };
  const hash = (phase: LlmPhase, step: 'hypothesize' | 'conclude') => {
    promptHashes[phase] = promptHash(env.language, step);
  };

  if (previous) {
    ledger.seed(previous.output.hypotheses);
  }
  // 阶段 A 的规则结论作为假设 h7–h9 进入账本（ADR 0178），与模型假设一样经过区分性检查
  const ruleConclusions = rc.stageA.rule_conclusions ?? [];
  if (ruleConclusions.length) {
    const lang = env.language === 'zh' ? 'zh-CN' : 'en';
    ledger.seedRules(ruleConclusions, (r) => r.mechanism[lang] ?? r.mechanism['zh-CN'] ?? r.mechanism.en ?? '', notes);
    ledger.evaluate();
  }

  const candidateScore = (c: string) => rc.incident.candidates.find((x) => x.component === c)?.score ?? 0;

  // conclude
  const conclude = async (stopReason: StopReason): Promise<ResearchRunResult> => {
    await move('conclude');
    hash('conclude', 'conclude');
    const concluded = await session.structured<ConcludeOutput>(
      'conclude',
      { items: concludeItems(env.language, parts, ledger, book), maxOutputTokens: 8000, temperature: 0 },
      output('conclude'),
    );
    if (!concluded.ok) {
      const f = failure(concluded);
      return finish({
        state: f.stageAOnly ? 'stage_a_only' : 'failed',
        stopReason: f.stop,
        output: null,
        error: { kind: f.kind, message: f.message },
        stillConsistent: false,
      });
    }
    notes.push(...concluded.notes);
    const v = validateConclusion(concluded.value, rc, book, ledger);
    notes.push(...v.notes);
    // 最低取证集合的缺口（ADR 0153）：阶段 A 记录的缺口中，区分性检查也没有补上的
    const gaps = missingRequired(
      rc.stageA.required_evidence,
      book.allCards.map((c) => c.result),
    );
    // 档位的三项限制：最低取证集合（ADR 0153）、把根因归到变更上时变更的关联分级（ADR 0169），
    // 以及共因结论的对照证据（ADR 0179，规则判定改选之后执行）
    const ladder = controlCap(
      changeCap(
        requiredCap(judgeLadder(ledger, v.chosen, rc.incident, ledger.list().length > 0, v.chosenBy), gaps),
        v.chosen,
        rc.incident,
        book,
        rc.subgraph,
      ),
      v.chosen,
      book,
    );
    notes.push(...ladder.notes);
    const undeterminedReason =
      v.undeterminedReason ?? (gaps.length ? `最低取证集合没有覆盖：${gaps.join('；')}`.slice(0, 400) : null);
    // 处置在档位确定之后由代码推导，模型的取值是输入之一（ADR 0138、0162）
    const disposition = deriveDisposition({
      model: concluded.value.disposition,
      incident: rc.incident,
      stageA: rc.stageA,
      level: ladder.level,
      root: v.chosen?.rootComponent ?? null,
      ruleSupport: ladder.detail?.support_refs.length ?? 0,
      proposals: v.proposals.length,
      cards: book.allCards,
      facts: rc.dispositionFacts,
      gaps,
    });
    notes.push(...disposition.notes);
    // ignore 的依据成立时模型的提议不生效，只记在研判备注里（ADR 0168）
    const proposals = disposition.dropProposals ? [] : v.proposals;
    if (disposition.dropProposals) {
      notes.push(`不生效的提议：${v.proposals.map((p) => `${p.action_id}（${p.hypothesis_id}）`).join('、')}`);
    }
    const leader = ledger.ranked(candidateScore)[0];
    const untested = v.chosen ? !ledger.competitorTested(v.chosen) : false;
    env.metrics.conclusions.inc({
      level: ladder.level,
      untested_competitor: String(untested && ledger.list().length > 1),
      zero_checks: String(checks.length === 0),
    });
    if (leader && v.chosen && leader.id !== v.chosen.id) {
      notes.push(`结论选中 ${v.chosen.id}，账本排名第一的是 ${leader.id}`);
    }
    // 根因范围在档位确定之后按确定性依据校正（ADR 0170），自愈 PR 的准入读它
    const scope = correctCauseScope({
      model: concluded.value.cause_scope,
      level: ladder.level,
      root: v.chosen?.rootComponent ?? null,
      facts: rc.dispositionFacts,
    });
    notes.push(...scope.notes);
    const draft: ResearchOutput = {
      disposition: disposition.disposition,
      ...(disposition.basis ? { ignore_basis: disposition.basis } : {}),
      conclusion: {
        level: ladder.level,
        hypothesis_id: v.chosen?.id ?? null,
        root_component: v.chosen?.rootComponent ?? null,
        undetermined_reason: undeterminedReason,
        consistency: ladder.consistency,
        ...(ladder.detail ? { consistency_detail: ladder.detail } : {}),
        cause_scope: scope.scope,
      },
      // 按排名排列的全部假设，被推翻的在最后（ADR 0133）
      hypotheses: ledger.toContract(candidateScore),
      next_checks: checks.map((x) => ({
        hypothesis_id: x.check.hypothesis_id,
        type: x.check.type,
        template: x.check.template,
        args: x.args,
        refutes_if: x.check.refutes_if,
        purpose: x.check.purpose,
        result_ref: x.card?.ref ?? null,
        outcome: x.outcome,
        error: x.error,
      })),
      situation: v.situation,
      summary: v.summary,
      recommendations: v.recommendations,
      proposals: proposals.map((p) => ({ ...p, proposal_id: null })),
      validation_notes: notes,
      stop_reason: stopReason,
      // 检查产生的卡随输出发布，消息与 issue 不依赖 worker 的运行明细；序列只在运行明细中保存
      check_cards: book.allCards
        .filter((c) => c.hypothesisId !== null)
        .slice(0, 12)
        .map((c) => ({ ...c.result, series: [] })),
      evidence_index: book.evidenceMap(),
      // 结论来自兜底路由时写明路由与模型，消息上据此标注（ADR 0152）
      ...lastResortRoute(env.layer, concluded.routeId),
    };
    // 模型文字的数值审计（ADR 0125）
    const audited = auditModelText(draft, incidentCorpus(rc, book));
    notes.push(...audited.notes);
    const result: ResearchOutput = { ...audited.output, validation_notes: notes };
    return finish({ state: 'completed', stopReason, output: result, error: null, stillConsistent: false });
  };

  // 研判子图没有任何组件（事件没有根因，例如 unlabelled）：没有可以作为根因的组件，hypothesize 的输出必然不合 schema。
  // 不提出假设，直接结论，档位为 undetermined
  if (rc.subgraph.nodes.length === 0) {
    notes.push('研判子图没有组件（事件没有根因），不提出假设，直接结论');
    return conclude('no_change');
  }

  // hypothesize
  const hypothesize = async (): Promise<StructuredResult<HypothesizeOutput>> => {
    hash('hypothesize', 'hypothesize');
    return session.structured<HypothesizeOutput>(
      'hypothesize',
      {
        items: hypothesizeItems(env.language, parts, ledger, book),
        maxOutputTokens: 6000,
        temperature: 0,
      },
      output('hypothesize'),
    );
  };
  let hyp = await hypothesize();
  // 第一轮 hypothesize 实际用掉的输入，作为再提一轮与结论各需多少输入的估计（ADR 0099）
  const roundInput = budgetLedger.input;
  if (!hyp.ok) {
    const f = failure(hyp);
    return finish({
      state: f.stageAOnly ? 'stage_a_only' : 'failed',
      stopReason: f.stop,
      output: null,
      error: { kind: f.kind, message: f.message },
      stillConsistent: false,
    });
  }
  ledger.merge(hyp.value.hypotheses, notes);
  notes.push(...hyp.notes);
  ledger.applyFeedback(rc.feedback, previous?.output.conclusion.root_component ?? null, notes);
  ledger.evaluate();

  // discriminate
  const done = new Set<string>();
  let stopReason: StopReason;
  let unchanged = 0;
  let lastSignature = ledger.signature();
  for (let step = 1; ; step++) {
    const leader = ledger.ranked(candidateScore)[0];
    if (ledger.leaderSettled(leader)) {
      stopReason = 'leader_supported';
      break;
    }
    if (step > env.limits.maxSteps) {
      stopReason = 'step_limit';
      break;
    }
    if (env.now() > deadline - env.limits.concludeReserveMs) {
      stopReason = 'deadline';
      break;
    }
    // 规则判定的假设不在其中：它们不由检查检验，只由检查推翻（ADR 0178）
    const openEntries = ledger
      .ranked(candidateScore)
      .filter((e) => !e.pinned && e.status !== 'refuted' && e.checksRun === 0 && e.rule === undefined)
      .slice(0, env.limits.checksPerStep);
    const open = new Set(openEntries.map((e) => e.id));
    // 模型一项检查都没有给出：事件的组件有适用的卡片检查时，由控制器按相关性补选（ADR 0137）
    let proposed = hyp.value.next_checks;
    if (proposed.length === 0) {
      proposed = incidentSupplement(rc, ledger, openEntries, done, env.language);
      if (proposed.length) {
        notes.push(
          `第 ${step} 轮 hypothesize 没有给出 next_checks，控制器按相关性补选 ${proposed.length} 项卡片检查：${proposed
            .map((c) => `${c.template}（假设 ${c.hypothesis_id}）`)
            .join('、')}`,
        );
      }
    }
    const planned: Array<{ check: NextCheck; args: Record<string, unknown> }> = [];
    const seen = new Set<string>();
    for (const c of proposed) {
      if (!open.has(c.hypothesis_id) || seen.has(c.hypothesis_id) || done.has(checkKey(c))) {
        continue;
      }
      const vet = vetCheck(c, rc.templates, box);
      if ('error' in vet) {
        notes.push(`检查 ${c.template}（假设 ${c.hypothesis_id}）：${vet.error}，未执行`);
        checks.push({ check: c, args: {}, outcome: 'failed', card: null, tool: null, error: vet.error });
        done.add(checkKey(c));
        continue;
      }
      seen.add(c.hypothesis_id);
      if (vet.note) {
        notes.push(vet.note);
      }
      planned.push({ check: vet.check, args: vet.args });
    }
    if (planned.length === 0) {
      stopReason = 'no_change';
      break;
    }
    await move('discriminate');
    for (const p of planned) {
      done.add(checkKey(p.check));
      const executed = await runCheck(
        {
          templates: rc.templates,
          clusterId: rc.incident.cluster_id,
          book,
          ledger,
          box,
          query: env.query,
          session,
          language: env.language,
          bounds,
          signal: input.signal,
          onTool: (r) => sink.toolCall(r),
        },
        p.check,
        p.args,
        checks.length + 1,
      );
      checks.push(executed);
      // 失败的检查（参数被拒绝、数据源报错、结果无法判定成卡）不算检验过；测的信号不属于假设机制的检查记为无关（ADR 0133）
      if (executed.outcome !== 'failed' && executed.card) {
        const unrelated = ledger.noteCheckRun(p.check.hypothesis_id, executed.card.ref);
        if (unrelated) {
          notes.push(unrelated);
        }
      }
      env.metrics.checks.inc({ type: p.check.type, outcome: executed.outcome });
      if (executed.error) {
        notes.push(`检查 ${p.check.template}（假设 ${p.check.hypothesis_id}）失败：${executed.error}`);
      }
    }
    ledger.evaluate();
    const sig = ledger.signature();
    unchanged = sig === lastSignature ? unchanged + 1 : 0;
    lastSignature = sig;
    if (unchanged >= 2) {
      stopReason = 'no_change';
      break;
    }
    const lead = ledger.ranked(candidateScore)[0];
    if (ledger.leaderSettled(lead)) {
      stopReason = 'leader_supported';
      break;
    }
    if (step >= env.limits.maxSteps) {
      stopReason = 'step_limit';
      break;
    }
    if (env.now() > deadline - env.limits.concludeReserveMs) {
      stopReason = 'deadline';
      break;
    }
    // 研判剩余预算不够再提一轮假设并留出结论所需时直接结论，不让结论因超限失败
    if (budgetLedger.remaining() < 2 * roundInput) {
      notes.push(
        `研判剩余输入预算 ${budgetLedger.remaining()} token，不够再提出一轮假设（约 ${roundInput} token）并留出结论所需，直接结论`,
      );
      stopReason = 'budget';
      break;
    }
    // 下一轮：带着账本重新提出假设与检查
    await move('hypothesize');
    const next = await hypothesize();
    if (!next.ok) {
      const f = failure(next);
      notes.push(`第 ${step + 1} 轮 hypothesize 未完成：${f.message.slice(0, 300)}`);
      stopReason = f.stop ?? 'model_unavailable';
      break;
    }
    hyp = next;
    ledger.merge(next.value.hypotheses, notes);
    notes.push(...next.notes);
    ledger.applyFeedback(rc.feedback, previous?.output.conclusion.root_component ?? null, notes);
    ledger.evaluate();
  }

  return conclude(stopReason);
}
