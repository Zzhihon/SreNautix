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
import type { ResearchCase } from './types.js';

// 结论的代码校验（DESIGN §7.3）：删除无效的证据引用；删除目录以外、参数不合 schema、目标与机器推导不一致的提议；
// 修复建议按同样规则处理并按类别排序、每类最多 3 条；处置判断按规则约束。所有修改写入 validation_notes。

export const RECOMMENDATION_ORDER = ['mitigation', 'root_fix', 'prevention', 'investigation'] as const;
const MAX_PER_KIND = 3;

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
 * 模型弃权时代码按账本选中的假设（ADR 0120）：账本中恰好一个假设处于支持状态（没有打平），
 * 并且它有范围内的异常卡（人工反馈固定为支持、没有卡的假设不算）。其余情况不代选。
 */
export function ledgerPick(ledger: Ledger): LedgerEntry | null {
  const supported = ledger.list().filter((e) => e.status === 'supported');
  if (supported.length !== 1) {
    return null;
  }
  const only = supported[0] as LedgerEntry;
  return ledger.supportCards(only).length > 0 ? only : null;
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
        `模型弃权，代码按账本选中 ${pick.id}（${displayKey(pick.rootComponent)}）：它是账本中唯一处于支持状态的假设，支持卡 ${ledger
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
