import type {
  ActionCatalogAction,
  ConcludeOutput,
  ConclusionLevel,
  ProposalDraft,
  ResearchOutput,
} from '@srenautix/contract';
import { displayKey, tryNodeKey } from '@srenautix/core';
import { validatorOf, formatErrors } from '../llm/schema.js';
import type { EvidenceBook } from './evidence.js';
import type { ChosenBy } from './ladder.js';
import type { Ledger, LedgerEntry } from './ledger.js';
import { auditText, buildCorpus, cardMaterial, type NumberCorpus } from './numbers.js';
import type { DispositionFacts } from './types.js';

// 结论的代码校验（DESIGN §7.3）：删除无效的证据引用；删除目录以外、参数不合 schema、目标与机器推导不一致的提议；
// 修复建议按同样规则处理并按类别排序、每类最多 3 条。所有修改写入 validation_notes。处置判断在结论阶梯之后由
// disposition.ts 推导（ADR 0138）。不依赖事件（ADR 0146 §2.7）：校验只用动作目录、runbook 与拓扑组件，
// 数值审计的语料由调用方给出证据簿之外的材料（事件研判见 incident.ts 的 incidentCorpus）。

/** 结论校验用到的目录：可用动作、runbook 与研判拓扑中的组件 */
export interface ConclusionCatalog {
  actions: readonly ActionCatalogAction[];
  runbooks: readonly string[];
  subgraph: { nodes: ReadonlyArray<{ component: string; kind: string }> };
}

/** 证据簿之外可以作为数值依据的材料（研判对象的时间、得分、时间线等） */
export interface CorpusExtra {
  texts: readonly string[];
  numbers: readonly number[];
  /** 放在证据卡的时刻之前 */
  times: readonly string[];
}

export const RECOMMENDATION_ORDER = ['mitigation', 'root_fix', 'prevention', 'investigation'] as const;
const MAX_PER_KIND = 3;

const RECOMMENDATION_ID = /^r[0-9]{1,2}$/;

/**
 * conclude 输出的补全（解析之后、校验之前，见 repairLocally 的 prepare）：recommendations 里有 id 不合规
 * （不符合 ^r[0-9]{1,2}$、缺失或重复）的条目时，全部条目按数组顺序重新编号为 r1、r2……，不因 id 删除整条建议。
 * id 只在建议之间区分条目，输出里没有别处引用它，重新编号不改变含义。每处改动写入 notes。
 */
export function renumberRecommendations(value: unknown, notes: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.recommendations)) {
    return value;
  }
  const items = v.recommendations as unknown[];
  const ids = items.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? (r as { id?: unknown }).id : null));
  const valid = ids.every((id, i) => typeof id === 'string' && RECOMMENDATION_ID.test(id) && ids.indexOf(id) === i);
  if (valid) {
    return value;
  }
  let n = 0;
  const recommendations = items.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return r;
    }
    const id = `r${++n}`;
    if (ids[i] !== id) {
      notes.push(
        `/recommendations[${i}]：id ${ids[i] === undefined ? '缺失' : JSON.stringify(ids[i]).slice(0, 40)}，按顺序重新编号为 ${id}`,
      );
    }
    return { ...r, id };
  });
  return { ...v, recommendations };
}

export interface Validated {
  chosen: LedgerEntry | null;
  /**
   * 结论假设的来源：模型选中；模型弃权时由代码按账本选中（ADR 0120，档位最高 likely）；规则判定没有被检查推翻、
   * 结论的根因又不是它时由代码改选（ADR 0178，档位最高 likely）
   */
  chosenBy: ChosenBy | null;
  undeterminedReason: string | null;
  situation: string;
  summary: string;
  recommendations: ResearchOutput['recommendations'];
  proposals: Array<Omit<ProposalDraft, 'proposal_id'>>;
  notes: string[];
}

/** 动作参数里的目标字段 → 拓扑组件键的候选（机器推导的目标） */
export function proposalTargets(action: ActionCatalogAction, params: Record<string, unknown>): string[] {
  const ns = typeof params.namespace === 'string' ? params.namespace : null;
  const s = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : null);
  const kind = s('kind') ?? action.target.kind;
  const out: string[] = [];
  const name = s('name') ?? s('pod') ?? s('application') ?? s('cluster') ?? s('workflow') ?? s('template') ?? s('node');
  if (!name) {
    return out;
  }
  const key = s('node') ? tryNodeKey('Node', null, name) : tryNodeKey(kind, ns, name);
  if (key) {
    out.push(key);
  }
  return out;
}

