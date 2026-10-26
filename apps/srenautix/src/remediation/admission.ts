import type { EvidenceResult, ResearchOutput } from '@srenautix/contract';
import { displayKey, tryNodeKey } from '@srenautix/core';
import type { RemediationPlan } from '@srenautix/packs-sdk';
import { REPOSITORY_SCOPES } from '../research/validate.js';

// 自愈 PR 的准入条件（ADR 0170），全部是纯函数，server 的自愈 PR（service.ts）与重建评测（eval/remediation.ts）共用。
// alert_rule 以外的类别修改系统本身，四项条件同时成立才开 PR：
// - cause_scope：研判输出的根因范围为 local 或 configuration（代码已按确定性依据校正，见 research/validate.ts）；
// - topology_only：结论的支撑有证据卡，不只是成员告警与变更；
// - no_runtime_evidence：支撑卡中至少一张的查询是运行时证据（指标、日志、数据库统计，或 Kubernetes 只读检查 kube_*）；
// - no_repo_fact：计划修改的文件在基线上都存在，并且研判根因由 GitOps 仓库负责（仓库声明的组件，或管理它们的 GitOps 应用）。
// 前三项只看研判输出，在模板匹配之前按运行判断；最后一项要看补丁计划，在计划校验之后按模板判断。
// alert_rule 类别修改的是告警本身：处置为 ignore、并且 ignore 的依据说明系统状态正常时才开 PR（not_benign）。

export type AdmissionCode = 'cause_scope' | 'topology_only' | 'no_runtime_evidence' | 'no_repo_fact' | 'not_benign';

export interface AdmissionBlock {
  code: AdmissionCode;
  reason: string;
}

/** 按运行判断的准入结果：不满足时给出跳过代码与原因，满足时为 null */
export interface RunAdmission {
  /** alert_rule 以外的类别 */
  general: AdmissionBlock | null;
  /** alert_rule 类别 */
  alertRule: AdmissionBlock | null;
}

export interface RunAdmissionInput {
  /** 研判输出；没有时（研判失败或只出阶段 A）两类都不准入 */
  output: ResearchOutput | null;
  /** 研判的处置（research_runs.disposition）；为 null 时取输出里的处置 */
  disposition: string | null;
  /** 研判针对的事件版本的阶段 A 卡：研判运行开始时证据簿里的卡 */
  stageACards: readonly EvidenceResult[];
}

/** 运行时证据的查询能力族：指标、日志与数据库统计 */
const RUNTIME_FAMILIES: ReadonlySet<string> = new Set(['metrics', 'logs', 'dbstats']);

/**
 * ignore 的依据中说明系统状态正常、因而告警本身过于敏感的几种（ADR 0168 的依据）：阶段 A 的确定性 ignore（抑制、领域包
 * 排除、只有预测类与长期告警）、得出结论的卡全部正常、影响卡全部正常。计划内的退役（告警如实反映了一次计划中的变更）与
 * 外部组件为根因（告警如实反映了上游故障）不在其中
 */
export const BENIGN_IGNORE_BASES: ReadonlySet<string> = new Set(['stage_a', 'evidence_normal', 'impact_normal']);

/** 查询是否为运行时证据：指标、日志、数据库统计，或 Kubernetes 只读检查（只读工具 kube_*） */
export function isRuntimeQuery(q: Pick<EvidenceResult['queries'][number], 'capability' | 'name'>): boolean {
  if (q.capability === 'tool') {
    return q.name.startsWith('kube_');
  }
  return RUNTIME_FAMILIES.has(q.capability.split('.')[0] ?? '');
}

/**
 * 研判输出里卡的引用 → 卡的结果，按研判运行时的证据簿解析：区分性检查产生的卡在 check_cards 中按引用找；其余是运行开始时
 * 的阶段 A 卡，按 evidence_index 给出的 <card_id>@<实体键> 在研判针对的事件版本的阶段 A 卡中找（不按编号，阶段 A 重算会
 * 改变编号）。找不到时为 null
 */
export function resolveCards(
  out: Pick<ResearchOutput, 'check_cards' | 'evidence_index'>,
  stageACards: readonly EvidenceResult[],
  refs: readonly string[],
): Map<string, EvidenceResult | null> {
  const checks = new Map((out.check_cards ?? []).map((c) => [c.ref, c]));
  const index = new Map((out.evidence_index ?? []).map((x) => [x.ref, x.target]));
  const keyOf = (c: EvidenceResult) => {
    const k = c.entity ? tryNodeKey(c.entity.kind, c.entity.namespace, c.entity.name) : null;
    return `${c.card_id}@${k ?? ''}`;
  };
  const byTarget = new Map(stageACards.map((c) => [keyOf(c), c]));
  const result = new Map<string, EvidenceResult | null>();
  for (const ref of refs) {
    const target = index.get(ref);
    const check = checks.get(ref);
    if (check && (target === undefined || target.startsWith(`${check.card_id}@`))) {
      result.set(ref, check);
      continue;
    }
    result.set(ref, target === undefined ? null : (byTarget.get(target) ?? null));
  }
  return result;
}

