// 本文件由 packages/contract/scripts/gen.ts 从 contract/ 生成，不要手工修改。
export type ActionCatalogLevel = 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
/**
 * 该动作在其目录等级下可接受的最低档位。
 */
export type ActionCatalogTier = 'L' | 'H';
/**
 * 等级降为 fallback_level 时可接受的最低档位。
 */
export type ActionCatalogTier1 = 'L' | 'H';
export type ActionCatalogTier2 = 'L' | 'H';
/**
 * 动作等级（DESIGN §9.1）：提议时按目录等级与目标状态确定。pod_restart 满足可重建条件时为 reversible_recreatable，否则为 irreversible。
 */
export type ApprovalAssertionLevel = 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
/**
 * 风险档位（DESIGN §9.2）。
 */
export type ApprovalAssertionTier = 'L' | 'H';
/**
 * "sha256:" 加 sha256(JCS(params)) 的小写十六进制。
 */
export type ApprovalAssertionSha256 = string;
/**
 * 被管集群的 cluster_id。
 */
export type ApprovalAssertionClusterId = string;
/**
 * 提议绑定的证据指纹。
 */
export type ApprovalAssertionSha2561 = string;
/**
 * 签发时间，UTC，RFC 3339，以 Z 结尾。
 */
export type ApprovalAssertionTimestamp = string;
/**
 * 审批的过期时间，与提议的 TTL 相互独立。
 */
export type ApprovalAssertionTimestamp1 = string;
export type ApprovalAssertionLevel1 = 'reversible' | 'reversible_recreatable' | 'compensable' | 'irreversible';
export type ApprovalAssertionTier1 = 'L' | 'H';
export type ApprovalAssertionSha2562 = string;
export type ApprovalAssertionClusterId1 = string;
export type ApprovalAssertionTimestamp2 = string;
/**
 * RFC 4648 §5 base64url，不带填充。
 */
export type ApprovalEnvelopeBase64Url = string;
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
 * 拓扑节点的键：命名空间内的对象为 <kind>:<namespace>/<名称段>，集群级对象为 <kind>:<名称段>。kind 是 Kubernetes 的 Kind（如 Pod、Node，其他 API 组写作 Kind.group）或领域包声明的组件类型（如 postgres.cluster）；namespace 是 DNS 标签。名称段由对象名编码得到（ADR 0034）：名称的 UTF-8 字节中 A–Z a–z 0–9 '-' '.' '_' 原样保留，其余每个字节写成 '%' 加两位大写十六进制，例如 RBAC 对象 system:node 写作 ClusterRole:system%3Anode；DNS 名称编码后不变。解析时只接受这种规范编码。命名空间伪组件写作 Namespace:<namespace>。黄金向量见 contract/testvectors/component-keys.json
 */
export type ComponentKey = string;
/**
 * 操作名；能力名为 dbstats.<操作名中的 . 换成 _>
 */
export type DbstatsOperation =
  | 'statements.top'
  | 'statements.text'
  | 'tables.top'
  | 'indexes.usage'
  | 'settings.get'
  | 'activity.summary'
  | 'locks.summary';
/**
 * 一次读取。database 为 null 时读取连接所在的库；statements.top 不按库过滤时可以读到全部库的语句
 */
export type DbstatsRequest =
  | DbstatsStatementsTopRequest
  | DbstatsStatementsTextRequest
  | DbstatsTablesTopRequest
  | DbstatsIndexesUsageRequest
  | DbstatsSettingsGetRequest
  | DbstatsActivitySummaryRequest
  | DbstatsLocksSummaryRequest;
/**
 * pg_stat_statements 的 queryid（bigint）的十进制字符串
 */
export type DbstatsQueryId = string;
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
 * 主动优化的实体键（契约 2.28.0，ADR 0146 §1.1）：Kubernetes 对象或领域包组件为 ComponentKey；逻辑实体为 <类型>:<组件内的键>，例如 pg_statement:<CNPG Cluster 名>/<库>/<语句指纹>、pg_table:<Cluster 名>/<库>/<schema>.<表>、route:<服务>/<endpoint>、stage:<服务>/<阶段>。逻辑实体都挂到一个拓扑组件上
 */
export type EntityKey = string;
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
 * RFC 3339 UTC 时间
 */
export type Timestamp2 = string;
/**
 * RFC 3339 UTC 时间
 */
export type Timestamp3 = string;
/**
 * 根因的粒度，从细到粗：pod < workload < component < node
 */
export type EvalGranularity = 'pod' | 'workload' | 'component' | 'node';
/**
 * 目标的来源：manual 人工下达；checkup 领域的定期体检；trend 趋势扫描；forecast_alert 预测类告警
 */
export type GoalOrigin = GoalOriginManual | GoalOriginCheckup | GoalOriginTrend | GoalOriginForecastAlert;
export type DomainId = string;
/**
 * 目标对象：一个指标（带参数），或一个领域的体检
 */
export type GoalSubject = GoalSubjectIndicator | GoalSubjectDomain;
/**
 * 指标的全局 id <包>/<指标 id>，例如 postgres/db-time
 */
export type IndicatorRef = string;
export type Comparator = 'lt' | 'le' | 'gt' | 'ge';
export type IndicatorUnit = 'none' | 'percent' | 'ratio' | 'bytes' | 'seconds' | 'count' | 'per_second' | 'cores';
/**
 * 基线窗口内按小时取值之后的统计方式
 */
export type IndicatorStatistic = 'p50' | 'p95' | 'max';
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration1 = string;
/**
 * ops_pr：ops 仓库的 PR（gitops_pr 提议）；business_issue：业务仓库的 issue
 */
export type RecommendationKind = 'ops_pr' | 'business_issue';
/**
 * 稳定标签 <根组件>:<首次触发时间取整到 10 分钟>，同一标签冲突时追加 ~2、~3
 */
export type IncidentLabel = string;
/**
 * 判定向量的指纹（带迟滞，见 docs/core/convergence.md）
 */
export type Sha2561 = string;
/**
 * 边的来源（DESIGN §4.2）
 */
export type EdgeProvenance = 'structural' | 'runtime' | 'config_ref' | 'network_policy' | 'naming';
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
  | ConditionChangedEvent
  | GoalCreatedEvent
  | GoalRunConcludedEvent
  | FindingUpdatedEvent
  | RecommendationUpdatedEvent
  | OutcomeVerifiedEvent;
export type IncidentUpsertedEvent = OutboxEventHeader & {
  type: 'incident.created' | 'incident.updated' | 'incident.resolved';
  payload: Incident;
};
export type OutboxOwner = 'server' | 'worker';
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
  | 'resumed'
  | 'reopened';
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
/**
 * RFC 3339 UTC 时间
 */
export type Timestamp4 = string;
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
export type Sha2562 = string;
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
/**
 * 目标创建（契约 2.28.0）
 */
export type GoalCreatedEvent = OutboxEventHeader & {
  type: 'goal.created';
  payload: Goal;
};
/**
 * queued 排队；analyzing 分析中；recommended 有建议已发布；verifying 验证中；achieved 达成；not_achieved 验证后未达成；no_action 没有差距或没有通过门槛的建议；cancelled 取消；expired 到期；failed 失败（state_reason 写明原因）
 */
export type GoalState =
  | 'queued'
  | 'analyzing'
  | 'recommended'
  | 'verifying'
  | 'achieved'
  | 'not_achieved'
  | 'no_action'
  | 'cancelled'
  | 'expired'
  | 'failed';
/**
 * RFC 3339 UTC 时间
 */
export type Timestamp5 = string;
/**
 * queued 排队；deferred 被准入推迟（defer_reason）；running 执行中；concluded 结束（result）；failed 失败；cancelled 目标取消
 */
export type GoalRunState = 'queued' | 'deferred' | 'running' | 'concluded' | 'failed' | 'cancelled';
/**
 * 目标运行结束（契约 2.28.0），含失败与没有差距
 */
export type GoalRunConcludedEvent = OutboxEventHeader & {
  type: 'goal.run.concluded';
  payload: {
    goal_id: Uuid;
    goal_revision: number;
    run_id: Uuid;
    summary: GoalRunSummary;
    /**
     * 运行输出；在基线之前失败时为 null
     */
    output: null | OptimizationOutput;
  };
};
/**
 * 发现指纹
 */
export type Sha2563 = string;
/**
 * 发现创建或更新（契约 2.28.0）
 */
export type FindingUpdatedEvent = OutboxEventHeader & {
  type: 'finding.updated';
  payload: Finding;
};
/**
 * sha256(JCS([cluster_id, domain, kind, entity.key]))
 */
export type Sha2564 = string;
/**
 * 拓扑节点的键：命名空间内的对象为 <kind>:<namespace>/<名称段>，集群级对象为 <kind>:<名称段>。kind 是 Kubernetes 的 Kind（如 Pod、Node，其他 API 组写作 Kind.group）或领域包声明的组件类型（如 postgres.cluster）；namespace 是 DNS 标签。名称段由对象名编码得到（ADR 0034）：名称的 UTF-8 字节中 A–Z a–z 0–9 '-' '.' '_' 原样保留，其余每个字节写成 '%' 加两位大写十六进制，例如 RBAC 对象 system:node 写作 ClusterRole:system%3Anode；DNS 名称编码后不变。解析时只接受这种规范编码。命名空间伪组件写作 Namespace:<namespace>。黄金向量见 contract/testvectors/component-keys.json
 */
export type ComponentKey1 = string;
/**
 * open 已发现；recommended 已有建议（PR 或 issue）；accepted PR 合并或 issue 以 completed 关闭；verifying 验证中；fixed 验证改善或差距消失（待人确认关闭）；no_effect 验证没有效果；regressed 验证回退；rejected 被拒绝，进入冷却期；suppressed 人工抑制
 */
export type FindingStatus =
  'open' | 'recommended' | 'accepted' | 'verifying' | 'fixed' | 'no_effect' | 'regressed' | 'rejected' | 'suppressed';
/**
 * 建议创建或状态变化（契约 2.28.0）
 */
export type RecommendationUpdatedEvent = OutboxEventHeader & {
  type: 'recommendation.updated';
  payload: OptimizationRecommendation;
};
/**
 * 发现的指纹
 */
export type Sha2565 = string;
/**
 * blocked 门槛不通过，只记录原因；open 通过门槛，PR 或 issue 创建中；recommended PR 或 issue 已创建；verifying PR 合并并同步或修复已部署，验证窗口中；improved、no_effect、regressed 验证结果；rejected issue 以 not planned 关闭、PR 未合并即关闭，或被标为建议无用；superseded 发现有了更新的建议；failed 创建失败
 */
export type RecommendationState =
  | 'blocked'
  | 'open'
  | 'recommended'
  | 'verifying'
  | 'improved'
  | 'no_effect'
  | 'regressed'
  | 'rejected'
  | 'superseded'
  | 'failed';
/**
 * 建议的验证结束（契约 2.28.0）
 */
