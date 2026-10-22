import type {
  ActionCatalogAction,
  ConcludeOutput,
  Disposition,
  ProposalDraft,
  ResearchOutput,
} from '@srenautix/contract';
import { displayKey, tryNodeKey } from '@srenautix/core';
import { validatorOf, formatErrors } from '../llm/schema.js';
import type { EvidenceBook } from './evidence.js';
import type { Ledger, LedgerEntry } from './ledger.js';
import { auditText, buildCorpus, cardMaterial, type NumberCorpus } from './numbers.js';
import type { ResearchCase } from './types.js';

// 结论的代码校验（DESIGN §7.3）：删除无效的证据引用；删除目录以外、参数不合 schema、目标与机器推导不一致的提议；
// 修复建议按同样规则处理并按类别排序、每类最多 3 条；处置判断按规则约束。所有修改写入 validation_notes。

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
  /** 结论假设的来源：模型选中；模型弃权时由代码按账本选中（ADR 0120，档位最高 likely） */
  chosenBy: 'model' | 'ledger' | null;
  disposition: Disposition;
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
  c: ResearchCase,
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

  // 处置判断
  let disposition = raw.disposition;
  const fallback: Disposition = c.incident.severity === 'critical' ? 'escalate' : 'undetermined';
  if (c.stageA.observability_blind && disposition !== 'escalate') {
    notes.push(`观测失明时不由模型判断，处置改为 escalate（模型给出 ${disposition}）`);
    disposition = 'escalate';
  } else if (disposition === 'act' && proposals.length === 0 && c.stageA.rule_proposals.length === 0) {
    notes.push(`处置为 act 但没有有效的提议或规则提议，改为 ${fallback}`);
    disposition = fallback;
  } else if (disposition === 'act' && !chosen) {
    notes.push(`处置为 act 但根因无法判定，改为 ${fallback}`);
    disposition = fallback;
  }

  return {
    chosen,
    chosenBy,
    disposition,
    undeterminedReason,
    situation: raw.situation,
    summary: raw.summary,
    recommendations,
    proposals,
    notes,
  };
}

/** 本次研判的证据语料：证据卡（阶段 A 与检查）、成员告警、变更、事件与候选 */
export function evidenceCorpus(c: ResearchCase, book: EvidenceBook): NumberCorpus {
  const texts: string[] = [];
  const numbers: number[] = [];
  const times: string[] = [c.incident.first_firing_at, c.incident.created_at, c.stageA.rendered_at];
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
  for (const t of c.stageA.timeline) {
    texts.push(t.text);
    times.push(t.at);
  }
  numbers.push(...c.incident.candidates.map((x) => x.score));
  if (c.incident.root.margin !== null) {
    numbers.push(c.incident.root.margin);
  }
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
