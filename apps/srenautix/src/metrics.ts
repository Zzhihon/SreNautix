import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { logger } from './log.js';

export const VERSION = process.env.SRENAUTIX_VERSION ?? '0.1.0-dev';

/** 各角色共用的注册表与公共指标；角色自己的指标在各自模块里注册到同一个 registry。 */
export class BaseMetrics {
  readonly registry = new Registry();

  readonly buildInfo = new Gauge({
    name: 'srenautix_build_info',
    help: '版本信息，值恒为 1',
    labelNames: ['role', 'version'] as const,
    registers: [this.registry],
  });

  readonly condition = new Gauge({
    name: 'srenautix_condition',
    help: '状态条件，1 表示条件成立（DESIGN §12.4）',
    labelNames: ['role', 'type'] as const,
    registers: [this.registry],
  });

  readonly clockSkew = new Gauge({
    name: 'srenautix_clock_skew_seconds',
    help: '与对端的时钟偏差（本地减对端），单位秒',
    labelNames: ['peer'] as const,
    registers: [this.registry],
  });

  readonly pgStatementTimeouts = new Counter({
    name: 'srenautix_pg_statement_timeouts_total',
    help: 'PostgreSQL 语句因 statement_timeout 被取消的次数，按连接池',
    labelNames: ['pool'] as const,
    registers: [this.registry],
  });

  constructor(
    readonly role: string,
    defaults = true,
  ) {
    this.buildInfo.set({ role, version: VERSION }, 1);
    if (defaults) {
      collectDefaultMetrics({ register: this.registry, prefix: 'srenautix_process_' });
    }
  }
}

/** server 角色的指标。 */
export class ServerMetrics extends BaseMetrics {
  readonly apiRateLimited = new Counter({
    name: 'srenautix_api_rate_limited_total',
    help: '控制台会话的读接口请求因过于频繁返回 429 的次数，按路由模板',
    labelNames: ['route'] as const,
    registers: [this.registry],
  });

