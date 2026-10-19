// 本文件由 packages/contract/scripts/gen.ts 从 contract/ 生成，不要手工修改。
export type Uuid = string;
/**
 * 提交渠道。console 为控制台，grafana 为 Grafana 嵌入，api 与 mcp 为外部调用方，其余为聊天渠道
 */
export type Channel = 'console' | 'grafana' | 'telegram' | 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'api' | 'mcp';
/**
 * RFC 3339 UTC 时间
 */
export type Timestamp = string;
/**
 * 集群标识，所有键都带它（DESIGN §2.2）
 */
export type ClusterId = string;
/**
 * 拓扑节点的键：命名空间内的对象为 <kind>:<namespace>/<name>，集群级对象为 <kind>:<name>。kind 是 Kubernetes 的 Kind（如 Pod、Node）或领域包声明的组件类型（如 postgres.cluster）。命名空间伪组件写作 Namespace:<namespace>
 */
export type ComponentKey = string;
/**
 * RFC 3339 UTC 时间
 */
export type Timestamp1 = string;
export type Severity = 'critical' | 'warning' | 'info';
/**
 * 告警角色（DESIGN §3.2）：cause 原因；change 变更；symptom 症状；forecast 预测，不能成为活动事件的根因，也不能连接两个分组；meta 观测缺口
 */
export type AlertRole = 'cause' | 'change' | 'symptom' | 'forecast' | 'meta';
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration = string;
/**
 * 处置判断：act 处理；ignore 忽略；escalate 升级；undetermined 无法判定
 */
export type Disposition = 'act' | 'ignore' | 'escalate' | 'undetermined';
/**
 * 结论阶梯（DESIGN §7.3）。evidence_consistent 只能由代码判定
 */
export type ConclusionLevel = 'evidence_consistent' | 'likely' | 'inconclusive' | 'undetermined';
/**
 * 证据卡的三种结论
 */
export type Verdict = 'normal' | 'abnormal' | 'undeterminable';
/**
 * 卡片级出境控制（DESIGN §8.4）：allow 原样进入提示词；redact 脱敏后进入；never 不进入提示词
 */
export type Egress = 'allow' | 'redact' | 'never';
export type Sha256 = string;
/**
 * 研判运行内的证据引用：card:<n> 指本次运行的第 n 张证据卡结果（含区分性检查产生的卡），alert:<n> 指事件成员告警，change:<n> 指关联的变更。编号由研判清单映射到定义和实体
 */
export type EvidenceRef = string;
/**
 * 事件流中的一条事件（DESIGN §2.3）。每个所有者（server、worker）各有一张只追加的 outbox，与状态变更写在同一事务里。消费者按游标调用 GET /v1/events?after=，投递语义是至少一次，按 event_id 幂等处理。type 决定 payload 的结构
 */
export type OutboxEvent =
  | IncidentUpsertedEvent
  | IncidentMergedEvent
  | IncidentSplitEvent
  | StageAReportedEvent
  | ResearchQueuedEvent
  | ResearchConcludedEvent
  | ResearchFailedEvent
  | ProposalChangedEvent
  | ApprovalIssuedEvent
  | ExecutionUpdatedEvent
  | FeedbackRecordedEvent
  | ConditionChangedEvent;
export type IncidentUpsertedEvent = OutboxEventHeader & {
  type: 'incident.created' | 'incident.updated' | 'incident.resolved';
  payload: Incident;
};
export type OutboxOwner = 'server' | 'worker';
/**
 * 稳定标签 <根组件>:<首次触发时间取整到 10 分钟>，同一标签冲突时追加 ~2、~3
 */
export type IncidentLabel = string;
export type IncidentMergedEvent = OutboxEventHeader & {
  type: 'incident.merged';
  payload: {
    from_incident_id: Uuid;
    into_incident_id: Uuid;
    into_version: number;
  };
};
export type IncidentSplitEvent = OutboxEventHeader & {
  type: 'incident.split';
  payload: {
    from_incident_id: Uuid;
    from_version: number;
    new_incident_ids: Uuid[];
  };
};
export type StageAReportedEvent = OutboxEventHeader & {
  type: 'stage_a.reported';
  payload: {
    incident_id: Uuid;
    incident_version: number;
    report_id: Uuid;
    disposition: Disposition;
    evidence_fingerprint: Sha256;
    /**
     * 状态库降级时在内存中生成
     */
    degraded: boolean;
  };
};
export type ResearchQueuedEvent = OutboxEventHeader & {
  type: 'research.queued';
  payload: {
    incident_id: Uuid;
    incident_version: number;
    reason: ResearchReason;
    run_id: Uuid;
  };
};
/**
 * 触发研判的原因；(incident_id, incident_version, reason) 是触发的唯一键
 */
export type ResearchReason =
  | 'new_incident'
  | 'fingerprint_changed'
  | 'root_changed'
  | 'severity_raised'
  | 'feedback'
  | 'manual'
  | 'model_recovered'
  | 'resumed';
export type ResearchConcludedEvent = OutboxEventHeader & {
  type: 'research.concluded';
  payload: {
    incident_id: Uuid;
    incident_version: number;
    run_id: Uuid;
    evidence_fingerprint: Sha256;
    output: ResearchOutput;
  };
};
export type ResearchFailedEvent = OutboxEventHeader & {
  type: 'research.failed';
  payload: {
    incident_id: Uuid;
    incident_version: number;
    run_id: Uuid;
    kind:
      | 'model_unavailable'
      | 'breaker_open'
      | 'budget_exhausted'
      | 'deadline'
      | 'invalid_output'
      | 'datasource'
      | 'internal';
    message: string;
  };
};
export type ProposalChangedEvent = OutboxEventHeader & {
  type: 'proposal.created' | 'proposal.updated';
  payload: Proposal;
};
/**
 * sha256(JCS([incident_id, run_id 或 rule_id 或 caller_id, action, canonical_params]))
 */
export type Sha2561 = string;
/**
 * rejected_by_policy 策略拒绝；awaiting_approval 待审批；approved 已签发审批断言、等待 gateway 拉取；dispatched gateway 已拉取，后续进度见 execution；rejected 人工拒绝；expired TTL 或审批过期；stale 绑定字段变化；duplicate 与未结束的提议幂等键相同；held 被软暂停扣住
 */
export type ProposalState =
  | 'rejected_by_policy'
  | 'awaiting_approval'
  | 'approved'
  | 'held'
  | 'dispatched'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'duplicate';
export type ApprovalIssuedEvent = OutboxEventHeader & {
  type: 'approval.issued';
  payload: {
    proposal_id: Uuid;
    assertion_id: Uuid;
    tier: 'L' | 'H';
    expires_at: Timestamp;
  };
};
export type ExecutionUpdatedEvent = OutboxEventHeader & {
  type: 'execution.updated';
  payload: {
    proposal_id: Uuid;
    execution: ExecutionSummary;
  };
};
export type FeedbackRecordedEvent = OutboxEventHeader & {
  type: 'feedback.recorded';
  payload: Feedback;
};
export type ConditionChangedEvent = OutboxEventHeader & {
  type: 'condition.changed';
  payload: Condition;
};
export type OutboxEventType =
  | 'incident.created'
  | 'incident.updated'
  | 'incident.resolved'
  | 'incident.merged'
  | 'incident.split'
  | 'stage_a.reported'
  | 'research.queued'
  | 'research.concluded'
  | 'research.failed'
  | 'proposal.created'
  | 'proposal.updated'
  | 'approval.issued'
  | 'execution.updated'
  | 'feedback.recorded'
  | 'condition.changed';
/**
 * <集成类别>.<能力>，例如 metrics.query_range、logs.match、traces.search、changes.list
 */
export type PackCapability = string;
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration1 = string;
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration2 = string;
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration3 = string;
/**
 * 判定向量的指纹（带迟滞，见 docs/core/convergence.md）
 */
export type Sha2562 = string;
/**
 * 边的来源（DESIGN §4.2）
 */
export type EdgeProvenance = 'structural' | 'runtime' | 'config_ref' | 'network_policy' | 'naming';

