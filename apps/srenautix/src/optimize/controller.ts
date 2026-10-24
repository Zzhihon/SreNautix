import type {
  FindingConclusion,
  FindingHypothesis,
  OptimizationCandidate,
  OptimizationOutput,
  OptimizeConcludeOutput,
  OptimizeHypothesizeOutput,
} from '@srenautix/contract';
import { ResearchLedger } from '../llm/budget.js';
import { bindSchema, modelSchema, type DynamicEnums } from '../llm/schema.js';
import type { ModelLayer, ModelSession, StructuredResult } from '../llm/session.js';
import type { LlmPhase } from '../llm/types.js';
import type { Language } from '../prompts/index.js';
import type { CheckTemplate } from '../research/catalog.js';
import {
  checkKey,
  inferCheckTemplates,
  runCheck,
  vetCheck,
  type ExecutedCheck,
  type NextCheck,
  type QueryRunner,
} from '../research/checks.js';
import {
  failure,
  type FailureKind,
  type ResearchLimits,
  type ResearchState,
  type RunSink,
  type StopReason,
} from '../research/controller.js';
import { EvidenceBook } from '../research/evidence.js';
import { Ledger, type LedgerEntry, type ModelHypothesis } from '../research/ledger.js';
import type { WorkerMetrics } from '../research/metrics.js';
import { evidenceCorpus } from '../research/validate.js';
import { auditText, type NumberCorpus } from '../research/numbers.js';
import { mechanismTypes, signalTypes } from '../research/targeting.js';
import type { Subgraph } from '../research/types.js';
import { ToolBox } from '../tools/box.js';
import { findingFrame } from './frame.js';
import { DEFAULT_GATES } from './gates.js';
import { optimizeConcludeItems, optimizeHypothesizeItems, optimizeParts } from './items.js';
import { judgeFinding, ledgerPickInGroup } from './ladder.js';
import { optimizePromptHash } from './prompts.js';
import type { GoalRunContext } from './runner.js';

// 主动优化的 worker 控制器（ADR 0146 §2.3）：hypothesize → discriminate（可多轮）→ conclude，与事件研判共用账本、
// 检查、证据簿、预算与出境（§2.7）。差异：
// - 证据簿开始时是 server 算好的诊断卡与份额卡，没有告警与变更；
// - 账本按发现分组（findingFrame），假设的根因是发现的实体，同一发现上的假设互为竞争假设；
// - 区分性检查只能用领域的查询模板（server 在发现挂到的组件上执行），没有只读工具；参数中缺少的、发现实体标签里有的
//   取值由控制器补上；
// - 结论为每个发现一条，档位由优化结论阶梯（§2.4）计算；建议与门槛由 server 计算（publisher.ts）。

export interface OptimizeEnv {
  layer: ModelLayer;
  metrics: WorkerMetrics;
  language: Language;
  limits: ResearchLimits;
  query: QueryRunner | null;
  now(): number;
}

export interface OptimizeRunInput {
  runId: string;
  ctx: GoalRunContext;
  signal: AbortSignal;
}

export interface OptimizeRunResult {
  state: 'completed' | 'failed';
  stopReason: StopReason | null;
  output: OptimizationOutput | null;
  error: { kind: FailureKind; message: string } | null;
  book: EvidenceBook;
  checks: ExecutedCheck[];
  session: ModelSession;
  ledger: ResearchLedger;
  promptHashes: Record<string, string>;
}

/** 输出契约的条数上限 */
const MAX_CHECK_CARDS = 60;
const MAX_NEXT_CHECKS = 12;
const MAX_REFS = 12;

