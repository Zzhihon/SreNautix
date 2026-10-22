import type { ConclusionLevel, Disposition, Incident, StageAReport } from '@srenautix/contract';
import { displayKey } from '@srenautix/core';
import type { CardEntry } from './evidence.js';
import type { DispositionFacts } from './types.js';

// 处置推导（ADR 0138）：模型给出的处置是输入之一，最终处置由代码按确定性依据推导。
// - 观测失明时一律 escalate；
// - ignore 只在确定性依据成立时给出（不论模型给出什么）：阶段 A 已判为 ignore；研判根因（likely 及以上）是领域包声明的
//   集群外部组件；没有任何异常卡；影响卡全部正常。四种依据都要求没有有效提议、没有规则提议、修复模板使用的根因上没有
//   适用的修复模板（ignore 不带修复）；
// - 模型给出 ignore 而没有依据时按严重度改写（critical 为 escalate，其余为 undetermined）；
// - act 需要选中的根因，以及一条有效的提议、一条规则提议或修复模板使用的根因上适用的修复模板，否则按严重度改写；
// - escalate 与 undetermined 保持模型的取值。

/** 修复模板中修改系统本身、能消除根因的类别；alert_rule 与 topology_coverage 是告警与领域包的维护，不算修复 */
export const FIX_CATEGORIES: ReadonlySet<string> = new Set(['release_rollback', 'config_resource']);

/** 研判根因达到这些档位时，修复模板按研判根因匹配（与 remediation/service.ts 的 RESEARCH_ROOT_LEVELS 相同，ADR 0126） */
const RESEARCH_ROOT_LEVELS: ReadonlySet<ConclusionLevel> = new Set(['likely', 'evidence_consistent']);

/** 阶段 A 的确定性 ignore（DESIGN §7.1）：命中抑制、领域包排除，或只有预测类与长期告警 */
const STAGE_A_IGNORE: ReadonlySet<string> = new Set(['suppressed', 'pack_exclude', 'forecast_or_chronic_only']);

export type IgnoreBasis = 'stage_a' | 'external' | 'evidence_normal' | 'impact_normal';

export interface DispositionInput {
  /** 模型给出的处置 */
  model: Disposition;
  incident: Pick<Incident, 'severity' | 'root'>;
  stageA: Pick<StageAReport, 'observability_blind' | 'disposition' | 'disposition_reason' | 'rule_proposals'>;
  /** 结论阶梯的档位 */
  level: ConclusionLevel;
  /** 选中的研判根因；没有选中假设时为 null */
  root: string | null;
  /** 校验之后仍然有效的提议数 */
  proposals: number;
  /** 本次研判的全部证据卡（阶段 A 与区分性检查） */
  cards: readonly CardEntry[];
  facts: DispositionFacts | null | undefined;
}

export interface DispositionResult {
  disposition: Disposition;
  /** 处置为 ignore 时的依据 */
  basis: IgnoreBasis | null;
  /** 修复模板使用的根因上适用的修复模板 */
  templates: string[];
  notes: string[];
}

/** 修复模板使用的根因：研判结论达到 likely 时取研判根因，否则取事件根因（ADR 0126） */
export function templateRoot(level: ConclusionLevel, root: string | null, incidentRoot: string | null): string | null {
  return root !== null && RESEARCH_ROOT_LEVELS.has(level) ? root : incidentRoot;
}

/** 根因上适用的修复模板（只含 FIX_CATEGORIES） */
export function fixTemplates(facts: DispositionFacts | null | undefined, root: string | null): string[] {
  if (!facts || root === null) {
    return [];
  }
  return (facts.remediations.find((r) => r.root === root)?.templates ?? [])
    .filter((t) => FIX_CATEGORIES.has(t.category))
    .map((t) => t.key);
}

