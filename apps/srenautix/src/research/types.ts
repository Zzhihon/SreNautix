import type {
  ChangeEvent,
  ActionCatalogAction,
  EvidenceResult,
  Feedback,
  HubComponents,
  Incident,
  ResearchOutput,
  StageAReport,
} from '@srenautix/contract';

export type Subgraph = HubComponents['schemas']['Subgraph'];

/** 检索到的知识条目（领域包 knowledge/*.yaml），带来源事件，回放时按用例排除 */
export interface KnowledgeItem {
  id: string;
  components: string[];
  text: string;
  learned_from: string[];
  learned_at: string | null;
  source: 'human' | 'model';
}

/** 参考案例：开始时间之前就已解决、经人工确认的历史事件 */
export interface ReferenceCase {
  incident_id: string;
  label: string;
  root_component: string;
  mechanism: string | null;
  resolved_at: string;
  source: 'human' | 'model';
}

/** 区分性检查可用的查询模板（领域包 signals.yaml 的 templates） */
export interface CheckTemplate {
  id: string;
  description: string;
  /** 参数的 JSON Schema（可移植子集） */
  args: Record<string, unknown>;
}

/** 区分性检查可用的只读工具 */
export interface CheckTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 一次阶段 B 研判的全部输入。日常研判由 worker 从中心 API 读取；回放时来自用例快照。
 * 输入里没有任何密钥，也不含 ConfigMap 内容。
 */
export interface ResearchCase {
  incident: Incident;
  stageA: StageAReport;
  subgraph: Subgraph;
  feedback: Feedback[];
  /** 本集群启用、且可用于这个事件的动作 */
  actions: ActionCatalogAction[];
  runbooks: string[];
  knowledge: KnowledgeItem[];
  cases: ReferenceCase[];
  /** 事件窗口内触及子图或事件命名空间、但不在事件里的变更（ADR 0106）；旧快照没有时为空 */
  relatedChanges?: ChangeEvent[];
  templates: CheckTemplate[];
  tools: CheckTool[];
  /** 研判时刻；回放时为快照的 as-of 时间 */
  asOf: string;
}

/** 上一次研判的结果，用于指纹门控与增量研判 */
export interface PreviousRun {
  runId: string;
  evidenceFingerprint: string;
  incidentVersion: number;
  finishedAt: string;
  output: ResearchOutput;
  /** 上一次研判中区分性检查产生的卡（引用编号按上一次运行） */
  checkCards: EvidenceResult[];
}
