// 证据卡定义的 TypeScript 视图，结构与 contract/schemas/evidence-card.schema.json 一致。

export type Locale = 'zh-CN' | 'en';
export type LocalizedText = Partial<Record<Locale, string>>;

export interface CardRule {
  cel: string;
  say: LocalizedText;
}

export interface CardLet {
  name: string;
  cel: string;
}

export interface CardRef {
  name: string;
  signal: string;
  mode: 'range' | 'instant' | 'logs' | 'traces';
  params?: Record<string, number | string | boolean>;
  limit?: number;
  /** no_data：没有序列视为缺数据；normal：过滤型查询，没有序列表示没有命中 */
  empty_is?: 'no_data' | 'normal';
}

export interface CardTableColumn {
  header: LocalizedText;
  cel: string;
  unit?: string;
}

export interface CardDefinition {
  id: string;
  title: LocalizedText;
  note?: LocalizedText;
  applies_to?: { kinds?: string[]; component_types?: string[] };
  window?: { before: string; after: string };
  params?: Record<string, number | string | boolean>;
  refs: CardRef[];
  judge: {
    let?: CardLet[];
    abnormal_if: CardRule[];
    undeterminable_if?: CardRule[];
  };
  display?: {
    value?: string;
    unit?: 'none' | 'percent' | 'ratio' | 'bytes' | 'seconds' | 'count' | 'per_second';
    threshold?: string;
    table?: {
      rows_from: string;
      columns: CardTableColumn[];
      sort_by?: string;
      limit?: number;
    };
  };
  links?: Array<{ kind: 'explore' | 'dashboard' | 'runbook'; label: LocalizedText; target?: string }>;
  egress: 'allow' | 'redact' | 'never';
  probe?: boolean;
  requires?: string[];
}

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