/** 目标运行的拓扑 → 账本用的子图（只用 owned_by 边计算 Kubernetes 实体的成员） */
export function goalSubgraph(ctx: GoalRunContext): Subgraph {
  return {
    topology_version: ctx.topology.version,
    root: null,
    nodes: ctx.topology.nodes.map((n) => ({
      component: n.key,
      kind: n.kind,
      namespace: n.namespace,
      name: n.name,
      role: 'neighbor' as const,
      alerts: [],
      hops: 1,
    })),
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

/**
 * 模板参数的补全：模板 schema 声明了、模型没有给出、发现实体的标签里有的参数取标签的值（按 schema 的类型转换）。
 * 返回补全后的参数文本与补上的参数名；参数文本不是 JSON 对象时原样返回，由 vetCheck 修复或拒绝
 */
export function fillTemplateArgs(
  t: CheckTemplate,
  argsJson: string,
  labels: Readonly<Record<string, string | undefined>>,
): { argsJson: string; filled: string[] } {
  let args: unknown;
  try {
    args = argsJson.trim() ? JSON.parse(argsJson) : {};
  } catch {
    return { argsJson, filled: [] };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { argsJson, filled: [] };
  }
  const props = ((t.args as { properties?: Record<string, { type?: string }> }).properties ?? {}) as Record<
    string,
    { type?: string }
  >;
  const out = { ...(args as Record<string, unknown>) };
  const filled: string[] = [];
  for (const [k, p] of Object.entries(props)) {
    const v = labels[k];
    if (k in out || v === undefined || k === 'statement') {
      continue;
    }
    if (p.type === 'number' || p.type === 'integer') {
      const n = Number(v);
      if (!Number.isFinite(n) || (p.type === 'integer' && !Number.isInteger(n))) {
        continue;
      }
      out[k] = n;
    } else if (p.type === 'boolean') {
      if (v !== 'true' && v !== 'false') {
        continue;
      }
      out[k] = v === 'true';
    } else {
      out[k] = v;
    }
    filled.push(k);
  }
  return filled.length ? { argsJson: JSON.stringify(out), filled } : { argsJson, filled };
}

/**
 * hypothesize 没有给出任何检查时由控制器补选（ADR 0137 的优化版本）：为待检验的假设各取一个领域模板，
 * 模板测的信号类型与假设的症状类型（机制文字与 symptoms）有交集、本次运行没有执行过；参数取发现实体的标签
 */
export function supplementGoalChecks(
  templates: readonly CheckTemplate[],
  ledger: Ledger,
  open: readonly LedgerEntry[],
  done: ReadonlySet<string>,
  language: Language,
  limit: number,
): NextCheck[] {
  const out: NextCheck[] = [];
  const used = new Set<string>();
  for (const e of open) {
    if (out.length >= limit) {
      break;
    }
    const mech = new Set([...mechanismTypes(e.mechanism, ledger.rules), ...(e.symptoms ?? [])]);
    const pick = templates.find(
      (t) =>
        !used.has(t.id) &&
        !done.has(`${e.id}:${t.id}:{}`) &&
        [...signalTypes(t.id, ledger.rules)].some((x) => mech.has(x)),
    );
    if (!pick) {
      continue;
    }
    used.add(pick.id);
    out.push({
      hypothesis_id: e.id as NextCheck['hypothesis_id'],
      type: 'query',
      template: pick.id,
      args_json: '{}',
      refutes_if:
        language === 'zh' ? `${pick.id} 在发现的实体上判为正常` : `${pick.id} is judged normal on the finding's entity`,
      purpose:
        language === 'zh'
          ? `hypothesize 没有给出检查，控制器按症状类型补选，检验假设 ${e.id}`
          : `hypothesize gave no checks; picked by the controller by symptom type to test ${e.id}`,
    });
  }
  return out;
}

/** 数值审计语料：证据簿，加上基线、差距与候选的数值（ADR 0125） */
export function goalCorpus(ctx: GoalRunContext, book: EvidenceBook): NumberCorpus {
  return evidenceCorpus(book, {
    times: [ctx.baseline.window.from, ctx.baseline.window.to],
    texts: [
      JSON.stringify(ctx.baseline.indicators.map(({ hourly: _hourly, ...rest }) => rest)),
      ctx.gap.detail,
      JSON.stringify(ctx.goal.spec.objective),
      ...ctx.candidates.map((c) => `${c.entity.display} ${Object.values(c.entity.labels).join(' ')}`),
    ],
    numbers: ctx.candidates.flatMap((c) => [c.score, ...(c.share !== null ? [c.share, c.share * 100] : [])]),
  });
}

export async function runOptimization(
  input: OptimizeRunInput,
  env: OptimizeEnv,
  sink: RunSink,
): Promise<OptimizeRunResult> {
  const { ctx, runId } = input;
  const started = env.now();
  const budget = ctx.goal.spec.budget;
  const deadline = started + Math.min(env.limits.deadlineMs, budget.duration_seconds * 1000);
  const selected = ctx.candidates.filter((c) => c.selected);
  const byFinding = new Map<string, OptimizationCandidate>(selected.map((c) => [c.finding, c]));
  const book = new EvidenceBook({ cards: ctx.cards, alerts: [], changes: [], relatedChanges: [] });
  const ledger = new Ledger(
    book,
    findingFrame(
      selected.map((c) => ({ fingerprint: c.finding, entity: c.entity.key, component: c.component })),
      goalSubgraph(ctx),
    ),
  );
  // 每个目标的 token 上限（GoalSpec.budget.tokens）作为这次运行的输入上限
  const budgetLedger = new ResearchLedger({
    ...env.layer.opts.budget,
    perResearchInputTokens: Math.min(env.layer.opts.budget.perResearchInputTokens, budget.tokens),
  });
  const notes: string[] = [];
  const checks: ExecutedCheck[] = [];
  const promptHashes: Record<string, string> = {};
  const session = env.layer.session({
    runId,
    incidentComponents: [...new Set(selected.map((c) => c.component))],
    deadline,
    signal: input.signal,
    ledger: budgetLedger,
    record: (r) => sink.llmCall(r),
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
  const finish = async (r: Omit<OptimizeRunResult, keyof typeof base>): Promise<OptimizeRunResult> => {
    await sink.step(state, stepStart, new Date(env.now()).toISOString());
    env.metrics.researchRuns.inc({ outcome: r.state, stop: r.stopReason ?? '' });
    env.metrics.researchDuration.observe((env.now() - started) / 1000);
    return { ...base, ...r };
  };
  const fail = (r: Extract<StructuredResult<unknown>, { ok: false }>) => {
    const f = failure(r);
    return finish({ state: 'failed', stopReason: f.stop, output: null, error: { kind: f.kind, message: f.message } });
  };

  const parts = optimizeParts(env.language, ctx, book);
  // 目标运行没有只读工具：区分性检查只用领域的查询模板（§3.1，模型不写查询）
  const box = new ToolBox([], env.metrics, 0);
  const templateIds = ctx.templates.map((t) => t.id);
  const enums = (): DynamicEnums => ({
    findings: selected.map((c) => c.finding),
    evidence_refs: book.refs(),
    check_templates: templateIds,
  });
  const output = (name: 'optimize-hypothesize' | 'optimize-conclude') => {
    const e = enums();
    const b = bindSchema(modelSchema(name), e);
    return {
      name: `${name.replace('-', '_')}_output`,
      schema: b.portable,
      full: b.full,
      ...(name === 'optimize-hypothesize'
        ? { prepare: (v: unknown, n: string[]) => inferCheckTemplates(v, e.check_templates ?? [], n) }
        : {}),
    };
  };
  const hash = (phase: LlmPhase, step: 'hypothesize' | 'conclude') => {
    promptHashes[phase] = optimizePromptHash(env.language, step);
  };
  const score = (entity: string) => selected.find((c) => c.entity.key === entity)?.score ?? 0;
  const groups = selected.map((c) => c.finding);
  const settled = () =>
    groups.every((g) => {
      const leader = ledger.ranked(score).find((e) => e.group === g);
      return leader === undefined || ledger.leaderSettled(leader);
    });

  const merge = (out: OptimizeHypothesizeOutput) => {
    const hyps: ModelHypothesis[] = out.hypotheses.flatMap((h) => {
      const c = byFinding.get(h.finding);
      if (!c) {
        notes.push(`假设 ${h.id} 解释的发现 ${h.finding.slice(7, 19)} 没有进入分析，已删除`);
        return [];
      }
      // 发现的诊断卡由代码关联为支持证据（模型漏引也不影响判定）
      return [
        {
          id: h.id,
          parent_id: h.parent_id,
          root_component: c.entity.key,
          mechanism: h.mechanism,
          supporting: [...new Set([...h.supporting, c.card_ref])],
          refuting: h.refuting,
          group: c.finding,
          symptoms: h.symptoms,
        },
      ];
    });
    ledger.merge(hyps, notes);
    ledger.evaluate();
  };

  // conclude
  const conclude = async (stopReason: StopReason): Promise<OptimizeRunResult> => {
    await move('conclude');
    hash('conclude', 'conclude');
    const concluded = await session.structured<OptimizeConcludeOutput>(
      'conclude',
      {
        items: optimizeConcludeItems(env.language, parts, ledger, book),
        maxOutputTokens: 8000,
        temperature: 0,
      },
      output('optimize-conclude'),
    );
    if (!concluded.ok) {
      return fail(concluded);
    }
    notes.push(...concluded.notes);
    const corpus = goalCorpus(ctx, book);
    const audit = (text: string, where: string): string => {
      const r = auditText(text, corpus);
      if (r.removed.length) {
        notes.push(`${where}：删除无法核实的数值 ${[...new Set(r.removed)].join('、')}`);
      }
      return r.text;
    };
    const minShare = ctx.gates.min_share ?? DEFAULT_GATES.min_share;
    const trendOnset = ctx.trend_onset ? Date.parse(ctx.trend_onset) : null;
    const conclusions: FindingConclusion[] = [];
    for (const c of selected) {
      const m = concluded.value.findings.find((x) => x.finding === c.finding);
      const short = c.finding.slice(7, 19);
      let chosen: LedgerEntry | null = null;
      let chosenBy: 'model' | 'ledger' = 'model';
      if (m?.hypothesis_id) {
        const e = ledger.entries.get(m.hypothesis_id);
        if (!e) {
          notes.push(`发现 ${short}：结论选中的假设 ${m.hypothesis_id} 不在账本中`);
        } else if (e.group !== c.finding) {
          notes.push(`发现 ${short}：结论选中的假设 ${e.id} 解释的是另一个发现`);
        } else if (e.status === 'refuted') {
          notes.push(`发现 ${short}：结论选中的假设 ${e.id} 已被推翻`);
        } else {
          chosen = e;
        }
      }
      if (!chosen) {
        const pick = ledgerPickInGroup(ledger, c.finding);
        if (pick) {
          chosen = pick;
          chosenBy = 'ledger';
          notes.push(`发现 ${short}：模型没有给出可用的假设，按账本选中唯一处于支持状态的 ${pick.id}（ADR 0120）`);
        }
      }
      const j = judgeFinding(ledger, {
        finding: c.finding,
        gapHolds: ctx.gap.exists,
        shareCards: ctx.shares[c.finding] ?? [],
        minShare,
        trendOnset,
        chosen,
        chosenBy,
        hasHypotheses: ledger.list().some((e) => e.group === c.finding),
        note: m?.note ? audit(m.note, `发现 ${short} 的说明`) : null,
        undeterminedReason: m?.undetermined_reason ? audit(m.undetermined_reason, `发现 ${short} 的原因`) : null,
      });
      notes.push(...j.notes);
      conclusions.push(j.conclusion);
      env.metrics.conclusions.inc({
        level: j.conclusion.level,
        untested_competitor: String(!j.conclusion.consistency.competitor_tested && chosen !== null),
        zero_checks: String(checks.length === 0),
      });
    }
    const hypotheses: FindingHypothesis[] = ledger.toContract(score).map((h) => {
      const e = ledger.entries.get(h.id) as LedgerEntry;
      const c = byFinding.get(e.group) as OptimizationCandidate;
      return {
        finding: e.group,
        hypothesis: {
          ...h,
          // 契约的 root_component 是组件键：换回发现挂到的组件，发现由 finding 给出
          root_component: c.component,
          mechanism: audit(h.mechanism, `假设 ${h.id} 的机制`),
          supporting: h.supporting.slice(0, MAX_REFS),
          refuting: h.refuting.slice(0, MAX_REFS),
        },
      };
    });
    const out: OptimizationOutput = {
      goal_id: ctx.goal.goal_id,
      goal_revision: ctx.goal.revision,
      run_id: ctx.run_id,
      baseline: ctx.baseline,
      gap: ctx.gap,
      candidates: ctx.candidates,
      hypotheses,
      next_checks: checks.slice(0, MAX_NEXT_CHECKS).map((x) => ({
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
      conclusions,
      recommendations: [],
      summary: audit(concluded.value.summary, '结论摘要'),
      stop_reason: stopReason,
      // 运行开始时的诊断卡与份额卡在前，检查卡在后；序列只在运行明细中保存
      check_cards: book.allCards.slice(0, MAX_CHECK_CARDS).map((c) => ({ ...c.result, series: [] })),
      evidence_index: book.evidenceMap(),
      validation_notes: notes,
    };
    return finish({ state: 'completed', stopReason, output: out, error: null });
  };

  if (!selected.length) {
    notes.push('没有进入分析的发现，直接结论');
    return conclude('no_change');
  }

  const hypothesize = async (): Promise<StructuredResult<OptimizeHypothesizeOutput>> => {
    hash('hypothesize', 'hypothesize');
    return session.structured<OptimizeHypothesizeOutput>(
      'hypothesize',
      {
        items: optimizeHypothesizeItems(env.language, parts, ledger.list().length ? ledger : null, book),
        maxOutputTokens: 6000,
        temperature: 0,
      },
      output('optimize-hypothesize'),
    );
  };
  let hyp = await hypothesize();
  const roundInput = budgetLedger.input;
  if (!hyp.ok) {
    return fail(hyp);
  }
  notes.push(...hyp.notes);
  merge(hyp.value);

  const templates: CheckTemplate[] = ctx.templates;
  const done = new Set<string>();
  let stopReason: StopReason;
  let unchanged = 0;
  let lastSignature = ledger.signature();
  for (let step = 1; ; step++) {
    if (settled()) {
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
    const remaining = budget.checks - checks.length;
    const openEntries = ledger
      .ranked(score)
      .filter((e) => !e.pinned && e.status !== 'refuted' && e.checksRun === 0)
      .slice(0, Math.min(env.limits.checksPerStep, Math.max(0, remaining)));
    const open = new Set(openEntries.map((e) => e.id));
    // 优化的假设 id 为 h1…h9（事件研判为 h1…h6），检查的执行与 id 的范围无关
    let proposed = hyp.value.next_checks as NextCheck[];
    if (proposed.length === 0) {
      proposed = supplementGoalChecks(templates, ledger, openEntries, done, env.language, openEntries.length);
      if (proposed.length) {
        notes.push(
          `第 ${step} 轮 hypothesize 没有给出 next_checks，控制器按症状类型补选 ${proposed.length} 项：${proposed
            .map((c) => `${c.template}（假设 ${c.hypothesis_id}）`)
            .join('、')}`,
        );
      }
    }
    const planned: Array<{ check: NextCheck; args: Record<string, unknown> }> = [];
    const seen = new Set<string>();
    for (const raw of proposed) {
      if (!open.has(raw.hypothesis_id) || seen.has(raw.hypothesis_id) || done.has(checkKey(raw))) {
        continue;
      }
      let c = raw;
      const t = templates.find((x) => x.id === c.template);
      const e = ledger.entries.get(c.hypothesis_id);
      const cand = e ? byFinding.get(e.group) : undefined;
      if (t && cand) {
        const f = fillTemplateArgs(t, c.args_json, cand.entity.labels);
        if (f.filled.length) {
          notes.push(`检查 ${c.template}（假设 ${c.hypothesis_id}）：参数 ${f.filled.join('、')} 取发现实体的标签`);
          c = { ...c, args_json: f.argsJson };
        }
      }
      // 不在本次运行模板目录中的模板、原始查询与不合 schema 的参数在这里拒绝，不发出任何后端请求（不变量 13）
      const vet = vetCheck(c, templates, box);
      if ('error' in vet) {
        notes.push(`检查 ${c.template}（假设 ${c.hypothesis_id}）：${vet.error}，未执行`);
        checks.push({ check: c, args: {}, outcome: 'failed', card: null, tool: null, error: vet.error });
        done.add(checkKey(raw));
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
          templates,
          clusterId: ctx.goal.cluster_id,
          book,
          ledger,
          box,
          query: env.query,
          session,
          language: env.language,
          bounds: { from: Date.parse(ctx.baseline.window.from), to: env.now() },
          signal: input.signal,
          onTool: (r) => sink.toolCall(r),
        },
        p.check,
        p.args,
        checks.length + 1,
      );
      checks.push(executed);
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
    if (settled()) {
      stopReason = 'leader_supported';
      break;
    }
    if (step >= env.limits.maxSteps || checks.length >= budget.checks) {
      stopReason = 'step_limit';
      break;
    }
    if (env.now() > deadline - env.limits.concludeReserveMs) {
      stopReason = 'deadline';
      break;
    }
    if (budgetLedger.remaining() < 2 * roundInput) {
      notes.push(
        `剩余输入预算 ${budgetLedger.remaining()} token，不够再提出一轮假设（约 ${roundInput} token）并留出结论所需，直接结论`,
      );
      stopReason = 'budget';
      break;
    }
    await move('hypothesize');
    const next = await hypothesize();
    if (!next.ok) {
      const f = failure(next);
      notes.push(`第 ${step + 1} 轮 hypothesize 未完成：${f.message.slice(0, 300)}`);
      stopReason = f.stop ?? 'model_unavailable';
      break;
    }
    hyp = next;
    notes.push(...next.notes);
    merge(next.value);
  }
  return conclude(stopReason);
}
