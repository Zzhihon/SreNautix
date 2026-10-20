import type { EvalCase, EvalSnapshot } from '@srenautix/contract';
import { tryNodeKey } from '@srenautix/core';
import type { ResearchCase } from '../research/types.js';

// 防泄漏（DESIGN §14.3）：从快照构造回放的研判输入时，排除可能包含答案的材料。
// - 该事件自己的反馈一律不进入上下文（反馈是标准答案的来源之一）；
// - 知识条目：learned_from 与用例的 learned_from_keys 有交集的排除；
// - 参考案例：只保留用例开始之前已经解决、且不在 exclude_incident_ids 中的；
// - 工具：回放时只读当前状态的工具不可用，查询范围限定在快照窗口（由研判控制器的 replay 模式执行）。

export interface Excluded {
  kind: 'feedback' | 'pack_knowledge' | 'retrieved_case';
  ref: string;
  reason: string;
}

export function replayCase(c: EvalCase, s: EvalSnapshot): { rc: ResearchCase; excluded: Excluded[] } {
  if (s.case_id !== c.case_id) {
    throw new Error(`快照 ${s.snapshot_id} 属于用例 ${s.case_id}，不是 ${c.case_id}`);
  }
  const excluded: Excluded[] = [];
  const keys = new Set([
    ...c.leakage.learned_from_keys,
    ...(c.incident_id ? [c.incident_id] : []),
    ...c.leakage.exclude_incident_ids,
  ]);
  const knowledge = s.context.knowledge.filter((k) => {
    const hit = k.learned_from.find((x) => keys.has(x));
    if (hit) {
      excluded.push({ kind: 'pack_knowledge', ref: k.id, reason: `learned_from 含本用例的 ${hit}` });
      return false;
    }
    return true;
  });
  const started = Date.parse(c.started_at);
  const excludeIds = new Set([...c.leakage.exclude_incident_ids, ...(c.incident_id ? [c.incident_id] : [])]);
  const roots = new Set(c.truth.root_components);
  const cases = s.context.cases.filter((x) => {
    if (excludeIds.has(x.incident_id)) {
      excluded.push({ kind: 'retrieved_case', ref: x.incident_id, reason: '本事件或别名' });
      return false;
    }
    if (x.source === 'model' && roots.has(x.root_component)) {
      excluded.push({ kind: 'retrieved_case', ref: x.incident_id, reason: '同根因的历史研判结论（模型生成）' });
      return false;
    }
    if (Date.parse(x.resolved_at) >= started) {
      excluded.push({
        kind: 'retrieved_case',
        ref: x.incident_id,
        reason: `解决时间 ${x.resolved_at} 不早于用例开始时间`,
      });
      return false;
    }
    return true;
  });
  for (const ref of c.leakage.exclude_refs) {
    excluded.push({ kind: 'feedback', ref, reason: '本事件的事故报告或反馈' });
  }
  const rc: ResearchCase = {
    incident: s.context.incident,
    stageA: s.context.stage_a,
    subgraph: s.context.subgraph,
    feedback: [],
    actions: s.context.actions,
    runbooks: s.context.runbooks,
    knowledge,
    cases,
    templates: s.context.templates,
    tools: [],
    asOf: s.as_of,
  };
  return { rc, excluded };
}

/**
 * abstain 用例（DESIGN §14.1）：去掉根因组件上的异常卡后的反事实快照，标准答案为 undetermined。
 * 被去掉的卡记在 derived_from 中；没有可去掉的异常卡时返回 null。
 */
export function deriveAbstain(
  c: EvalCase,
  s: EvalSnapshot,
  snapshotId: string,
  now: string,
): { c: EvalCase; s: EvalSnapshot } | null {
  const roots = new Set(c.truth.root_components);
  const entityKey = (e: { kind: string; namespace: string | null; name: string } | null) =>
    e ? tryNodeKey(e.kind, e.namespace, e.name) : null;
  const removed = s.context.stage_a.cards.filter(
    (x) => x.verdict === 'abnormal' && roots.has(entityKey(x.entity) ?? ''),
  );
  if (!removed.length) {
    return null;
  }
  const gone = new Set(removed.map((x) => x.ref));
  const caseId = `abstain:${c.case_id}`;
  return {
    c: {
      ...c,
      case_id: caseId,
      version: 1,
      type: 'abstain',
      truth: {
        root_components: [],
        granularity: null,
        mechanism: null,
        // 标准答案是结论弃权；处置判断取决于严重度（critical 且根因无法判定时为 escalate），不计入处置准确率
        disposition: null,
        forbid_evidence_consistent: true,
      },
      truth_source: { kind: 'human', principal: null, ref: `derived:${c.case_id}` },
      snapshot_id: snapshotId,
      derived_from: { case_id: c.case_id, removed_cards: removed.map((x) => x.card_id) },
      created_at: now,
    },
    s: {
      ...s,
      snapshot_id: snapshotId,
      case_id: caseId,
      context: {
        ...s.context,
        stage_a: { ...s.context.stage_a, cards: s.context.stage_a.cards.filter((x) => !gone.has(x.ref)) },
      },
    },
  };
}
