import type { ConclusionLevel, Disposition, Incident, StageAReport } from '@srenautix/contract';
import { displayKey } from '@srenautix/core';
import { isRoutine } from '../stage-a/novelty.js';
import type { CardEntry } from './evidence.js';
import type { DispositionFacts } from './types.js';

// 处置推导（ADR 0138）：模型给出的处置是输入之一，最终处置由代码按确定性依据推导。
// - 观测失明时一律 escalate；
// - ignore 只在确定性依据成立时给出（不论模型给出什么）：阶段 A 已判为 ignore；研判根因（likely 及以上）是领域包声明的
//   集群外部组件；没有任何异常卡；影响卡全部正常。四种依据都要求没有有效提议、没有规则提议、修复模板使用的根因上没有
//   适用的修复模板（ignore 不带修复）。证据基线判为常态的异常卡（ADR 0153）在这里按正常计；
// - 有触发中的 critical 业务影响告警（处置依据的 business_impact），并且有规则判定的异常卡时，四种依据都不成立，
//   模型给出的 ignore 按严重度改写（ADR 0163）；
// - 最低取证集合没有覆盖（ADR 0153）时，除阶段 A 已判为 ignore 之外，不给 ignore，也不给 act；
// - 模型给出 ignore 而没有依据时按严重度改写（critical 为 escalate，其余为 undetermined）；
// - act 表示有可以经 Git 或动作目录执行的处置（ADR 0162）。两种确定性依据不论模型给出什么都给 act：
//   1. 研判根因（likely 及以上）上有适用的修复模板：server 会按模板开出修复 PR；
//   2. 研判根因（likely 及以上）与发现根因都是 GitOps 仓库声明的运行中组件（declared），并且选中的假设有规则判定的支持卡：
//      事件不是由一次变更（GitOps 应用、逻辑组件 release 等发现根因）引起，根因的状态有证据说明异常，消除根因的办法是
//      修改仓库中这个组件的声明，改什么由修复建议写明；
//   模型给出 act 时，一条有效提议、一条规则提议或修复模板使用的根因（档位低于 likely 时为事件根因）上适用的修复模板也是依据。
//   模型给出 act 而依据都不成立时按严重度改写；
// - 其余情况下 escalate（需要应用代码、外部服务方或人决定）与 undetermined 保持模型的取值。

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
  /** 选中假设的规则判定的支持卡数（结论阶梯的 support_refs，常态的卡不算，ADR 0153） */
  ruleSupport: number;
  /** 校验之后仍然有效的提议数 */
  proposals: number;
  /** 本次研判的全部证据卡（阶段 A 与区分性检查） */
  cards: readonly CardEntry[];
  facts: DispositionFacts | null | undefined;
  /** 最低取证集合的缺口（ADR 0153，missingRequired 的说明）；没有时为空 */
  gaps?: readonly string[];
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

/**
 * 不能 ignore 的业务影响（ADR 0163）：有触发中的 critical 业务影响告警，并且有领域包规则判定的异常卡（证据基线判为常态的
 * 不算）。成立时返回说明，否则为 null
 */
function impactHeld(i: DispositionInput): string | null {
  const alerts = i.facts?.business_impact ?? [];
  const abnormal = i.cards.filter(
    (c) => c.judgedBy === 'rule' && c.result.verdict === 'abnormal' && !isRoutine(c.result),
  );
  if (!alerts.length || !abnormal.length) {
    return null;
  }
  return `${alerts.length} 条 critical 业务影响告警在触发，${abnormal.length} 张证据卡异常（${abnormal
    .slice(0, 3)
    .map((c) => c.ref)
    .join('、')}${abnormal.length > 3 ? ' 等' : ''}）`;
}

