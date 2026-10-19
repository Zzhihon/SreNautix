// 数据端口：领域组件与共享视图只经这一个接口读写数据，宿主注入实现。独立控制台的实现走
// 中心 API（openapi-fetch），Grafana 插件的实现走插件后端；插件后端只代理只读接口和反馈接口，
// 所以审批、拒绝、撤销、重跑放在可选的 actions 里，插件不提供，界面改为跳转到控制台。
// 方法与 contract/openapi.yaml 的 operationId 一一对应。

import type {
  Condition,
  EvidenceRef,
  EvidenceResult,
  Feedback,
  FeedbackCreate,
  Incident,
  IncidentList,
  IncidentSubgraph,
  Proposal,
  ProposalDetail,
  ResearchManifest,
  ResearchRun,
  ResearchRunSummary,
  StageAReport,
  TimelineEntry,
} from './contract';

export interface IncidentQuery {
  cluster_id?: string;
  state: 'firing' | 'resolved' | 'all';
  severity?: 'critical' | 'warning' | 'info';
  disposition?: 'act' | 'escalate' | 'ignore' | 'undetermined';
  feedback: 'pending' | 'given' | 'all';
  suppressed: boolean;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ProposalQuery {
  incident_id?: string;
  state?: Proposal['state'];
  limit?: number;
}

export interface DataPort {
  /** listConditions。 */
  listConditions(clusterId?: string): Promise<Condition[]>;
  /** listIncidents：明细、被折叠的抑制数、盲区时段。 */
  listIncidents(q: IncidentQuery): Promise<IncidentList>;
  /** getIncident；ref 接受 incident_id、标签或别名。 */
  getIncident(ref: string): Promise<Incident>;
  /** getStageAReport；还没有阶段 A 报告时为 null（404）。 */
  getStageAReport(ref: string): Promise<StageAReport | null>;
  /** getEvidenceSnapshot：研判当时的证据卡（模型所见）；runId 为 null 时取最新阶段 A 的卡。 */
  getEvidenceSnapshot(ref: string, runId: string | null): Promise<EvidenceResult[]>;
  /** getIncidentTimeline。 */
  getIncidentTimeline(ref: string): Promise<TimelineEntry[]>;
  /** getIncidentSubgraph：根因加不超过 2 跳的邻居。 */
  getIncidentSubgraph(ref: string): Promise<IncidentSubgraph>;
  /** listResearchRuns（新的在前）。 */
  listResearchRuns(ref: string): Promise<ResearchRunSummary[]>;
  /** getResearchRun。 */
  getResearchRun(runId: string): Promise<ResearchRun>;
  /** getResearchManifest；研判还没有清单时为 null（404）。 */
  getResearchManifest(runId: string): Promise<ResearchManifest | null>;
  /** listFeedback（新的在前）。 */
  listFeedback(ref: string): Promise<Feedback[]>;
  /** createFeedback。 */
  createFeedback(ref: string, body: FeedbackCreate): Promise<Feedback>;
  /** listProposals。 */
  listProposals(q: ProposalQuery): Promise<Proposal[]>;
  /** getProposal：提议加审批页需要的机器推导字段。 */
  getProposal(id: string): Promise<ProposalDetail>;
  /** 写操作（反馈除外）；只有独立控制台提供。 */
  actions?: ActionPort;
}

export interface ActionPort {
  /** approveProposal；H 档必须带 confirm_target，合规配置的 H 档附通行密钥断言。 */
  approve(id: string, body: { confirm_target: string | null; webauthn: unknown }): Promise<Proposal>;
  /** rejectProposal；理由必填。 */
  reject(id: string, reason: string): Promise<Proposal>;
  /** undoProposal。 */
  undo(id: string): Promise<Proposal>;
  /** requestResearch。 */
  requestResearch(ref: string): Promise<{ run_id: string; merged: boolean }>;
  /** rerunEvidence：结果不是模型所见，只用于并排对比。 */
  rerunEvidence(
    ref: string,
    body: { run_id: string | null; refs: EvidenceRef[]; window_to: string },
  ): Promise<EvidenceResult[]>;
}

/** 接口错误：保留 HTTP 状态与契约里的错误码，界面据此给出具体说明。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly operation: string,
  ) {
    super(`${operation}: ${status} ${code}: ${message}`);
    this.name = 'ApiError';
  }
}