export type OutcomeVerifiedEvent = OutboxEventHeader & {
  type: 'outcome.verified';
  payload: {
    recommendation_id: Uuid;
    finding: Sha256;
    goal_id: Uuid;
    outcome: RecommendationOutcome;
  };
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
  | 'condition.changed'
  | 'goal.created'
  | 'goal.run.concluded'
  | 'finding.updated'
  | 'recommendation.updated'
  | 'outcome.verified';
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration2 = string;
/**
 * <集成类别>.<能力>，例如 metrics.query_range、logs.match、traces.search、changes.list
 */
export type PackCapability = string;
/**
 * 代码定位的锚点类型（ADR 0146 §3.5）：sql 规范化语句（按 libpg-query 指纹匹配字符串字面量与 .sql 文件）；table 表名（置信度低）；span_name、metric_name、route 字符串字面量精确匹配
 */
export type AnchorKind = 'sql' | 'table' | 'span_name' | 'metric_name' | 'route';
/**
 * 指标的全局 id <包>/<指标 id>，例如 postgres/db-time
 */
export type IndicatorRef1 = string;
/**
 * 指标的全局 id <包>/<指标 id>，例如 postgres/db-time
 */
export type IndicatorRef2 = string;
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration3 = string;
/**
 * 指标的全局 id <包>/<指标 id>，例如 postgres/db-time
 */
export type IndicatorRef3 = string;
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration4 = string;
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration5 = string;
/**
 * Prometheus 风格的时长，例如 30s、5m、2h、7d
 */
export type Duration6 = string;
/**
 * 出境数据类别。sql：规范化语句文本（常量为 $n、去掉注释）；code：业务代码片段（契约 2.28.0，ADR 0146 §3.6）
 */
export type EgressCategory =
  'metrics' | 'logs' | 'traces' | 'events' | 'topology' | 'changes' | 'alerts' | 'knowledge' | 'sql' | 'code';

export interface SrenautixContractIndex {
  ActionCatalog?: ActionCatalog;
  ActionCatalogLevel?: ActionCatalogLevel;
  ActionCatalogTier?: ActionCatalogTier2;
  ActionCatalogAction?: ActionCatalogAction;
  ActionCatalogTarget?: ActionCatalogTarget;
  ActionCatalogPromqlCondition?: ActionCatalogPromqlCondition;
  ApprovalAssertion?: ApprovalAssertion;
  ApprovalAssertionLevel?: ApprovalAssertionLevel1;
  ApprovalAssertionTier?: ApprovalAssertionTier1;
  ApprovalAssertionSha256?: ApprovalAssertionSha2562;
  ApprovalAssertionClusterId?: ApprovalAssertionClusterId1;
  ApprovalAssertionTimestamp?: ApprovalAssertionTimestamp2;
  ApprovalEnvelope?: ApprovalEnvelope;
  ApprovalEnvelopeBase64url?: ApprovalEnvelopeBase64Url;
  ApprovalEnvelopeServiceProof?: ApprovalEnvelopeServiceProof;
  ApprovalEnvelopeReauth?: ApprovalEnvelopeReauth;
  ApprovalEnvelopeWebauthnProof?: ApprovalEnvelopeWebauthnProof;
  ApproverKeys?: ApproverKeys;
  ExecutionAuditRecord?: ExecutionAuditRecord;
  GatewayPolicy?: GatewayPolicy;
  AlertmanagerWebhook?: AlertmanagerWebhook;
  AlertmanagerAlert?: AlertmanagerAlert;
  GenericWebhookMapping?: GenericWebhookMapping;
  ApprovalAction?: ApprovalAction;
  ApprovalOutcome?: ApprovalOutcome;
  ChangesListRequest?: ChangesListRequest;
  ChangesScope?: ChangesScope;
  ChangesListResponse?: ChangesListResponse;
  ChangeEvent?: ChangeEvent;
  DbstatsOperation?: DbstatsOperation;
  DbstatsRequest?: DbstatsRequest;
  DbstatsStatementsTopRequest?: DbstatsStatementsTopRequest;
  DbstatsStatementsTextRequest?: DbstatsStatementsTextRequest;
  DbstatsTablesTopRequest?: DbstatsTablesTopRequest;
  DbstatsIndexesUsageRequest?: DbstatsIndexesUsageRequest;
  DbstatsSettingsGetRequest?: DbstatsSettingsGetRequest;
  DbstatsActivitySummaryRequest?: DbstatsActivitySummaryRequest;
  DbstatsLocksSummaryRequest?: DbstatsLocksSummaryRequest;
  DbstatsQueryId?: DbstatsQueryId;
  DbstatsSample?: DbstatsSample;
  DbstatsStatementRow?: DbstatsStatementRow;
  DbstatsStatementText?: DbstatsStatementText;
  DbstatsTableRow?: DbstatsTableRow;
  DbstatsIndexRow?: DbstatsIndexRow;
  DbstatsSettingRow?: DbstatsSettingRow;
  DbstatsActivityRow?: DbstatsActivityRow;
  DbstatsLockRow?: DbstatsLockRow;
  DbstatsPrivilegeReport?: DbstatsPrivilegeReport;
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
  NotifyRun?: NotifyRun;
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
  OptimizeConcludeOutput?: OptimizeConcludeOutput;
  OptimizeHypothesizeOutput?: OptimizeHypothesizeOutput;
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
  EntityKey?: EntityKey;
  Subject?: Subject;
  CommonComponentNames?: CommonComponentNames;
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
  ConditionDirections?: ConditionDirections;
  ConditionDirectionsRole?: ConditionDirectionsRole;
  ConditionDirectionsType?: ConditionDirectionsType;
  Condition?: Condition;
  EvalCase?: EvalCase;
  EvalGranularity?: EvalGranularity;
  EvalTruth?: EvalTruth;
  EvalOptimizationTruth?: EvalOptimizationTruth;
  EvalLeakage?: EvalLeakage;
  EvalReport?: EvalReport;
  EvalRatio?: EvalRatio7;
  EvalModelRow?: EvalModelRow;
  EvalGate?: EvalGate;
  EvalSnapshot?: EvalSnapshot;
  EvalSnapshotContext?: EvalSnapshotContext;
  EvalDispositionFacts?: EvalDispositionFacts;
  EvalKnowledge?: EvalKnowledge;
  EvalReferenceCase?: EvalReferenceCase;
  QuerySnapshot?: QuerySnapshot1;
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
  GoalCreatedEvent?: GoalCreatedEvent;
  GoalRunConcludedEvent?: GoalRunConcludedEvent;
  FindingUpdatedEvent?: FindingUpdatedEvent;
  RecommendationUpdatedEvent?: RecommendationUpdatedEvent;
  OutcomeVerifiedEvent?: OutcomeVerifiedEvent;
  EvidenceCardDefinition?: EvidenceCardDefinition;
  LocalizedText?: LocalizedText2;
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
  EvidenceCondition?: EvidenceCondition;
  EvidenceQueryRecord?: EvidenceQueryRecord;
  Feedback?: Feedback;
  FeedbackCreate?: FeedbackCreate;
  Finding?: Finding;
  FindingStatus?: FindingStatus;
  FindingEntity?: FindingEntity;
  Goal?: Goal;
  GoalState?: GoalState;
  GoalSpec?: GoalSpec;
  RecommendationKind?: RecommendationKind;
  GoalOrigin?: GoalOrigin;
  DomainId?: DomainId;
  GoalScope?: GoalScope;
  GoalSubject?: GoalSubject;
  Comparator?: Comparator;
  GoalObjective?: GoalObjective;
  GoalBudget?: GoalBudget;
  GoalCreate?: GoalCreate;
  GoalRunState?: GoalRunState;
  GoalRunSummary?: GoalRunSummary;
  Incident?: Incident;
  ResearchRoot?: ResearchRoot1;
  IncidentLabel?: IncidentLabel;
  IncidentRoot?: IncidentRoot;
  RootCandidate?: RootCandidate;
  RootScoreTerms?: RootScoreTerms;
  IncidentMember?: IncidentMember;
  IncidentAlias?: IncidentAlias;
  IntegrationManifest?: IntegrationManifest;
  OptimizationOutput?: OptimizationOutput;
  OptimizationBaseline?: OptimizationBaseline;
  BaselineIndicator?: BaselineIndicator;
  OptimizationGap?: OptimizationGap;
  OptimizationCandidate?: OptimizationCandidate;
  FindingHypothesis?: FindingHypothesis;
  OptimizationConsistency?: OptimizationConsistency;
  FindingConclusion?: FindingConclusion;
  RecommendationAttempt?: RecommendationAttempt;
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
  RemediationsFile?: RemediationsFile;
  Remediation?: Remediation;
  RemediationEdit?: RemediationEdit;
  RepositoryLayout?: RepositoryLayout;
  CodeLayout?: CodeLayout;
  AnchorKind?: AnchorKind;
  IndicatorRef?: IndicatorRef;
  IndicatorUnit?: IndicatorUnit;
  IndicatorStatistic?: IndicatorStatistic;
  DomainsFile?: DomainsFile;
  Indicator?: Indicator;
  Domain?: Domain;
  DomainDiagnostic?: DomainDiagnostic;
  DomainContribution?: DomainContribution;
  EntityRows?: EntityRows;
  DomainGates?: DomainGates;
  DomainTrend?: DomainTrend;
  DomainLoadGuard?: DomainLoadGuard;
  Estimate?: Estimate1;
  Guard?: Guard;
  IssuesFile?: IssuesFile;
  IssueTemplate?: IssueTemplate;
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
  OptimizationRecommendation?: OptimizationRecommendation;
  RecommendationState?: RecommendationState;
  EstimateValue?: EstimateValue;
  VerifyPlan?: VerifyPlan;
  GateRecord?: GateRecord;
  RecommendationDelivery?: RecommendationDelivery;
  RecommendationOutcome?: RecommendationOutcome;
  ResearchManifest?: ResearchManifest;
  RouteUse?: RouteUse;
  EgressEntry?: EgressEntry;
  EgressCategory?: EgressCategory;
  ResearchOutput?: ResearchOutput;
  ResearchConclusion?: ResearchConclusion;
  ConsistencyDetail?: ConsistencyDetail;
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
 * 动作目录（DESIGN §9.1）。目录只描述动作本身；哪些动作启用、作用于哪些命名空间、能否自动执行由 gateway 策略决定。
 */
export interface ActionCatalog {
  version: 1;
  /**
   * @minItems 1
   */
  actions: [ActionCatalogAction, ...ActionCatalogAction[]];
}
export interface ActionCatalogAction {
  id: string;
  title: string;
  level: ActionCatalogLevel;
  /**
   * 只用于 reversible_recreatable：可重建条件在执行时不成立时的等级。
   */
  fallback_level?: 'irreversible';
  /**
   * 只用于 reversible_recreatable：执行时重新核对的可重建条件。
   */
  recreatable_conditions?: {
    controller_managed: true;
    min_ready_replicas: number;
    pdb_headroom: true;
  };
  min_tier: ActionCatalogTier;
  fallback_min_tier?: ActionCatalogTier1;
  /**
   * allowed 只允许出现在 reversible 与 reversible_recreatable 动作上（不变量 7）。
   */
  auto_execution: 'allowed' | 'forbidden';
  target: ActionCatalogTarget;
  /**
   * 参数的 JSON Schema（可移植子集：type、properties、required、additionalProperties:false、enum、pattern、minLength、maxLength、minimum、maximum、items）。所有动作的参数另外可以带 verify（见 promqlCondition）。
   */
  params: {
    [k: string]: unknown | undefined;
  };
  /**
   * 冲突域类型。键由执行器根据解析出的目标计算：workload:<ns>/<Kind>/<name>、node:<name>、pg:<ns>/<cluster>、argocd:<ns>/<app>、flux:<ns>/<Kind>/<name>、workflow:<ns>/<template>、gitops:<owner>/<repo>。
   */
  conflict_domain: 'workload' | 'node' | 'pg' | 'argocd' | 'flux' | 'workflow' | 'gitops';
  prechecks: {
    id: string;
    kind: 'k8s' | 'pdb' | 'promql' | 'git';
    description: string;
  }[];
  verify: {
    window_seconds: number;
    checks: {
      id: string;
      kind: 'k8s' | 'git';
      description: string;
    }[];
  };
  undo: {
    /**
     * restore：自动恢复原状态（reversible）；recreate：由控制器重建（reversible_recreatable）；compensate：补偿需要再次审批（compensable）；none：无法撤销（irreversible）。
     */
    kind: 'restore' | 'recreate' | 'compensate' | 'none';
    description: string;
    /**
     * compensate 时提议的补偿动作 ID。
     */
    compensation_action?: string;
  };
  blast_radius: {
    unit: 'pods' | 'nodes' | 'objects' | 'repositories';
    method: string;
    /**
     * L 档允许的最大爆炸半径；超过时需要 H 档。
     */
    l_tier_max: number;
  };
  /**
   * 执行与撤销会产生的全部 Kubernetes 写入。RBAC 与准入策略由此生成；gitops_pr 只写 Git，此列表为空。
   */
  writes: {
    group: string;
    resource: string;
    subresource?: string;
    verb: 'create' | 'patch';
  }[];
}
export interface ActionCatalogTarget {
  group: string;
  version: string;
  kind: string;
  resource: string;
  namespaced: boolean;
  /**
   * 目标可以是多种类型时列出全部（例如 Deployment 与 StatefulSet）。
   */
  kinds?: {
    group: string;
    version: string;
    kind: string;
    resource: string;
  }[];
}
/**
 * 执行后校验条件：窗口结束时做一次即时查询，结果中的每个样本都必须满足 value <op> threshold。查询结果为空时按 on_empty 处理。
 */
export interface ActionCatalogPromqlCondition {
  id: string;
  query: string;
  op: 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne';
  threshold: number;
  on_empty?: 'fail' | 'pass';
}
/**
 * 审批断言 v1（DESIGN §9.2）。字段集合固定为 15 个，全部必填。签名覆盖的是 approval-envelope 中定义的签名输入，签名输入包含本断言的 JCS（RFC 8785）规范化形式。
 */
export interface ApprovalAssertion {
  /**
   * 提议 ID（UUID，小写）。
   */
  proposal_id: string;
  /**
   * 动作目录中的动作 ID。
   */
  action: string;
  level: ApprovalAssertionLevel;
  tier: ApprovalAssertionTier;
  params_hash: ApprovalAssertionSha256;
  /**
   * 规范化版本：jcs-sha256-v1 表示 RFC 8785 JCS、UTF-8 编码、SHA-256、小写十六进制并带 "sha256:" 前缀。
   */
  canon_version: 'jcs-sha256-v1';
  /**
   * 目标对象的 metadata.uid；gitops_pr 为补丁所基于的 40 位提交 SHA。
   */
  target_uid: string;
  cluster: ApprovalAssertionClusterId;
  /**
   * 提议绑定的事件版本。
   */
  incident_version: number;
  /**
   * 提议绑定的根因组件（组件键）。
   */
  root_component: string;
  evidence_fingerprint: ApprovalAssertionSha2561;
  /**
   * 审批人主体。策略自动批准时为 "auto:<规则名>"。
   */
  approver_principal: string;
  /**
   * 审批渠道。策略自动批准时为 auto。
   */
  channel: string;
  issued_at: ApprovalAssertionTimestamp;
  expires_at: ApprovalAssertionTimestamp1;
}
/**
 * 审批断言及其签名证明。服务签名（service_ed25519）由 server 的服务签名密钥签发；通行密钥签名（webauthn）由审批人的 WebAuthn 凭据签发，算法（EdDSA 或 ES256）取自登记的凭据。签名输入与校验步骤见 docs/adr/0020-approval-assertion-format.md。
 */
export interface ApprovalEnvelope {
  assertion: ApprovalAssertion;
  proof: ApprovalEnvelopeServiceProof | ApprovalEnvelopeWebauthnProof;
}
/**
 * 服务签名。签名输入为 ASCII "srenautix-approval-v1" 加一个换行符 0x0A，再接 JCS(statement) 的 UTF-8 字节；statement 为 {"assertion": assertion}，H 档时为 {"assertion": assertion, "reauth": reauth}。
 */
export interface ApprovalEnvelopeServiceProof {
  type: 'service_ed25519';
  /**
   * 服务签名公钥的 ID，对应 approver-keys 中 use=service 的条目。
   */
  key_id: string;
  /**
   * Ed25519 签名（64 字节）的 base64url。
   */
  signature: ApprovalEnvelopeBase64Url;
  reauth?: ApprovalEnvelopeReauth;
}
/**
 * H 档服务签名必须携带的重新认证凭据（OIDC max_age）。auth_time 不晚于 assertion.issued_at，且两者相差不超过 300 秒。
 */
export interface ApprovalEnvelopeReauth {
  method: 'oidc_max_age' | 'local_totp';
  auth_time: string;
  /**
   * "sha256:" 加服务端会话 ID 的 SHA-256，用于在治理审计链中关联会话。
   */
  session_hash: string;
}
/**
 * 通行密钥签名（WebAuthn Level 3 断言）。clientDataJSON 的 type 为 webauthn.get，challenge 为 sha256(JCS(assertion)) 原始 32 字节的 base64url；签名覆盖 authenticatorData 与 sha256(clientDataJSON) 的拼接。签名算法由 approver-keys 中该凭据的 alg 决定：EdDSA 为 64 字节 Ed25519 签名，ES256 为 DER 编码的 ECDSA 签名。type 取 webauthn；webauthn_ed25519 只能用于 alg 为 EdDSA 的凭据，用于其他凭据时拒绝（webauthn_alg_mismatch）。
 */
export interface ApprovalEnvelopeWebauthnProof {
  type: 'webauthn' | 'webauthn_ed25519';
  credential_id: ApprovalEnvelopeBase64Url;
  authenticator_data: ApprovalEnvelopeBase64Url;
  client_data_json: ApprovalEnvelopeBase64Url;
  /**
   * EdDSA：64 字节（86 个字符）；ES256：DER 编码的 ECDSA-Sig-Value，至多 72 字节（96 个字符）。
   */
  signature: ApprovalEnvelopeBase64Url;
}
/**
 * gateway 信任的签名公钥，来自 Git，经 ConfigMap 挂载。service 条目是 server 的服务签名公钥（Ed25519）；webauthn 条目是审批人通行密钥的公钥（合规配置），算法为 EdDSA 或 ES256。通行密钥只能经 Git 登记。
 */
export interface ApproverKeys {
  version: 1;
  /**
   * WebAuthn 依赖方设置；存在 webauthn 条目时必填。
   */
  webauthn?: {
    rp_id: string;
    /**
     * @minItems 1
     */
    origins: [string, ...string[]];
  };
  /**
   * @minItems 1
   */
  keys: [
    (
      | {
          use: 'service';
          key_id: string;
          /**
           * Ed25519 公钥 32 字节的 base64url（不带填充）。
           */
          public_key: string;
          /**
           * 该密钥签发的断言 issued_at 必须早于此时间；用于轮换。
           */
          not_after?: string;
        }
      | {
          use: 'webauthn';
          credential_id: string;
          principal: string;
          /**
           * 凭据的签名算法，对应 COSE alg：EdDSA 为 -8（Ed25519），ES256 为 -7（P-256 上的 ECDSA，SHA-256）。省略时为 EdDSA。
           */
          alg?: 'EdDSA' | 'ES256';
          /**
           * EdDSA：Ed25519 公钥 32 字节的 base64url（43 个字符）；ES256：P-256 未压缩点 0x04‖X‖Y 共 65 字节的 base64url（87 个字符），必须在曲线上。
           */
          public_key: string;
        }
    ),
    ...(
      | {
          use: 'service';
          key_id: string;
          /**
           * Ed25519 公钥 32 字节的 base64url（不带填充）。
           */
          public_key: string;
          /**
           * 该密钥签发的断言 issued_at 必须早于此时间；用于轮换。
           */
          not_after?: string;
        }
      | {
          use: 'webauthn';
          credential_id: string;
          principal: string;
          /**
           * 凭据的签名算法，对应 COSE alg：EdDSA 为 -8（Ed25519），ES256 为 -7（P-256 上的 ECDSA，SHA-256）。省略时为 EdDSA。
           */
          alg?: 'EdDSA' | 'ES256';
          /**
           * EdDSA：Ed25519 公钥 32 字节的 base64url（43 个字符）；ES256：P-256 未压缩点 0x04‖X‖Y 共 65 字节的 base64url（87 个字符），必须在曲线上。
           */
          public_key: string;
        }
    )[],
  ];
}
/**
 * 执行审计链的一行 JSONL（DESIGN §16.3）。hash = "sha256:" + hex(sha256(JCS(去掉 hash 字段后的记录)))；prev_hash 为上一条记录的 hash，第一条记录的 prev_hash 为 "sha256:" 加 64 个 0。checkpoint 记录为它之前的链头签名：signature 是审计签名密钥（Ed25519）对 "srenautix-audit-checkpoint-v1\n" + cluster + "\n" + (seq-1) 的十进制 + "\n" + prev_hash 的 UTF-8 字节的签名。
 */
export interface ExecutionAuditRecord {
  seq: number;
  prev_hash: string;
  chain: 'execution';
  cluster: string;
  at: string;
  type: 'phase' | 'write' | 'checkpoint';
  execution_id?: string;
  proposal_id?: string;
  action?: string;
  phase?: string;
  reason?: string;
  approver?: {
    principal: string;
    channel: string;
  };
  assertion_hash?: string;
  attempt_id?: string;
  target?: {
    group?: string;
    resource?: string;
    subresource?: string;
    namespace?: string;
    name?: string;
    uid?: string;
  };
  /**
   * type=write：一次 Kubernetes 或 Git 写入，与 apiserver 审计日志按 attempt_id、目标与时间关联。
   */
  write?: {
    verb: string;
    outcome: 'succeeded' | 'failed';
    detail?: string;
  };
  checkpoint?: {
    key_id: string;
    signature: string;
  };
  hash: string;
}
/**
 * gateway 策略，来自 Git，经 ConfigMap 挂载（DESIGN §2.1）。只能启用目录中的动作；准入策略与 RBAC 按同一份策略生成。
 */
export interface GatewayPolicy {
  version: 1;
  /**
   * 本集群的 cluster_id，必须与断言的 cluster 相同。
   */
  cluster: string;
  /**
   * 启用的动作。未列出的动作不生成 RBAC 与准入策略，工单直接被拒绝。
   */
  actions: {
    id: string;
    /**
     * 允许的目标命名空间；命名空间级动作必填，集群级动作（节点）不填。
     *
     * @minItems 1
     */
    namespaces?: [string, ...string[]];
    /**
     * 自动执行只允许用于目录中 auto_execution=allowed 的动作，否则策略加载失败（不变量 7）。
     */
    auto_execution?: {
      /**
       * 允许自动批准的规则名；断言 approver_principal 为 auto:<规则名>。
       *
       * @minItems 1
       */
      rules: [string, ...string[]];
      /**
       * 自动执行的命名空间，必须是 namespaces 的子集；命名空间级动作必填，集群级动作不填。
       *
       * @minItems 1
       */
      namespaces?: [string, ...string[]];
    };
  }[];
  max_auto_executions_per_hour?: number;
  /**
   * SreNautix 自己的依赖集合（DESIGN §9.1 自我保护）。目标落在其中时一律按 irreversible 加 H 档处理，并且不自动执行。gateway 所在节点自动计入。
   */
  self_dependencies?: {
    namespaces?: string[];
    nodes?: string[];
    pg_clusters?: {
      namespace: string;
      name: string;
    }[];
  };
  /**
   * 审批人的作用域（DESIGN §13 approver 角色）。gateway 按目标所在的命名空间核对。
   */
  approvers: {
    principal: string;
    /**
     * "*" 表示全部命名空间（含集群级目标）。
     *
     * @minItems 1
     */
    namespaces: [string, ...string[]];
    max_tier: 'L' | 'H';
  }[];
  /**
   * workflow_submit 的模板白名单：名称、sha256(JCS(WorkflowTemplate.spec)) 与 ServiceAccount 都必须一致。
   */
  workflow_templates?: {
    namespace: string;
    name: string;
    sha256: string;
    service_account: string;
    /**
     * 参数名到约束；提交的参数必须恰好是这些名称。
     */
    parameters: {
      [k: string]:
        | {
            /**
             * @minItems 1
             */
            enum?: [string, ...string[]];
            pattern?: string;
            max_length?: number;
          }
        | undefined;
    };
  }[];
  /**
   * gitops_pr 的仓库、路径白名单与补偿控制（ADR 0025）。
   */
  gitops?: {
    /**
     * 每个仓库每小时最多开出的 PR 数（按进入 executing 的时间计），超出的工单以 gitops_rate_limited 拒绝。默认 2。
     */
    max_prs_per_hour?: number;
    /**
     * 定期检查 base 分支上的提交：由机器人身份直接写入、或由机器人合并的提交为非人工提交，回看窗口内存在时条件 GitMainWatchdog 为 False，gitops_pr 停止推送。
     */
    main_watchdog?: {
      /**
       * 检查间隔，Go duration，1s 到 1h，默认 5m。
       */
      interval?: string;
      /**
       * 回看窗口，Go duration，1h 到 168h，默认 24h。
       */
      lookback?: string;
      /**
       * 允许直接写入 base 的机器人账号（例如 renovate[bot]）；gateway 自己的 App 不能列在这里。
       */
      allowed_bots?: string[];
    };
    repositories: {
      repository: string;
      base: string;
      /**
       * 允许修改的路径：以 / 结尾的目录前缀、完整路径，或含 * ? [ 的模式（path.Match 语义，* 不跨越 /）。
       *
       * @minItems 1
       */
      paths: [string, ...string[]];
      /**
       * 开出 PR 后请求审阅的 GitHub 账号；工单参数中的 reviewers 必须是它的子集。
       *
       * @maxItems 10
       */
      reviewers?: string[];
      /**
       * base 分支没有分支保护时，经批准以补偿控制代替（不变量 12，ADR 0025）：只推送 srenautix/ 分支并在推送前后核对 base、从不合并、每次推送与开 PR 写入审计链、按小时限速、main watchdog。这一项记录批准人与依据，没有它时 base 必须有分支保护。
       */
      compensating_controls?: {
        approved_by: string;
        approved_at: string;
        /**
         * 批准的出处（issue、章程、ADR 链接）。
         */
        reference: string;
      };
    }[];
  };
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
  /**
   * 变更之前的版本（版本标签的旧取值）；与更早一次变更的 revision 相同时，这次变更是回退。来源不知道旧版本时省略或为 null
   */
  previous_revision?: string | null;
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
  /**
   * 推导出的变更挂上的前置对象及推导依据（ADR 0104 §13），例如发布之前的迁移 Job。basis：managed_by（与发布由同一个应用管理：managed_by 边或 Argo 的 instance 标签）、revision_label（配置的版本标签取值与发布的相同，例如 cchp.io/release-id）、image（Pod 镜像与发布新 ReplicaSet 的镜像相同）、namespace_window（只按同一命名空间与时间窗推断，是弱推导）
   */
  attachments?: {
    target: ComponentKey;
    basis: 'managed_by' | 'revision_label' | 'image' | 'namespace_window';
  }[];
}
export interface DbstatsStatementsTopRequest {
  op: 'statements.top';
  args: {
    order_by:
      | 'total_exec_time'
      | 'mean_exec_time'
      | 'calls'
      | 'rows'
      | 'shared_blks_read'
      | 'temp_blks_written'
      | 'blk_read_time'
      | 'wal_bytes';
    limit: number;
    /**
     * 按库名过滤（pg_database.datname）；null 或不填时不过滤
     */
    database?: string | null;
    /**
     * 只取这些 queryid（十进制字符串）；不填时按 order_by 取前 limit 条
     *
     * @maxItems 50
     */
    queryids?: DbstatsQueryId[];
  };
}
export interface DbstatsStatementsTextRequest {
  op: 'statements.text';
  args: {
    /**
     * @minItems 1
     * @maxItems 10
     */
    queryids: [DbstatsQueryId, ...DbstatsQueryId[]];
  };
}
export interface DbstatsTablesTopRequest {
  op: 'tables.top';
  args: {
    order_by: 'seq_scan' | 'seq_tup_read' | 'idx_scan' | 'n_dead_tup' | 'n_live_tup' | 'heap_blks_read' | 'writes';
    limit: number;
  };
}
export interface DbstatsIndexesUsageRequest {
  op: 'indexes.usage';
  args: {
    /**
     * <schema>.<表名>；Timescale hypertable 的名字包含它的全部分块；null 或不填时为全部表
     */
    table?: string | null;
    limit: number;
  };
}
export interface DbstatsSettingsGetRequest {
  op: 'settings.get';
  args: {
    /**
     * @minItems 1
     * @maxItems 50
     */
    names: [string, ...string[]];
  };
}
export interface DbstatsActivitySummaryRequest {
  op: 'activity.summary';
  args: {};
}
export interface DbstatsLocksSummaryRequest {
  op: 'locks.summary';
  args: {};
}
/**
 * 一次读取的结果。rows 的结构由 op 决定（StatementRow、StatementText、TableRow、IndexRow、SettingRow、ActivityRow、LockRow）；累计计数器原样返回，速率由两次采样的差值计算
 */
export interface DbstatsSample {
  op: DbstatsOperation;
  sampled_at: Timestamp;
  /**
   * server_version_num 的取值，例如 170002
   */
  server_version: string;
  /**
   * @maxItems 50
   */
  rows: {
    [k: string]: string | number | boolean | null | undefined;
  }[];
  /**
   * 结果被 limit 截断
   */
  truncated: boolean;
}
/**
 * statements.top 的一行（pg_stat_statements(showtext := false)）。时间单位为毫秒；计数器是累计值
 */
export interface DbstatsStatementRow {
  queryid: DbstatsQueryId;
  database: string;
  role: string;
  toplevel: boolean;
  calls: number;
  total_exec_time_ms: number;
  mean_exec_time_ms: number;
  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
  temp_blks_written: number;
  blk_read_time_ms: number;
  wal_bytes: number;
}
/**
 * statements.text 的一行：语句经 libpg-query 重新规范化（常量换成 $n）并去掉注释，不超过 4 KiB；fingerprint 是 libpg-query 对规范化语句计算的指纹（十六进制），PG 升级后 queryid 变化时不变。无法解析的语句 text 为 null，normalize_error 写明原因
 */
export interface DbstatsStatementText {
  queryid: DbstatsQueryId;
  text: string | null;
  fingerprint: string | null;
  truncated: boolean;
  normalize_error: string | null;
}
/**
 * tables.top 的一行（pg_stat_user_tables 与 pg_statio_user_tables）。Timescale 分块按 hypertable 汇总，chunks 为分块数；普通表 chunks 为 0
 */
export interface DbstatsTableRow {
  schema: string;
  table: string;
  hypertable: boolean;
  chunks: number;
  seq_scan: number;
  seq_tup_read: number;
  idx_scan: number;
  idx_tup_fetch: number;
  n_tup_ins: number;
  n_tup_upd: number;
  n_tup_del: number;
  n_tup_hot_upd: number;
  n_live_tup: number;
  n_dead_tup: number;
  heap_blks_read: number;
  heap_blks_hit: number;
  idx_blks_read: number;
  idx_blks_hit: number;
  last_autovacuum: null | Timestamp;
  last_autoanalyze: null | Timestamp;
}
/**
 * indexes.usage 的一行（pg_stat_user_indexes、pg_index 与 pg_relation_size）。Timescale 分块上的索引按 hypertable 与索引名汇总
 */
export interface DbstatsIndexRow {
  schema: string;
  table: string;
  index: string;
  idx_scan: number;
  idx_tup_read: number;
  idx_tup_fetch: number;
  size_bytes: number;
  unique: boolean;
  primary: boolean;
}
/**
 * settings.get 的一行（pg_settings）。不存在的参数不返回
 */
export interface DbstatsSettingRow {
  name: string;
  setting: string;
  unit: string | null;
  vartype: 'bool' | 'enum' | 'integer' | 'real' | 'string';
  /**
   * 修改需要的条件；postmaster 需要重启
   */
  context: 'internal' | 'postmaster' | 'sighup' | 'superuser-backend' | 'backend' | 'superuser' | 'user';
  source: string;
  min_val: string | null;
  max_val: string | null;
  pending_restart: boolean;
}
/**
 * activity.summary 的一行：按状态与等待事件计数的客户端会话（pg_stat_activity，backend_type 为 client backend），不含语句文本与应用名。另有一行 state 为 max_connections，count 为参数取值
 */
export interface DbstatsActivityRow {
  state: string;
  wait_event_type: string | null;
  wait_event: string | null;
  count: number;
}
/**
 * locks.summary 的一行：按锁类型、模式与是否授予计数（pg_locks），不含对象名与进程
 */
export interface DbstatsLockRow {
  locktype: string;
  mode: string;
  granted: boolean;
  count: number;
}
/**
 * 权限自检（启动时与每小时一次）：角色能读取任何业务表（has_table_privilege SELECT 或 has_any_column_privilege SELECT，系统 schema 之外）时 ok 为 false，集成降级为不可用并发布状态条件 DatasourceOverPrivileged。missing 为缺少的 pg_read_all_stats、pg_read_all_settings 成员关系与 pg_stat_statements 扩展
 */
export interface DbstatsPrivilegeReport {
  ok: boolean;
  role: string;
  /**
   * 能读取的业务表 <schema>.<表名>，最多列出 20 个
   *
   * @maxItems 20
   */
  readable_tables: string[];
  missing: string[];
  /**
   * default_transaction_read_only 为 on
   */
  read_only: boolean;
  checked_at: Timestamp;
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
 * 渠道无关的消息，渠道适配器负责转义和渲染。各段依次为现状、业务关键信号（有异常或接近阈值的信号时）、关键问题、拓扑联系、解决方案、证据链；带 runs 的块是富文本，渠道按自己的格式渲染（Telegram HTML、飞书卡片 markdown、GitHub Markdown），没有 runs 时按 text 渲染
 */
export interface NotifyMessage {
  /**
   * incident 事件消息；goal 主动优化的目标消息（契约 2.28.0）：incident_id 为目标 id，incident_version 为目标的 revision，五段依次为现状（目标与基线）、关键问题（发现与档位）、拓扑联系、解决方案（建议、预期收益、验证）、证据链。不填时为 incident
   */
  kind?: 'incident' | 'goal';
  incident_id: Uuid;
  incident_version: number;
  /**
   * 部署配置的消息前缀，例如影子部署的标记
   */
  prefix: string;
  severity: Severity;
  title: string;
  /**
   * 一句话现状（严重度、根因组件、症状、状态），渠道放在最上面并加粗
   */
  headline?: NotifyRun[];
  sections: NotifySection[];
  buttons: NotifyButton[];
  /**
   * 降级横幅，例如状态库降级、模型研判中、模型输出无效
   */
  banner: string | null;
}
/**
 * 富文本片段。text 是原文，渠道负责转义；code 用于数值与对象名；italic 用于模型生成的文字；href 是链接（只允许 http 与 https）
 */
export interface NotifyRun {
  text: string;
  style: 'plain' | 'bold' | 'code' | 'italic';
  href: string | null;
}
export interface NotifySection {
  /**
   * situation 现状；signals 业务关键信号（存储、内存、CPU、流量负载、阻塞中异常或接近阈值的卡，在现状之后、关键问题之前）；key_issue 关键问题（结论、结论档位的依据、假设）；topology 拓扑联系；remedy 解决方案；evidence 证据链；root_cause 是旧的四段结构中的问题根源
   */
  kind: 'situation' | 'signals' | 'key_issue' | 'topology' | 'remedy' | 'evidence' | 'root_cause';
  /**
   * 段标题；没有时渠道按 kind 取固定文案
   */
  title?: string;
  /**
   * 聊天渠道折叠显示（Telegram 可展开引用块、飞书折叠面板）
   */
  folded?: boolean;
  /**
   * 超长时的省略顺序：数字越小越先省略；0 不省略
   */
  priority?: number;
  /**
   * 整段被省略时显示的一行
   */
  omitted?: string;
  blocks: NotifyBlock[];
}
/**
 * text 是 SreNautix 渲染的模板文本（runs 的纯文本形式）；quote 是引用的不可信原文，source 注明来源；model_generated=true 的块标注模型生成
 */
export interface NotifyBlock {
  type: 'text' | 'quote' | 'list_item' | 'heading' | 'table';
  text: string;
  source: string | null;
  model_generated: boolean;
  /**
   * 富文本：按顺序拼接的文本片段
   */
  runs?: NotifyRun[];
  /**
   * all：所有渠道；summary：只在聊天渠道（摘要）；full：只在完整报告（issue）
   */
  scope?: 'all' | 'summary' | 'full';
  indent?: number;
  /**
   * type 为 table 时的表格：表头与每行每格的富文本
   */
  table?: {
    head: string[];
    rows: NotifyRun[][][];
  };
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
 * 主动优化 conclude 步骤的模型输出（ADR 0146 §2.3）：为每个发现选出一个假设并写说明。档位由代码按优化结论阶梯（§2.4）计算，不由模型输出；模型弃权时按 ADR 0120 由代码代选。遵守可移植 schema 子集（DESIGN §8.2）
 */
export interface OptimizeConcludeOutput {
  /**
   * @maxItems 3
   */
  findings: {
    finding: string;
    /**
     * 选中的假设（必须是这个发现上的）；为 null 时 undetermined_reason 必须非空
     */
    hypothesis_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'h7' | 'h8' | 'h9' | null;
    /**
     * 选择这个假设的说明与建议的补充，显示时标注【模型】
     */
    note: string | null;
    undetermined_reason: string | null;
  }[];
  /**
   * 一到两句：本次分析的结论与第一步该做什么
   */
  summary: string;
}
/**
 * 主动优化 hypothesize 步骤的模型输出（ADR 0146 §2.3）。为每个候选发现提出机制假设，机制点明预示的症状；同一发现上的假设互为竞争假设。遵守可移植 schema 子集（DESIGN §8.2）。x-srenautix-dynamic-enum 标出的字段在每次运行时由 worker 替换为本次运行中存在的取值：发现只能是进入分析的候选，检查只能是本次运行的查询模板与只读工具，模型不写任何查询语句
 */
export interface OptimizeHypothesizeOutput {
  /**
   * 按发现分组的假设，用 parent_id 表示同一发现上的细化
   *
   * @minItems 1
   * @maxItems 9
   */
  hypotheses: [
    {
      id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'h7' | 'h8' | 'h9';
      parent_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'h7' | 'h8' | 'h9' | null;
      /**
       * 假设解释的候选发现（发现指纹）
       */
      finding: string;
      mechanism: string;
      /**
       * 机制预示的症状类型
       *
       * @maxItems 4
       */
      symptoms: (
        | 'seq_scan'
        | 'index'
        | 'temp_spill'
        | 'lock_wait'
        | 'io_read'
        | 'connection_pool'
        | 'cache_miss'
        | 'polling'
        | 'n_plus_one'
        | 'payload_size'
        | 'overprovision'
        | 'cpu'
        | 'memory'
        | 'connections'
        | 'storage'
        | 'network'
        | 'service'
      )[];
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
      id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'h7' | 'h8' | 'h9';
      parent_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'h7' | 'h8' | 'h9' | null;
      /**
       * 假设解释的候选发现（发现指纹）
       */
      finding: string;
      mechanism: string;
      /**
       * 机制预示的症状类型
       *
       * @maxItems 4
       */
      symptoms: (
        | 'seq_scan'
        | 'index'
        | 'temp_spill'
        | 'lock_wait'
        | 'io_read'
        | 'connection_pool'
        | 'cache_miss'
        | 'polling'
        | 'n_plus_one'
        | 'payload_size'
        | 'overprovision'
        | 'cpu'
        | 'memory'
        | 'connections'
        | 'storage'
        | 'network'
        | 'service'
      )[];
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
   * 为待检验的假设各给出一项区分性检查，由控制器执行；只能选本次运行的查询模板或只读工具，参数按其 schema 校验
   *
   * @maxItems 6
   */
  next_checks: {
    hypothesis_id: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'h7' | 'h8' | 'h9';
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
  title?: LocalizedText;
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
   * 与告警条件对应的主卡：<chain id>/<card id>（本包）或 <pack>/<chain id>/<card id>。告警触发时主卡应当判为异常；评测按它统计证据卡与告警结论的一致率
   */
  primary_card?: string;
  /**
   * 来源 mixin，用于覆盖率统计
   */
  mixin?: 'kubernetes' | 'node' | 'etcd' | 'prometheus' | 'alertmanager' | 'kube-state-metrics' | 'other';
}
/**
 * 告警的可读标题（症状短语），例如“worker 没有可用副本”；通知的标题与问题陈述用它代替告警名
 */
export interface LocalizedText {
  'zh-CN'?: string;
  en?: string;
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
   * 接入来源。reconcile 表示由 60 秒对账从 Alertmanager API 或 ALERTS 重建；detector 表示集群状态检测器在没有告警规则时合成的告警（ADR 0105）
   */
  source: 'alertmanager' | 'grafana' | 'nightingale' | 'generic' | 'reconcile' | 'detector';
  /**
   * 去掉 alertstate、alertgroup、__name__ 之后按键排序，依次写入 key、0xff、value、0xff 的 UTF-8 字节，取 FNV-1a 64 位哈希，16 位小写十六进制；空标签集为 cbf29ce484222325
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
/**
 * 研判、提议、出境清单与消息的主体（契约 2.28.0，ADR 0146 §8）：incident 事件；goal 主动优化的目标。没有 subject 的旧数据都是事件。主体为 goal 时沿用的事件字段语义为：incident_id 取目标 id，incident_version 取目标的 revision
 */
export interface Subject {
  type: 'incident' | 'goal';
  id: Uuid;
}
/**
 * 组件键 → 可读名称（领域包 ComponentType.display_name 求出，ADR 0101）。只用于显示；没有名称的组件不在其中，显示组件键
 */
export interface CommonComponentNames {
  [k: string]: string | undefined;
}
export interface Error {
  /**
   * 机器可读的错误码
   */
  error: string;
  message: string;
}
/**
 * 各角色上报的状态条件里哪个取值表示正常（数据在 contract/conditions.json）。server 把分支心跳的条件换算成状态条的 Condition（status true 表示问题正在发生），chart 的自身告警与看板按同一张表判断异常；新增的条件类型按所在角色的 healthy 处理
 */
export interface ConditionDirections {
  $schema?: string;
  roles: {
    [k: string]: ConditionDirectionsRole | undefined;
  };
}
export interface ConditionDirectionsRole {
  /**
   * condition：角色自己写 Condition（status 为 true/false，true 表示问题）；gateway_heartbeat、reader_heartbeat：分支心跳的条件（status 为 True/False/Unknown，见 gateway/v1 的 Condition 与 ReaderCondition）。指标 srenautix_condition 与 srenautix_reader_condition 的取值为 1 当且仅当 status 为 true 或 True
   */
  source: 'condition' | 'gateway_heartbeat' | 'reader_heartbeat';
  /**
   * 该角色的条件正常时的取值；取值不同（包括 Unknown）即为异常
   */
  healthy: 'true' | 'false' | 'True' | 'False';
  types: {
    [k: string]: ConditionDirectionsType | undefined;
  };
}
export interface ConditionDirectionsType {
  /**
   * 与角色默认方向不同的类型
   */
  healthy?: 'true' | 'false' | 'True' | 'False';
  /**
   * false：异常取值是预期的运行模式（例如冻结），状态条照常显示，自身告警不告警
   */
  alert?: boolean;
  /**
   * gateway 心跳条件在状态条上的类型（Condition.type）；null 表示不转发到状态条。reader 的条件以原类型转发
   */
  strip_type?: string | null;
}
/**
 * 带类型的状态条件（DESIGN §12.4），驱动每个页面顶部的状态条。每个判定都附带影响它的条件
 */
export interface Condition {
  /**
   * server、worker 等角色的条件；InformersFresh、TunnelConnected、QueryManifest、Datasource、AlertReconcile 由分支 reader 的心跳转来（role 为 reader，见 gateway/v1/reader.openapi.yaml 的 ReaderCondition），ClockSkew 两边都有。控制台必须容忍以后新增的类型
   */
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
    | 'StormMode'
    | 'InformersFresh'
    | 'TunnelConnected'
    | 'QueryManifest'
    | 'Datasource'
    | 'AlertReconcile';
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
 * 一个回放评测用例（DESIGN §14.1）：标准答案、防泄漏所需的标识与时间、对应的快照。用例只追加；修改标准答案时新建版本，旧版本保留以便复现历史成绩
 */
export interface EvalCase {
  /**
   * 用例集内唯一，例如 incident:<incident_id>、benign:<label>、abstain:<基础用例>、scenario:<名称>
   */
  case_id: string;
  /**
   * 标准答案的版本；同一 case_id 以最大版本为准
   */
  version: number;
  /**
   * 用例集，例如 reference、scenarios-kind、benign
   */
  suite: string;
  /**
   * incident：真实事件；feedback：来自已绑定账号且给出根因的反馈；benign：被人工忽略或平静时段注入的告警；abstain：去掉根因异常卡后的反事实快照；scenario：Kind 上注入的级联故障；optimization：主动优化的目标运行（契约 2.28.0，ADR 0146 §7），incident_id 为 null，标准答案在 truth.optimization
   */
  type: 'incident' | 'feedback' | 'benign' | 'abstain' | 'scenario' | 'optimization';
  cluster_id: ClusterId;
  /**
   * 用例对应的事件；从外部导入、还没有事件身份时为 null
   */
  incident_id: null | Uuid;
  /**
   * 事件的稳定标签或导入时的原始键，只用于展示
   */
  label: string;
  started_at: Timestamp2;
  as_of: Timestamp3;
  truth: EvalTruth;
  truth_source: {
    /**
     * human：人工标注；feedback：已绑定账号的反馈；knowledge：事故复盘（经人工确认）；injected：场景注入的根因；imported：从外部种子导入的标准答案
     */
    kind: 'human' | 'feedback' | 'knowledge' | 'injected' | 'imported';
    principal: string | null;
    /**
     * 反馈 id、复盘条目 id 或导入来源的记录引用
     */
    ref: string | null;
  };
  leakage: EvalLeakage;
  /**
   * 领域包（知识、证据链、runbook）早于事件还是晚于事件；分两组报告
   */
  pack_timing: 'pack_before_incident' | 'pack_after_incident';
  /**
   * snapshot 模式的快照；只能用 reconstructed 模式回放时为 null
   */
  snapshot_id: null | Uuid;
  /**
   * abstain 用例：基础用例与被去掉的卡
   */
  derived_from: {
    case_id: string;
    removed_cards: string[];
  } | null;
  /**
   * scenario 用例的作者类型：maintainer 由维护者编写（存在作者偏差，单独报告）；external 外部贡献
   */
  authored_by: 'maintainer' | 'external' | null;
  created_at: Timestamp;
}
export interface EvalTruth {
  /**
   * 根因集合：落在集合内即为命中。benign 与 abstain 为空
   */
  root_components: ComponentKey[];
  granularity: null | EvalGranularity;
  mechanism: string | null;
  /**
   * 正确的处置判断；benign 为 ignore，abstain 为 undetermined
   */
  disposition: null | Disposition;
  /**
   * benign 与 abstain 用例为 true：出现 evidence_consistent 即为误报
   */
  forbid_evidence_consistent: boolean;
  optimization?: EvalOptimizationTruth;
}
/**
 * optimization 用例的标准答案（ADR 0146 §7）。root_components 为期望发现挂到的组件，disposition 为 null；良性用例 benign 为 true，findings、templates、locations 为空，任何建议都算误报
 */
export interface EvalOptimizationTruth {
  goal: GoalSpec;
  benign: boolean;
  /**
   * 期望的发现：类型与实体键（召回@3 与精确率）
   */
  findings: {
    kind: string;
    entity: EntityKey;
  }[];
  /**
   * 可接受的模板 <pack>/<id>
   */
  templates: string[];
  /**
   * 期望的代码位置（文件命中@3 与函数命中@1）
   */
  locations: {
    path: string;
    /**
     * 函数或方法名（带接收者时写 Receiver.Method）
     */
    symbol: string | null;
  }[];
  /**
   * 已知的实际收益（指标单位，按改善方向取正值），用于预期收益的校准
   */
  known_gain: number | null;
}
export interface GoalSpec {
  origin: GoalOrigin;
  subject: GoalSubject;
  /**
   * 目标值；领域体检没有目标值时为 null，差距按领域的门槛（DomainGates.thresholds）
   */
  objective: null | GoalObjective;
  /**
   * 允许的建议类别
   *
   * @minItems 1
   */
  outputs: [RecommendationKind, ...RecommendationKind[]];
  budget: GoalBudget;
}
export interface GoalOriginManual {
  kind: 'manual';
  channel: 'console' | 'telegram' | 'api';
  /**
   * 下达目标的主体 id；api 为调用方 id
   */
  principal: string;
}
export interface GoalOriginCheckup {
  kind: 'checkup';
  domain: DomainId;
  schedule_id: string;
}
export interface GoalOriginTrend {
  kind: 'trend';
  /**
   * <包>/<领域>/<趋势 id>
   */
  trend: string;
  entity: EntityKey;
}
export interface GoalOriginForecastAlert {
  kind: 'forecast_alert';
  alert_fingerprint: string;
}
export interface GoalSubjectIndicator {
  type: 'indicator';
  indicator: IndicatorRef;
  /**
   * 按指标的 params schema 校验
   */
  params: {
    [k: string]: number | string | boolean | undefined;
  };
  scope: GoalScope;
}
/**
 * 范围白名单：组件键与命名空间；两者都为空表示不限
 */
export interface GoalScope {
  /**
   * @maxItems 50
   */
  components: ComponentKey[];
  /**
   * @maxItems 50
   */
  namespaces: string[];
}
export interface GoalSubjectDomain {
  type: 'domain';
  domain: DomainId;
  scope: GoalScope;
}
export interface GoalObjective {
  comparator: Comparator;
  target: number;
  unit: IndicatorUnit;
  statistic: IndicatorStatistic;
  window: Duration1;
}
/**
 * 一次运行的预算（ADR 0146 §1.2 的默认值）
 */
export interface GoalBudget {
  tokens: number;
  duration_seconds: number;
  checks: number;
  dbstats_queries: number;
  traces_queries: number;
  logs_queries: number;
  code_files: number;
  code_bytes: number;
  github_requests: number;
}
/**
 * 防泄漏（DESIGN §14.3）：回放时从检索与上下文中排除的材料
 */
export interface EvalLeakage {
  /**
   * 该事件自己与别名，以及同一根因的历史结论所在的事件
   */
  exclude_incident_ids: Uuid[];
  /**
   * 该事件自己的事故报告、反馈与复盘条目的引用
   */
  exclude_refs: string[];
  /**
   * 领域包知识、证据链、runbook 的 learned_from 中代表这个用例的取值（incident_id、标签、外部引用）；回放时排除来自该用例的部分
   */
  learned_from_keys: string[];
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
  recall_at_3: EvalRatio1;
  pass_at_1: EvalRatio2;
  pass_pow_k: EvalRatio3;
  run_agreement: EvalRatio4;
  coverage: EvalRatio5;
  selective_accuracy: EvalRatio6;
  disposition_accuracy: EvalRatio7;
  /**
   * 可靠性表：结论阶梯每一档的精确率（DESIGN §14.4）；evidence_consistent 的精确率下界低于 0.85 时该档自动降级
   */
  reliability: {
    level: ConclusionLevel;
    precision: EvalRatio7;
    demoted: boolean;
  }[];
  /**
   * 评测期间观察到的服务方指纹；与路由当前指纹不同的成绩作废
   */
  provider_fingerprints: string[];
  benign_false_positive: EvalRatio7;
  undetermined_ratio: EvalRatio7;
  structured_output_failure: EvalRatio7;
  cost_per_case: {
    currency: string;
    mean: number;
    p90: number;
  };
  snapshot_miss_rate: number | null;
  by_granularity: {
    [k: string]: EvalRatio7 | undefined;
  };
}
/**
 * top-1 落在根因集合内的运行占比（分母为有根因的用例的全部运行）
 */
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
/**
 * 前 3 个候选覆盖根因集合的运行占比
 */
export interface EvalRatio1 {
  numerator: number;
  denominator: number;
  value: number | null;
  /**
   * 聚类自助法 90% 置信区间下界
   */
  ci_low: number | null;
  ci_high: number | null;
}
/**
 * 每个用例第一次运行命中的占比
 */
export interface EvalRatio2 {
  numerator: number;
  denominator: number;
  value: number | null;
  /**
   * 聚类自助法 90% 置信区间下界
   */
  ci_low: number | null;
  ci_high: number | null;
}
/**
 * k 次运行全部命中的用例占比（k 为 runs_per_case）
 */
export interface EvalRatio3 {
  numerator: number;
  denominator: number;
  value: number | null;
  /**
   * 聚类自助法 90% 置信区间下界
   */
  ci_low: number | null;
  ci_high: number | null;
}
/**
 * 同一用例的多次运行给出相同根因与相同处置判断的用例占比
 */
export interface EvalRatio4 {
  numerator: number;
  denominator: number;
  value: number | null;
  /**
   * 聚类自助法 90% 置信区间下界
   */
  ci_low: number | null;
  ci_high: number | null;
}
/**
 * 没有弃权（结论不是 undetermined 或 inconclusive）的运行占比
 */
export interface EvalRatio5 {
  numerator: number;
  denominator: number;
  value: number | null;
  /**
   * 聚类自助法 90% 置信区间下界
   */
  ci_low: number | null;
  ci_high: number | null;
}
/**
 * 不弃权的运行中 top-1 命中的占比
 */
export interface EvalRatio6 {
  numerator: number;
  denominator: number;
  value: number | null;
  /**
   * 聚类自助法 90% 置信区间下界
   */
  ci_low: number | null;
  ci_high: number | null;
}
export interface EvalRatio7 {
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
  /**
   * 两份报告共有的用例数 n
   */
  paired_cases: number;
  /**
   * 基线 pass^k 通过、候选不通过的用例；不在 waived_cases 中的任何一条都使门禁失败
   */
  regressed_cases: string[];
  waived_cases: string[];
  /**
   * 新减旧的 top-1 差值（按用例配对）
   */
  paired_delta: number;
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
/**
 * 用例的查询邻域快照（DESIGN §14.2 snapshot 模式）：用例被提升时固化研判所需的全部输入与两跳以内组件的数据源调用结果。回放只从快照读取（VCR）；快照中没有的调用返回不可用并计入未命中率。日常研判不录制快照
 */
export interface EvalSnapshot {
  snapshot_id: Uuid;
  case_id: string;
  format_version: 1;
  window: TimeWindow1;
  as_of: Timestamp;
  context: EvalSnapshotContext;
  queries: QuerySnapshot;
  created_at: Timestamp;
  source: {
    /**
     * promoted：控制台或 API 提升用例时固化；imported：从外部种子导入；scenario：场景运行后固化；reconstructed：评测时从保留期内的数据重建（阶段 A 与研判输入按当前代码重新生成）
     */
    kind: 'promoted' | 'imported' | 'scenario' | 'reconstructed';
    /**
     * 导入来源（格式名、版本、文件与记录）
     */
    ref: string | null;
    code_sha: string | null;
    pack_lock: null | Sha256;
  };
}
/**
 * 快照窗口：工具与查询模板只能查询这个窗口内的数据
 */
export interface TimeWindow1 {
  from: Timestamp;
  to: Timestamp;
}
/**
 * 阶段 B 的输入（与 worker 从中心读取的研判上下文同形）。卡片判定、拓扑与动作目录都是固化时的结果
 */
export interface EvalSnapshotContext {
  incident: Incident;
  stage_a: StageAReport;
  /**
   * 根因两跳内的拓扑（与 OpenAPI 的 Subgraph 同形）
   */
  subgraph: {
    topology_version: number;
    root: null | ComponentKey;
    nodes: {
      component: ComponentKey;
      kind: string;
      namespace: string | null;
      name: string;
      role: 'root' | 'candidate' | 'member' | 'neighbor';
      alerts: string[];
      hops: number;
    }[];
    edges: {
      from: ComponentKey;
      to: ComponentKey;
      relation: string;
      provenance: EdgeProvenance;
      confidence: number;
      scope: 'instance' | 'service';
    }[];
  };
  alerts: Alert[];
  /**
   * 固化时本集群启用、可用于这个事件的动作
   */
  actions: ActionCatalogAction[];
  runbooks: string[];
  /**
   * 可检索的知识条目（带 learned_from，回放时按用例排除）
   */
  knowledge: EvalKnowledge[];
  /**
   * 可检索的参考案例（回放时只取 resolved_at 早于用例开始时间的）
   */
  cases: EvalReferenceCase[];
  /**
   * 区分性检查可用的查询模板
   */
  templates: {
    id: string;
    description: string;
    args: {};
  }[];
  disposition_facts?: EvalDispositionFacts;
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
  component_names?: CommonComponentNames1;
  research_root?: ResearchRoot;
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
   * alert：有指向它的 cause/change 告警；change：有触及它的变更；hub：没有告警的集群枢纽，至少 3 个独立依赖方同时出现告警；probe：沉默根因探测卡异常；symptom：只有症状告警
   */
  source: 'alert' | 'change' | 'hub' | 'probe' | 'symptom';
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
 * 组件键 → 可读名称（领域包 ComponentType.display_name 求出，ADR 0101）。只用于显示；没有名称的组件不在其中，显示组件键
 */
export interface CommonComponentNames1 {
  [k: string]: string | undefined;
}
/**
 * 最近一次完成的研判给出的根因，读取时由中心附上（ADR 0104 §14）；没有给出根因的研判、事件流与旧版本的事件没有这个字段
 */
export interface ResearchRoot {
  run_id: Uuid;
  component: ComponentKey;
  /**
   * 研判根因与事件根因按属主粒度比较不一致（Pod 与它所属的 Deployment 算一致）。只标记，事件不拆分，分组与根因不变
   */
  mismatch: boolean;
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
  evidence_fingerprint: Sha2561;
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
 * 一张证据卡在一次研判（或阶段 A 报告）中的结果（DESIGN §6.1）。三种结论之外另有显示状态 capability_missing：所需的数据源能力不可用，和没有数据区分开
 */
export interface EvidenceResult {
  ref: EvidenceRef;
  /**
   * <pack>/<chain>/<card>；区分性检查产生的卡为 check/<hypothesis id>/<n>
   */
  card_id: string;
  title: LocalizedText1;
  /**
   * 展示用阈值线
   */
  threshold: number | null;
  /**
   * 每个查询引用的降采样序列（每条不超过 300 点），用于迷你图与实时重跑的并排对比。points 中每项为 [unix 秒, 值或 null]
   */
  series: {
    /**
     * 卡片中的引用名
     */
    ref: string;
    labels: Labels;
    /**
     * @maxItems 300
     */
    points: [number, number | null][];
  }[];
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
  /**
   * 主值、阈值与基线的单位（卡片 display.unit）；没有时为 none
   */
  unit?: 'none' | 'percent' | 'ratio' | 'bytes' | 'seconds' | 'count' | 'per_second';
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
  /**
   * 判定时 let 绑定的标量取值（数值、字符串、布尔），按定义顺序最多 16 个；绑定不可用时为 null。通知与控制台用它展示正常卡的实测值
   */
  observations?: {
    [k: string]: number | string | boolean | null | undefined;
  };
  /**
   * 本次判定生效的 params（卡片默认值与覆盖值合并后），即判定条件里的阈值
   */
  params?: {
    [k: string]: number | string | boolean | undefined;
  };
  /**
   * 求值过的判定条件，按求值顺序：undeterminable_if 全部条件，abnormal_if 到第一条命中为止
   */
  conditions?: EvidenceCondition[];
  /**
   * 对比基线（卡片 display.baseline 的取值）；卡片没有基线或基线不可用时为 null
   */
  baseline?: number | null;
  /**
   * 卡片标为影响类（impact: true），异常时它的值进入通知的影响范围
   */
  impact?: boolean;
  /**
   * 卡片定义的业务关键信号类别（EvidenceCardDefinition.category）；没有时为 null，通知按证据链名推断（ADR 0148）
   */
  category?: 'storage' | 'memory' | 'cpu' | 'traffic' | 'blocking' | null;
  /**
   * 主值（display.value）格式化之前的数值，与 threshold 同单位；没有主值或不是有限数时为 null。通知用它判断正常卡是否接近阈值
   */
  value_number?: number | null;
}
/**
 * 取自卡片定义，结果脱离定义也能展示
 */
export interface LocalizedText1 {
  'zh-CN'?: string;
  en?: string;
}
export interface EvidenceReason {
  /**
   * rule：命中判定规则；no_data：查询没有样本；partial_data：部分查询没有样本；source_error：数据源报错或超时；capability_missing：所需能力不可用；observability_gap：依赖的目标有 meta 告警；evaluation_error：CEL 求值出错；all_clear：没有命中任何规则；model_judged：只读工具的结果没有 CEL 判定，由小模型对照 refutes_if 判定（可以支持 likely，不能单独支撑 evidence_consistent，展示时标注模型判定）
   */
  kind:
    | 'rule'
    | 'no_data'
    | 'partial_data'
    | 'source_error'
    | 'capability_missing'
    | 'observability_gap'
    | 'evaluation_error'
    | 'all_clear'
    | 'model_judged';
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
export interface EvidenceCondition {
  kind: 'undeterminable' | 'abnormal';
  /**
   * 条件的 CEL 表达式
   */
  cel: string;
  /**
   * hit：命中；miss：求值为 false；unavailable：依赖的引用或绑定没有数据，没有求值
   */
  outcome: 'hit' | 'miss' | 'unavailable';
  /**
   * 命中时为条件的 say；没有命中时为条件的 normal_say（卡片提供时），否则为 null
   */
  say: string | null;
}
export interface EvalKnowledge {
  id: string;
  components: string[];
  text: string;
  learned_from: string[];
  learned_at: null | Timestamp;
  source: 'human' | 'model';
}
export interface EvalReferenceCase {
  incident_id: string;
  label: string;
  root_component: ComponentKey;
  mechanism: string | null;
  resolved_at: Timestamp;
  source: 'human' | 'model';
}
/**
 * 处置推导的确定性依据（ADR 0138），与 server 写进研判输入的相同；旧快照没有这个字段
 */
export interface EvalDispositionFacts {
  /**
   * 子图中组件类型声明为集群外部（external）的组件
   */
  external: ComponentKey[];
  /**
   * 候选根因 → 适用的修复模板（release_rollback、config_resource 两类中启用的类别），按研判以它为根因、处置为 act 求值；没有适用模板的根因不列出
   */
  remediations: {
    root: ComponentKey;
    templates: {
      key: string;
      category: string;
    }[];
  }[];
}
/**
 * 数据源调用的录制结果（VCR），与领域包的 pack test --replay 使用同一种查询快照
 */
export interface QuerySnapshot {
  api_version: 'srenautix.io/query-snapshot/v1';
  snapshot_id: string;
  recorded_at: Timestamp;
  clock_window: TimeWindow;
  ids: {
    metrics: string | null;
    logs: string | null;
    traces: string | null;
  };
  capabilities: (
    'metrics.query' | 'metrics.query_range' | 'metrics.series' | 'logs.match' | 'logs.query' | 'traces.search'
  )[];
  metrics_dialects: ('promql' | 'metricsql')[];
  label_profile: null | LabelProfile;
  logs_profile: {
    namespace: string;
    pod: string;
    container: string;
    cluster: string | null;
  } | null;
  entries: {
    op: 'query' | 'query_range' | 'metric_exists' | 'logs_match' | 'logs_query' | 'traces_search';
    /**
     * 集成契约的请求，去掉 clock_window
     */
    request: {};
    /**
     * 集成契约的结果；有 error 时不填
     */
    result?: {
      [k: string]: unknown | undefined;
    };
    error?: {
      kind: 'datasource' | 'capability_missing';
      message: string;
    };
  }[];
  /**
   * pack test 的期望（卡片、实体、锚点、期望判定）；评测快照为空
   */
  cases: {}[];
}
/**
 * 查询快照 srenautix.io/query-snapshot/v1：请求按去掉 clock_window 之后的规范 JSON（JCS）与操作名组成键，回放时按键读取，没有的请求为快照未命中
 */
export interface QuerySnapshot1 {
  api_version: 'srenautix.io/query-snapshot/v1';
  snapshot_id: string;
  recorded_at: Timestamp;
  clock_window: TimeWindow;
  ids: {
    metrics: string | null;
    logs: string | null;
    traces: string | null;
  };
  capabilities: (
    'metrics.query' | 'metrics.query_range' | 'metrics.series' | 'logs.match' | 'logs.query' | 'traces.search'
  )[];
  metrics_dialects: ('promql' | 'metricsql')[];
  label_profile: null | LabelProfile;
  logs_profile: {
    namespace: string;
    pod: string;
    container: string;
    cluster: string | null;
  } | null;
  entries: {
    op: 'query' | 'query_range' | 'metric_exists' | 'logs_match' | 'logs_query' | 'traces_search';
    /**
     * 集成契约的请求，去掉 clock_window
     */
    request: {};
    /**
     * 集成契约的结果；有 error 时不填
     */
    result?: {
      [k: string]: unknown | undefined;
    };
    error?: {
      kind: 'datasource' | 'capability_missing';
      message: string;
    };
  }[];
  /**
   * pack test 的期望（卡片、实体、锚点、期望判定）；评测快照为空
   */
  cases: {}[];
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
   * 代码校验的修改记录：删除的无效证据引用、删除的目录外提议、降级的结论、删除的无法核实的数值等
   */
  validation_notes: string[];
  /**
   * 检验循环的停止原因：leader_supported 第一的假设得到支持且竞争假设都已推翻或检验后无法判定；no_change 连续两步没有变化或没有可执行的检查；step_limit、deadline、budget 达到步数、期限或预算上限；model_unavailable 模型不可用；指纹不变直接沿用上一次研判时为 no_change
   */
  stop_reason?: 'leader_supported' | 'no_change' | 'step_limit' | 'deadline' | 'budget' | 'model_unavailable' | null;
  /**
   * 区分性检查产生的证据卡（引用编号接在阶段 A 的卡之后），序列为空数组；完整序列在 worker 的运行明细中
   *
   * @maxItems 12
   */
  check_cards?: EvidenceResult[];
  /**
   * 研判运行内的证据引用到定义与实体的映射（同研判清单的 evidence_map）：卡为 <card_id>@<实体键>，告警为 alert_id，变更为 change_id
   */
  evidence_index?: {
    ref: EvidenceRef;
    target: string;
  }[];
}
export interface ResearchConclusion {
  level: ConclusionLevel;
  hypothesis_id: string | null;
  root_component: null | ComponentKey;
  undetermined_reason: string | null;
  consistency: ConsistencyChecks;
  consistency_detail?: ConsistencyDetail;
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
/**
 * 四个条件各自的依据，由结论阶梯的代码给出：支持卡、支持的成员告警、最早的异常起点、症状起点与容差、相反的正常卡、检验过与同样得到支持的竞争假设、结论由谁选中
 */
export interface ConsistencyDetail {
  /**
   * 由领域包规则判定、实体在假设范围内的异常卡
   */
  support_refs: EvidenceRef[];
  /**
   * 计入支持的成员告警（ADR 0122）；只有它们支持时档位最高为 likely
   */
  support_alerts: EvidenceRef[];
  /**
   * 同样处于支持状态的竞争假设（ADR 0124）；不为空时第 4 个条件不满足
   */
  supported_competitors: string[];
  /**
   * model：模型在 conclude 中选中；ledger：模型弃权，由代码按账本选中（ADR 0120，档位最高为 likely）
   */
  chosen_by: 'model' | 'ledger';
  /**
   * 由小模型判定的支持卡（只能支持 likely）
   */
  model_judged_refs: EvidenceRef[];
  /**
   * 支持卡中最早的异常起点；没有可确定起点的支持卡时为 null
   */
  onset: null | {
    ref: EvidenceRef;
    at: Timestamp;
  };
  symptom_onset_at: Timestamp4;
  tolerance_seconds: number;
  contrary_refs: EvidenceRef[];
  /**
   * 执行过检查或已被推翻的竞争假设
   */
  tested_competitors: string[];
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
  /**
   * 账本给出状态的依据，按时间顺序，例如“支持卡：card:31、card:38”“相反的正常卡：card:25”“人工反馈确认根因”
   */
  status_reasons?: string[];
  /**
   * 针对这个假设执行完成的区分性检查数（失败的检查不计）
   */
  checks_run?: number;
}
export interface NextCheck {
  hypothesis_id: string;
  type: 'query' | 'tool';
  template: string;
  args: {
    [k: string]: unknown | undefined;
  };
  refutes_if: string;
  purpose: string;
  /**
   * 控制器执行后得到的卡；未执行时为 null
   */
  result_ref: null | EvidenceRef;
  outcome: 'not_run' | 'supports' | 'refutes' | 'inconclusive' | 'failed';
  /**
   * outcome 为 failed 时的原因（参数被拒绝、数据源报错、结果无法判定成卡）
   */
  error?: string | null;
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
  params: {
    [k: string]: unknown | undefined;
  };
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
  idempotency_key: Sha2562;
  cluster_id: ClusterId;
  subject?: Subject1;
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
  params: {
    [k: string]: unknown | undefined;
  };
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
/**
 * 研判、提议、出境清单与消息的主体（契约 2.28.0，ADR 0146 §8）：incident 事件；goal 主动优化的目标。没有 subject 的旧数据都是事件。主体为 goal 时沿用的事件字段语义为：incident_id 取目标 id，incident_version 取目标的 revision
 */
export interface Subject1 {
  type: 'incident' | 'goal';
  id: Uuid;
}
/**
 * 主体为事件时是事件版本、根因组件与阶段 A 的证据指纹；主体为目标时（契约 2.28.0）incident_version 取目标的 revision，root_component 取发现挂到的组件，evidence_fingerprint 取发现的证据指纹。审批断言 v1 与 gateway 的绑定核对不变
 */
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
 * 主动优化的目标（契约 2.28.0，ADR 0146 §1.2）。目标只引用领域包声明的指标或领域，不含任何自由查询；规格每修改一次 revision 加一。每次分析是一次目标运行（GoalRunSummary），结果见 optimization-output.schema.json
 */
export interface Goal {
  goal_id: Uuid;
  revision: number;
  cluster_id: ClusterId;
  spec: GoalSpec;
  state: GoalState;
  /**
   * 状态的机器可读原因，例如 failed 的 baseline_insufficient、cancelled 的 user
   */
  state_reason: string | null;
  expires_at: Timestamp5;
  /**
   * 最近一次运行；还没有运行时为 null
   */
  last_run: null | GoalRunSummary;
  created_at: Timestamp;
  updated_at: Timestamp;
}
export interface GoalRunSummary {
  run_id: Uuid;
  goal_id: Uuid;
  goal_revision: number;
  state: GoalRunState;
  /**
   * concluded 时的结果：no_gap 没有差距（不调用模型）；recommended 有通过门槛的建议；report_only 有发现、没有建议通过门槛；其余状态为 null
   */
  result: null | ('no_gap' | 'recommended' | 'report_only');
  /**
   * deferred 的原因（budget、storm、incident、load_guard、rate_limit、schedule_window）或 failed 的原因（baseline_insufficient、model_unavailable、budget_exhausted、deadline、datasource、internal）
   */
  reason: string | null;
  /**
   * 差距是否成立；基线之前为 null
   */
  gap: boolean | null;
  /**
   * 本次运行发现或更新的发现数
   */
  findings: number;
  /**
   * 通过全部门槛的建议数
   */
  recommendations: number;
  queued_at: Timestamp;
  started_at: null | Timestamp;
  finished_at: null | Timestamp;
}
/**
 * 一次目标运行经代码校验后的输出（契约 2.28.0，ADR 0146 §2）：基线、差距、候选发现、按发现分组的账本、每个发现的结论、建议与门槛记录、validation_notes。baseline、gap、candidates 与 recommendations 的数值全部由代码从信号卡计算；模型只提出假设、选择检查并写说明。没有差距时整次运行不调用模型，ledger 与 conclusions 为空
 */
export interface OptimizationOutput {
  goal_id: Uuid;
  goal_revision: number;
  run_id: Uuid;
  baseline: OptimizationBaseline;
  gap: OptimizationGap;
  /**
   * 候选发现，按“份额 × 差距”降序；前 3 个 selected 为 true，进入假设；其余为“未分析的候选”
   *
   * @maxItems 50
   */
  candidates: OptimizationCandidate[];
  /**
   * 假设账本：root_component 为发现挂到的组件，finding 给出分组键；同一发现上的假设互为竞争假设
   *
   * @maxItems 9
   */
  hypotheses: FindingHypothesis[];
  /**
   * @maxItems 12
   */
  next_checks: NextCheck[];
  /**
   * 每个进入假设的发现一条，档位由代码按 ADR 0146 §2.4 计算
   *
   * @maxItems 3
   */
  conclusions: FindingConclusion[];
  /**
   * 本次运行评估过的建议与门槛记录（每次运行最多 2 个通过全部门槛）
   *
   * @maxItems 12
   */
  recommendations: RecommendationAttempt[];
  /**
   * 【模型】本次分析的说明；没有调用模型时为代码生成的说明
   */
  summary: string;
  /**
   * 检验循环的停止原因（取值同 ResearchOutput.stop_reason）；没有差距时为 null
   */
  stop_reason: 'leader_supported' | 'no_change' | 'step_limit' | 'deadline' | 'budget' | 'model_unavailable' | null;
  /**
   * 诊断卡、份额卡与区分性检查产生的证据卡（编号见 evidence_index），序列为空数组
   *
   * @maxItems 60
   */
  check_cards: EvidenceResult[];
  /**
   * 运行内的证据引用到定义与实体的映射：card:<n> → <card_id>@<实体键>
   */
  evidence_index: {
    ref: EvidenceRef;
    target: string;
  }[];
  /**
   * 代码校验的修改记录：删除的无效证据引用、拒绝的未知模板与原始查询、降级的结论、删除的无法核实的数值等
   */
  validation_notes: string[];
}
export interface OptimizationBaseline {
  window: TimeWindow;
  /**
   * 覆盖率不低于 90% 且至少 3 个业务高峰；否则运行以 failed（baseline_insufficient）结束
   */
  sufficient: boolean;
  /**
   * 基线不足时缺少的数据（例如“postgres/db-time 覆盖率 72%”）
   */
  missing: string[];
  indicators: BaselineIndicator[];
}
export interface BaselineIndicator {
  indicator: IndicatorRef;
  params: {
    [k: string]: number | string | boolean | undefined;
  };
  entity: EntityKey;
  unit: IndicatorUnit;
  better: 'lower' | 'higher';
  statistic: IndicatorStatistic;
  /**
   * 统计值；没有数据时为 null
   */
  value: number | null;
  hours: number;
  covered_hours: number;
  /**
   * 按负载指标判定的业务高峰小时数（负载前 20%）
   */
  peak_hours: number;
  /**
   * 违反目标或门槛的小时占比；没有目标与门槛时为 null
   */
  violation_ratio: number | null;
  /**
   * 按小时的取值 [unix 秒, 值或 null]，控制台画基线图
   *
   * @maxItems 336
   */
  hourly: [number, number | null][];
}
export interface OptimizationGap {
  exists: boolean;
  /**
   * objective 按目标值；gate 按领域门槛；none 基线不足或没有可比较的目标
   */
  basis: 'objective' | 'gate' | 'none';
  detail: string;
}
export interface OptimizationCandidate {
  finding: Sha2563;
  kind: string;
  entity: FindingEntity;
  component: ComponentKey;
  /**
   * <领域>/<诊断卡 id>
   */
  diagnostic: string;
  card_ref: EvidenceRef;
  share: number | null;
  share_ref: null | EvidenceRef;
  gap: number | null;
  score: number;
  selected: boolean;
  /**
   * 没有进入假设的原因：rank（排在前 3 之外）、verifying（已修复的发现在验证期内）、cooldown
   */
  skipped_reason: 'rank' | 'verifying' | 'cooldown' | null;
}
export interface FindingEntity {
  /**
   * 逻辑实体类型（pg_statement、pg_table、pg_index、route、stage），或 Kubernetes 的 Kind
   */
  type: string;
  key: EntityKey;
  /**
   * 可读名称，只用于显示
   */
  display: string;
  labels: Labels2;
}
/**
 * 实体的标签（EntityRows.labels），例如 pg_statement 的 database、queryid；按实体执行的卡片与模板以 $params 引用
 */
export interface Labels2 {
  [k: string]: string | undefined;
}
export interface FindingHypothesis {
  finding: Sha256;
  hypothesis: Hypothesis;
}
export interface FindingConclusion {
  finding: Sha256;
  level: ConclusionLevel;
  hypothesis_id: string | null;
  consistency: OptimizationConsistency;
  support_refs: EvidenceRef[];
  share_refs: EvidenceRef[];
  contrary_refs: EvidenceRef[];
  chosen_by: 'model' | 'ledger';
  /**
   * 【模型】选择这个假设的说明
   */
  note: string | null;
  undetermined_reason: string | null;
}
/**
 * 优化场景的 evidence_consistent 条件逐项结果（ADR 0146 §2.4）；trend_onset 只对趋势触发的目标求值，其余为 null
 */
export interface OptimizationConsistency {
  gap_holds: boolean;
  share_holds: boolean;
  trend_onset: boolean | null;
  no_contrary_normal: boolean;
  competitor_tested: boolean;
}
export interface RecommendationAttempt {
  finding: Sha256;
  kind: RecommendationKind;
  template: string;
  gates: GateRecord[];
  passed: boolean;
  /**
   * 保存的建议；没有保存时为 null
   */
  recommendation_id: null | Uuid;
}
export interface GateRecord {
  /**
   * G1 证据档位；G2 预期收益；G3 安全约束；G4 新颖性；G5 数量；G6 时机
   */
  gate: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';
  passed: boolean;
  /**
   * 机器可读的原因码，与 remediation_attempts 的方式相同；G3 不通过时为模板 guard 的 id
   */
  code: string;
  detail: string;
}
/**
 * 一个实体上的一个问题（契约 2.28.0，ADR 0146 §1.4），跨分析运行持久保存；fingerprint 是去重的唯一键。每次运行先按指纹更新已有发现（last_seen、差距、份额、档位），再判断是否生成建议
 */
export interface Finding {
  fingerprint: Sha2564;
  cluster_id: ClusterId;
  domain: DomainId;
  /**
   * 领域声明的发现类型（DomainDiagnostic.finding），例如 pg.statement_dominant、pg.temp_spill、workload.cpu_overprovisioned
   */
  kind: string;
  entity: FindingEntity;
  component: ComponentKey1;
  /**
   * 发现影响的指标；诊断卡没有声明时为 null
   */
  indicator: null | IndicatorRef;
  /**
   * 指标相对目标或门槛的差距（指标单位，按改善方向取正值）；没有可比较的目标时为 null
   */
  gap: number | null;
  /**
   * 实体在指标中的份额（份额卡）；没有份额卡时为 null
   */
  share: number | null;
  /**
   * 最近一次分析的结论档位（ADR 0146 §2.4）；进入候选但未分析时为 null
   */
  level: null | ConclusionLevel;
  /**
   * 支持卡与份额卡的判定向量指纹；未分析时为 null
   */
  evidence_fingerprint: null | Sha256;
  status: FindingStatus;
  /**
   * 被拒绝之后的冷却期限
   */
  cooldown_until: null | Timestamp;
  last_goal_id: null | Uuid;
  last_run_id: null | Uuid;
  first_seen: Timestamp;
  last_seen: Timestamp;
  updated_at: Timestamp;
}
/**
 * 主动优化的建议（契约 2.28.0，ADR 0146 §1.5、§2.5、§2.6）：ops 仓库的 PR（经 gitops_pr 提议）或业务仓库的 issue。预期收益与验证计划在创建时由代码确定；模型写的文字只在 model_note 中，消息与控制台标注【模型】
 */
export interface OptimizationRecommendation {
  recommendation_id: Uuid;
  cluster_id: ClusterId;
  finding: Sha2565;
  goal_id: Uuid;
  run_id: Uuid;
  kind: RecommendationKind;
  /**
   * <pack>/<模板 id>：ops_pr 为 remediations.yaml 中 applies 为 goal 的模板，business_issue 为 issues.yaml 的模板
   */
  template: string;
  title: string;
  level: ConclusionLevel;
  state: RecommendationState;
  estimate: EstimateValue;
  verify: VerifyPlan;
  /**
   * G1–G6 的逐项结果（按顺序，遇到第一个不通过即停止）；全部通过才创建 PR 或 issue
   */
  gates: GateRecord[];
  /**
   * 创建的 PR 或 issue；门槛不通过或还没有创建时为 null
   */
  delivery: null | RecommendationDelivery;
  /**
   * 验证结果；验证结束之前为 null
   */
  outcome: null | RecommendationOutcome;
  /**
   * 模型补充的说明（经数值审计），显示时标注【模型】
   */
  model_note: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}
/**
 * 模板 estimate 的求值结果：lower 为保守下界，expected 为期望值，单位与指标相同，按改善方向取正值
 */
export interface EstimateValue {
  indicator: IndicatorRef;
  unit: IndicatorUnit;
  lower: number;
  expected: number | null;
  basis: string;
}
/**
 * 验证计划（ADR 0146 §2.6）：start 为 merged_synced 时等管理这个文件的 Argo 应用的同步版本包含合并提交且 Healthy（GUC 另外核对 pg_settings）；为 deployed 时等发布输入的版本对应的业务提交包含修复提交。窗口开始后与基线按“星期 × 小时”匹配的时段比较
 */
export interface VerifyPlan {
  start: 'merged_synced' | 'deployed';
  indicator: IndicatorRef;
  params: {
    [k: string]: number | string | boolean | undefined;
  };
  within: Duration;
  /**
   * 应转为正常的卡片全局 id
   */
  cards: string[];
  guards: IndicatorRef[];
  /**
   * GUC：应在 pg_settings 中生效的参数 → 新值
   */
  settings: {
    [k: string]: string | undefined;
  };
  /**
   * 验证窗口；开始之前为 null
   */
  window: null | TimeWindow;
}
export interface RecommendationDelivery {
  /**
   * ops：ops 仓库（只经 gateway 的 gitops_pr）；business：业务仓库（只创建 issue 与评论）
   */
  repository_role: 'ops' | 'business';
  repository: string;
  /**
   * ops_pr 的 gitops_pr 提议；business_issue 为 null
   */
  proposal_id: null | Uuid;
  /**
   * PR 或 issue 号；PR 还没有创建时为 null
   */
  number: number | null;
  url: string | null;
  /**
   * ops_pr 的分支 srenautix/goal-…
   */
  branch: string | null;
  merged_at: null | Timestamp;
  merge_commit: string | null;
  /**
   * issue 的关闭原因或 PR 未合并就关闭（unmerged）；未关闭时为 null
   */
  closed_reason: null | ('completed' | 'not_planned' | 'unmerged');
}
/**
 * 合并或部署之后的验证结果（ADR 0146 §2.6）：改善不低于预期下界的 50% 并超出噪声带为 improved；守护指标恶化超过 10% 为 regressed；其余为 no_effect
 */
export interface RecommendationOutcome {
  result: 'improved' | 'no_effect' | 'regressed';
  window: TimeWindow;
  /**
   * 匹配时段的基线统计值
   */
  baseline: number | null;
  /**
   * 验证窗口的统计值
   */
  observed: number | null;
  /**
   * 按改善方向取正值，单位与指标相同
   */
  improvement: number | null;
  /**
   * 基线窗口内同一时段的四分位距的一半
   */
  noise_band: number | null;
  estimate_lower: number;
  guards: {
    indicator: IndicatorRef;
    /**
     * 恶化方向为正
     */
    change_ratio: number | null;
    regressed: boolean;
  }[];
  /**
   * verify.cards 在窗口结束时的结论
   */
  cards: {
    card_id: string;
    verdict: Verdict;
  }[];
  /**
   * regressed 的 ops PR 由 server 提交的 revert 提议
   */
  revert_proposal_id: null | Uuid;
  verified_at: Timestamp;
}
/**
 * 证据卡定义（DESIGN §6.1），写在领域包 chains.yaml 的证据链中。卡片只包含数据：信号引用、时间窗口、params、CEL 判定、声明式展示和链接。CEL 只在 TypeScript 运行时求值，求值成本有上限
 */
export interface EvidenceCardDefinition {
  /**
   * 证据链内唯一；全局 id 为 <pack>/<chain>/<id>
   */
  id: string;
  title: LocalizedText2;
  note?: LocalizedText3;
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
   * 影响类卡片：衡量用户可见的影响（错误率、可用性、业务量）。异常时它的标题与值写进通知的影响范围
   */
  impact?: boolean;
  /**
   * 业务关键信号的类别（ADR 0148）：storage 存储（PVC 与卷容量、IO、对象存储）、memory 内存（使用占 limit、OOM）、cpu CPU（使用、节流、HPA 饱和）、traffic 流量负载（请求量、错误率、延迟）、blocking 阻塞（队列积压、锁等待、Pending 与 Init 卡住、PDB 阻塞驱逐、rollout 停滞）。异常或接近阈值时，卡片进入事件消息的“业务关键信号”段；不填时按证据链与卡片名推断
   */
  category?: 'storage' | 'memory' | 'cpu' | 'traffic' | 'blocking';
  /**
   * 卡片需要的集成能力，例如 metrics.query_range、logs.match。能力不可用时卡片显示 capability_missing
   */
  requires?: string[];
  /**
   * 作为阶段 B 区分性检查执行时的说明与可覆盖参数（ADR 0116）。没有它时卡片仍可作为检查，参数为全部 params 与 window_before、window_after，类型取默认值；有它时 params 的取值范围按 args 约束。window_before、window_after 总是由运行时提供，不在 args 中声明
   */
  check?: {
    description?: LocalizedText6;
    /**
     * 可覆盖参数的 JSON Schema（type: object、additionalProperties: false）：每个属性都是卡片 params 的键，带 description；字符串用 enum 或 pattern 限定，数字有 minimum 与 maximum，卡片的默认值满足它
     */
    args?: {
      type: 'object';
      additionalProperties?: false;
      properties: {};
    };
  };
}
export interface LocalizedText2 {
  'zh-CN'?: string;
  en?: string;
}
/**
 * 这张卡展示什么、怎么读
 */
export interface LocalizedText3 {
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
  /**
   * dbstats 读取 dbstats 信号（契约 2.28.0）：每行一条序列，点为采样时刻
   */
  mode: 'range' | 'instant' | 'logs' | 'traces' | 'dbstats';
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
  say: LocalizedText4;
  normal_say?: LocalizedText5;
}
/**
 * 命中时的理由，ICU MessageFormat，可引用 CEL 变量
 */
export interface LocalizedText4 {
  'zh-CN'?: string;
  en?: string;
}
/**
 * 求值为 false 时的说明（例如“连接池峰值 {poolPeak, number, percent}，未超过 95%”），ICU MessageFormat，可引用的参数与 say 相同
 */
export interface LocalizedText5 {
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
  /**
   * 对比基线的 CEL 表达式（例如前一天的中位数），结果写入 EvidenceResult.baseline
   */
  baseline?: string;
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
      header: LocalizedText2;
      cel: string;
      unit?: string;
    },
    ...{
      header: LocalizedText2;
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
  label: LocalizedText2;
  /**
   * dashboard 的 uid 或 runbook 的 <文件>#<锚点>
   */
  target?: string;
}
/**
 * 这张卡作为检查时判断什么、结果怎样区分假设
 */
export interface LocalizedText6 {
  'zh-CN'?: string;
  en?: string;
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
 * 下达目标的请求体（POST /v1/goals）。origin 由认证上下文决定（控制台会话为 console，API token 为 api，聊天渠道的确认卡片为 telegram）；budget 只写要改的项，其余取默认值
 */
export interface GoalCreate {
  cluster_id: ClusterId;
  subject: GoalSubject;
  objective: null | GoalObjective;
  /**
   * @minItems 1
   */
  outputs: [RecommendationKind, ...RecommendationKind[]];
  budget?: {
    tokens?: number;
    duration_seconds?: number;
    checks?: number;
    dbstats_queries?: number;
    traces_queries?: number;
    logs_queries?: number;
    code_files?: number;
    code_bytes?: number;
    github_requests?: number;
  };
  expires_in?: Duration2;
}
export interface ResearchRoot1 {
  run_id: Uuid;
  component: ComponentKey;
  /**
   * 研判根因与事件根因按属主粒度比较不一致（Pod 与它所属的 Deployment 算一致）。只标记，事件不拆分，分组与根因不变
   */
  mismatch: boolean;
}
/**
 * 集成清单 integration.yaml（DESIGN §10.1）。一项能力只有在清单里声明过、并且 verify() 通过，才算可用。控制台的集成页由清单生成
 */
export interface IntegrationManifest {
  api_version: 'srenautix.io/integration/v1';
  id: string;
  display_name?: string;
  /**
   * dbstats：数据库统计视图（契约 2.28.0）
   */
  category:
    | 'alerts'
    | 'metrics'
    | 'logs'
    | 'traces'
    | 'changes'
    | 'notify'
    | 'approve'
    | 'identity'
    | 'model'
    | 'execute'
    | 'dbstats';
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
  config_schema: {
    [k: string]: unknown | undefined;
  };
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
 * 领域包的 pack.yaml（DESIGN §6.3）。领域包只包含数据，不包含可执行代码；其余文件的结构见本文件的 $defs：signals.yaml → SignalsFile，components.yaml → ComponentsFile，alerts.yaml → AlertsFile，chains.yaml → ChainsFile，checks.yaml → ChecksFile，rules.yaml → RulesFile，remediations.yaml → RemediationsFile，domains.yaml → DomainsFile，issues.yaml → IssuesFile，rca-params.yaml → RcaParams，knowledge/*.yaml → KnowledgeFile，action-requests.yaml → ActionRequestsFile，chaos/*.yaml → ChaosFile，tests/*.yaml → PackTestFile，用户层文件 → UserLayer，pack.lock → PackLock
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
  /**
   * dbstats：数据库统计视图（契约 2.28.0，ADR 0146 §3.3），备选的方言必须是 dbstats
   */
  kind: 'metrics' | 'logs' | 'traces' | 'dbstats';
  unit?: string;
  /**
   * 补充另一个包的信号 <包>/<信号 id>（契约 2.26.0，ADR 0139）：本信号的备选排在那个信号原有的备选之前，引用那个信号的卡都按合并后的备选探测与查询。只能补充别的包里没有 extends 的信号，类型必须相同。备选按数据源选中一个，被选中后用于这个信号的全部实体，只覆盖部分实体的备选要让其余实体查不到数据
   */
  extends?: string;
  /**
   * 按优先级排列
   *
   * @minItems 1
   */
  alternatives: [SignalAlternative, ...SignalAlternative[]];
}
export interface SignalAlternative {
  /**
   * 查询模板。可用变量：$selector（按标签档案展开的实体选择器）、$namespace、$name、$node、$rate_window（由抓取间隔推导）、$params.<名字>。dbstats 方言的 expr 是 dbstats/v1 的操作名（例如 statements.top），SQL 由适配器给出
   */
  expr: string;
  /**
   * PromQL 用严格解析器做 lint；使用 MetricsQL 必须显式声明；dbstats 只用于 dbstats 信号
   */
  dialect?: 'promql' | 'metricsql' | 'logql' | 'logs_match' | 'traceql' | 'dbstats';
  /**
   * dbstats：操作的参数（dbstats/v1 各操作的 args）；字符串值可以整体写成 $params.<名字>，执行时换成参数值，按操作的 schema 校验
   */
  args?: {
    [k: string]: number | string | boolean | null | string[] | undefined;
  };
  /**
   * dbstats：作为序列取值的数值列（例如 total_exec_time_ms）。每行结果是一条序列，标签为该行的字符串与布尔列，取值为这一列
   */
  column?: string;
  /**
   * dbstats：取值为两次采样（相隔不少于 300 秒）的差值除以间隔秒数，计数器回绕的行不计；只在第二次采样中出现的行在前一次采样没有被截断时从 0 开始计，被截断时不计；只有一次采样时引用为缺数据
   */
  rate?: boolean;
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
  args: {
    [k: string]: unknown | undefined;
  };
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
  title: LocalizedText2;
  note?: LocalizedText3;
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
   * 影响类卡片：衡量用户可见的影响（错误率、可用性、业务量）。异常时它的标题与值写进通知的影响范围
   */
  impact?: boolean;
  /**
   * 业务关键信号的类别（ADR 0148）：storage 存储（PVC 与卷容量、IO、对象存储）、memory 内存（使用占 limit、OOM）、cpu CPU（使用、节流、HPA 饱和）、traffic 流量负载（请求量、错误率、延迟）、blocking 阻塞（队列积压、锁等待、Pending 与 Init 卡住、PDB 阻塞驱逐、rollout 停滞）。异常或接近阈值时，卡片进入事件消息的“业务关键信号”段；不填时按证据链与卡片名推断
   */
  category?: 'storage' | 'memory' | 'cpu' | 'traffic' | 'blocking';
  /**
   * 卡片需要的集成能力，例如 metrics.query_range、logs.match。能力不可用时卡片显示 capability_missing
   */
  requires?: string[];
  /**
   * 作为阶段 B 区分性检查执行时的说明与可覆盖参数（ADR 0116）。没有它时卡片仍可作为检查，参数为全部 params 与 window_before、window_after，类型取默认值；有它时 params 的取值范围按 args 约束。window_before、window_after 总是由运行时提供，不在 args 中声明
   */
  check?: {
    description?: LocalizedText6;
    /**
     * 可覆盖参数的 JSON Schema（type: object、additionalProperties: false）：每个属性都是卡片 params 的键，带 description；字符串用 enum 或 pattern 限定，数字有 minimum 与 maximum，卡片的默认值满足它
     */
    args?: {
      type: 'object';
      additionalProperties?: false;
      properties: {};
    };
  };
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
  /**
   * 组件在集群之外（例如外部 API 服务方），集群内没有可处置的对象：研判根因落在这种组件上、结论为 likely 及以上时，处置推导以它为 ignore 的依据（ADR 0138）
   */
  external?: boolean;
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
  /**
   * 组件的可读名称来源（只影响显示，组件键不变）：按顺序尝试，取第一个非空且不等于实体名的值；都没有时显示组件键。alert_annotation、alert_label 取实体所在告警的注解或标签；signal 在事件锚点对本包的 metrics 信号做 instant 查询，取第一条序列的 label 标签
   *
   * @minItems 1
   */
  display_name?: [
    (
      | {
          alert_annotation: string;
        }
      | {
          alert_label: string;
        }
      | {
          signal: string;
          label: string;
        }
    ),
    ...(
      | {
          alert_annotation: string;
        }
      | {
          alert_label: string;
        }
      | {
          signal: string;
          label: string;
        }
    )[],
  ];
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
  title: LocalizedText2;
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
  title: LocalizedText2;
  /**
   * CEL，可引用 incident、root、cards（卡片 id → 结论）
   */
  when: string;
  action: string;
  /**
   * 参数值为 CEL 表达式文本
   */
  params: {
    [k: string]: string | undefined;
  };
  expected_effect?: LocalizedText2;
}
/**
 * remediations.yaml：修复补丁模板（ADR 0103）。模板生成 Git 补丁，由 server 经 gitops_pr 开 PR，从不合并
 */
export interface RemediationsFile {
  remediations: Remediation[];
}
/**
 * 一个修复补丁模板。模板只引用仓库角色与文件角色，真实路径由 server 配置的仓库布局（RepositoryLayout）给出，同一模板可用于不同仓库
 */
export interface Remediation {
  id: string;
  title: LocalizedText2;
  /**
   * release_rollback 发布回退；config_resource 副本数、HPA 上限、request/limit、超时与限流参数；alert_rule 告警阈值、持续时间、严重度；topology_coverage 拓扑与领域包覆盖；component_param 组件参数（PG 的 GUC、连接池、缓存与存储组件的配置，契约 2.28.0）
   */
  category: 'release_rollback' | 'config_resource' | 'alert_rule' | 'topology_coverage' | 'component_param';
  /**
   * incident：事件的自愈 PR（ADR 0108）；goal：主动优化的 ops PR（契约 2.28.0，ADR 0146 §4.3），由领域的 optimizations 引用。现有模板不写时为 incident，行为不变
   */
  applies?: 'incident' | 'goal';
  /**
   * 仓库角色，例如 gitops；server 配置把它映射到仓库与布局
   */
  repository: string;
  /**
   * CEL 适用条件。变量：incident、root、research（触发计划的研判结论 {disposition, level}，取值见 Disposition 与 ConclusionLevel；没有研判时为 null）、cards（卡片全局 id → 结论）、alerts（成员告警：alertname、labels、annotations、entity，以及 AlertClassification 的 role、source、catalog_entry、chronic）、params。applies 为 goal 时另有 goal（GoalSpec 与 goal_id、revision）、finding（Finding）与 finding_cards（发现的支持卡、份额卡与诊断卡：卡片全局 id → 结论，形状与 cards 相同），incident 与 alerts 为空，root 为发现挂到的组件
   */
  when: string;
  estimate?: Estimate;
  /**
   * 安全约束（ADR 0146 §2.5 的 G3）：在 let 之后求值，任一为 false 时不生成补丁，say 写明原因。变量与 skip_if 相同
   */
  guard?: Guard[];
  /**
   * 参数默认值，可由用户层覆盖
   */
  params?: {
    [k: string]: number | string | boolean | undefined;
  };
  /**
   * 计划时在事件锚点对本包的 metrics 信号做 instant 查询；结果（序列列表）以 name 作为 CEL 变量
   */
  inputs?: {
    name: string;
    signal: string;
    /**
     * CEL，求出查询的实体 {kind, namespace, name}，变量与 when 相同；默认为根因。为 null 时模板跳过。例如根因是管理工作负载的 Argo 应用时，用 component_ref 从 incident.components 取工作负载
     */
    entity?: string;
  }[];
  /**
   * 读取一个文件角色的 Git 历史：变量 history 为最近 depth 个修改过它的提交（从新到旧，含当前版本），每项 {commit, author, time, message, doc}
   */
  history?: {
    file: string;
    depth: number;
  };
  /**
   * 按顺序求值的 CEL 绑定，后面的绑定、skip_if、edits、change 可以引用。另有变量 files（文件角色 → 文档列表：glob 匹配的全部文件与多文档 YAML 的全部文档按路径顺序展开，单个 JSON 文件为一个元素）与 fields（文件角色 → 逻辑字段 → 点路径）
   */
  let?: {
    name: string;
    cel: string;
  }[];
  /**
   * 任一 CEL 为 true 时不生成补丁，say 写明原因
   */
  skip_if?: {
    cel: string;
    say: LocalizedText2;
  }[];
  /**
   * @minItems 1
   */
  edits: [RemediationEdit, ...RemediationEdit[]];
  change: LocalizedText9;
  verify: {
    say: LocalizedText2;
    /**
     * 合并并同步后应判为正常的卡片全局 id
     */
    cards?: string[];
    within?: string;
    /**
     * applies 为 goal：验证时的守护指标 <包>/<指标>（错误率、其他语句的执行时间、CPU 限流、OOM 等），恶化超过 10% 判为 regressed（ADR 0146 §2.6）
     */
    guards?: IndicatorRef[];
  };
  /**
   * 回滚方法：revert 这个 PR 的提交；say 写补充说明
   */
  rollback: {
    say: LocalizedText2;
  };
}
/**
 * applies 为 goal 时必填：确定性计算的预期收益（ADR 0146 §2.5 的 G2）
 */
export interface Estimate {
  indicator: IndicatorRef;
  unit: IndicatorUnit;
  /**
   * CEL，下界
   */
  lower: string;
  /**
   * CEL，期望值
   */
  expected: string;
  basis: LocalizedText7;
}
/**
 * 计算依据与前提（ICU MessageFormat，变量为 let、params、lower、expected）
 */
export interface LocalizedText7 {
  'zh-CN'?: string;
  en?: string;
}
export interface Guard {
  /**
   * 写进门槛记录的原因码
   */
  id: string;
  /**
   * 为 true 表示约束成立
   */
  cel: string;
  say: LocalizedText8;
}
/**
 * 约束不成立时的原因（ICU MessageFormat，变量为 let 与 params）
 */
export interface LocalizedText8 {
  'zh-CN'?: string;
  en?: string;
}
/**
 * 对一个文件角色的修改。path 用点路径：段为键名、name[key=value]（数组中 key 等于 value 的元素）、name[*]（任一元素，只用于定位）或 name[N]；{变量} 由 let 与 params 的值替换。文件角色是 glob 或多文档 YAML 时，按 document 与 locate 找到唯一的文档，找不到或不唯一时模板跳过
 */
export interface RemediationEdit {
  /**
   * 文件角色
   */
  file: string;
  /**
   * 多文档 YAML 中按 kind 与 metadata.name 选文档；两者都可以含 {变量}
   */
  document?: {
    kind?: string;
    name?: string;
  };
  /**
   * 定位文档的点路径，默认取第一个 set 的路径去掉最后一段
   */
  locate?: string;
  set?: {
    path?: string;
    /**
     * 布局 fields 中的逻辑字段名，与 path 二选一
     */
    field?: string;
    /**
     * CEL；另有变量 current（修改前的值，不存在时为 null）
     */
    value: string;
  }[];
  append?: {
    /**
     * 数组的点路径
     */
    path: string;
    /**
     * CEL，追加的元素
     */
    value: string;
  }[];
}
/**
 * 改了什么、为什么（ICU MessageFormat，变量取自 let 与 params），写入 PR 描述
 */
export interface LocalizedText9 {
  'zh-CN'?: string;
  en?: string;
}
/**
 * 仓库布局（server 配置 remediation.repositories.<角色>.files）：文件角色 → 路径、格式与逻辑字段
 */
export interface RepositoryLayout {
  [k: string]:
    | {
        /**
         * 仓库内路径，可以是 glob（* 与 **）
         */
        path: string;
        format: 'json' | 'yaml';
        /**
         * 逻辑字段 → 点路径
         */
        fields?: {
          [k: string]: string | undefined;
        };
      }
    | undefined;
}
/**
 * 业务仓库的代码布局（server 配置 optimization.repositories.business.code，契约 2.28.0，ADR 0146 §3.5）：代码定位读取哪个提交、哪些路径，锚点类型对应的候选路径，以及路径到 issue 标签的映射
 */
export interface CodeLayout {
  version: {
    /**
     * running：从 ops 仓库的发布输入解析出运行中的业务提交，没有时用默认分支；default_branch：总是默认分支
     */
    rule: 'running' | 'default_branch';
    /**
     * running：ops 仓库中发布输入的文件角色（RepositoryLayout 的键），其中的版本字段解析为业务提交
     */
    release_input?: string;
    /**
     * running：发布输入中版本的逻辑字段名（RepositoryLayout 的 fields）
     */
    field?: string;
  };
  /**
   * 代码根目录，仓库根为空串
   */
  root: string;
  /**
   * glob（* 与 **）
   *
   * @minItems 1
   */
  include: [string, ...string[]];
  /**
   * glob；测试、生成文件中的数据、testdata、*.pem、.env*、*secret* 总是排除
   */
  exclude: string[];
  /**
   * @minItems 1
   */
  languages: ['go' | 'typescript', ...('go' | 'typescript')[]];
  /**
   * 锚点类型 → 候选路径的 glob；没有列出的锚点类型在 include 的全部路径中查找
   */
  anchors: {
    kind: AnchorKind;
    /**
     * @minItems 1
     */
    paths: [string, ...string[]];
  }[];
  /**
   * 路径 glob → issue 标签（例如 internal/gateway/** → area/gateway），按顺序匹配，全部命中的标签都加上
   */
  labels?: {
    /**
     * @minItems 1
     */
    paths: [string, ...string[]];
    label: string;
  }[];
  max_files?: number;
  max_bytes?: number;
}
/**
 * domains.yaml（契约 2.28.0，ADR 0146 §1.1、§1.3）：本包声明的指标与领域。多个包可以给同一个领域补充内容：同一 id 的领域按包的加载顺序合并，列表追加，gates 后者覆盖前者的同名键
 */
export interface DomainsFile {
  indicators?: Indicator[];
  domains?: Domain[];
}
/**
 * 目标可以引用的指标。按实体产生序列：基线、差距与验证在指标的信号上按小时取值；目标不提交自由查询
 */
export interface Indicator {
  /**
   * 包内唯一；全局 id 为 <包>/<id>
   */
  id: string;
  title: LocalizedText2;
  description?: LocalizedText2;
  /**
   * metrics 信号 <pack>/<signal id>（同包内可省略 <pack>/）；查询按实体与 params 渲染，结果是一条或多条序列，多条时取和
   */
  signal: string;
  /**
   * 实体类型：Kubernetes 的 Kind（其他 API 组写作 Kind.group），或逻辑实体 pg_statement、pg_table、pg_index、route、stage
   */
  entity: string;
  /**
   * 参数的 JSON Schema（可移植子集：type: object、additionalProperties: false，字符串用 enum 或 pattern 限定，数字有 minimum 与 maximum）。信号中写作 $params.<名字>
   */
  params?: {
    type: 'object';
    additionalProperties?: false;
    properties: {};
  };
  unit: IndicatorUnit;
  /**
   * 改善方向
   */
  better: 'lower' | 'higher';
  statistic: IndicatorStatistic;
  load_indicator?: IndicatorRef1;
}
/**
 * 一个优化领域（ADR 0146 §1.3）。卡片引用写 <chain>/<card>、checks/<id> 或 templates/<模板 id>（本包内），三段为 <pack>/<chain>/<card>
 */
export interface Domain {
  /**
   * 例如 database、compute、traffic、storage、cache
   */
  id: string;
  title?: LocalizedText2;
  /**
   * 组件类型或 Kind（例如 Cluster.postgresql.cnpg.io）；领域体检在范围内这些组件上执行
   */
  applies_to?: string[];
  /**
   * 体检时计算基线的指标
   */
  indicators?: IndicatorRef[];
  diagnostics?: DomainDiagnostic[];
  contribution?: DomainContribution[];
  /**
   * 区分性检查可用的查询模板全局 id <pack>/<模板 id>（含 dbstats、traces、logs 信号的模板）
   */
  templates?: string[];
  /**
   * 适用的 ops 修复模板 <pack>/<id>（remediations.yaml 中 applies 为 goal 的模板）
   */
  optimizations?: string[];
  /**
   * 适用的业务 issue 模板 <pack>/<id>（issues.yaml）
   */
  issues?: string[];
  gates?: DomainGates;
  trends?: DomainTrend[];
  /**
   * 默认体检计划；时段由 server 配置 optimization.schedule.window 限定
   */
  schedule?: {
    /**
     * 五段 cron（UTC）
     */
    cron: string;
  };
  /**
   * 负载保护卡（ADR 0146 §6.2）：每次直接查询后端之前执行（缓存 1 分钟），任何一张异常就跳过这次查询
   */
  load_guards?: DomainLoadGuard[];
}
/**
 * 诊断卡：在范围内的实体上执行，异常即候选发现。有 entities 时卡片在组件上执行一次，按 rows_from 引用的每条序列求 entities.when，为 true 的行各是一个逻辑实体上的候选；没有 entities 时卡片的实体就是发现的实体，卡片异常即候选
 */
export interface DomainDiagnostic {
  id: string;
  card: string;
  /**
   * 发现类型，例如 pg.statement_dominant、pg.temp_spill、workload.cpu_overprovisioned
   */
  finding: string;
  indicator?: IndicatorRef2;
  /**
   * 这类发现预示的症状类型（ADR 0133 的集合与 ADR 0146 §2.3 的补充），供假设与检查的对应
   */
  symptoms?: (
    | 'seq_scan'
    | 'index'
    | 'temp_spill'
    | 'lock_wait'
    | 'io_read'
    | 'connection_pool'
    | 'cache_miss'
    | 'polling'
    | 'n_plus_one'
    | 'payload_size'
    | 'overprovision'
    | 'saturation'
    | 'latency'
    | 'errors'
  )[];
  entities?: EntityRows;
}
/**
 * 从卡片的一个引用的序列得到逻辑实体。每个 CEL 的变量为卡片的引用、let、params、entity，以及 row（当前序列 {labels, times, values}）
 */
export interface EntityRows {
  /**
   * 逻辑实体类型，例如 pg_statement、pg_table、pg_index、route、stage
   */
  type: string;
  /**
   * 卡片的引用名
   */
  rows_from: string;
  /**
   * CEL，实体键中类型之后、组件之内的部分（例如 pg_statement 为 <库>/<queryid>）。server 把 pg_statement 的 queryid 换成语句指纹，得到 pg_statement:<集群>/<库>/<指纹>
   */
  key: string;
  /**
   * CEL，实体的可读名称
   */
  display?: string;
  /**
   * 实体的标签：名字 → CEL（字符串）。按实体执行的卡片与查询模板以 $params.<名字> 引用
   */
  labels?: {
    [k: string]: string | undefined;
  };
  /**
   * 诊断卡：CEL，为 true 的行是候选
   */
  when?: string;
  /**
   * 份额卡：CEL，行的份额（0 到 1）
   */
  share?: string;
  limit?: number;
}
/**
 * 份额卡：实体占指标的比例（0 到 1），用于候选排序与结论阶梯。有 entities 时按行求 entities.share；没有时卡片的实体份额为 share 的值（CEL，变量与卡片的 let 相同），不填为 1
 */
export interface DomainContribution {
  id: string;
  card: string;
  indicator: IndicatorRef;
  /**
   * 没有 entities 时实体的份额（CEL）
   */
  share?: string;
  entities?: EntityRows;
}
/**
 * 领域的门槛参数（ADR 0146 §2.2、§2.4、§2.5）。都有默认值；同一领域在多个包中声明时后者覆盖前者的同名键
 */
export interface DomainGates {
  /**
   * 违反目标的小时数占比不低于它时差距成立
   */
  violation_ratio?: number;
  /**
   * evidence_consistent 与业务 issue 要求的份额下限
   */
  min_share?: number;
  /**
   * G2：预期收益下界的门槛之一，指标当前值的这个比例；门槛取它与 min_gain_gap_ratio 两者中较小者
   */
  min_gain_ratio?: number;
  /**
   * G2：预期收益下界的门槛之一，差距的这个比例
   */
  min_gain_gap_ratio?: number;
  /**
   * compute：每个工作负载的最小收益（核）
   */
  min_cpu_cores?: number;
  /**
   * compute：每个工作负载的最小收益（字节）
   */
  min_memory_bytes?: number;
  /**
   * 扩缩容：变更后 p95 利用率不超过目标的这个比例
   */
  max_utilization_after?: number;
  cooldown?: Duration3;
  /**
   * 领域体检没有目标值时的差距：任一指标的统计值违反门槛即差距成立
   */
  thresholds?: {
    indicator: IndicatorRef;
    params?: {
      [k: string]: number | string | boolean | undefined;
    };
    comparator: Comparator;
    value: number;
    statistic?: IndicatorStatistic;
  }[];
}
/**
 * 趋势定义（ADR 0146 §5.4）。drift：相对过去 7 天同一小时的中位数，比值超过 ratio 并持续 sustain；slope：在 window 内线性外推，horizon 内到达 limit 指标；headroom：用量占 limit 指标的 p95 超过 ratio 并持续 sustain
 */
export interface DomainTrend {
  id: string;
  indicator: IndicatorRef;
  params?: {
    [k: string]: number | string | boolean | undefined;
  };
  method: 'drift' | 'slope' | 'headroom';
  ratio?: number;
  sustain: Duration;
  window?: Duration;
  horizon?: Duration;
  limit?: IndicatorRef3;
}
export interface DomainLoadGuard {
  card: string;
  /**
   * 这张卡保护的后端：异常时跳过对它们的直接查询；metrics 异常时整次运行推迟
   *
   * @minItems 1
   */
  backends: ['dbstats' | 'traces' | 'logs' | 'metrics', ...('dbstats' | 'traces' | 'logs' | 'metrics')[]];
}
/**
 * 预期收益（ADR 0146 §2.5）。lower 只用卡片里的确定值计算（保守下界），单位与 indicator 相同、按改善方向取正值；CEL 的变量与模板的 let 相同，另有 gates（领域门槛）
 */
export interface Estimate1 {
  indicator: IndicatorRef;
  unit: IndicatorUnit;
  /**
   * CEL，下界
   */
  lower: string;
  /**
   * CEL，期望值
   */
  expected: string;
  basis: LocalizedText7;
}
/**
 * issues.yaml（契约 2.28.0，ADR 0146 §4.4）：业务仓库 issue 模板。模板只描述适用条件、锚点、建议与收益，由 server 渲染 issue 并在业务仓库创建，从不提交 PR
 */
export interface IssuesFile {
  issues: IssueTemplate[];
}
export interface IssueTemplate {
  id: string;
  title: LocalizedText2;
  domain: string;
  /**
   * CEL 适用条件。变量：goal（GoalSpec 与 goal_id、revision）、finding（Finding）、finding_cards（卡片全局 id → 结论：verdict、display_state、value、observations）、params
   */
  when: string;
  params?: {
    [k: string]: number | string | boolean | undefined;
  };
  /**
   * 按顺序求值的 CEL 绑定，后面的绑定、locate、estimate 与文案可以引用
   */
  let?: {
    name: string;
    cel: string;
  }[];
  /**
   * 代码定位的锚点，按顺序都执行，命中合并后按置信度排列
   *
   * @minItems 1
   */
  locate: [
    {
      kind: AnchorKind;
      /**
       * CEL，锚点的取值（字符串；为空串或 null 时跳过）
       */
      from: string;
    },
    ...{
      kind: AnchorKind;
      /**
       * CEL，锚点的取值（字符串；为空串或 null 时跳过）
       */
      from: string;
    }[],
  ];
  suggestion: LocalizedText10;
  estimate: Estimate1;
  verify: {
    say: LocalizedText2;
    /**
     * 部署后应判为正常的卡片全局 id
     */
    cards?: string[];
    within?: string;
    guards?: IndicatorRef[];
  };
  /**
   * 模板声明的 issue 标签（例如 perf）；srenautix、srenautix:<领域> 与路径映射的 area/* 由 server 加上
   */
  labels?: string[];
}
/**
 * 建议文字（ICU MessageFormat，变量为 let 与 params），写进 issue 的“建议”段
 */
export interface LocalizedText10 {
  'zh-CN'?: string;
  en?: string;
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
  adjacency?: Duration4;
  change_window?: Duration5;
  chronic_window?: Duration6;
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
    text: LocalizedText2;
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
    [k: string]:
      | {
          [k: string]: unknown | undefined;
        }
      | undefined;
  };
  /**
   * 禁用的条目：alerts/<id>、chains/<id>、chains/<id>/<card>、checks/<id>、rules/<id>、domains/<id>、domains/<id>/<诊断卡或份额卡 id>、indicators/<id>、issues/<id>
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
    indicators?: Indicator[];
    /**
     * 与目标包同 id 的领域按 DomainsFile 的规则合并进去，其余追加
     */
    domains?: Domain[];
    issues?: IssueTemplate[];
  };
  rca_params?: RcaParams;
}
/**
 * 面向预发集群的混沌实验配方（DESIGN §14.5）。只包含声明式的 Kubernetes 对象（例如 Chaos Mesh 资源）与期望，不包含脚本
 */
export interface ChaosFile {
  api_version: 'srenautix.io/chaos/v1';
  id: string;
  title: LocalizedText2;
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
      metadata: {
        [k: string]: unknown | undefined;
      };
    },
    ...{
      apiVersion: string;
      kind: string;
      metadata: {
        [k: string]: unknown | undefined;
      };
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
   * dbstats 夹具（契约 2.28.0）：每个操作的采样，offset 相对测试起点。读取时取不晚于 eval_time 的最近一次采样，速率按它与前一次采样的差值计算；排序、过滤与 limit 按适配器的语义作用在夹具的行上
   */
  input_dbstats?: {
    op: DbstatsOperation;
    /**
     * @minItems 1
     */
    samples: [
      {
        offset: Duration;
        rows: {
          [k: string]: string | number | boolean | null | undefined;
        }[];
      },
      ...{
        offset: Duration;
        rows: {
          [k: string]: string | number | boolean | null | undefined;
        }[];
      }[],
    ];
  }[];
  /**
   * 在真实 PostgreSQL（预加载 pg_stat_statements）上执行的 dbstats 夹具：以管理员执行 setup，重置统计并采样一次，执行 workload，再采样一次；之后每个测试的 dbstats 引用读取这个库，期望同样必须成立。只在测试运行器提供 PostgreSQL 时执行，没有时只用 input_dbstats
   */
  input_sql?: {
    database?: string;
    setup: string[];
    /**
     * @minItems 1
     */
    workload: [
      {
        sql: string;
        repeat: number;
      },
      ...{
        sql: string;
        repeat: number;
      }[],
    ];
  };
  /**
   * @minItems 1
   */
  tests: [
    {
      name: string;
      eval_time: Duration;
      /**
       * <chain>/<card> 或 checks/<id>；写成 <包>/<链>/<卡> 时测试别的包的卡，例如本包用 extends 补充了它读取的信号（契约 2.26.0）
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
        /**
         * rows 给出时：按 EntityRows 得到的实体（契约 2.28.0）。列出的键必须出现；hit 为诊断卡的 when，share 为份额卡的份额（相对误差 1e-3）
         */
        entities?: {
          key: string;
          hit?: boolean;
          share?: number;
        }[];
      };
      /**
       * 同时检查领域的诊断卡或份额卡按行得到的实体：<领域>/<诊断卡或份额卡 id>，card 必须是它引用的卡
       */
      rows?: string;
    },
    ...{
      name: string;
      eval_time: Duration;
      /**
       * <chain>/<card> 或 checks/<id>；写成 <包>/<链>/<卡> 时测试别的包的卡，例如本包用 extends 补充了它读取的信号（契约 2.26.0）
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
        /**
         * rows 给出时：按 EntityRows 得到的实体（契约 2.28.0）。列出的键必须出现；hit 为诊断卡的 when，share 为份额卡的份额（相对误差 1e-3）
         */
        entities?: {
          key: string;
          hit?: boolean;
          share?: number;
        }[];
      };
      /**
       * 同时检查领域的诊断卡或份额卡按行得到的实体：<领域>/<诊断卡或份额卡 id>，card 必须是它引用的卡
       */
      rows?: string;
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
  subject?: Subject2;
  incident_id: Uuid;
  binding: ProposalBinding;
  action: string;
  params: {
    [k: string]: unknown | undefined;
  };
  research_run_id: null | Uuid;
  rule_id: string | null;
  hypothesis_id: string | null;
  evidence_refs: EvidenceRef[];
  expected_effect: string;
}
/**
 * 研判、提议、出境清单与消息的主体（契约 2.28.0，ADR 0146 §8）：incident 事件；goal 主动优化的目标。没有 subject 的旧数据都是事件。主体为 goal 时沿用的事件字段语义为：incident_id 取目标 id，incident_version 取目标的 revision
 */
export interface Subject2 {
  type: 'incident' | 'goal';
  id: Uuid;
}
/**
 * 研判清单（DESIGN §8.5）：复现一次研判需要的全部版本信息，以及出境清单（§8.4）。后处理部分可以基于已保存的响应精确重放；重新采样模型得到的是一个分布
 */
export interface ResearchManifest {
  run_id: Uuid;
  subject?: Subject3;
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
/**
 * 研判、提议、出境清单与消息的主体（契约 2.28.0，ADR 0146 §8）：incident 事件；goal 主动优化的目标。没有 subject 的旧数据都是事件。主体为 goal 时沿用的事件字段语义为：incident_id 取目标 id，incident_version 取目标的 revision
 */
export interface Subject3 {
  type: 'incident' | 'goal';
  id: Uuid;
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
  categories: EgressCategory[];
  /**
   * 不在 llm.egress.categories 中、进入提示词之前删除的片段数，按类别计（契约 2.28.0，ADR 0146 §3.6）；没有删除时不填或为空对象
   */
  dropped?: {
    [k: string]: number | undefined;
  };
  redaction_hits: number;
  bytes: number;
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
  /**
   * Pod 容器的镜像（kube_pod_container_info 的 image 与 image_id），去重后按字典序；只有 Pod 节点填写，用于把发布之前的 Job 关联到发布（ADR 0104 §13）
   */
  images?: string[];
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