/** ignore 的确定性依据；没有时为 null。前提：没有有效提议、规则提议与适用的修复模板，也没有不能 ignore 的业务影响 */
function ignoreBasis(i: DispositionInput, templates: readonly string[]): { basis: IgnoreBasis; why: string } | null {
  if (i.proposals > 0 || i.stageA.rule_proposals.length > 0 || templates.length > 0 || impactHeld(i)) {
    return null;
  }
  if (i.stageA.disposition === 'ignore' && STAGE_A_IGNORE.has(i.stageA.disposition_reason)) {
    return { basis: 'stage_a', why: `阶段 A 判为 ignore（${i.stageA.disposition_reason}）` };
  }
  if (i.gaps?.length) {
    return null;
  }
  if (i.root !== null && RESEARCH_ROOT_LEVELS.has(i.level) && (i.facts?.external ?? []).includes(i.root)) {
    return {
      basis: 'external',
      why: `研判根因 ${displayKey(i.root)}（${i.level}）是领域包声明的集群外部组件，集群内没有可处置的对象`,
    };
  }
  // 只有领域包规则判定的卡算确定性证据；只读工具结果由小模型判定的卡不算。常态的异常卡按正常计（ADR 0153）
  const rule = i.cards.filter((c) => c.judgedBy === 'rule');
  const normal = (c: CardEntry) => c.result.verdict === 'normal' || isRoutine(c.result);
  const routine = (list: readonly CardEntry[]) => {
    const r = list.filter((c) => isRoutine(c.result)).map((c) => c.ref);
    return r.length ? `（${r.join('、')} 为常态）` : '';
  };
  const determinate = rule.filter((c) => c.result.verdict === 'abnormal' || c.result.verdict === 'normal');
  if (determinate.length > 0 && determinate.every(normal)) {
    return {
      basis: 'evidence_normal',
      why: `${determinate.length} 张得出结论的卡全部正常${routine(determinate)}，没有异常卡`,
    };
  }
  const impact = rule.filter((c) => c.result.impact === true);
  if (impact.length > 0 && impact.every(normal)) {
    return {
      basis: 'impact_normal',
      why: `影响卡 ${impact.map((c) => c.ref).join('、')} 全部正常${routine(impact)}`,
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
  const act = i.gaps?.length ? null : actBasis(i, templates);
  if (act && i.model !== 'act') {
    notes.push(`处置改为 act（模型给出 ${i.model}）：${act}`);
    return { disposition: 'act', basis: null, templates, notes };
  }
  if (i.model === 'ignore') {
    const held = impactHeld(i);
    const why = held
      ? `${held}，业务受影响时不给 ignore（ADR 0163）`
      : i.proposals > 0
        ? `有 ${i.proposals} 条有效提议，ignore 不带修复`
        : templates.length > 0
          ? `根因上有适用的修复模板 ${templates.join('、')}，ignore 不带修复`
          : i.stageA.rule_proposals.length > 0
            ? '有规则提议，ignore 不带修复'
            : i.gaps?.length
              ? '最低取证集合没有覆盖（ADR 0153）'
              : '没有确定性依据（阶段 A 没有判为 ignore，根因不是 likely 以上的集群外部组件，有异常卡，影响卡不是全部正常）';
    notes.push(`模型给出 ignore，但${why}，改为 ${fallback}`);
    return { disposition: fallback, basis: null, templates, notes };
  }
  if (i.model === 'act') {
    if (i.root === null) {
      notes.push(`处置为 act 但根因无法判定，改为 ${fallback}`);
      return { disposition: fallback, basis: null, templates, notes };
    }
    if (i.gaps?.length) {
      notes.push(`处置为 act 但最低取证集合没有覆盖（ADR 0153），改为 ${fallback}`);
      return { disposition: fallback, basis: null, templates, notes };
    }
    if (i.proposals > 0 || i.stageA.rule_proposals.length > 0) {
      return { disposition: 'act', basis: null, templates, notes };
    }
    if (templates.length > 0) {
      notes.push(`处置为 act：没有有效提议，修复由适用的修复模板 ${templates.join('、')} 给出`);
      return { disposition: 'act', basis: null, templates, notes };
    }
    if (act) {
      notes.push(`处置为 act：没有有效提议与适用的修复模板，${act}`);
      return { disposition: 'act', basis: null, templates, notes };
    }
    notes.push(
      `处置为 act 但没有有效的提议、规则提议或适用的修复模板，研判根因与发现根因也不都是结论 likely 以上、由 GitOps 仓库声明的运行中组件，改为 ${fallback}`,
    );
    return { disposition: fallback, basis: null, templates, notes };
  }
  return { disposition: i.model, basis: null, templates, notes };
}

/**
 * 不论模型给出什么都给 act 的确定性依据（ADR 0162）；没有时为 null。调用方先排除最低取证集合的缺口
 * - 研判根因 likely 及以上、上面有适用的修复模板：server 会按模板开出修复 PR（ADR 0126）；
 * - 研判根因 likely 及以上，它与发现根因都是 GitOps 仓库声明的运行中组件，并且选中的假设有规则判定的支持卡：发现根因是
 *   GitOps 应用或逻辑组件（例如 release）时事件由一次变更引起，回退还是向前修复要由修复模板的检查或人决定，不算依据；
 *   只有成员告警支持（或支持卡都是常态）时没有证据说明根因的状态异常，也不算依据
 */
function actBasis(i: DispositionInput, templates: readonly string[]): string | null {
  if (i.root === null || !RESEARCH_ROOT_LEVELS.has(i.level)) {
    return null;
  }
  if (templates.length > 0) {
    return `研判根因 ${displayKey(i.root)}（${i.level}）上适用修复模板 ${templates.join('、')}，server 会按模板开出修复 PR`;
  }
  const declared = i.facts?.declared ?? [];
  const found = i.incident.root.component;
  if (declared.includes(i.root) && found !== null && declared.includes(found) && i.ruleSupport > 0) {
    return `研判根因 ${displayKey(i.root)}（${i.level}，${i.ruleSupport} 张规则判定的支持卡）与发现根因 ${displayKey(found)} 都由 GitOps 仓库声明，修复是修改仓库中的声明（见修复建议）`;
  }
  return null;
}
