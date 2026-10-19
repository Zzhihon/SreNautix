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

export interface CardOutcome {
  verdict: Verdict;
  display_state: DisplayState;
  reason: { kind: ReasonKind; text: string };
  value: string | null;
  threshold: number | null;
  table: { head: string[]; rows: string[][] } | null;
  /** unix 秒；卡片用 let anomaly_started_at 给出 */
  anomaly_started_at: number | null;
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
