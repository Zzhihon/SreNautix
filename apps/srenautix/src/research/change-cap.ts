import type { ChangeEvent, ChangeGrade, ChangeLink, Incident } from '@srenautix/contract';
import { CHANGE_GRADE_RANK, sameKind } from '@srenautix/core';
import { parseStoredKey } from '../topology/keys.js';
import type { EvidenceBook } from './evidence.js';
import type { LadderResult } from './ladder.js';
import { ownerOf, type LedgerEntry } from './ledger.js';
import type { Subgraph } from './types.js';

// 变更关联分级对结论档位的限制（ADR 0169）。选中的假设把根因归到变更上时——根因是发布逻辑组件、根因是管理变更目标的
// GitOps 应用，或者 supporting 引用了 change:N——结论只能建立在与事件强关联的变更上：
// 这些变更中最高的分级是 high 时不限制；是 medium 或 low（或没有对应的变更）时档位最高为 inconclusive，
// validation_notes 写明变更、分级与缺少的条件。不在事件里的相关变更（book.related）一律按 low。
// 分级由 core 在计算事件时得出（Incident.change_links）；契约 2.37.0 之前算出的事件没有分级，这时不限制并记一条说明。

export interface BookChangeGrade {
  ref: string;
  change: ChangeEvent;
  inIncident: boolean;
  /** 事件里的变更的关联记录；相关变更为 null */
  link: ChangeLink | null;
  grade: ChangeGrade;
}

/**
 * 证据簿里每个变更的分级（按 change:N）：事件里的变更读事件的 change_links，不在事件里的相关变更为 low。
 * 事件没有 change_links（契约 2.37.0 之前算出）时返回空表
 */
export function bookChangeGrades(book: EvidenceBook, incident: Incident): Map<string, BookChangeGrade> {
  const out = new Map<string, BookChangeGrade>();
  if (!incident.change_links) {
    return out;
  }
  const links = new Map(incident.change_links.map((l) => [l.change_id, l]));
  for (const [ref, change] of book.changeEntries) {
    if (book.related.has(ref)) {
      out.set(ref, { ref, change, inIncident: false, link: null, grade: 'low' });
      continue;
    }
    const link = links.get(change.change_id);
    if (!link) {
      throw new Error(`事件 ${incident.incident_id} 的 change_links 缺少变更 ${change.change_id}`);
    }
    out.set(ref, { ref, change, inIncident: true, link, grade: link.grade });
  }
  return out;
}

/** 发布的逻辑组件（ADR 0104 §6）：component:release，或带命名空间的 component:<命名空间>/release */
export function isReleaseComponent(key: string): boolean {
  return key === 'component:release' || /^component:[^/]+\/release$/.test(key);
}

/** 两个组件键指同一个对象：kind 忽略 API 组与大小写（application 与 Application.argoproj.io 相同） */
function sameObject(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const x = parseStoredKey(a);
  const y = parseStoredKey(b);
  return sameKind(x.kind, y.kind) && x.namespace === y.namespace && x.name === y.name;
}

/**
 * 根因是管理这个变更目标的 GitOps 应用：子图里有变更目标（或它的顶层属主）到根因的 managed_by 边；
 * 或者根因是变更引用的应用（集群变更源的发布与退役在 refs 里写管理目标的应用）
 */
export function managesChangeTargets(root: string, c: ChangeEvent, subgraph: Subgraph): boolean {
  const targets = c.targets.flatMap((t) => [t, ownerOf(t, subgraph)]);
  const byEdge = subgraph.edges.some(
    (e) => e.relation === 'managed_by' && sameObject(e.to, root) && targets.some((t) => sameObject(e.from, t)),
  );
  return byEdge || c.refs.some((k) => sameObject(k, root));
}

/** 分级不是 high 时缺少的条件 */
function missing(g: BookChangeGrade): string {
  if (!g.inIncident) {
    return '不在事件里，没有经变更与告警的关联进入事件';
  }
  const basis = g.link!.basis;
  if (basis.includes('late')) {
    return '变更晚于它自己目标上已经开始的问题';
  }
  if (basis.some((b) => b === 'component_match' || b === 'acts_on' || b === 'retire_scrape_job')) {
    return g.grade === 'medium'
      ? '变更之后目标上没有开始的 symptom 或 cause 告警（新信号）'
      : '直接作用的告警不满足时间条件（变更之后的变更窗口内开始，问题不早于变更 10 分钟以上）';
  }
  if (basis.includes('topology_reach')) {
    return '变更没有直接作用在告警的对象上，只经拓扑可达关联';
  }
  return `只经 ${basis.join('、')} 关联，变更没有直接作用在告警的对象上`;
}

/**
 * 按变更关联分级限制档位（ADR 0169）。在最低取证集合的限制（requiredCap）之后、处置推导之前执行；
 * 档位已经是 inconclusive 或 undetermined 时不变
 */
export function changeCap(
  r: LadderResult,
  chosen: LedgerEntry | null,
  incident: Incident,
  book: EvidenceBook,
  subgraph: Subgraph,
): LadderResult {
  if (!chosen || (r.level !== 'likely' && r.level !== 'evidence_consistent')) {
    return r;
  }
  const root = chosen.rootComponent;
  const cited = new Set(chosen.supporting.filter((ref) => ref.startsWith('change:')));
  const release = isReleaseComponent(root);
  const owned = book.changeEntries.filter(([, c]) => managesChangeTargets(root, c, subgraph)).map(([ref]) => ref);
  if (!release && owned.length === 0 && cited.size === 0) {
    return r;
  }
  const grades = bookChangeGrades(book, incident);
  if (book.changeEntries.length > 0 && grades.size === 0) {
    return {
      ...r,
      notes: [...r.notes, `事件没有变更关联分级（契约 2.37.0 之前算出），假设 ${chosen.id} 的档位不按分级限制`],
    };
  }
  // 根因是发布逻辑组件时，证据簿里的全部变更都对应它；管理应用对应它管理的目标上的变更；再加上引用的变更
  const refs = new Set([...(release ? book.changeEntries.map(([ref]) => ref) : owned), ...cited]);
  const items = [...refs].map((ref) => grades.get(ref)).filter((g): g is BookChangeGrade => g !== undefined);
  if (items.some((g) => g.grade === 'high')) {
    return r;
  }
  const why = items.length
    ? items
        .sort((a, b) => CHANGE_GRADE_RANK[b.grade] - CHANGE_GRADE_RANK[a.grade] || a.ref.localeCompare(b.ref))
        .map((g) => `${g.ref}（${g.change.change_id}）分级 ${g.grade}：${missing(g)}`)
        .join('；')
    : '事件与证据簿里没有对应的变更';
  return {
    ...r,
    level: 'inconclusive',
    notes: [
      ...r.notes,
      `假设 ${chosen.id} 的根因 ${root} 归到变更上，但对应的变更没有 high 分级（${why}），档位由 ${r.level} 改为 inconclusive（ADR 0169）`,
    ],
  };
}
