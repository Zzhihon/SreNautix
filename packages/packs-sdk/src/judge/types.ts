// 证据卡判定的类型。卡片定义来自契约（contract/schemas/evidence-card.schema.json）。

import type { EvidenceCardDefinition, LocalizedText } from '@srenautix/contract';

export type Locale = 'zh-CN' | 'en';
export type { LocalizedText };
export type CardDefinition = EvidenceCardDefinition;

export type Verdict = 'normal' | 'abnormal' | 'undeterminable';
export type DisplayState = Verdict | 'capability_missing';
export type ReasonKind =
  | 'rule'
  | 'no_data'
  | 'partial_data'
  | 'source_error'
  | 'capability_missing'
  | 'observability_gap'
  | 'evaluation_error'
  | 'all_clear';

export type Scalar = number | string | boolean;

/** 一条求值过的判定条件 */
export interface ConditionOutcome {
  kind: 'undeterminable' | 'abnormal';
  cel: string;
  outcome: 'hit' | 'miss' | 'unavailable';
  /** 命中时为 say；没有命中时为 normal_say（卡片提供时），否则为 null */
  say: string | null;
}

export interface CardOutcome {
  verdict: Verdict;
  display_state: DisplayState;
  reason: { kind: ReasonKind; text: string };
  value: string | null;
  /** 主值格式化之前的数值；没有主值或不是有限数时为 null */
  value_number: number | null;
  threshold: number | null;
  /** 对比基线（display.baseline）；没有或不可用时为 null */
  baseline: number | null;
  table: { head: string[]; rows: string[][] } | null;
  /** unix 秒；卡片用 let anomaly_started_at 给出 */
  anomaly_started_at: number | null;
  /** let 绑定的标量取值，按定义顺序最多 16 个；不可用时为 null */
  observations: Record<string, Scalar | null>;
  /** 生效的 params */
  params: Record<string, Scalar>;
  /** 求值过的判定条件 */
  conditions: ConditionOutcome[];
}

export interface EntityBinding {
  cluster_id: string;
  kind: string;
  namespace: string | null;
  name: string;
}

/** 判定窗口，unix 秒；anchor 是事件锚点（首次触发时间） */
export interface WindowBinding {
  from: number;
  to: number;
  anchor: number;
}