/** 一张卡的查询能力，去重后按出现顺序 */
function capabilities(c: EvidenceResult): string[] {
  return [...new Set(c.queries.map((q) => (q.capability === 'tool' ? `tool ${q.name}` : q.capability)))];
}

/** alert_rule 以外类别按运行判断的三项条件 */
function generalAdmission(out: ResearchOutput | null, stageACards: readonly EvidenceResult[]): AdmissionBlock | null {
  if (!out) {
    return { code: 'cause_scope', reason: '研判没有输出，根因范围未知' };
  }
  const scope = out.conclusion.cause_scope;
  if (scope === undefined || !REPOSITORY_SCOPES.has(scope)) {
    return {
      code: 'cause_scope',
      reason: `根因范围为 ${scope ?? '空（研判输出没有根因范围）'}，只有 local 与 configuration（根因由 GitOps 仓库负责）开自愈 PR`,
    };
  }
  const detail = out.conclusion.consistency_detail;
  // 只读工具的结果由小模型判定，记在 model_judged_refs；两者都是结论的支撑卡
  const refs = detail ? [...new Set([...detail.support_refs, ...detail.model_judged_refs])] : [];
  if (!refs.length) {
    const alerts = detail?.support_alerts.length ?? 0;
    return {
      code: 'topology_only',
      reason: `结论没有支撑卡，${alerts ? `只有 ${alerts} 条成员告警` : '只有拓扑关系'}与变更支撑`,
    };
  }
  const cards = resolveCards(out, stageACards, refs);
  const runtime = refs.filter((r) => cards.get(r)?.queries.some(isRuntimeQuery));
  if (!runtime.length) {
    const seen = refs.map((r) => {
      const c = cards.get(r);
      return c ? `${r}（${capabilities(c).join('、') || '没有查询'}）` : `${r}（研判运行的证据里找不到）`;
    });
    return {
      code: 'no_runtime_evidence',
      reason: `支撑卡 ${seen.join('、')}都不是运行时证据（指标、日志、数据库统计或 Kubernetes 只读检查）`,
    };
  }
  return null;
}

/** alert_rule 类别：处置为 ignore，并且 ignore 的依据说明系统状态正常 */
function alertRuleAdmission(out: ResearchOutput | null, disposition: string | null): AdmissionBlock | null {
  const d = disposition ?? out?.disposition ?? null;
  if (d !== 'ignore') {
    return { code: 'not_benign', reason: `处置为 ${d ?? '空'}，告警调优只在处置为 ignore 时提出` };
  }
  const basis = out?.ignore_basis;
  if (basis === undefined || !BENIGN_IGNORE_BASES.has(basis)) {
    return {
      code: 'not_benign',
      reason: `ignore 的依据为 ${basis ?? '空（研判输出没有依据）'}，不说明系统状态正常；告警调优要求依据为阶段 A 的确定性 ignore、得出结论的卡全部正常或影响卡全部正常`,
    };
  }
  return null;
}

export function runAdmission(i: RunAdmissionInput): RunAdmission {
  return {
    general: generalAdmission(i.output, i.stageACards),
    alertRule: alertRuleAdmission(i.output, i.disposition),
  };
}

/** 模板类别适用的运行级准入结果 */
export function admissionFor(category: string, a: RunAdmission): AdmissionBlock | null {
  return category === 'alert_rule' ? a.alertRule : a.general;
}

/**
 * 仓库事实（no_repo_fact，alert_rule 以外的类别）：计划修改的文件在基线上都存在（before 非空），并且研判根因由 GitOps 仓库
 * 负责（owned 由调用方按处置依据的规则求出，见 facts.ts 的 repositoryRoots）
 */
export function repositoryFact(
  plan: Pick<RemediationPlan, 'files'>,
  root: string | null,
  owned: boolean,
): AdmissionBlock | null {
  const created = plan.files.filter((f) => f.before === '').map((f) => f.path);
  if (created.length) {
    return { code: 'no_repo_fact', reason: `计划修改的文件 ${created.join('、')} 在基线上不存在` };
  }
  if (root === null || !owned) {
    return {
      code: 'no_repo_fact',
      reason:
        root === null
          ? '研判没有选中根因'
          : `研判根因 ${displayKey(root)} 不由 GitOps 仓库负责（不是仓库声明的组件，也不是管理它们的 GitOps 应用）`,
    };
  }
  return null;
}
