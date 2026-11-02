// 步骤之间传递的数据（ADR 0181 §3）。宿主的步骤（kube.read、trigger.occurrences、metrics.range、logs.events）产生它们，
// analyze.* 纯函数消费它们。时间一律为 unix 毫秒。

export type Lang = 'zh-CN' | 'en';

export interface Point {
  t: number;
  v: number;
}

export interface Series {
  labels: Record<string, string>;
  points: Point[];
}

/** 一个信号在一个实体上的查询结果：实际发出的查询与返回的序列 */
export interface SignalData {
  expr: string;
  series: Series[];
}

/** 一次发生：Pod 的一个容器在某个时刻因内存被终止（或持续贴近 limit） */
export interface Occurrence {
  pod: string;
  container: string;
  at: number;
  /** oom_killed 容器被 OOM 终止；evicted Pod 被驱逐；near_limit 指标触发、没有终止 */
  cause: 'oom_killed' | 'evicted' | 'near_limit';
  /** 时刻的来源：metric 区间查询（精度为一个步长）；pod_status Pod 状态中最近一次终止的时刻；trigger 触发带来的时刻 */
  source: 'metric' | 'pod_status' | 'trigger';
  /** 这个工作负载上以前的运行没有报告过它 */
  new: boolean;
}

/** 围绕一次发生的窗口 */
export interface AroundWindow {
  pod: string;
  container: string;
  at: number;
  from: number;
  to: number;
  signals: Record<string, SignalData>;
}

/** 整个工作负载的一段历史 */
export interface HistoryWindow {
  from: number;
  to: number;
  step_seconds: number;
  signals: Record<string, SignalData>;
}

export interface MetricsRangeOutput {
  windows: AroundWindow[];
  history: HistoryWindow | null;
}

export type FieldType =
  'bytes' | 'int' | 'float' | 'bool' | 'duration_ms' | 'string' | 'path' | 'request_id' | 'org_id';

/** 绑定声明的日志事件：只取出 fields 列出的字段，其余内容丢弃 */
export interface LogEventDecl {
  id: string;
  /** message_key 字段的取值，精确匹配 */
  message: string;
  format: 'json';
  message_key: string;
  fields: Array<{ name: string; type: FieldType; as?: string }>;
  /** 字段等值条件，解析之后过滤 */
  where?: Record<string, string | number | boolean>;
  /** 数值下限，在 Loki 端过滤（| json | <field> > <gt>） */
  min?: { field: string; gt: number };
}

export interface LogRecord {
  event: string;
  pod: string;
  time: number;
  /** 字段名取 as（没有时为 name） */
  fields: Record<string, string | number | boolean | null>;
  /** 字段的展示文字 */
  text: Record<string, string>;
}

export interface LogsOutput {
  records: LogRecord[];
  /** 事件 id → 发出的 LogQL（每个窗口一条，去重） */
  queries: Record<string, string[]>;
  truncated: boolean;
}

/** Pod 状态摘要（kube.read 的 pod_status）：不含环境变量与卷 */
export interface PodSummary {
  name: string;
  node: string | null;
  phase: string | null;
  reason: string | null;
  containers: Array<{
    name: string;
    image: string | null;
    ready: boolean;
    restarts: number;
    memory_limit_bytes: number | null;
    last_terminated: { reason: string | null; exit_code: number | null; finished_at: number | null } | null;
  }>;
}

export interface KubeEvent {
  object: string;
  type: string | null;
  reason: string | null;
  message: string | null;
  count: number;
  last: number | null;
}

/** 证据表的一行 */
export interface EvidenceRow {
  when: string;
  pod: string;
  what: string;
  value: string;
  /** 观测、推断（统计）、推断（领域包声明）、推断（代替） */
  basis: string;
  query: string;
}