  readonly githubIssues = new Counter({
    name: 'srenautix_github_issues_total',
    help: '事件 issue 的处理结果（opened、skipped_rate_limit、skipped_external、retry、failed、body_updated、title_updated）',
    labelNames: ['repo', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly githubComments = new Counter({
    name: 'srenautix_github_issue_comments_total',
    help: '事件 issue 上的进展评论与 PR 回链（posted、retry、failed）',
    labelNames: ['repo', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly ingestLastReceived = new Gauge({
    name: 'srenautix_ingest_last_received_timestamp_seconds',
    help: '每个接入源最近一次收到有效载荷的时间',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  readonly ingestAlerts = new Counter({
    name: 'srenautix_ingest_alerts_total',
    help: '接入的告警数，按接入源与结果（accepted、dropped_self、invalid）',
    labelNames: ['source', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly reconcileRuns = new Counter({
    name: 'srenautix_ingest_reconcile_runs_total',
    help: '告警对账次数，按结果',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly reconcileRepairs = new Counter({
    name: 'srenautix_ingest_reconcile_repairs_total',
    help: '对账修正的告警数，按类型（added、resolved）',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  readonly incidents = new Gauge({
    name: 'srenautix_incidents',
    help: '事件数，按状态',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });

  readonly stageARecomputes = new Counter({
    name: 'srenautix_stage_a_recomputes_total',
    help: '阶段 A 重算次数，按原因（manual：人工；pack_change：领域包变化后自动；before_research：研判前报告过期）',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly alertsReresolved = new Counter({
    name: 'srenautix_alerts_reresolved_total',
    help: '重算阶段 A 之前按当前解析规则重新解析并回写的告警数（升级前接入的告警，ADR 0107）',
    registers: [this.registry],
  });

  readonly remediations = new Counter({
    name: 'srenautix_remediations_total',
    help: '自愈 PR 的处理结果（ADR 0108），按类别与结果（proposed：已提交 gitops_pr 提议；skipped：模板跳过或不适用；rejected：提议未通过策略；failed：计划或校验失败）',
    labelNames: ['category', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly gitopsPulls = new Counter({
    name: 'srenautix_gitops_pulls_total',
    help: 'gitops_pr 开出并被 server 关联到事件的 PR 数，按来源（event：执行事件；lookup：按分支查询 GitHub）',
    labelNames: ['via'] as const,
    registers: [this.registry],
  });

  readonly detectorLastScan = new Gauge({
    name: 'srenautix_detector_last_scan_timestamp_seconds',
    help: '集群状态检测器最近一次收到完整对象状态上报的时间',
    labelNames: ['cluster_id'] as const,
    registers: [this.registry],
  });

  readonly detectorFindings = new Gauge({
    name: 'srenautix_detector_findings',
    help: '当前不健康的对象数（未按阈值过滤），按状态',
    labelNames: ['cluster_id', 'kind'] as const,
    registers: [this.registry],
  });

  readonly detectorAlerts = new Counter({
    name: 'srenautix_detector_alerts_total',
    help: '检测器合成的告警数，按状态',
    labelNames: ['cluster_id', 'kind'] as const,
    registers: [this.registry],
  });

  readonly detectorRefired = new Counter({
    name: 'srenautix_detector_refired_total',
    help: '检测器的发现仍然成立、告警却已不在触发而重新触发的告警数（ADR 0128）',
    labelNames: ['cluster_id'] as const,
    registers: [this.registry],
  });

  readonly detectorScanErrors = new Counter({
    name: 'srenautix_detector_scan_errors_total',
    help: '检测器一轮检测失败的次数',
    labelNames: ['cluster_id'] as const,
    registers: [this.registry],
  });

  readonly incidentDetection = new Histogram({
    name: 'srenautix_incident_detection_seconds',
    help: '首个症状（最早的成员告警开始时间）到事件创建的时长，按来源（alert：告警规则；detector：集群状态检测器）',
    labelNames: ['source'] as const,
    buckets: [10, 30, 60, 90, 120, 180, 300, 600, 1200, 3600],
    registers: [this.registry],
  });

  readonly incidentPersistErrors = new Counter({
    name: 'srenautix_incident_persist_errors_total',
    help: '事件重算中写入失败、回滚到保存点的事件组数（其余事件照常写入，ADR 0132）',
    labelNames: ['cluster_id'] as const,
    registers: [this.registry],
  });

  readonly topologyQuery = new Histogram({
    name: 'srenautix_topology_query_seconds',
    help: '时间点拓扑查询的耗时（ADR 0144），query 为 at、subgraph、neighborhood；source 为 db、cache（命中缓存）、shared（并入进行中的同一查询）',
    labelNames: ['query', 'source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly topologyCompacted = new Counter({
    name: 'srenautix_topology_compacted_rows_total',
    help: '拓扑历史压缩删除的行数（ADR 0144）',
    registers: [this.registry],
  });

  readonly incidentRecomputeDuration = new Histogram({
    name: 'srenautix_incident_recompute_duration_seconds',
    help: '一次事件重算与对账的耗时',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });

  readonly stageALatency = new Histogram({
    name: 'srenautix_stage_a_latency_seconds',
    help: '从首次触发到阶段 A 报告发出的时长（DESIGN §7.1 SLO：p95 ≤60 秒）',
    buckets: [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 300],
    registers: [this.registry],
  });

  readonly stageARuns = new Counter({
    name: 'srenautix_stage_a_runs_total',
    help: '阶段 A 运行次数，按处置判断与是否降级',
    labelNames: ['disposition', 'degraded'] as const,
    registers: [this.registry],
  });

  readonly evidenceCards = new Counter({
    name: 'srenautix_stage_a_evidence_cards_total',
    help: '阶段 A 与实时重跑执行的证据卡，按显示状态（runtime_error 表示卡没有执行）',
    labelNames: ['display_state'] as const,
    registers: [this.registry],
  });

  readonly evidenceCardSeconds = new Histogram({
    name: 'srenautix_stage_a_evidence_card_seconds',
    help: '单张证据卡的执行时长（取数与判定）',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
    registers: [this.registry],
  });

  readonly evidenceNovelty = new Counter({
    name: 'srenautix_stage_a_evidence_novelty_total',
    help: '异常卡的证据基线判定（ADR 0153）：novel 明显异常，routine 常态，unknown 基线样本不足',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });

  readonly ruleErrors = new Counter({
    name: 'srenautix_stage_a_rule_errors_total',
    help: '规则提议求值出错的次数，按规则 <pack>/<rule id>',
    labelNames: ['rule'] as const,
    registers: [this.registry],
  });

  readonly researchAdmissions = new Counter({
    name: 'srenautix_research_admissions_total',
    help: '阶段 B 入队判定，按结果（queued、coalesced、capped、storm、budget、no_model_route、duplicate）',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly researchQueue = new Gauge({
    name: 'srenautix_research_queue',
    help: '阶段 B 队列中的任务数，按状态',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });

  readonly notifySent = new Counter({
    name: 'srenautix_notify_messages_total',
    help: '渠道消息发送与编辑次数',
    labelNames: ['channel', 'op'] as const,
    registers: [this.registry],
  });

  readonly notifyFailures = new Counter({
    name: 'srenautix_notify_delivery_failures_total',
    help: '渠道投递失败次数',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  readonly notifyAbandoned = new Counter({
    name: 'srenautix_notify_abandoned_total',
    help: '放弃投递的消息内容（渠道永久拒绝且纯文本降级仍失败，或已结束事件的编辑次数用完），按渠道与原因；不计入投递失败',
    labelNames: ['channel', 'reason'] as const,
    registers: [this.registry],
  });

  readonly notifyPending = new Gauge({
    name: 'srenautix_notify_pending',
    help: '尚未呈现最新内容的消息数，按渠道',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  readonly callbacks = new Counter({
    name: 'srenautix_notify_callbacks_total',
    help: '渠道按钮回调，按渠道、动作与结果',
    labelNames: ['channel', 'action', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly feedback = new Counter({
    name: 'srenautix_feedback_total',
    help: '反馈条数（含隐式反馈），按是否来自已绑定账号与渠道',
    labelNames: ['linked', 'channel', 'implicit'] as const,
    registers: [this.registry],
  });

  readonly proposals = new Counter({
    name: 'srenautix_proposals_total',
    help: '提议状态迁移，按动作、来源与新状态',
    labelNames: ['action', 'source', 'state'] as const,
    registers: [this.registry],
  });

  readonly approvals = new Counter({
    name: 'srenautix_approval_assertions_total',
    help: '签发的审批断言，按档位与渠道',
    labelNames: ['tier', 'channel'] as const,
    registers: [this.registry],
  });

  readonly logins = new Counter({
    name: 'srenautix_logins_total',
    help: '登录尝试，按方式与结果',
    labelNames: ['method', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly auditExportLag = new Gauge({
    name: 'srenautix_audit_export_lag_seconds',
    help: '审计链最早一条未导出记录的等待时间',
    labelNames: ['chain'] as const,
    registers: [this.registry],
  });

  readonly eventsServed = new Counter({
    name: 'srenautix_events_served_total',
    help: '经 /v1/events 投递的事件数，按方式（poll、sse）',
    labelNames: ['mode'] as const,
    registers: [this.registry],
  });
}

export function startMetricsServer(registry: Registry, host: string | undefined, port: number): Server {
  const s = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((text) => {
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(text);
      })
      .catch((e: Error) => {
        logger.error('指标导出失败', { error: e });
        res.writeHead(500).end();
      });
  });
  s.listen(port, host);
  return s;
}
