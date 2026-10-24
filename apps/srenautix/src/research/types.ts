import type {
  ChangeEvent,
  ActionCatalogAction,
  EvalDispositionFacts,
  EvidenceResult,
  Feedback,
  HubComponents,
  Incident,
  ResearchOutput,
  StageAReport,
} from '@srenautix/contract';
import type { CheckTemplate, CheckTool } from './catalog.js';

export type { CheckTemplate, CheckTool };

export type Subgraph = HubComponents['schemas']['Subgraph'];

/**
 * 处置推导的确定性依据（ADR 0138），server 按领域包与阶段 A 计算：
 * - external：子图中组件类型声明为集群外部的组件；
 * - remediations：候选根因 → 适用的修复模板（release_rollback、config_resource 中启用的类别）。
 */
export type DispositionFacts = EvalDispositionFacts;

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
  /** 处置推导的确定性依据（ADR 0138）；旧版 server 与旧快照没有时为 null（没有外部组件，也没有适用的修复模板） */
  dispositionFacts?: DispositionFacts | null;
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