export interface SrenautixContractIndex {
  AlertmanagerWebhook?: AlertmanagerWebhook;
  AlertmanagerAlert?: AlertmanagerAlert;
  GenericWebhookMapping?: GenericWebhookMapping;
  ApprovalAction?: ApprovalAction;
  ApprovalOutcome?: ApprovalOutcome;
  ChangesListRequest?: ChangesListRequest;
  ChangesScope?: ChangesScope;
  ChangesListResponse?: ChangesListResponse;
  ChangeEvent?: ChangeEvent;
  AuthenticatedPrincipal?: AuthenticatedPrincipal;
  RoleBinding?: RoleBinding;
  LogsMatchRequest?: LogsMatchRequest;
  LogsK8sSelector?: LogsK8SSelector;
  LogsQueryRequest?: LogsQueryRequest;
  LogsResult?: LogsResult;
  LogLine?: LogLine;
  MetricsQueryRequest?: MetricsQueryRequest;
  MetricsQueryRangeRequest?: MetricsQueryRangeRequest;
  MetricsQueryResult?: MetricsQueryResult;
  MetricSeries?: MetricSeries;
  MetricsSeriesRequest?: MetricsSeriesRequest;
  MetricsSeriesResult?: MetricsSeriesResult;
  MetricsRulesResult?: MetricsRulesResult;
  LabelProfile?: LabelProfile;
  ModelRoute?: ModelRoute;
  DialectProfile?: DialectProfile;
  ModelUsage?: ModelUsage;
  NotifyMessage?: NotifyMessage;
  NotifySection?: NotifySection;
  NotifyBlock?: NotifyBlock;
  NotifyButton?: NotifyButton;
  NotifySendResult?: NotifySendResult;
  NotifyCallback?: NotifyCallback;
  NotifyLinkRequest?: NotifyLinkRequest;
  TracesSearchRequest?: TracesSearchRequest;
  TracesSearchResult?: TracesSearchResult;
  TraceHit?: TraceHit;
  TraceRequest?: TraceRequest;
  Trace?: Trace;
  ServiceGraph?: ServiceGraph;
  ConcludeOutput?: ConcludeOutput;
  HypothesizeOutput?: HypothesizeOutput;
  AlertCatalogEntry?: AlertCatalogEntry;
  AlertEntityMapping?: AlertEntityMapping;
  Alert?: Alert;
  AlertClassification?: AlertClassification;
  Uuid?: Uuid;
  Timestamp?: Timestamp;
  Duration?: Duration;
  ClusterId?: ClusterId;
  Labels?: Labels;
  Severity?: Severity;
  AlertRole?: AlertRole;
  ComponentKey?: ComponentKey;
  EntityRef?: EntityRef;
  TimeWindow?: TimeWindow;
  Disposition?: Disposition;
  ConclusionLevel?: ConclusionLevel;
  Verdict?: Verdict;
  Egress?: Egress;
  Channel?: Channel;
  Principal?: Principal;
  Sha256?: Sha256;
  EvidenceRef?: EvidenceRef;
  Error?: Error;
  Condition?: Condition;
  EvalReport?: EvalReport;
  EvalRatio?: EvalRatio;
  EvalModelRow?: EvalModelRow;
  EvalGate?: EvalGate;
  OutboxEvent?: OutboxEvent;
  OutboxEventType?: OutboxEventType;
  OutboxOwner?: OutboxOwner;
  OutboxEventHeader?: OutboxEventHeader;
  IncidentUpsertedEvent?: IncidentUpsertedEvent;
  IncidentMergedEvent?: IncidentMergedEvent;
  IncidentSplitEvent?: IncidentSplitEvent;
  StageAReportedEvent?: StageAReportedEvent;
  ResearchQueuedEvent?: ResearchQueuedEvent;
  ResearchReason?: ResearchReason;
  ResearchConcludedEvent?: ResearchConcludedEvent;
  ResearchFailedEvent?: ResearchFailedEvent;
  ProposalChangedEvent?: ProposalChangedEvent;
  ApprovalIssuedEvent?: ApprovalIssuedEvent;
  ExecutionUpdatedEvent?: ExecutionUpdatedEvent;
  FeedbackRecordedEvent?: FeedbackRecordedEvent;
  ConditionChangedEvent?: ConditionChangedEvent;
  EvidenceCardDefinition?: EvidenceCardDefinition;
  LocalizedText?: LocalizedText;
  CardWindow?: CardWindow;
  CardSignalRef?: CardSignalRef;
  CardBinding?: CardBinding;
  CardJudge?: CardJudge;
  CardRule?: CardRule;
  CardDisplay?: CardDisplay;
  CardTableTemplate?: CardTableTemplate;
  CardLink?: CardLink;
  EvidenceResult?: EvidenceResult;
  EvidenceReason?: EvidenceReason;
  EvidenceQueryRecord?: EvidenceQueryRecord;
  Feedback?: Feedback;
  FeedbackCreate?: FeedbackCreate;
  Incident?: Incident;
  IncidentLabel?: IncidentLabel;
  IncidentRoot?: IncidentRoot;
  RootCandidate?: RootCandidate;
  RootScoreTerms?: RootScoreTerms;
  IncidentMember?: IncidentMember;
  IncidentAlias?: IncidentAlias;
  IntegrationManifest?: IntegrationManifest;
  PackManifest?: PackManifest;
  PackCapability?: PackCapability;
  SignalsFile?: SignalsFile;
  Signal?: Signal;
  SignalAlternative?: SignalAlternative;
  QueryTemplate?: QueryTemplate;
  ComponentsFile?: ComponentsFile;
  ComponentType?: ComponentType;
  OperatorConvention?: OperatorConvention;
  ObjectPattern?: ObjectPattern;
  AlertsFile?: AlertsFile;
  ChainsFile?: ChainsFile;
  EvidenceChain?: EvidenceChain;
  ChecksFile?: ChecksFile;
  RulesFile?: RulesFile;
  PackRule?: PackRule;
  RcaParams?: RcaParams;
  KnowledgeFile?: KnowledgeFile;
  ActionRequestsFile?: ActionRequestsFile;
  PackUserLayer?: PackUserLayer;
  ChaosFile?: ChaosFile;
  PackTestFile?: PackTestFile;
  PackLock?: PackLock;
  Proposal?: Proposal;
  ProposalBinding?: ProposalBinding;
  ProposalTarget?: ProposalTarget;
  ProposalState?: ProposalState;
  ApprovalRecord?: ApprovalRecord;
  ExecutionSummary?: ExecutionSummary;
  ProposalCreate?: ProposalCreate;
  ResearchManifest?: ResearchManifest;
  RouteUse?: RouteUse;
  EgressEntry?: EgressEntry;
  ResearchOutput?: ResearchOutput;
  ResearchConclusion?: ResearchConclusion;
  ConsistencyChecks?: ConsistencyChecks;
  Hypothesis?: Hypothesis;
  NextCheck?: NextCheck;
  Recommendation?: Recommendation;
  ProposalDraft?: ProposalDraft;
  StageAReport?: StageAReport;
  TopologyEvent?: TopologyEvent;
  TopologyNode?: TopologyNode;
  TopologyEdge?: TopologyEdge;
  EdgeProvenance?: EdgeProvenance;
}
/**
 * Alertmanager webhook 请求体 version 4
 */
export interface AlertmanagerWebhook {
  version: '4';
  groupKey?: string;
  truncatedAlerts?: number;
  status: 'firing' | 'resolved';
  receiver: string;
  groupLabels: Labels;
  commonLabels: Labels;
  commonAnnotations: Labels;
  externalURL: string;
  alerts: AlertmanagerAlert[];
}
export interface Labels {
  [k: string]: string | undefined;
}
/**
 * webhook 中的告警，以及 GET /api/v2/alerts 返回的 GettableAlert 的公共部分。endsAt 为零值时间或晚于当前时间表示仍在触发
 */
export interface AlertmanagerAlert {
  /**
   * webhook 中为字符串；API v2 中为对象
   */
  status?:
    | ('firing' | 'resolved')
    | {
        state: 'active' | 'suppressed' | 'unprocessed';
        silencedBy?: string[];
        inhibitedBy?: string[];
      };
  labels: Labels;
  annotations: Labels;
  startsAt: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}
/**
 * 通用 webhook 的 JSONPath 映射，每个路径相对单条告警
 */
export interface GenericWebhookMapping {
  alerts_path: string;
  alertname: string;
  status: string;
  firing_values?: string[];
  starts_at: string;
  ends_at?: string;
  severity?: string;
  labels: string;
  annotations?: string;
}
export interface ApprovalAction {
  proposal_id: Uuid;
  decision: 'approve' | 'reject';
  /**
   * 拒绝必须填写理由
   */
  reason: string | null;
  /**
   * 绑定后的主体 id
   */
  principal_id: string;
  channel: Channel;
  /**
   * 防重放
   */
  nonce: string;
  issued_at: Timestamp;
  expires_at: Timestamp;
}
export interface ApprovalOutcome {
  proposal_id: Uuid;
  outcome:
    | 'approved'
    | 'rejected'
    | 'already_decided'
    | 'expired'
    | 'stale'
    | 'tier_requires_console'
    | 'not_linked'
    | 'forbidden'
    | 'replayed'
    | 'not_found';
  message: string;
  assertion_id: null | Uuid;
}
export interface ChangesListRequest {
  scope: ChangesScope;
  window: TimeWindow;
  limit?: number;
}
export interface ChangesScope {
  cluster_id: ClusterId;
  /**
   * 空数组表示不按命名空间过滤
   */
  namespaces: string[];
  /**
   * 空数组表示不按组件过滤
   */
  components: ComponentKey[];
}
export interface TimeWindow {
  from: Timestamp;
  to: Timestamp;
}
export interface ChangesListResponse {
  changes: ChangeEvent[];
  truncated: boolean;
}
export interface ChangeEvent {
  /**
   * <source>:<来源内唯一标识>，用于去重
   */
  change_id: string;
  /**
   * 集成实例 id，例如 argocd、flux、k8s-rollout、github
   */
  source: string;
  /**
   * rollout：新 ReplicaSet/ControllerRevision；config：挂载的 ConfigMap 版本变化；cordon；scale：HPA 或手动扩缩；gitops_sync：Argo/Flux 同步；ci_deploy：CI 部署；operator：Operator 发起的切换或升级；other
   */
  kind: 'rollout' | 'config' | 'cordon' | 'scale' | 'gitops_sync' | 'ci_deploy' | 'operator' | 'other';
  /**
   * 来源中的引用，例如 Application 名、PR 号、流水线运行 id
   */
  refs: string[];
  revision: string | null;
  actor: string | null;
  time: Timestamp;
  link: string | null;
  /**
   * 变更触及的拓扑节点
   */
  targets: ComponentKey[];
  /**
   * 不可信文本，只作为文本显示
   */
  summary: string;
}
export interface AuthenticatedPrincipal {
  principal: Principal;
  /**
   * 身份集成实例 id，例如 oidc、local-admin
   */
  provider: string;
  auth_time: Timestamp1;
  mfa: boolean;
  /**
   * 可用于自动绑定聊天账号的外部 id，例如飞书 union_id
   */
  external_ids: {
    [k: string]: string | undefined;
  };
}
/**
 * 已认证的主体（DESIGN §10.3 identity 契约输出）
 */
export interface Principal {
  id: string;
  display_name: string;
  groups: string[];
}
/**
 * (主体, 角色, 作用域)，来自 Git
 */