/** 组件键的名称部分：用于和领域包组件类型（例如 postgres.cluster:<ns>/<name>）比对 */
function nsName(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

/**
 * 模型弃权时代码按账本选中的假设（ADR 0120）：账本中处于支持状态的假设都落在同一个根因组件上（没有打平），
 * 并且它有范围内的异常卡（人工反馈固定为支持、没有卡的假设不算）。其余情况不代选。
 */
export function ledgerPick(ledger: Ledger): LedgerEntry | null {
  const roots = ledger.supportedRoots();
  if (roots.length !== 1) {
    return null;
  }
  // 同一组件上有多个支持假设时，取支持证据最多的一个（账本排名第一）
  const pick = ledger.ranked().find((e) => e.status === 'supported' && e.rootComponent === roots[0]) as LedgerEntry;
  return ledger.supportCards(pick).length > 0 ? pick : null;
}

export function validateConclusion(
  raw: ConcludeOutput,
  c: ConclusionCatalog,
  book: EvidenceBook,
  ledger: Ledger,
): Validated {
  const notes: string[] = [];
  const keepRefs = (refs: string[], where: string) => {
    const bad = refs.filter((r) => !book.has(r));
    if (bad.length) {
      notes.push(`${where}：删除不存在的引用 ${bad.join('、')}`);
    }
    return [...new Set(refs.filter((r) => book.has(r)))];
  };

  // 选中的假设：必须在账本中且未被推翻
  let chosen: LedgerEntry | null = null;
  let undeterminedReason = raw.undetermined_reason;
  if (raw.hypothesis_id !== null) {
    const e = ledger.entries.get(raw.hypothesis_id) ?? null;
    if (!e) {
      notes.push(`结论引用的假设 ${raw.hypothesis_id} 不在账本中，改为无法判定`);
      undeterminedReason = `结论引用的假设 ${raw.hypothesis_id} 不存在`;
    } else if (e.status === 'refuted') {
      notes.push(`结论所选假设 ${e.id} 在账本中已被推翻，改为无法判定`);
      undeterminedReason = `所选假设 ${e.id}（${e.rootComponent}）已被推翻`;
    } else {
      chosen = e;
    }
  }
  let chosenBy: Validated['chosenBy'] = chosen ? 'model' : null;
  if (raw.hypothesis_id === null) {
    const pick = ledgerPick(ledger);
    if (pick) {
      chosen = pick;
      chosenBy = 'ledger';
      notes.push(
        `模型弃权，代码按账本选中 ${pick.id}（${displayKey(pick.rootComponent)}）：账本中处于支持状态的假设都落在这个根因上，支持卡 ${ledger
          .supportCards(pick)
          .map((x) => x.ref)
          .join('、')}；模型给出的弃权原因：${raw.undetermined_reason ?? '没有给出'}`,
      );
    }
  }
  if (!chosen && !undeterminedReason) {
    undeterminedReason = '模型没有给出原因';
    notes.push('结论为无法判定但没有原因，补为"模型没有给出原因"');
  }
  // 规则判定（ADR 0178）：账本中没有被推翻的规则判定都不落在结论的根因上时（模型弃权，或选了别的根因），模型没有给出
  // 推翻规则条件的检查结果，代码改选排名最靠前的规则判定；结论的根因与某个规则判定相同时保持原来的选择
  const rules = ledger.ruleEntries().filter((e) => e.status !== 'refuted');
  if (chosen?.rule) {
    chosenBy = 'rule';
  } else if (rules.length && !rules.some((e) => e.rootComponent === chosen?.rootComponent)) {
    const pick = ledger.ranked().find((e) => e.rule !== undefined && e.status !== 'refuted') as LedgerEntry;
    notes.push(
      `${chosen ? `模型选中 ${chosen.id}（${displayKey(chosen.rootComponent)}）` : '模型弃权'}，规则判定 ${pick.rule!.rule_id}（${displayKey(
        pick.rootComponent,
      )}）没有被检查推翻：没有一项区分性检查在它的卡片条件上得出不满足条件的结果，代码改选规则判定 ${pick.id}（ADR 0178）`,
    );
    chosen = pick;
    chosenBy = 'rule';
  }
  if (chosen) {
    undeterminedReason = null;
  }

  // 提议：目录内、参数合 schema、目标在拓扑中、依据的假设未被推翻
  const actions = new Map(c.actions.map((a) => [a.id, a]));
  const topology = new Set(c.subgraph.nodes.map((n) => n.component));
  // 领域包组件类型（kind 含点，例如 postgres.cluster:<ns>/<name>）对应的 Kubernetes 对象按命名空间与名称比对
  const topologyNames = new Set(c.subgraph.nodes.filter((n) => n.kind.includes('.')).map((n) => nsName(n.component)));
  const proposals: Validated['proposals'] = [];
  for (const p of raw.proposals) {
    const action = actions.get(p.action_id);
    if (!action) {
      notes.push(`提议 ${p.action_id}：不在本集群可用的动作目录中，已删除`);
      continue;
    }
    const h = ledger.entries.get(p.hypothesis_id);
    if (!h || h.status === 'refuted') {
      notes.push(`提议 ${p.action_id}：依据的假设 ${p.hypothesis_id} ${h ? '已被推翻' : '不存在'}，已删除`);
      continue;
    }
    let params: unknown;
    try {
      params = JSON.parse(p.params_json);
    } catch (e) {
      notes.push(`提议 ${p.action_id}：params_json 不是合法 JSON（${(e as Error).message}），已删除`);
      continue;
    }
    const v = validatorOf(action.params as Record<string, unknown>);
    if (!v(params)) {
      notes.push(`提议 ${p.action_id}：参数不符合动作 schema（${formatErrors(v.errors)}），已删除`);
      continue;
    }
    const targets = proposalTargets(action, params as Record<string, unknown>);
    if (
      action.target.kind !== 'GitRepository' &&
      !targets.some((t) => topology.has(t) || topologyNames.has(nsName(t)))
    ) {
      notes.push(
        `提议 ${p.action_id}：目标 ${targets.map(displayKey).join('、') || '（无）'} 不在本次研判的拓扑中，与机器推导的目标不一致，已删除`,
      );
      continue;
    }
    proposals.push({
      action_id: action.id,
      params: params as Record<string, unknown>,
      hypothesis_id: h.id,
      expected_effect: p.expected_effect,
    });
  }

  // 修复建议
  const runbooks = new Set(c.runbooks);
  const perKind = new Map<string, number>();
  const recommendations: ResearchOutput['recommendations'] = [];
  const ordered = [...raw.recommendations].sort(
    (a, b) => RECOMMENDATION_ORDER.indexOf(a.kind) - RECOMMENDATION_ORDER.indexOf(b.kind),
  );
  for (const r of ordered) {
    const h = ledger.entries.get(r.hypothesis_id);
    if (!h || h.status === 'refuted') {
      notes.push(`修复建议 ${r.id}：依据的假设 ${r.hypothesis_id} ${h ? '已被推翻' : '不存在'}，已删除`);
      continue;
    }
    const n = perKind.get(r.kind) ?? 0;
    if (n >= MAX_PER_KIND) {
      notes.push(`修复建议 ${r.id}：${r.kind} 类超过 ${MAX_PER_KIND} 条，已删除`);
      continue;
    }
    perKind.set(r.kind, n + 1);
    let runbook = r.runbook_ref;
    if (runbook !== null && !runbooks.has(runbook)) {
      notes.push(`修复建议 ${r.id}：runbook ${runbook} 不在领域包的 runbook 中，已置空`);
      runbook = null;
    }
    let actionId = r.action_id;
    if (actionId !== null && !actions.has(actionId)) {
      notes.push(`修复建议 ${r.id}：动作 ${actionId} 不在可用动作中，已置空`);
      actionId = null;
    }
    recommendations.push({
      ...r,
      hypothesis_id: h.id,
      runbook_ref: runbook,
      action_id: actionId,
      evidence_refs: keepRefs(r.evidence_refs, `修复建议 ${r.id} 的引用`),
      generated_by: 'model',
    });
  }

  return {
    chosen,
    chosenBy,
    undeterminedReason,
    situation: raw.situation,
    summary: raw.summary,
    recommendations,
    proposals,
    notes,
  };
}

/**
 * 本次研判的证据语料：证据卡（运行开始时已有的与检查产生的）、告警、变更，以及调用方给出的其他材料
 * （事件研判为事件与候选、阶段 A 的时间线）。语料是集合，材料的先后不影响审计
 */
export function evidenceCorpus(book: EvidenceBook, extra: CorpusExtra): NumberCorpus {
  const texts: string[] = [];
  const numbers: number[] = [];
  const times: string[] = [...extra.times];
  for (const card of book.allCards) {
    const m = cardMaterial(card.result);
    texts.push(...m.texts);
    numbers.push(...m.numbers);
    times.push(...m.times);
  }
  for (const [, a] of book.alertEntries) {
    times.push(a.starts_at, ...(a.ends_at ? [a.ends_at] : []));
  }
  for (const [, ch] of book.changeEntries) {
    texts.push(ch.summary, ch.revision ?? '', ch.previous_revision ?? '');
    times.push(ch.time);
  }
  texts.push(...extra.texts);
  numbers.push(...extra.numbers);
  return buildCorpus(texts, numbers, times);
}

/**
 * 模型文字的数值审计（ADR 0125）：假设机制、结论摘要与现状、建议的标题与步骤、无法判定的原因中，
 * 证据里找不到的数值断言连同所在分句删除；每处删除写一条 validation_notes
 */
export function auditModelText(out: ResearchOutput, corpus: NumberCorpus): { output: ResearchOutput; notes: string[] } {
  const notes: string[] = [];
  const audit = (text: string, where: string): string => {
    const r = auditText(text, corpus);
    if (r.removed.length) {
      notes.push(`${where}：删除无法核实的数值 ${[...new Set(r.removed)].join('、')}`);
    }
    return r.text;
  };
  // 步骤全部被删除的建议整条删除
  const recommendations: ResearchOutput['recommendations'] = [];
  for (const r of out.recommendations) {
    const steps = r.steps.map((s, i) => audit(s, `修复建议 ${r.id} 的第 ${i + 1} 步`)).filter((s) => s !== '');
    const [first, ...rest] = steps;
    if (first === undefined) {
      notes.push(`修复建议 ${r.id}：步骤都含无法核实的数值，已删除`);
      continue;
    }
    recommendations.push({
      ...r,
      title: audit(r.title, `修复建议 ${r.id} 的标题`),
      rationale: audit(r.rationale, `修复建议 ${r.id} 的理由`),
      steps: [first, ...rest],
    });
  }
  return {
    output: {
      ...out,
      hypotheses: out.hypotheses.map((h) => ({ ...h, mechanism: audit(h.mechanism, `假设 ${h.id} 的机制`) })),
      situation: audit(out.situation, '现状'),
      summary: audit(out.summary, '结论摘要'),
      recommendations,
      conclusion: {
        ...out.conclusion,
        undetermined_reason:
          out.conclusion.undetermined_reason === null
            ? null
            : audit(out.conclusion.undetermined_reason, '无法判定的原因'),
      },
    },
    notes,
  };
}

export type CauseScope = ConcludeOutput['cause_scope'];

/** 根因在仓库声明的组件上的两种范围：只有它们可以由自愈 PR 处理（ADR 0170） */
export const REPOSITORY_SCOPES: ReadonlySet<CauseScope> = new Set<CauseScope>(['local', 'configuration']);

export interface CauseScopeInput {
  /** 模型给出的取值 */
  model: CauseScope;
  /** 结论阶梯的档位 */
  level: ConclusionLevel;
  /** 选中的研判根因；没有选中假设时为 null */
  root: string | null;
  /** 处置推导的确定性依据（ADR 0138、0162、0170）；旧版 server 没有给出时为 null */
  facts: Pick<DispositionFacts, 'external' | 'repository_owned'> | null | undefined;
}

/**
 * 根因范围的校正（ADR 0170）：模型给出的取值按确定性依据改写，每次改写写一条备注。按顺序：
 * - 结论为 undetermined 或没有选中根因：unknown；
 * - 研判根因是领域包声明在集群之外的组件（处置依据的 external）：upstream；
 * - 研判根因不由 GitOps 仓库负责（处置依据的 repository_owned：仓库声明的组件与管理它们的 GitOps 应用）而模型给出 local 或
 *   configuration：unknown。
 * 没有处置依据（或依据里没有 repository_owned）时按空处理，local 与 configuration 因此都改为 unknown。
 */
export function correctCauseScope(i: CauseScopeInput): { scope: CauseScope; notes: string[] } {
  const changed = (scope: CauseScope, why: string) => ({
    scope,
    notes: scope === i.model ? [] : [`根因范围由 ${i.model} 改为 ${scope}：${why}`],
  });
  if (i.level === 'undetermined' || i.root === null) {
    return changed('unknown', i.root === null ? '没有选中根因' : '结论为 undetermined');
  }
  if ((i.facts?.external ?? []).includes(i.root)) {
    return changed('upstream', `研判根因 ${displayKey(i.root)} 是领域包声明在集群之外的组件`);
  }
  if (REPOSITORY_SCOPES.has(i.model) && !(i.facts?.repository_owned ?? []).includes(i.root)) {
    return changed(
      'unknown',
      `研判根因 ${displayKey(i.root)} 不由 GitOps 仓库负责（不是仓库声明的组件，也不是管理它们的 GitOps 应用）`,
    );
  }
  return { scope: i.model, notes: [] };
}
