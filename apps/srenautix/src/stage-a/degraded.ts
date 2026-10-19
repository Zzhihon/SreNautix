import type { Alert, Incident, StageAReport, TopologyEdge, TopologyNode } from '@srenautix/contract';
import {
  classifyAlert,
  computeIncidents,
  reconcileIncidents,
  TopologyGraph,
  type AlertCatalog,
  type ResolvedRcaParams,
} from '@srenautix/core';
import { alertId, type RawAlert } from '../ingest/normalize.js';
import { logger } from '../log.js';
import type { ServerMetrics } from '../metrics.js';
import { composeMessage } from '../notify/compose.js';
import type { DesiredIncidentMessage } from '../notify/ports.js';
import type { EvidenceRunner } from './ports.js';
import { buildReport, verdictFingerprint } from './report.js';

export interface DegradedSettings {
  clusterId: string;
  prefix: string;
  consoleUrl: string;
  language: 'zh' | 'en';
  severities: string[];
}

export interface DirectSender {
  sendDirect(msg: DesiredIncidentMessage): Promise<number>;
}

/**
 * 状态库不可用时的阶段 A 通道（DESIGN §7.1、§15.1）：以最后一轮成功对账的告警、拓扑与事件为起点，
 * 把降级期间接入的告警合并进内存，重算并对账事件，执行证据卡（数据源不依赖 PG），生成带"状态库降级"横幅的报告，
 * 直接调用渠道发送。PG 恢复后由正常流水线从接入日志补写与告警源对账重建，通知层 backfill 已发出的消息。
 */
export class DegradedLane {
  private alerts = new Map<string, Alert>();
  private nodes: TopologyNode[] = [];
  private edges: TopologyEdge[] = [];
  private topologyVersion = 0;
  private incidents: Incident[] = [];
  private sentVersions = new Map<string, number>();
  active = false;

  constructor(
    private readonly s: DegradedSettings,
    private readonly catalog: AlertCatalog,
    private readonly params: () => ResolvedRcaParams,
    private readonly evidence: EvidenceRunner,
    private readonly sender: DirectSender,
    private readonly metrics: ServerMetrics,
  ) {}

  /** 每轮成功对账后保存起点。 */
  snapshot(state: {
    alerts: Alert[];
    nodes: TopologyNode[];
    edges: TopologyEdge[];
    topologyVersion: number;
    incidents: Incident[];
  }): void {
    this.alerts = new Map(state.alerts.map((a) => [a.alert_id, a]));
    this.nodes = state.nodes;
    this.edges = state.edges;
    this.topologyVersion = state.topologyVersion;
    this.incidents = state.incidents;
    this.sentVersions = new Map(state.incidents.map((i) => [i.incident_id, i.incident_version]));
  }

  /** 降级期间接入的告警：只按目录分类，实体与组件取标签（拓扑查询需要 PG）。 */
  ingest(raws: RawAlert[], now: Date): void {
    for (const r of raws) {
      const id = alertId(r.fingerprint, r.startsAt);
      const ns = r.labels.namespace;
      const a: Alert = {
        alert_id: id,
        cluster_id: this.s.clusterId,
        source: r.source,
        fingerprint: r.fingerprint,
        alertname: r.alertname,
        labels: r.labels,
        annotations: r.annotations,
        severity: r.severity,
        status: r.status,
        suppressed: r.suppressed,
        starts_at: r.startsAt.toISOString(),
        ends_at: r.endsAt ? r.endsAt.toISOString() : null,
        generator_url: r.generatorUrl,
        classification: classifyAlert({ labels: r.labels, chronic: false }, this.catalog),
        entity: null,
        entity_resolution: 'unresolved',
        component: ns ? `Namespace:${ns}` : null,
        received_at: now.toISOString(),
      };
      this.alerts.set(id, a);
    }
  }

  /** 重算并发送有变化的事件；返回发送的消息数。 */
  async run(now: Date): Promise<number> {
    this.active = true;
    const graph = new TopologyGraph(this.nodes, this.edges, this.topologyVersion);
    const alerts = [...this.alerts.values()];
    const computed = computeIncidents({ alerts, changes: [], graph, params: this.params(), now: now.getTime() });
    const r = reconcileIncidents({
      clusterId: this.s.clusterId,
      previous: this.incidents,
      computed,
      topologyVersion: this.topologyVersion,
      now: now.getTime(),
    });
    const current = new Map(this.incidents.map((i) => [i.incident_id, i]));
    for (const inc of r.incidents) {
      current.set(inc.incident_id, inc);
    }
    this.incidents = [...current.values()].filter((i) => i.state !== 'merged');
    let sent = 0;
    for (const inc of r.incidents) {
      if (inc.state === 'merged' || !this.s.severities.includes(inc.severity) || inc.suppressed) {
        continue;
      }
      if (this.sentVersions.get(inc.incident_id) === inc.incident_version) {
        continue;
      }
      const memberIds = new Set(inc.members.filter((m) => m.left_version === null).map((m) => m.alert_id));
      const own = alerts.filter((a) => memberIds.has(a.alert_id));
      const cards = await this.evidence.run(inc, own, AbortSignal.timeout(40_000));
      const report: StageAReport = buildReport({
        incident: inc,
        alerts: own,
        cards,
        ruleActions: 0,
        excludedBy: null,
        runbooks: this.evidence.runbooks(inc),
        ruleProposalIds: [],
        fingerprint: verdictFingerprint(cards),
        degraded: true,
        now,
      });
      const { message, targets } = composeMessage({
        incident: inc,
        stageA: report,
        alerts: own,
        research: null,
        researchPending: false,
        stageAOnlyReason: null,
        proposals: [],
        feedback: null,
        prefix: this.s.prefix,
        consoleUrl: this.s.consoleUrl,
        language: this.s.language,
      });
      sent += await this.sender.sendDirect({
        incidentId: inc.incident_id,
        clusterId: inc.cluster_id,
        label: inc.label,
        severity: inc.severity,
        state: inc.state,
        firstFiringAt: new Date(inc.first_firing_at),
        endedAt: inc.ended_at ? new Date(inc.ended_at) : null,
        lane: inc.state === 'resolved' ? 'recovery' : 'urgent',
        message,
        targets,
        language: this.s.language,
      });
      this.sentVersions.set(inc.incident_id, inc.incident_version);
      this.metrics.stageARuns.inc({ disposition: report.disposition, degraded: 'true' });
      if (inc.incident_version === 1) {
        this.metrics.stageALatency.observe((now.getTime() - new Date(inc.first_firing_at).getTime()) / 1000);
      }
      logger.warn('状态库降级：阶段 A 报告直接发送', { incident_id: inc.incident_id, label: inc.label });
    }
    return sent;
  }

  recovered(): void {
    this.active = false;
  }
}