export interface RoleBinding {
  subject: {
    kind: 'user' | 'group';
    name: string;
  };
  role: 'viewer' | 'responder' | 'approver' | 'auditor' | 'admin' | 'sys-admin' | 'security-admin';
  scope: {
    clusters: string[];
    namespaces: string[];
    component_labels: Labels;
  };
  /**
   * approver 的风险上限
   */
  max_risk_tier?: 'L' | 'H';
}
export interface LogsMatchRequest {
  selector: LogsK8SSelector;
  /**
   * 子串匹配；与 regex 二选一，另一个为 null
   */
  contains: string | null;
  /**
   * RE2 正则
   */
  regex: string | null;
  window: TimeWindow;
  limit: number;
  clock_window: TimeWindow;
}
export interface LogsK8SSelector {
  cluster_id: ClusterId;
  namespace: string;
  /**
   * Pod 名；空数组表示命名空间内全部 Pod
   */
  pods: string[];
  containers: string[];
  labels: Labels;
}
export interface LogsQueryRequest {
  query: string;
  dialect: 'logql' | 'logsql' | 'lucene' | 'sls';
  window: TimeWindow;
  limit: number;
  clock_window: TimeWindow;
}
export interface LogsResult {
  lines: LogLine[];
  truncated: boolean;
}
export interface LogLine {
  time: Timestamp;
  labels: Labels;
  line: string;
}
export interface MetricsQueryRequest {
  expr: string;
  dialect: 'promql' | 'metricsql';
  time: Timestamp;
  clock_window: TimeWindow;
  timeout_ms: number;
}
export interface MetricsQueryRangeRequest {
  expr: string;
  dialect: 'promql' | 'metricsql';
  window: TimeWindow;
  step_seconds: number;
  clock_window: TimeWindow;
  timeout_ms: number;
  max_series: number;
}
export interface MetricsQueryResult {
  series: MetricSeries[];
  truncated: boolean;
  warnings: string[];
}
/**
 * times 为 unix 毫秒；values 与 times 一一对应，缺失点为 null
 */
export interface MetricSeries {
  labels: Labels;
  times: number[];
  values: (number | null)[];
}
export interface MetricsSeriesRequest {
  /**
   * @minItems 1
   */
  match: [string, ...string[]];
  window: TimeWindow;
  limit: number;
}
export interface MetricsSeriesResult {
  series: Labels[];
  truncated: boolean;
}
/**
 * 告警规则，用于按表达式分类未知告警（DESIGN §3.2）
 */
export interface MetricsRulesResult {
  rules: {
    group: string;
    name: string;
    expr: string;
    for: string | null;
    labels: Labels;
    annotations: Labels;
  }[];
}
/**
 * 自动探测的标签档案（DESIGN §6.2）：每个逻辑字段在该数据源中对应的标签名
 */
export interface LabelProfile {
  /**
   * 例如 namespace、kubernetes_namespace、k8s_namespace_name
   */
  namespace: string;
  pod: string;
  container: string;
  node: string;
  /**
   * 外部标签 cluster；单集群时为 null
   */
  cluster: string | null;
  scrape_interval_seconds: number;
  /**
   * Mimir 等多租户后端的租户
   */
  tenant: string | null;
}
export interface ModelRoute {
  id: string;
  base_url: string;
  api: 'responses' | 'chat_completions';
  model: string;
  dialect_profile: string;
  price: {
    currency: 'USD' | 'CNY';
    input_per_mtok: number;
    output_per_mtok: number;
    cached_input_per_mtok: number | null;
  };
  /**
   * 这条路由依赖的被管拓扑组件；事件涉及这些组件时提前打开熔断器
   */
  failure_domain: ComponentKey[];
  /**
   * 服务方是否在境内
   */
  in_domain: boolean;
  tier: 'small' | 'large';
  /**
   * 服务方的数据保留条款
   */
  retention_terms: string;
}
export interface DialectProfile {
  id: string;
  strict_json_schema: boolean;
  native_tools: boolean;
  /**
   * 推理模型只约束最终输出
   */
  reasoning_channel: 'none' | 'separate_field' | 'inline_tags';
  context_tokens: number;
  chinese: 'native' | 'adequate' | 'poor';
  /**
   * 没有公开分词器时用字节估算并按实际 usage 校准
   */
  tokenizer: 'tiktoken_o200k' | 'tiktoken_cl100k' | 'byte_estimate';
  measured_at: Timestamp;
  /**
   * 服务方的模型指纹；变化时告警，该路由的回放分数作废
   */
  provider_fingerprint: string | null;
}
/**
 * 计量依据服务方返回的 usage
 */
export interface ModelUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}
/**
 * 渠道无关的消息，渠道适配器负责转义和渲染。四段：现状与背景、问题根源、解决方案、相关证据
 */
export interface NotifyMessage {
  incident_id: Uuid;
  incident_version: number;
  /**
   * 部署配置的消息前缀，例如影子部署的标记
   */
  prefix: string;
  severity: Severity;
  title: string;
  sections: NotifySection[];
  buttons: NotifyButton[];
  /**
   * 降级横幅，例如状态库降级、模型研判中、模型输出无效
   */
  banner: string | null;
}
export interface NotifySection {
  kind: 'situation' | 'root_cause' | 'remedy' | 'evidence';
  blocks: NotifyBlock[];
}
/**
 * text 是 SreNautix 渲染的模板文本；quote 是引用的不可信原文，source 注明来源；model_generated=true 的块标注模型生成
 */
export interface NotifyBlock {
  type: 'text' | 'quote' | 'list_item';
  text: string;
  source: string | null;
  model_generated: boolean;
}
export interface NotifyButton {
  kind:
    | 'approve'
    | 'reject'
    | 'open_console'
    | 'undo'
    | 'feedback_confirm'
    | 'feedback_reject'
    | 'disposition_confirm'
    | 'disposition_reject'
    | 'resolved_confirm';
  label: string;
  /**
   * 回调数据，由 server 签名
   */
  callback: string | null;
  url: string | null;
}
export interface NotifySendResult {
  channel_message_id: string;
  delivered_at: Timestamp;
}
/**
 * 渠道回调。重放和过期的回调必须被拒绝；未绑定账号的审批和反馈必须被拒绝
 */
export interface NotifyCallback {
  channel: Channel;
  channel_user_id: string;
  channel_message_id: string;
  callback: string;
  received_at: Timestamp;
  signature_valid: boolean;
}
/**
 * 聊天账号绑定：控制台登录后获取一次性绑定码，在聊天里发送 /link <code>
 */
export interface NotifyLinkRequest {
  channel: Channel;
  channel_user_id: string;
  code: string;
}
export interface TracesSearchRequest {
  query: string;
  dialect: 'traceql' | 'jaeger' | 'skywalking';
  window: TimeWindow;
  limit: number;
  clock_window: TimeWindow;
}
export interface TracesSearchResult {
  hits: TraceHit[];
  truncated: boolean;
}
export interface TraceHit {
  trace_id: string;
  root_service: string;
  root_name: string;
  start: Timestamp;
  duration_ms: number;
  attributes: Labels;
}
export interface TraceRequest {
  trace_id: string;
  max_spans: number;
}
export interface Trace {
  trace_id: string;
  spans: {
    span_id: string;
    parent_span_id: string | null;
    service: string;
    name: string;
    start: Timestamp;
    duration_ms: number;
    status: 'ok' | 'error' | 'unset';
    attributes: Labels;
  }[];
  truncated: boolean;
}
export interface ServiceGraph {
  window: TimeWindow;
  edges: {
    client: string;
    server: string;
    requests: number;
    errors: number;
    last_seen: Timestamp;
  }[];
}
/**
 * 阶段 B conclude 步骤的模型输出（DESIGN §7.2）。遵守可移植 schema 子集（§8.2）。结论阶梯的档位由代码判定，不由模型输出
 */
export interface ConcludeOutput {
  disposition: 'act' | 'ignore' | 'escalate' | 'undetermined';
  /**
   * 选中的假设；为 null 时 undetermined_reason 必须非空
   */
  hypothesis_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | null;
  undetermined_reason: string | null;
  /**
   * 现状与背景，三句以内：发生了什么、影响范围、当前状态
   */
  situation: string;
  /**
   * 一到两句：根因结论（或无法判定的原因）与第一步该做什么
   */
  summary: string;
  /**
   * 按 mitigation、root_fix、prevention、investigation 排列，每类最多 3 条
   *
   * @maxItems 12
   */
  recommendations: {
    id: string;
    kind: 'mitigation' | 'root_fix' | 'prevention' | 'investigation';
    title: string;
    rationale: string;
    /**
     * @minItems 1
     * @maxItems 8
     */
    steps: [string, ...string[]];
    owner: 'platform' | 'app' | 'vendor' | 'oncall';
    risk: 'low' | 'medium' | 'high';
    risk_note: string | null;
    /**
     * <pack>/<runbook 文件>#<锚点>
     */
    runbook_ref: string | null;
    /**
     * 能由动作目录中的动作完成时填写
     */
    action_id: string | null;
    hypothesis_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    /**
     * @maxItems 8
     */
    evidence_refs: string[];
  }[];
  /**
   * @maxItems 3
   */
  proposals: {
    action_id: string;
    /**
     * 动作参数的 JSON 文本，按动作目录中该动作的参数 schema 校验；目标由机器推导，模型给出的目标必须等于推导结果
     */
    params_json: string;
    hypothesis_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    expected_effect: string;
  }[];
}
/**
 * 阶段 B hypothesize 步骤的模型输出（DESIGN §7.2）。遵守可移植 schema 子集（§8.2）：扁平结构、所有字段必填、additionalProperties=false、使用枚举、不使用 oneOf。x-srenautix-dynamic-enum 标出的字段在每次运行时由 worker 替换为本次运行中存在的取值
 */
