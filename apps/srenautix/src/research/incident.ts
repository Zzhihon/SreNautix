import type { Language } from '../prompts/index.js';
import { supplementChecks, type NextCheck } from './checks.js';
import { EvidenceBook, type BookInput } from './evidence.js';
import type { Ledger, LedgerEntry } from './ledger.js';
import type { ResearchCase } from './types.js';
import { evidenceCorpus } from './validate.js';
import type { NumberCorpus } from './numbers.js';

// 事件研判对共用模块（证据簿、检查补选、数值审计，ADR 0146 §2.7）的输入：共用模块不依赖事件，
// 事件特有的部分（阶段 A 的卡、仍在事件中的成员告警、事件的组件与时间线）在这里取出。

/** 事件研判的证据簿内容：阶段 A 的卡、仍在事件中的成员告警、事件的变更与相关变更（ADR 0106） */
export function incidentBookInput(c: ResearchCase): BookInput {
  return {
    cards: c.stageA.cards,
    alerts: c.incident.members.filter((m) => m.left_version === null),
    changes: c.incident.changes,
    relatedChanges: c.relatedChanges ?? [],
  };
}

export function incidentBook(c: ResearchCase): EvidenceBook {
  return new EvidenceBook(incidentBookInput(c));
}

/** 事件的组件（按组件粒度）：根因、候选根因与事件组件，控制器补选检查的范围（ADR 0137） */
export function incidentComponents(c: ResearchCase, ledger: Ledger): Set<string> {
  const inc = c.incident;
  return new Set(
    [inc.root.component, ...inc.candidates.map((x) => x.component), ...inc.components]
      .filter((k): k is string => typeof k === 'string' && k !== '')
      .map((k) => ledger.componentOf(k)),
  );
}

/** hypothesize 没有给出检查时控制器为事件补选的卡片检查（ADR 0137） */
export function incidentSupplement(
  c: ResearchCase,
  ledger: Ledger,
  open: readonly LedgerEntry[],
  done: ReadonlySet<string>,
  language: Language,
): NextCheck[] {
  return supplementChecks(c.templates, incidentComponents(c, ledger), ledger, open, done, language);
}

/** 事件研判的数值审计语料：证据簿，加上事件的时间、候选得分与根因差值、阶段 A 的时间线（ADR 0125） */
export function incidentCorpus(c: ResearchCase, book: EvidenceBook): NumberCorpus {
  return evidenceCorpus(book, {
    times: [
      c.incident.first_firing_at,
      c.incident.created_at,
      c.stageA.rendered_at,
      ...c.stageA.timeline.map((t) => t.at),
    ],
    texts: c.stageA.timeline.map((t) => t.text),
    numbers: [
      ...c.incident.candidates.map((x) => x.score),
      ...(c.incident.root.margin !== null ? [c.incident.root.margin] : []),
    ],
  });
}
