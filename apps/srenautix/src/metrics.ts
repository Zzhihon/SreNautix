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

  readonly researchAdmissions = new Counter({
    name: 'srenautix_research_admissions_total',
    help: '阶段 B 入队判定，按结果（queued、coalesced、capped、storm、budget、duplicate）',
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