export interface HypothesizeOutput {
  /**
   * 假设树，用 parent_id 表示层级
   *
   * @minItems 1
   * @maxItems 6
   */
  hypotheses: [
    {
      id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      parent_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | null;
      /**
       * 本次运行拓扑中的组件键
       */
      root_component: string;
      mechanism: string;
      /**
       * @maxItems 12
       */
      supporting: string[];
      /**
       * @maxItems 12
       */
      refuting: string[];
    },
    ...{
      id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      parent_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | null;
      /**
       * 本次运行拓扑中的组件键
       */
      root_component: string;
      mechanism: string;
      /**
       * @maxItems 12
       */
      supporting: string[];
      /**
       * @maxItems 12
       */
      refuting: string[];
    }[],
  ];
  /**
   * 对排名前 N 的假设各给出一项区分性检查，由控制器执行
   *
   * @maxItems 6
   */
  next_checks: {
    hypothesis_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    /**
     * query：领域包的查询模板；tool：只读工具
     */
    type: 'query' | 'tool';
    /**
     * 查询模板 <pack>/<id> 或只读工具名
     */
    template: string;
    /**
     * 参数的 JSON 文本，按模板或工具的参数 schema 校验
     */
    args_json: string;
    /**
     * 什么样的结果能推翻这个假设
     */
    refutes_if: string;
    purpose: string;
  }[];
}
/**
 * 告警目录中的一个条目（DESIGN §3.2），写在领域包的 alerts.yaml 中。同一告警名可以有多个条目，用 match_labels 区分变体（例如同名告警的 warning 与 critical 规则），查找时取 match_labels 最具体的条目
 */
export interface AlertCatalogEntry {
  /**
   * 包内唯一
   */
  id: string;
  alertname: string;
  match_labels?: Labels1;
  /**
   * 上游规则的表达式，用于按表达式复核角色与 CI 覆盖检查
   */
  expr?: string;
  role: AlertRole;
  role_confidence?: number;
  entity: AlertEntityMapping;
  /**
   * 告警直接归属的组件类型（components.yaml 声明）；不填时归属解析出的实体本身
   */
  component_type?: string;
  /**
   * 作用范围（DESIGN §4.3）。hub 表示集群枢纽（CoreDNS、CNI、apiserver、存储）的告警
   */
  scope?: 'instance' | 'service' | 'hub';
  /**
   * 该告警触发的证据链 <pack>/<chain id>
   */
  chains?: string[];
  /**
   * 来源 mixin，用于覆盖率统计
   */
  mixin?: 'kubernetes' | 'node' | 'etcd' | 'prometheus' | 'alertmanager' | 'kube-state-metrics' | 'other';
}
/**
 * 变体的标签等值条件，全部满足才命中
 */
export interface Labels1 {
  [k: string]: string | undefined;
}
/**
 * 从告警标签取实体。name_labels 按顺序取第一个非空的标签；node 类实体的 instance 标签会去掉端口
 */
export interface AlertEntityMapping {
  /**
   * Kubernetes Kind（Pod、Node、PersistentVolumeClaim、Deployment 等）或 cluster 表示整个集群
   */
  kind: string;
  namespace_label?: string;
  /**
   * @minItems 1
   */
  name_labels: [string, ...string[]];
}
/**
 * 接入层归一化后的一个告警实例：一个标签集的一次触发（DESIGN §3）。时间一律取告警源的时间戳
 */
export interface Alert {
  /**
   * <fingerprint>@<starts_at 的 unix 秒>，同一标签集的每次触发各有一个
   */
  alert_id: string;
  cluster_id: ClusterId;
  /**
   * 接入来源。reconcile 表示由 60 秒对账从 Alertmanager API 或 ALERTS 重建
   */
  source: 'alertmanager' | 'grafana' | 'nightingale' | 'generic' | 'reconcile';
  /**
   * 去掉 alertstate、alertgroup、__name__ 之后的标签集按键排序的 FNV-1a 64 位哈希，16 位十六进制
   */
  fingerprint: string;
  alertname: string;
  labels: Labels;
  annotations: Labels;
  severity: Severity;
  status: 'firing' | 'resolved';
  /**
   * 告警源报告的抑制状态。只用于展示和阶段 A 的 disposition，SreNautix 从不改变告警路由
   */
  suppressed: 'none' | 'silenced' | 'inhibited';
  starts_at: Timestamp;
  /**
   * 告警恢复时间；仍在触发时为 null
   */
  ends_at: null | Timestamp;
  generator_url: string | null;
  classification: AlertClassification;
  /**
   * 解析出的实体；解析失败时为 null，告警归入命名空间伪组件
   */
  entity: null | EntityRef;
  /**
   * 实体解析命中的层（DESIGN §3.3）：informer 缓存、24 小时墓碑、kube-state-metrics 历史；labels 表示告警自带 entity 标签；unresolved 表示未解析
   */
  entity_resolution: 'labels' | 'informer' | 'tombstone' | 'ksm_history' | 'unresolved';
  /**
   * 告警归属的拓扑节点；无法映射时为命名空间伪组件 Namespace:<namespace>，连 namespace 标签也没有时为 null
   */
  component: null | ComponentKey;
  received_at: Timestamp;
}
/**
 * 角色分类结果与依据（DESIGN §3.2）
 */
export interface AlertClassification {
  role: AlertRole;
  /**
   * label：告警自带 role 标签；catalog：告警目录条目；expression：按规则表达式分类；default：没有任何依据时按 symptom 处理
   */
  source: 'label' | 'catalog' | 'expression' | 'default';
  confidence: number;
  /**
   * 命中的告警目录条目 <pack>/<entry id>
   */
  catalog_entry: string | null;
  /**
   * 长期告警：同一告警名 × 实体在 7 天内的触发率超过阈值
   */
  chronic: boolean;
}
/**
 * 一个 Kubernetes 对象或领域包组件实例。uid 在实体解析成功时填写
 */
export interface EntityRef {
  cluster_id: ClusterId;
  kind: string;
  namespace: string | null;
  name: string;
  uid: string | null;
}
export interface Error {
  /**
   * 机器可读的错误码
   */
  error: string;
  message: string;
}
/**
 * 带类型的状态条件（DESIGN §12.4），驱动每个页面顶部的状态条。每个判定都附带影响它的条件
 */
export interface Condition {
  type:
    | 'IngestSilent'
    | 'WatchdogMissing'
    | 'DatasourceUnavailable'
    | 'ModelRouteBreakerOpen'
    | 'AdmissionSelfTestFailed'
    | 'PackLoadFailed'
    | 'BudgetCutoffHigh'
    | 'ChannelDeliveryFailed'
    | 'AuditExportLagging'
    | 'ClockSkew'
    | 'StateStoreDegraded'
    | 'Restored'
    | 'Frozen'
    | 'StormMode';
  /**
   * true 表示该问题正在发生
   */
  status: 'true' | 'false';
  role: 'server' | 'worker' | 'mcp' | 'reader' | 'gateway';
  cluster_id: null | ClusterId;
  /**
   * 条件涉及的对象，例如集成实例 id、路由 id、领域包名
   */
  subject: string | null;
  reason: string;
  message: string;
  since: Timestamp;
}
/**
 * 回放与评测的成绩单（DESIGN §14），按模型 × 用例集给出。对外公布时始终同时给出分子和分母；snapshot 与 reconstructed 两种模式的成绩分开报告
 */
export interface EvalReport {
  report_id: Uuid;
  created_at: Timestamp;
  code_sha: string;
  pack_lock: Sha256;
  mode: 'snapshot' | 'reconstructed';
  case_set: string;
  runs_per_case: number;
  rows: EvalModelRow[];
  /**
   * 发布门禁结果；只评测、不做比较时为 null
   */
  gate: null | EvalGate;
}
export interface EvalModelRow {
  route_id: string;
  model: string;
  /**
   * 领域包早于事件或晚于事件，分两组报告
   */
  pack_timing: 'pack_before_incident' | 'pack_after_incident' | 'all';
  top1: EvalRatio;
  recall_at_3: EvalRatio;
  pass_pow_k: EvalRatio;
  disposition_accuracy: EvalRatio;
  benign_false_positive: EvalRatio;
  undetermined_ratio: EvalRatio;
  structured_output_failure: EvalRatio;
  cost_per_case: {
    currency: string;
    mean: number;
    p90: number;
  };
  snapshot_miss_rate: number | null;
  by_granularity: {
    [k: string]: EvalRatio | undefined;
  };
}
export interface EvalRatio {
  numerator: number;
  denominator: number;
  value: number | null;
  /**
   * 聚类自助法 90% 置信区间下界
   */
  ci_low: number | null;
  ci_high: number | null;
}
export interface EvalGate {
  baseline_report_id: Uuid;
  regressed_cases: string[];
  waived_cases: string[];
  /**
   * 新减旧的单侧 90% 下界
   */
  paired_delta_low: number;
  /**
   * n<100 时 -0.10，n≥100 时 -0.05
   */
  threshold: number;
  passed: boolean;
}
export interface OutboxEventHeader {
  /**
   * 所有者 outbox 内单调递增；游标形如 <owner>:<seq>
   */
  seq: number;
  event_id: Uuid;
  owner: OutboxOwner;
  schema_version: string;
  cluster_id: ClusterId;
  occurred_at: Timestamp;
}
/**
 * 持久化的事件（DESIGN §2.2、§5）。每次对账按确定性规则重算一次，再与已持久化的事件对账；成员或根因变化时 incident_version 加一
 */