/** ignore 的确定性依据；没有时为 null。前提：没有有效提议、规则提议与适用的修复模板 */
function ignoreBasis(i: DispositionInput, templates: readonly string[]): { basis: IgnoreBasis; why: string } | null {
  if (i.proposals > 0 || i.stageA.rule_proposals.length > 0 || templates.length > 0) {
    return null;
  }
  if (i.stageA.disposition === 'ignore' && STAGE_A_IGNORE.has(i.stageA.disposition_reason)) {
    return { basis: 'stage_a', why: `阶段 A 判为 ignore（${i.stageA.disposition_reason}）` };
  }
  if (i.root !== null && RESEARCH_ROOT_LEVELS.has(i.level) && (i.facts?.external ?? []).includes(i.root)) {
    return {
      basis: 'external',
      why: `研判根因 ${displayKey(i.root)}（${i.level}）是领域包声明的集群外部组件，集群内没有可处置的对象`,
    };
  }
  // 只有领域包规则判定的卡算确定性证据；只读工具结果由小模型判定的卡不算
  const rule = i.cards.filter((c) => c.judgedBy === 'rule');
  const determinate = rule.filter((c) => c.result.verdict === 'abnormal' || c.result.verdict === 'normal');
  if (determinate.length > 0 && determinate.every((c) => c.result.verdict === 'normal')) {
    return { basis: 'evidence_normal', why: `${determinate.length} 张得出结论的卡全部正常，没有异常卡` };
  }
  const impact = rule.filter((c) => c.result.impact === true);
  if (impact.length > 0 && impact.every((c) => c.result.verdict === 'normal')) {
    return {
      basis: 'impact_normal',
      why: `影响卡 ${impact.map((c) => c.ref).join('、')} 全部正常`,
    };
  }
  return null;
}

export function deriveDisposition(i: DispositionInput): DispositionResult {
  const notes: string[] = [];
  const fallback: Disposition = i.incident.severity === 'critical' ? 'escalate' : 'undetermined';
  const templates = fixTemplates(i.facts, templateRoot(i.level, i.root, i.incident.root.component));
  if (i.stageA.observability_blind) {
    if (i.model !== 'escalate') {
      notes.push(`观测失明时不由模型判断，处置改为 escalate（模型给出 ${i.model}）`);
    }
    return { disposition: 'escalate', basis: null, templates, notes };
  }
  const ignore = ignoreBasis(i, templates);
  if (ignore) {
    notes.push(
      i.model === 'ignore' ? `处置为 ignore：${ignore.why}` : `处置改为 ignore（模型给出 ${i.model}）：${ignore.why}`,
    );
    return { disposition: 'ignore', basis: ignore.basis, templates, notes };
  }
  if (i.model === 'ignore') {
    const why =
      i.proposals > 0
        ? `有 ${i.proposals} 条有效提议，ignore 不带修复`
        : templates.length > 0
          ? `根因上有适用的修复模板 ${templates.join('、')}，ignore 不带修复`
          : i.stageA.rule_proposals.length > 0
            ? '有规则提议，ignore 不带修复'
            : '没有确定性依据（阶段 A 没有判为 ignore，根因不是 likely 以上的集群外部组件，有异常卡，影响卡不是全部正常）';
    notes.push(`模型给出 ignore，但${why}，改为 ${fallback}`);
    return { disposition: fallback, basis: null, templates, notes };
  }
  if (i.model === 'act') {
    if (i.root === null) {
      notes.push(`处置为 act 但根因无法判定，改为 ${fallback}`);
      return { disposition: fallback, basis: null, templates, notes };
    }
    if (i.proposals === 0 && i.stageA.rule_proposals.length === 0) {
      if (templates.length === 0) {
        notes.push(`处置为 act 但没有有效的提议、规则提议或适用的修复模板，改为 ${fallback}`);
        return { disposition: fallback, basis: null, templates, notes };
      }
      notes.push(`处置为 act：没有有效提议，修复由适用的修复模板 ${templates.join('、')} 给出`);
    }
    return { disposition: 'act', basis: null, templates, notes };
  }
  return { disposition: i.model, basis: null, templates, notes };
}
