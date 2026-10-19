// 组件库用到的契约类型。经 API 传递的数据一律取自 OpenAPI 生成的类型（与 openapi-fetch 客户端一致），
// 只在 API 之外使用的类型取自 JSON Schema 生成的类型。两者都由 contract/ 生成。

import type { HubComponents, HubOperations } from '@srenautix/contract';

export type { Condition, Severity, Disposition, ConclusionLevel, EvidenceRef, OutboxEvent } from '@srenautix/contract';

type S = HubComponents['schemas'];
type Ok<O extends keyof HubOperations> = HubOperations[O]['responses'] extends {
  200: { content: { 'application/json': infer T } };
}
  ? T
  : HubOperations[O]['responses'] extends { 201: { content: { 'application/json': infer T } } }
    ? T
    : never;
type Body<O extends keyof HubOperations> = HubOperations[O] extends {
  requestBody: { content: { 'application/json': infer T } };
}
  ? T
  : HubOperations[O] extends { requestBody?: { content: { 'application/json': infer T } } }
    ? T
    : never;

export type IncidentSummary = S['IncidentSummary'];
export type ResearchRun = S['ResearchRun'];
export type ResearchRunSummary = S['ResearchRunSummary'];
export type ResearchState = S['ResearchState'];
export type LlmCall = S['LlmCall'];
export type ToolCall = S['ToolCall'];
export type Session = S['Session'];
export type Profile = S['Profile'];
export type ProposalDetail = S['ProposalDetail'];
export type IncidentSubgraph = S['Subgraph'];
export type TimelineEntry = S['TimelineEntry'];
export type Cluster = S['Cluster'];
export type SpokeStatus = S['SpokeStatus'];

export type Incident = Ok<'getIncident'>;
export type StageAReport = Ok<'getStageAReport'>;
export type EvidenceResult = Ok<'getEvidenceSnapshot'>[number];
export type Feedback = Ok<'listFeedback'>[number];
export type FeedbackCreate = Body<'createFeedback'>;
export type Proposal = Ok<'getProposal'>['proposal'];
export type ResearchManifest = Ok<'getResearchManifest'>;
export type ResearchOutput = NonNullable<ResearchRun['output']>;
export type Hypothesis = ResearchOutput['hypotheses'][number];
export type NextCheck = ResearchOutput['next_checks'][number];
export type Recommendation = ResearchOutput['recommendations'][number];
export type EvalReport = Ok<'getEvalReport'>;

export type IncidentList = Ok<'listIncidents'>;
export type BlindSpan = IncidentList['blind_spans'][number];
export type RawPrompt = Ok<'getRawPrompts'>[number];
export type SearchHit = Ok<'search'>[number];
export type AuthProviders = Ok<'listAuthProviders'>;
export type ActionCatalogView = Ok<'listCatalogActions'>;
