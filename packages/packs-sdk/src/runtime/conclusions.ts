// 确定性结论规则的求值（conclusions.yaml，ADR 0178）。阶段 A 与 pack test 共用：
// 规则在每个求值对象（组件）上检查全部条件，成立时给出根因候选（求值对象本身）与依据（满足条件的证据引用）。
// 条件分三类：证据卡结果、成员告警、变更；on 为 self 时只看落在求值对象上的证据，incident 时看事件里的全部证据。

import type { AlertRole, ChangeGrade, Labels, LocalizedText } from '@srenautix/contract';

export type ConclusionScope = 'self' | 'incident';
export type ObservationOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne';
/** 卡片判定时 let 绑定的取值（EvidenceResult.observations） */
export type Observations = Readonly<Record<string, number | string | boolean | null | undefined>>;

/** 编译后的结论规则：卡片条件已解析为全局卡键 <pack>/<chain>/<card> */
export interface CompiledConclusion {
  pack: string;
  id: string;
  /** <pack>/<规则 id> */
  key: string;
  title: LocalizedText;
  /** 求值对象的组件类型；为 null 时在全部组件上求值 */
  componentTypes: ReadonlySet<string> | null;
  cards: Array<{
    card: string;
    verdict: 'abnormal' | 'normal';
    observations: Array<{ name: string; op: ObservationOp; value: number | string | boolean }>;
    on: ConclusionScope;
  }>;
  alerts: Array<{
    alertnames: ReadonlySet<string>;
    labels: Readonly<Labels>;
    roles: ReadonlySet<AlertRole> | null;
    on: ConclusionScope;
  }>;
  changes: Array<{ kinds: ReadonlySet<string> | null; minGrade: ChangeGrade | null; on: ConclusionScope }>;
  mechanism: LocalizedText;
}

/** 求值输入：阶段 A 的卡、成员告警与变更，各自带证据引用与所属组件 */
export interface ConclusionInput {
  /** 求值对象：组件键 → 组件类型（没有匹配到组件类型时为 null），按根因候选的排名排列 */
  components: ReadonlyArray<{ key: string; type: string | null }>;
  cards: ReadonlyArray<{
    ref: string;
    card_id: string;
    /** 卡的实体所属的组件；不知道时为 null（只满足 on: incident 的条件） */
    component: string | null;
    verdict: 'normal' | 'abnormal' | 'undeterminable';
    /** 证据基线判为常态（ADR 0153）：异常卡按正常对待 */
    routine: boolean;
    observations: Observations | undefined;
  }>;
  alerts: ReadonlyArray<{ ref: string; alertname: string; labels: Labels; role: AlertRole; component: string | null }>;
  changes: ReadonlyArray<{
    ref: string;
    kind: string;
    /** 变更的目标与管理它们的 GitOps 应用（ChangeEvent.targets 与 refs） */
    targets: readonly string[];
    /** 事件与变更的关联分级（ADR 0169）；事件没有分级时为 null */
    grade: ChangeGrade | null;
  }>;
}

export interface ConclusionHit {
  rule: CompiledConclusion;
  /** 根因候选：命中的求值对象 */
  root: string;
  /** 满足条件的证据引用：证据卡、告警、变更的顺序，去重 */
  basis: string[];
}

const GRADE_RANK: Record<ChangeGrade, number> = { low: 0, medium: 1, high: 2 };

function compare(
  have: number | string | boolean | null | undefined,
  op: ObservationOp,
  want: number | string | boolean,
) {
  if (have === null || have === undefined) {
    return false;
  }
  switch (op) {
    case 'eq':
      return have === want;
    case 'ne':
      return have !== want;
    default: {
      // 大小比较只用于数值（编译时已检查 value 是数值）
      if (typeof have !== 'number' || typeof want !== 'number') {
        return false;
      }
      return op === 'gt' ? have > want : op === 'gte' ? have >= want : op === 'lt' ? have < want : have <= want;
    }
  }
}

/** 卡片条件的判定部分（结论与 observations）：不看实体 */
export interface CardCondition {
  card: string;
  verdict: 'abnormal' | 'normal';
  observations: ReadonlyArray<{ name: string; op: ObservationOp; value: number | string | boolean }>;
}

/**
 * 一张卡的结果是否满足卡片条件的判定部分。无法判定的卡两种结论都不满足；常态的异常卡按正常对待（ADR 0153）。
 * 研判用它判断区分性检查的结果是否推翻规则判定
 */
export function cardConditionHolds(
  c: CardCondition,
  verdict: 'normal' | 'abnormal' | 'undeterminable',
  routine: boolean,
  observations: Observations | undefined,
): boolean {
  const v = verdict === 'abnormal' && routine ? 'normal' : verdict;
  return v === c.verdict && c.observations.every((o) => compare(observations?.[o.name], o.op, o.value));
}

/** 一个条件在求值对象 root 上满足的证据引用；没有时为空 */
function matchCards(c: CompiledConclusion['cards'][number], root: string, input: ConclusionInput): string[] {
  return input.cards
    .filter(
      (x) =>
        x.card_id === c.card &&
        (c.on === 'incident' || x.component === root) &&
        cardConditionHolds(c, x.verdict, x.routine, x.observations),
    )
    .map((x) => x.ref);
}

function matchAlerts(c: CompiledConclusion['alerts'][number], root: string, input: ConclusionInput): string[] {
  return input.alerts
    .filter(
      (a) =>
        c.alertnames.has(a.alertname) &&
        (c.on === 'incident' || a.component === root) &&
        (c.roles === null || c.roles.has(a.role)) &&
        Object.entries(c.labels).every(([k, v]) => a.labels[k] === v),
    )
    .map((a) => a.ref);
}

function matchChanges(c: CompiledConclusion['changes'][number], root: string, input: ConclusionInput): string[] {
  return input.changes
    .filter(
      (x) =>
        (c.on === 'incident' || x.targets.includes(root)) &&
        (c.kinds === null || c.kinds.has(x.kind)) &&
        (c.minGrade === null || (x.grade !== null && GRADE_RANK[x.grade] >= GRADE_RANK[c.minGrade])),
    )
    .map((x) => x.ref);
}

/** 规则在求值对象上的依据；有条件不满足时为 null */
export function conclusionBasis(rule: CompiledConclusion, root: string, input: ConclusionInput): string[] | null {
  const basis: string[] = [];
  const groups = [
    ...rule.cards.map((c) => matchCards(c, root, input)),
    ...rule.alerts.map((c) => matchAlerts(c, root, input)),
    ...rule.changes.map((c) => matchChanges(c, root, input)),
  ];
  for (const refs of groups) {
    if (!refs.length) {
      return null;
    }
    basis.push(...refs);
  }
  return [...new Set(basis)];
}

/**
 * 按声明顺序求值全部结论规则：每条规则在每个求值对象上检查一次（组件类型不符的跳过），命中的按求值对象的顺序排列，
 * 同一求值对象上先声明的规则在前。规则只含数据，求值不会出错
 */
export function evaluateConclusions(rules: readonly CompiledConclusion[], input: ConclusionInput): ConclusionHit[] {
  const out: ConclusionHit[] = [];
  for (const { key, type } of input.components) {
    for (const rule of rules) {
      if (rule.componentTypes !== null && (type === null || !rule.componentTypes.has(type))) {
        continue;
      }
      const basis = conclusionBasis(rule, key, input);
      if (basis) {
        out.push({ rule, root: key, basis });
      }
    }
  }
  return out;
}