export interface Incident {
  incident_id: Uuid;
  cluster_id: ClusterId;
  label: IncidentLabel;
  incident_version: number;
  state: 'firing' | 'resolved' | 'merged';
  severity: Severity;
  first_firing_at: Timestamp;
  ended_at: null | Timestamp;
  root: IncidentRoot;
  /**
   * 前 k 个候选根因，按得分从高到低
   */
  candidates: RootCandidate[];
  members: IncidentMember[];
  /**
   * 成员告警涉及的组件，根因在前
   */
  components: ComponentKey[];
  /**
   * 首次触发前 30 分钟到结束之间、触及事件组件的变更
   */
  changes: ChangeEvent[];
  /**
   * 合并进本事件的旧事件（incident_aliases：from → into）。旧 URL 与旧标签经别名解析到本事件
   */
  aliases: IncidentAlias[];
  /**
   * 本事件由哪个事件拆分而来
   */
  split_from: null | Uuid;
  /**
   * state=merged 时指向吸收本事件的事件
   */
  merged_into: null | Uuid;
  /**
   * 命中 SreNautix 自己的抑制规则，或全部触发中的成员都被告警源静默。只影响 SreNautix 的消息与研判
   */
  suppressed: boolean;
  /**
   * 至少 50% 的证据卡没有数据（DESIGN §7.1）
   */
  observability_blind: boolean;
  /**
   * 本版本使用的拓扑事件 seq
   */
  topology_version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface IncidentRoot {
  /**
   * 排名第一的候选；没有候选时为 null
   */
  component: null | ComponentKey;
  entity: null | EntityRef;
  /**
   * 第一与第二候选的分差小于 δ（默认 0.1）；两个候选的证据链都执行
   */
  ambiguous: boolean;
  /**
   * 第一与第二候选的分差；只有一个候选时为 null
   */
  margin: number | null;
  /**
   * 根因由沉默根因探测卡加入，没有指向它的告警
   */
  silent_root: boolean;
}
export interface RootCandidate {
  component: ComponentKey;
  score: number;
  terms: RootScoreTerms;
  /**
   * 在折叠强连通分量后的依赖图上的深度，只用于平分时排序
   */
  depth: number;
  /**
   * 能解释的症状告警 alert_id
   */
  explains: string[];
  /**
   * alert：有指向它的 cause/change 告警；change：有触及它的变更；probe：沉默根因探测卡异常；symptom：只有症状告警
   */
  source: 'alert' | 'change' | 'probe' | 'symptom';
}
/**
 * 根因得分的各项（DESIGN §5），每项在 [0,1] 内，乘以 rca-params 中的权重后求和
 */
export interface RootScoreTerms {
  coverage: number;
  precedence: number;
  role_prior: number;
  recent_change: number;
  chronic_penalty: number;
}
export interface IncidentMember {
  alert_id: string;
  alertname: string;
  role: AlertRole;
  component: null | ComponentKey;
  severity: Severity;
  status: 'firing' | 'resolved';
  starts_at: Timestamp;
  ends_at: null | Timestamp;
  joined_version: number;
  /**
   * 拆分时离开本事件的版本；仍是成员时为 null
   */
  left_version: number | null;
}
export interface IncidentAlias {
  from_incident_id: Uuid;
  from_label: IncidentLabel;
  at_version: number;
  merged_at: Timestamp;
}
/**
 * 一次研判经代码校验后的输出（DESIGN §7.2、§7.3），由 worker 写入 research_runs 并随 research.concluded 发布。模型直接输出的部分见 contract/model/；本结构加入假设账本状态、区分性检查结果、代码判定的结论阶梯和校验记录
 */
export interface ResearchOutput {
  disposition: Disposition;
  conclusion: ResearchConclusion;
  /**
   * @maxItems 6
   */
  hypotheses: Hypothesis[];
  /**
   * @maxItems 12
   */
  next_checks: NextCheck[];
  situation: string;
  summary: string;
  /**
   * @maxItems 12
   */
  recommendations: Recommendation[];
  /**
   * @maxItems 3
   */
  proposals: ProposalDraft[];
  /**
   * 代码校验的修改记录：删除的无效证据引用、删除的目录外提议、降级的结论等
   */
  validation_notes: string[];
}
export interface ResearchConclusion {
  level: ConclusionLevel;
  hypothesis_id: string | null;
  root_component: null | ComponentKey;
  undetermined_reason: string | null;
  consistency: ConsistencyChecks;
}
/**
 * evidence_consistent 的四个条件逐项结果（DESIGN §7.3）；四项全为 true 才是 evidence_consistent
 */
export interface ConsistencyChecks {
  entity_in_scope: boolean;
  onset_precedes_symptom: boolean;
  no_contrary_normal: boolean;
  competitor_tested: boolean;
}
export interface Hypothesis {
  id: string;
  parent_id: string | null;
  root_component: ComponentKey;
  mechanism: string;
  /**
   * @maxItems 12
   */
  supporting: EvidenceRef[];
  /**
   * @maxItems 12
   */
  refuting: EvidenceRef[];
  /**
   * 假设账本状态：pending 待检验；supported 支持；refuted 推翻；inconclusive 检验后仍无法判定
   */
  status: 'pending' | 'supported' | 'refuted' | 'inconclusive';
}
export interface NextCheck {
  hypothesis_id: string;
  type: 'query' | 'tool';
  template: string;
  args: {};
  refutes_if: string;
  purpose: string;
  /**
   * 控制器执行后得到的卡；未执行时为 null
   */
  result_ref: null | EvidenceRef;
  outcome: 'not_run' | 'supports' | 'refutes' | 'inconclusive' | 'failed';
}
export interface Recommendation {
  id: string;
  kind: 'mitigation' | 'root_fix' | 'prevention' | 'investigation';
  title: string;
  rationale: string;
  /**
   * @minItems 1
   * @maxItems 8
   */
  steps: [string, ...string[]];
  owner: 'platform' | 'app' | 'vendor' | 'oncall';
  risk: 'low' | 'medium' | 'high';
  risk_note: string | null;
  runbook_ref: string | null;
  action_id: string | null;
  hypothesis_id: string;
  /**
   * @maxItems 8
   */
  evidence_refs: EvidenceRef[];
  /**
   * model 的建议在消息与控制台中标注模型生成
   */
  generated_by: 'model' | 'rule';
}
/**
 * 研判产生的提议草稿，经 server 的提议中转写入 proposals
 */
export interface ProposalDraft {
  action_id: string;
  params: {};
  hypothesis_id: string;
  expected_effect: string;
  /**
   * 提议中转接受后的 id；被拒绝时为 null
   */
  proposal_id: null | Uuid;
}
/**
 * server 持有的提议（DESIGN §2.4、§9）。提交时带幂等键，并绑定 {incident_version, root_component, evidence_fingerprint}；三者任一变化即标为 stale，gateway 执行前经中心再检查一次。审批断言、工单与 ActionExecution 的格式以 contract/gateway/ 为准
 */
export interface Proposal {
  proposal_id: Uuid;
  idempotency_key: Sha2561;
  cluster_id: ClusterId;
  incident_id: Uuid;
  binding: ProposalBinding;
  /**
   * research：阶段 B 研判；rule：领域包规则提议；human：控制台人工提议；external：MCP 或 API 调用方（只能提议）
   */
  source: 'research' | 'rule' | 'human' | 'external';
  research_run_id: null | Uuid;
  /**
   * <pack>/<rule id>
   */
  rule_id: string | null;
  /**
   * human 为主体 id，external 为调用方 id
   */
  caller_id: string | null;
  /**
   * 动作目录中的动作 id
   */
  action: string;
  /**
   * 动作等级（DESIGN §9.1），取值与 contract/gateway/v1/approval-assertion 的 level 一致（packages/contract 的测试核对）；满足可重建条件的 pod_restart 为 reversible_recreatable
   */
  level: 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
  /**
   * 审批档位（DESIGN §9.2），取值与审批断言的 tier 一致
   */
  tier: 'L' | 'H';
  /**
   * 策略允许自动执行：等级为 reversible 或 reversible_recreatable、在策略允许的命名空间与动作内、未超过每小时上限。自动批准的断言 approver_principal 为 auto:<规则名>
   */
  auto_eligible: boolean;
  params: {};
  params_hash: Sha256;
  /**
   * 参数规范化版本，取值与审批断言的 canon_version 一致：jcs-sha256-v1 表示 RFC 8785 JCS、UTF-8、SHA-256、小写十六进制并带 sha256: 前缀
   */
  canon_version: 'jcs-sha256-v1';
  target: ProposalTarget;
  hypothesis_id: string | null;
  evidence_refs: EvidenceRef[];
  expected_effect: string;
  state: ProposalState;
  policy_checks: {
    name: string;
    passed: boolean;
    detail: string;
  }[];
  /**
   * 审批或拒绝的记录；断言本体见 contract/gateway/
   */
  approval: null | ApprovalRecord;
  /**
   * gateway 推回的 ActionExecution 摘要；phase 取值以 contract/gateway/ 的 ActionExecution 为准
   */
  execution: null | ExecutionSummary;
  /**
   * 提议 TTL 从第一次成功送达时开始计算，并且有硬上限；未送达时为 null
   */
  ttl_expires_at: null | Timestamp;
  first_delivered_at: null | Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface ProposalBinding {
  incident_version: number;
  root_component: ComponentKey;
  evidence_fingerprint: Sha256;
}
/**
 * 由机器从事件与动作的目标解析规则推导，模型给出的目标必须等于推导结果
 */
export interface ProposalTarget {
  cluster_id: ClusterId;
  kind: string;
  namespace: string | null;
  name: string;
  uid: string | null;
  /**
   * H 档审批时要输入的目标名
   */
  display: string;
}
export interface ApprovalRecord {
  decision: 'approved' | 'rejected' | 'auto';
  principal_id: string;
  /**
   * Channel 的取值，或策略自动批准时的 auto
   */
  channel: 'console' | 'grafana' | 'telegram' | 'feishu' | 'dingtalk' | 'wecom' | 'slack' | 'api' | 'mcp' | 'auto';
  reason: string | null;
  /**
   * 签发的审批断言 id；拒绝时为 null
   */
  assertion_id: null | Uuid;
  at: Timestamp;
}
export interface ExecutionSummary {
  execution_id: string;
  phase: string;
  queue_position: number | null;
  updated_at: Timestamp;
}
/**
 * 一条反馈（DESIGN §11），表只追加，同一事件以 created_at 最新的一条为准。两个维度：verdict 评价根因结论，disposition_verdict 评价处置判断。verdict=rejected 且 root_component=null 表示只否定结论、真实根因未知：不生成回放用例也不作为参考案例，计入准确率与校准统计，记为一次未命中。只有 linked=true（已绑定账号）的反馈进入评测的标准答案
 */
export interface Feedback {
  feedback_id: Uuid;
  incident_id: Uuid;
  incident_version: number;
  /**
   * 反馈针对的研判；针对阶段 A 报告时为 null
   */
  research_run_id: null | Uuid;
  /**
   * 根因结论是否正确；只评价处置判断时为 null
   */
  verdict: 'confirmed' | 'rejected' | null;
  /**
   * verdict=rejected 时人工给出的真实根因组件，从本次研判的拓扑组件中选择；不知道时为 null
   */
  root_component: null | ComponentKey;
  /**
   * 处置判断是否正确；只评价根因时为 null
   */
  disposition_verdict: 'confirmed' | 'rejected' | null;
  /**
   * disposition_verdict=rejected 时人工给出的正确处置判断
   */
  disposition: null | Disposition;
  mechanism: string | null;
  reason: string | null;
  principal_id: string;
  channel: Channel;
  /**
   * 提交者是已绑定的账号（控制台登录或聊天账号经 /link 绑定）
   */
  linked: boolean;
  /**
   * 隐式反馈的来源：批准、拒绝、撤销自动记为对应反馈；resolved_confirm 是事件恢复时的一键确认。显式反馈为 null
   */
  implicit: 'approved' | 'rejected' | 'undone' | 'resolved_confirm' | null;
  /**
   * 反馈之后又有研判完成（读取时计算）
   */
  stale: boolean;
  created_at: Timestamp;
}
/**
 * 证据卡定义（DESIGN §6.1），写在领域包 chains.yaml 的证据链中。卡片只包含数据：信号引用、时间窗口、params、CEL 判定、声明式展示和链接。CEL 只在 TypeScript 运行时求值，求值成本有上限
 */
export interface EvidenceCardDefinition {
  /**
   * 证据链内唯一；全局 id 为 <pack>/<chain>/<id>
   */
  id: string;
  title: LocalizedText;
  note?: LocalizedText1;
  /**
   * 卡片对哪些实体执行；不填时对证据链所属组件执行
   */
  applies_to?: {
    kinds?: string[];
    component_types?: string[];
  };
  window?: CardWindow;
  /**
   * 可由用户层覆盖的参数及默认值，在查询模板中写作 $params.<名字>，在 CEL 中写作 params.<名字>
   */
  params?: {
    [k: string]: number | string | boolean | undefined;
  };
  /**
   * @minItems 1
   */
  refs: [CardSignalRef, ...CardSignalRef[]];
  judge: CardJudge;
  display?: CardDisplay;
  links?: CardLink[];
  egress: Egress;
  /**
   * 沉默根因探测卡：症状存在但没有指向原因的告警时，对上游组件执行，结果异常的组件加入根因候选
   */
  probe?: boolean;
  /**
   * 卡片需要的集成能力，例如 metrics.query_range、logs.match。能力不可用时卡片显示 capability_missing
   */
  requires?: string[];
}
export interface LocalizedText {
  'zh-CN'?: string;
  en?: string;
}
/**
 * 这张卡展示什么、怎么读
 */
export interface LocalizedText1 {
  'zh-CN'?: string;
  en?: string;
}
/**
 * 相对事件锚点（首次触发时间）的窗口
 */
export interface CardWindow {
  before: Duration;
  after: Duration;
}
export interface CardSignalRef {
  /**
   * 在 CEL 中引用的名字
   */
  name: string;
  /**
   * signals.yaml 中的信号 <pack>/<signal id>；同包内可省略 <pack>/
   */
  signal: string;
  mode: 'range' | 'instant' | 'logs' | 'traces';
  params?: {
    [k: string]: number | string | boolean | undefined;
  };
  limit?: number;
  /**
   * no_data：没有序列视为缺数据，引用它的规则不可求值，卡片不能判为正常；normal：过滤型查询（例如 ... > 0），没有序列表示没有命中。每张卡至少有一个 no_data 引用（加载时校验）
   */
  empty_is?: 'no_data' | 'normal';
}
/**
 * 先求 undeterminable_if，命中即为无法判定；再按顺序求 abnormal_if，命中第一条即为异常；都不命中为正常。表达式出错时为无法判定。没有任何样本永远不是正常
 */
export interface CardJudge {
  /**
   * 按顺序求值的绑定；结果可在 undeterminable_if、abnormal_if、display.value、display.threshold、表格列和 say 的 ICU 参数中引用
   */
  let?: CardBinding[];
  /**
   * @minItems 1
   */
  abnormal_if: [CardRule, ...CardRule[]];
  undeterminable_if?: CardRule[];
}
export interface CardBinding {
  /**
   * 保留名 anomaly_started_at（unix 秒）用于填写 EvidenceResult 的同名字段
   */
  name: string;
  cel: string;
}
export interface CardRule {
  cel: string;
  say: LocalizedText2;
}
/**
 * 命中时的理由，ICU MessageFormat，可引用 CEL 变量
 */
export interface LocalizedText2 {
  'zh-CN'?: string;
  en?: string;
}
export interface CardDisplay {
  /**
   * 主值的 CEL 表达式
   */
  value?: string;
  unit?: 'none' | 'percent' | 'ratio' | 'bytes' | 'seconds' | 'count' | 'per_second';
  /**
   * 图上阈值线的 CEL 表达式
   */
  threshold?: string;
  table?: CardTableTemplate;
}
export interface CardTableTemplate {
  /**
   * 每个序列或日志行一行的引用名
   */
  rows_from: string;
  /**
   * @minItems 1
   */
  columns: [
    {
      header: LocalizedText;
      cel: string;
      unit?: string;
    },
    ...{
      header: LocalizedText;
      cel: string;
      unit?: string;
    }[],
  ];
  sort_by?: string;
  limit?: number;
}
export interface CardLink {
  /**
   * explore：按卡片的查询生成数据源浏览链接；dashboard：看板；runbook：领域包内的 runbook
   */
  kind: 'explore' | 'dashboard' | 'runbook';
  label: LocalizedText;
  /**
   * dashboard 的 uid 或 runbook 的 <文件>#<锚点>
   */
  target?: string;
}
/**
 * 一张证据卡在一次研判（或阶段 A 报告）中的结果（DESIGN §6.1）。三种结论之外另有显示状态 capability_missing：所需的数据源能力不可用，和没有数据区分开
 */
export interface EvidenceResult {
  ref: EvidenceRef;
  /**
   * <pack>/<chain>/<card>；区分性检查产生的卡为 check/<hypothesis id>/<n>
   */
  card_id: string;
  entity: null | EntityRef;
  window: TimeWindow;
  verdict: Verdict;
  /**
   * verdict 为 undeterminable 且原因是所需能力不可用时为 capability_missing，其余与 verdict 相同
   */
  display_state: 'normal' | 'abnormal' | 'undeterminable' | 'capability_missing';
  reason: EvidenceReason;
  /**
   * 主值的展示文本
   */
  value: string | null;
  table: null | {
    head: string[];
    rows: string[][];
  };
  queries: EvidenceQueryRecord[];
  egress: Egress;
  /**
   * 异常的起始时间，用于 evidence_consistent 判定中的时间条件；无法确定时为 null
   */
  anomaly_started_at?: null | Timestamp;
  evaluated_at: Timestamp;
}
export interface EvidenceReason {
  /**
   * rule：命中判定规则；no_data：查询没有样本；partial_data：部分查询没有样本；source_error：数据源报错或超时；capability_missing：所需能力不可用；observability_gap：依赖的目标有 meta 告警；evaluation_error：CEL 求值出错；all_clear：没有命中任何规则
   */
  kind:
    | 'rule'
    | 'no_data'
    | 'partial_data'
    | 'source_error'
    | 'capability_missing'
    | 'observability_gap'
    | 'evaluation_error'
    | 'all_clear';
  text: string;
}
export interface EvidenceQueryRecord {
  name: string;
  /**
   * 集成实例 id
   */
  integration: string;
  capability: string;
  /**
   * 实际执行的查询文本
   */
  query: string;
  sample_count: number;
  truncated: boolean;
  error: string | null;
  duration_ms: number;
}
/**
 * 提交反馈的请求体。channel 与主体由认证上下文决定，请求体不含
 */
export interface FeedbackCreate {
  research_run_id: null | Uuid;
  verdict: 'confirmed' | 'rejected' | null;
  root_component: null | ComponentKey;
  disposition_verdict: 'confirmed' | 'rejected' | null;
  disposition: null | Disposition;
  mechanism: string | null;
  reason: string | null;
}
/**
 * 集成清单 integration.yaml（DESIGN §10.1）。一项能力只有在清单里声明过、并且 verify() 通过，才算可用。控制台的集成页由清单生成
 */
export interface IntegrationManifest {
  api_version: 'srenautix.io/integration/v1';
  id: string;
  display_name?: string;
  category:
    'alerts' | 'metrics' | 'logs' | 'traces' | 'changes' | 'notify' | 'approve' | 'identity' | 'model' | 'execute';
  /**
   * 按方向分级（DESIGN §10.2）：approve、authenticate 只能是核心或官方；execute 只能是核心
   */
  direction: 'read' | 'notify' | 'approve' | 'authenticate' | 'execute';
  /**
   * official_candidate：没有真实部署报告的官方级集成，不称为支持
   */
  tier: 'core' | 'official' | 'official_candidate' | 'community' | 'mcp_bridge';
  /**
   * 实现的契约，例如 metrics/v1
   */
  contract: string;
  /**
   * @minItems 1
   */
  capabilities: [
    {
      name: string;
      stability: 'alpha' | 'beta' | 'stable';
    },
    ...{
      name: string;
      stability: 'alpha' | 'beta' | 'stable';
    }[],
  ];
  /**
   * 测过的后端版本矩阵
   */
  tested_versions: {
    backend: string;
    versions: string[];
    /**
     * 徽章上注明的验证方式
     */
    verification: 'kind_e2e' | 'testcontainers' | 'recorded_fixtures' | 'live_smoke';
  }[];
  /**
   * 实例配置的 JSON Schema。密钥字段只写挂载文件的引用，用 x-srenautix-secret-ref: true 标出
   */
  config_schema: {};
  /**
   * 凭证需要的最小权限；启动时探测凭证是否超出，超出时降级为 warn 或只提议
   */
  required_scopes: string[];
  owner: string;
  /**
   * 真实部署报告的链接
   */
  deployment_reports?: string[];
}
/**
 * 领域包的 pack.yaml（DESIGN §6.3）。领域包只包含数据，不包含可执行代码；其余文件的结构见本文件的 $defs：signals.yaml → SignalsFile，components.yaml → ComponentsFile，alerts.yaml → AlertsFile，chains.yaml → ChainsFile，checks.yaml → ChecksFile，rules.yaml → RulesFile，rca-params.yaml → RcaParams，knowledge/*.yaml → KnowledgeFile，action-requests.yaml → ActionRequestsFile，chaos/*.yaml → ChaosFile，tests/*.yaml → PackTestFile，用户层文件 → UserLayer，pack.lock → PackLock
 */
export interface PackManifest {
  api_version: 'srenautix.io/pack/v1';
  name: string;
  version: string;
  description?: string;
  /**
   * stable：有 CI 夹具，并且在 Prometheus 和 VictoriaMetrics 上结论一致；只有 stable 的包计入支持
   */
  maturity: 'stable' | 'beta' | 'draft';
  min_srenautix_version?: string;
  /**
   * 依赖的其他包（引用其信号或组件类型）
   */
  depends_on?: string[];
  /**
   * 必须的集成能力；缺失时整个包禁用并给出原因
   */
  requires: PackCapability[];
  /**
   * 可选的集成能力；缺失时相应的卡显示 capability_missing
   */
  optional?: PackCapability[];
}
export interface SignalsFile {
  signals: Signal[];
  /**
   * 区分性检查可用的查询模板（next_checks 的 type=query）
   */
  templates?: QueryTemplate[];
}
/**
 * 一个信号与它的备选（DESIGN §6.2）。加载时逐个探测，按数据源记录最终选中的一个
 */
export interface Signal {
  id: string;
  kind: 'metrics' | 'logs' | 'traces';
  unit?: string;
  /**
   * 按优先级排列
   *
   * @minItems 1
   */
  alternatives: [SignalAlternative, ...SignalAlternative[]];
}
export interface SignalAlternative {
  /**
   * 查询模板。可用变量：$selector（按标签档案展开的实体选择器）、$namespace、$name、$node、$rate_window（由抓取间隔推导）、$params.<名字>
   */
  expr: string;
  /**
   * PromQL 用严格解析器做 lint；使用 MetricsQL 必须显式声明
   */
  dialect?: 'promql' | 'metricsql' | 'logql' | 'logs_match' | 'traceql';
  /**
   * 探测该备选是否可用的查询，返回非空即可用；不填时用 expr 本身探测
   */
  probe?: string;
  /**
   * expr 依赖录制规则；录制规则可选，下一条备选必须是原始表达式
   */
  recording_rule?: boolean;
}
export interface QueryTemplate {
  id: string;
  signal: string;
  /**
   * 参数的 JSON Schema（可移植子集）
   */
  args: {};
  description: string;
  card?: EvidenceCardDefinition1;
}
/**
 * 证据卡定义（DESIGN §6.1），写在领域包 chains.yaml 的证据链中。卡片只包含数据：信号引用、时间窗口、params、CEL 判定、声明式展示和链接。CEL 只在 TypeScript 运行时求值，求值成本有上限
 */
export interface EvidenceCardDefinition1 {
  /**
   * 证据链内唯一；全局 id 为 <pack>/<chain>/<id>
   */
  id: string;
  title: LocalizedText;
  note?: LocalizedText1;
  /**
   * 卡片对哪些实体执行；不填时对证据链所属组件执行
   */
  applies_to?: {
    kinds?: string[];
    component_types?: string[];
  };
  window?: CardWindow;
  /**
   * 可由用户层覆盖的参数及默认值，在查询模板中写作 $params.<名字>，在 CEL 中写作 params.<名字>
   */
  params?: {
    [k: string]: number | string | boolean | undefined;
  };
  /**
   * @minItems 1
   */
  refs: [CardSignalRef, ...CardSignalRef[]];
  judge: CardJudge;
  display?: CardDisplay;
  links?: CardLink[];
  egress: Egress;
  /**
   * 沉默根因探测卡：症状存在但没有指向原因的告警时，对上游组件执行，结果异常的组件加入根因候选
   */
  probe?: boolean;
  /**
   * 卡片需要的集成能力，例如 metrics.query_range、logs.match。能力不可用时卡片显示 capability_missing
   */
  requires?: string[];
}
export interface ComponentsFile {
  component_types: ComponentType[];
  /**
   * Operator 约定边，置信度 1.0（例如 CNPG 的 -rw Service 指向它的 Cluster）
   */
  conventions?: OperatorConvention[];
}
export interface ComponentType {
  id: string;
  hub?: boolean;
  match: {
    kind: string;
    api_group?: string;
    labels?: Labels;
    /**
     * RE2 正则
     */
    name_pattern?: string;
    namespaces?: string[];
  };
  chains?: string[];
}
export interface OperatorConvention {
  id: string;
  from: ObjectPattern;
  to: ObjectPattern;
  relation: string;
  scope: 'instance' | 'service';
}
/**
 * name 可以引用另一端的捕获组，例如 from 的 name_pattern 为 ^(.+)-rw$ 时 to 的 name 写 $1
 */
export interface ObjectPattern {
  kind: string;
  name_pattern?: string;
  name?: string;
  same_namespace?: boolean;
}
export interface AlertsFile {
  entries: AlertCatalogEntry[];
}
export interface ChainsFile {
  chains: EvidenceChain[];
}
export interface EvidenceChain {
  id: string;
  title: LocalizedText;
  runbook?: string;
  /**
   * @minItems 1
   */
  cards: [EvidenceCardDefinition, ...EvidenceCardDefinition[]];
  /**
   * 排除规则：CEL 表达式命中时阶段 A 的 disposition 为 ignore
   */
  excludes?: CardRule[];
}
export interface ChecksFile {
  checks: EvidenceCardDefinition[];
}
export interface RulesFile {
  rules: PackRule[];
}
/**
 * 确定性规则提议，只能引用动作目录中已有的动作
 */
export interface PackRule {
  id: string;
  title: LocalizedText;
  /**
   * CEL，可引用 incident、root、cards（卡片 id → 结论）
   */
  when: string;
  action: string;
  /**
   * 参数值为 CEL 表达式文本
   */
  params: {};
  expected_effect?: LocalizedText;
}
/**
 * 根因排序参数（DESIGN §5）。修改需要通过回放门禁
 */
export interface RcaParams {
  weights?: {
    coverage?: number;
    precedence?: number;
    role_prior?: number;
    recent_change?: number;
    chronic_penalty?: number;
  };
  role_priors?: {
    change?: number;
    cause?: number;
    symptom?: number;
    forecast?: number;
    meta?: number;
  };
  merge_threshold?: number;
  ambiguity_margin?: number;
  adjacency?: Duration1;
  change_window?: Duration2;
  chronic_window?: Duration3;
  /**
   * 7 天内处于触发状态的时间比例达到该值视为长期告警
   */
  chronic_rate?: number;
  hub_min_dependents?: number;
  top_k?: number;
}
export interface KnowledgeFile {
  entries: {
    id: string;
    components?: string[];
    text: LocalizedText;
    /**
     * 来源事件 incident_id 或外部引用；回放时排除来自该用例的部分
     */
    learned_from: string[];
    learned_at?: Timestamp;
    source: 'human' | 'model';
  }[];
}
/**
 * 动作启用申请；经 Git PR 合入策略之后才生效
 */
export interface ActionRequestsFile {
  requests: {
    action: string;
    namespaces: string[];
    auto?: boolean;
    reason: string;
  }[];
}
/**
 * 用户层文件，按声明的顺序合并（组织在前、集群在后）
 */
export interface PackUserLayer {
  api_version: 'srenautix.io/pack-layer/v1';
  /**
   * 被修改的包名
   */
  target: string;
  /**
   * <chain>/<card> → 参数覆盖
   */
  params?: {
    [k: string]: {} | undefined;
  };
  /**
   * 禁用的条目：alerts/<id>、chains/<id>、chains/<id>/<card>、checks/<id>、rules/<id>
   */
  disable?: string[];
  patch?: {
    /**
     * JSON Pointer，相对包的合并后文档
     */
    path: string;
    value: unknown;
  }[];
  /**
   * 追加的内容，结构同各文件
   */
  extend?: {
    signals?: Signal[];
    component_types?: ComponentType[];
    conventions?: OperatorConvention[];
    alerts?: AlertCatalogEntry[];
    chains?: EvidenceChain[];
    checks?: EvidenceCardDefinition[];
    rules?: PackRule[];
  };
  rca_params?: RcaParams;
}
/**
 * 面向预发集群的混沌实验配方（DESIGN §14.5）。只包含声明式的 Kubernetes 对象（例如 Chaos Mesh 资源）与期望，不包含脚本
 */
export interface ChaosFile {
  api_version: 'srenautix.io/chaos/v1';
  id: string;
  title: LocalizedText;
  /**
   * 实验需要的集群组件，例如 chaos-mesh
   */
  requires?: string[];
  /**
   * @minItems 1
   */
  manifests: [
    {
      apiVersion: string;
      kind: string;
      metadata: {};
    },
    ...{
      apiVersion: string;
      kind: string;
      metadata: {};
    }[],
  ];
  duration: Duration;
  expect: {
    /**
     * 期望的根因对象 Kind 或组件类型
     */
    root_kind: string;
    root_name_pattern?: string;
    disposition: Disposition;
    alerts?: string[];
  };
}
/**
 * 领域包测试（DESIGN §6.3）。input_series 使用 promtool 的序列写法，在 Prometheus 与 VictoriaMetrics 上各跑一遍，结论必须一致
 */
export interface PackTestFile {
  api_version: 'srenautix.io/pack-test/v1';
  interval: Duration;
  input_series?: {
    /**
     * 例如 kube_pod_info{namespace="shop",pod="pg-1"}
     */
    series: string;
    /**
     * promtool 的展开写法，例如 0+1x10 _ stale
     */
    values: string;
  }[];
  input_logs?: {
    labels: Labels;
    lines: {
      offset: Duration;
      line: string;
    }[];
  }[];
  /**
   * @minItems 1
   */
  tests: [
    {
      name: string;
      eval_time: Duration;
      /**
       * <chain>/<card> 或 checks/<id>
       */
      card: string;
      entity: {
        kind: string;
        namespace?: string | null;
        name: string;
      };
      params?: {
        [k: string]: number | string | boolean | undefined;
      };
      expect: {
        verdict: Verdict;
        display_state?: 'normal' | 'abnormal' | 'undeterminable' | 'capability_missing';
        reason_kind?: string;
      };
    },
    ...{
      name: string;
      eval_time: Duration;
      /**
       * <chain>/<card> 或 checks/<id>
       */
      card: string;
      entity: {
        kind: string;
        namespace?: string | null;
        name: string;
      };
      params?: {
        [k: string]: number | string | boolean | undefined;
      };
      expect: {
        verdict: Verdict;
        display_state?: 'normal' | 'abnormal' | 'undeterminable' | 'capability_missing';
        reason_kind?: string;
      };
    }[],
  ];
}
/**
 * pack.lock：每个包与用户层的内容哈希；每次研判和评测都记录 lock 本身的哈希
 */
export interface PackLock {
  api_version: 'srenautix.io/pack-lock/v1';
  packs: {
    name: string;
    version: string;
    /**
     * builtin、git+<url>@<sha> 或 oci://<ref>@<digest>
     */
    source: string;
    digest: Sha256;
  }[];
  layers: {
    path: string;
    digest: Sha256;
  }[];
}
/**
 * 提交提议的请求体。source、caller_id 由认证上下文决定；目标由 server 推导
 */
export interface ProposalCreate {
  incident_id: Uuid;
  binding: ProposalBinding;
  action: string;
  params: {};
  research_run_id: null | Uuid;
  rule_id: string | null;
  hypothesis_id: string | null;
  evidence_refs: EvidenceRef[];
  expected_effect: string;
}
/**
 * 研判清单（DESIGN §8.5）：复现一次研判需要的全部版本信息，以及出境清单（§8.4）。后处理部分可以基于已保存的响应精确重放；重新采样模型得到的是一个分布
 */
export interface ResearchManifest {
  run_id: Uuid;
  incident_id: Uuid;
  incident_version: number;
  code_sha: string;
  pack_lock: Sha256;
  contract_version: string;
  /**
   * 阶段名 → 提示词哈希
   */
  prompt_hashes: {
    [k: string]: Sha256 | undefined;
  };
  routes: RouteUse[];
  topology_version: number;
  snapshot_id: null | Uuid;
  redaction_version: string;
  retrieved_cases: string[];
  retrieved_knowledge: string[];
  /**
   * 研判运行内的证据引用（card:n、alert:n、change:n）到定义与实体的映射
   */
  evidence_map: {
    ref: EvidenceRef;
    /**
     * card_id@实体键、alert_id 或 change_id
     */
    target: string;
  }[];
  /**
   * 出境清单：每次出站模型请求带出了哪些类别的数据
   */
  egress: EgressEntry[];
}
export interface RouteUse {
  phase: 'hypothesize' | 'conclude' | 'compress' | 'still_consistent' | 'repair';
  route_id: string;
  model: string;
  dialect_profile: string;
  provider_fingerprint: string | null;
  sampling: {
    [k: string]: number | string | boolean | undefined;
  };
  seed: number | null;
}
export interface EgressEntry {
  route_id: string;
  in_domain: boolean;
  categories: ('metrics' | 'logs' | 'traces' | 'events' | 'topology' | 'changes' | 'alerts' | 'knowledge')[];
  redaction_hits: number;
  bytes: number;
}
/**
 * 阶段 A 的确定性报告（DESIGN §7.1）：不调用模型，不经过 worker。事件创建或版本变化后立即生成
 */
export interface StageAReport {
  report_id: Uuid;
  incident_id: Uuid;
  incident_version: number;
  disposition: Disposition;
  /**
   * suppressed：命中抑制规则；pack_exclude：命中领域包的排除规则；forecast_or_chronic_only：只有 forecast 和长期告警；rule_action：有动作明确的规则提议；critical_ambiguous：critical 且根因有歧义；observability_blind：观测失明；default：其余情况
   */
  disposition_reason:
    | 'suppressed'
    | 'pack_exclude'
    | 'forecast_or_chronic_only'
    | 'rule_action'
    | 'critical_ambiguous'
    | 'observability_blind'
    | 'default';
  candidates: RootCandidate[];
  ambiguous: boolean;
  /**
   * 证据卡的判定向量；正常卡表示被排除嫌疑
   */
  cards: EvidenceResult[];
  evidence_fingerprint: Sha2562;
  observability_blind: boolean;
  timeline: {
    at: Timestamp;
    kind: 'alert_firing' | 'alert_resolved' | 'change' | 'card_abnormal';
    text: string;
    ref: string | null;
  }[];
  /**
   * Items: <pack>/<runbook 文件>#<锚点>
   */
  runbooks: string[];
  rule_proposals: Uuid[];
  /**
   * 状态库降级：PG 不可用时在内存中生成，消息带降级横幅
   */
  degraded: boolean;
  rendered_at: Timestamp;
}
/**
 * 事件溯源拓扑中的一条事件（DESIGN §4.1）。节点或边在 [valid_from, valid_to) 内有效；同一节点或边的新事件到达时，上一条的 valid_to 被设为新事件的 valid_from。删除事件只关闭区间。按时刻 t 查询拓扑时取 valid_from <= t 且 (valid_to 为空或 t < valid_to) 的全部节点和边
 */
export interface TopologyEvent {
  event_id: Uuid;
  cluster_id: ClusterId;
  /**
   * 集群内单调递增，也是拓扑版本号
   */
  seq: number;
  op: 'node_upsert' | 'node_delete' | 'edge_upsert' | 'edge_delete';
  valid_from: Timestamp;
  valid_to: null | Timestamp;
  /**
   * informer：reader 或 server 的 informer；ksm_history：从 kube-state-metrics 历史重建；pack：领域包声明的 Operator 约定；user：用户声明的覆盖；runtime：运行时观测（服务图、Hubble 等）
   */
  source: 'informer' | 'ksm_history' | 'pack' | 'user' | 'runtime';
  /**
   * op 为 node_* 时填写
   */
  node: null | TopologyNode;
  /**
   * op 为 edge_* 时填写
   */
  edge: null | TopologyEdge;
}
export interface TopologyNode {
  key: ComponentKey;
  kind: string;
  namespace: string | null;
  name: string;
  uid: string | null;
  labels: Labels;
  /**
   * 领域包 components.yaml 匹配到的组件类型
   */
  component_type: string | null;
  /**
   * 集群枢纽（CoreDNS、CNI、apiserver、存储）：只有在出现针对它的证据，或至少 3 个独立依赖方同时失败时才吸收症状
   */
  hub: boolean;
}
/**
 * from 依赖 to：to 的故障沿边反向传播到 from
 */
export interface TopologyEdge {
  from: ComponentKey;
  to: ComponentKey;
  /**
   * 关系名，例如 owned_by、runs_on、mounts、bound_to、provisioned_by、selects、routes_to、calls、references、egress_to、operator_convention、named_like
   */
  relation: string;
  provenance: EdgeProvenance;
  /**
   * 默认值由来源决定（structural 1.0、runtime 0.9 并随过期衰减、config_ref 0.7、network_policy 0.6、naming 0.3）。低于归并阈值 τ=0.6 的边只参与候选排序
   */
  confidence: number;
  /**
   * instance：只把同一实例的故障联系起来（Pod→节点、Pod→PVC→PV→CSI）；service：沿服务依赖传播
   */
  scope: 'instance' | 'service';
  /**
   * 边的依据，例如 ownerReference、env DATABASE_HOST=pg-rw、Tempo 服务图
   */
  evidence: string;
}
