import type { Alert, Feedback, Incident, NotifyMessage, Proposal, StageAReport } from '@srenautix/contract';
import type pg from 'pg';
import { subgraphOf } from '../console-bff/routes-incidents.js';
import { alertsById } from '../ingest/store.js';
import type { FeedbackService } from '../proposals/feedback.js';
import type { ProposalService } from '../proposals/service.js';
import { pullsOf } from '../remediation/pulls.js';
import type { TopologyStore } from '../topology/store.js';
import { composeMessage, laneOf, type ActionVerify, type ComposeInput, type ResearchMirror } from './compose.js';
import { impactLine, type Classification, type ExternalRoots, type ExternalWindowStats } from './external.js';
import type { LinkSettings } from './links.js';
import type { DesiredIncidentMessage, MessageSource } from './ports.js';
import { withComponentNames } from '../incident/names.js';
import { researchRoots, type OwnerLookup } from '../incident/research-root.js';

export interface SourceSettings {
  prefix: string;
  consoleUrl: string;
  severities: string[];
  resolvedRetentionMs: number;
}

/** 报告需要的领域数据：告警目录的可读标题、动作目录的执行后校验、链接模板 */
export interface ReportDomain {
  alertTitle: (a: Alert, language: 'zh' | 'en') => string | null;
  actionVerify: (actionId: string) => ActionVerify | null;
  links: Omit<LinkSettings, 'consoleUrl'>;
}

/**
 * 事件报告的输入（ADR 0125）：事件、最新与研判所用版本的阶段 A 报告、研判镜像、提议、反馈、成员告警与研判子图。
 * 通知（Telegram、飞书）与事件 issue 共用。
 */
export class ReportSource {
  constructor(
    private readonly pool: pg.Pool,
    private readonly feedback: FeedbackService,
    private readonly topology: TopologyStore,
    private readonly domain: ReportDomain,
    private readonly s: { prefix: string; consoleUrl: string },
    /** 研判根因与事件根因按属主粒度比较时取顶层属主（ADR 0104 §14）；不提供时只按键比较 */
    private readonly ownerOf: OwnerLookup = async () => null,
  ) {}

  /** 若干事件的报告输入，顺序与 rows 相同 */
  async inputs(rows: Array<{ body: Incident; report: StageAReport }>, language: 'zh' | 'en'): Promise<ComposeInput[]> {
    if (!rows.length) {
      return [];
    }
    const ids = rows.map((x) => x.body.incident_id);
    const props = await this.pool.query<{ incident_id: string; body: Proposal }>(
      'SELECT incident_id, body FROM server.proposals WHERE incident_id = ANY($1::uuid[])',
      [ids],
    );
    const runs = await this.pool.query<ResearchMirror & { incident_id: string }>(
      `SELECT DISTINCT ON (incident_id) incident_id, run_id, state, disposition, conclusion_level, root_component, output, error,
              incident_version, started_at::text AS started_at, finished_at::text AS finished_at
         FROM server.research_runs WHERE incident_id = ANY($1::uuid[]) ORDER BY incident_id, started_at DESC`,
      [ids],
    );
    const queue = await this.pool.query<{ incident_id: string; state: string; skip_reason: string | null }>(
      `SELECT DISTINCT ON (incident_id) incident_id, state, skip_reason FROM server.research_queue
        WHERE incident_id = ANY($1::uuid[]) ORDER BY incident_id, enqueued_at DESC`,
      [ids],
    );
    const fbs: Map<string, Feedback> = await this.feedback.latest(this.pool, ids);
    const roots = await researchRoots(
      this.pool,
      this.ownerOf,
      rows.map((x) => ({
        incident_id: x.body.incident_id,
        cluster_id: x.body.cluster_id,
        root_component: x.body.root.component,
      })),
    );
    const pulls = await pullsOf(this.pool, ids);
    const propMap = new Map<string, Proposal[]>();
    for (const x of props.rows) {
      propMap.set(x.incident_id, [...(propMap.get(x.incident_id) ?? []), x.body]);
    }
    const runMap = new Map(
      runs.rows.map((x) => [
        x.incident_id,
        {
          ...x,
          started_at: x.started_at ? new Date(x.started_at).toISOString() : null,
          finished_at: x.finished_at ? new Date(x.finished_at).toISOString() : null,
        },
      ]),
    );
    const queueMap = new Map(queue.rows.map((x) => [x.incident_id, x]));
    const out: ComposeInput[] = [];
    for (const { body: raw, report } of rows) {
      const inc = await withComponentNames(this.pool, raw);
      const q = queueMap.get(inc.incident_id);
      const run = runMap.get(inc.incident_id) ?? null;
      // 研判输出中的 card:<n> 按研判所用事件版本的阶段 A 报告编号
      let researchStageA: StageAReport | null = null;
      if (run?.state === 'completed' && run.incident_version !== undefined) {
        const r = await this.pool.query<{ body: StageAReport }>(
          'SELECT body FROM server.stage_a_reports WHERE incident_id = $1 AND incident_version = $2',
          [inc.incident_id, run.incident_version],
        );
        researchStageA = r.rows[0]?.body ?? null;
      }
      const alerts = await alertsById(
        this.pool,
        inc.members.filter((m) => m.left_version === null).map((m) => m.alert_id),
      );
      out.push({
        incident: inc,
        stageA: report,
        researchStageA,
        alerts,
        research: run,
        researchRootMismatch: roots.get(inc.incident_id)?.mismatch ?? false,
        researchPending: q?.state === 'queued' || q?.state === 'leased',
        stageAOnlyReason: q?.state === 'skipped' ? q.skip_reason : null,
        proposals: propMap.get(inc.incident_id) ?? [],
        pulls,
        feedback: fbs.get(inc.incident_id) ?? null,
        prefix: this.s.prefix,
        consoleUrl: this.s.consoleUrl,
        language,
        subgraph: await subgraphOf(this.topology, inc, 2),
        alertTitle: (a) => this.domain.alertTitle(a, language),
        actionVerify: this.domain.actionVerify,
        links: this.domain.links,
      });
    }
    return out;
  }

  /** 一个事件的消息（最新阶段 A 报告）；事件或报告不存在时为 null */
  async message(incidentId: string, language: 'zh' | 'en'): Promise<NotifyMessage | null> {
    const r = await this.pool.query<{ body: Incident; report: StageAReport }>(
      `SELECT i.body, s.body AS report FROM server.incidents i
         JOIN LATERAL (SELECT body FROM server.stage_a_reports WHERE incident_id = i.incident_id ORDER BY incident_version DESC LIMIT 1) s ON true
        WHERE i.incident_id = $1`,
      [incidentId],
    );
    const [input] = await this.inputs(r.rows, language);
    return input ? composeMessage(input).message : null;
  }
}

/**
 * 期望消息的来源：已有阶段 A 报告、严重度在推送范围内、没有被 SreNautix 抑制的事件；恢复或合并后在保留期内继续编辑。
 */
export class PgMessageSource implements MessageSource {
  /** 外部上游汇总时实现（ADR 0147） */
  readonly externalWindow?: (from: Date, to: Date) => Promise<ExternalWindowStats>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly s: SourceSettings,
    private readonly proposals: ProposalService,
    private readonly reports: ReportSource,
    /** 外部上游的分类（ADR 0147）；没有或没有启用时照常推送全部事件 */
    private readonly external: ExternalRoots | null = null,
  ) {
    if (external?.s.enabled) {
      this.externalWindow = (from, to) => this.window(from, to);
    }
  }

  async desired(language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]> {
    const r = await this.pool.query<{ body: Incident; report: StageAReport }>(
      `SELECT i.body, s.body AS report FROM server.incidents i
         JOIN LATERAL (SELECT body FROM server.stage_a_reports WHERE incident_id = i.incident_id ORDER BY incident_version DESC LIMIT 1) s ON true
        WHERE i.severity = ANY($1::text[]) AND NOT i.suppressed
          AND (i.state = 'firing' OR i.updated_at > now() - make_interval(secs => $2))
        ORDER BY i.first_firing_at`,
      [this.s.severities, this.s.resolvedRetentionMs / 1000],
    );
    return this.compose(r.rows, language);
  }

  async byIds(incidentIds: readonly string[], language: 'zh' | 'en'): Promise<DesiredIncidentMessage[]> {
    if (!incidentIds.length) {
      return [];
    }
    const r = await this.pool.query<{ body: Incident; report: StageAReport }>(
      `SELECT i.body, s.body AS report FROM server.incidents i
         JOIN LATERAL (SELECT body FROM server.stage_a_reports WHERE incident_id = i.incident_id ORDER BY incident_version DESC LIMIT 1) s ON true
        WHERE i.incident_id = ANY($1::uuid[])
        ORDER BY i.first_firing_at`,
      [incidentIds],
    );
    return this.compose(r.rows, language);
  }

  private async compose(
    rows: Array<{ body: Incident; report: StageAReport }>,
    language: 'zh' | 'en',
  ): Promise<DesiredIncidentMessage[]> {
    const inputs = await this.reports.inputs(rows, language);
    const cls = this.external ? await this.external.classify(inputs) : new Map<string, Classification>();
    return inputs.map((input) => {
      const inc = input.incident;
      const c = cls.get(inc.incident_id);
      // 外部上游伴随相关的业务影响时即时推送，横幅写明“上游故障已影响业务”与每个信号的依据（ADR 0150）；
      // 没有业务影响时进入周期汇总
      const { message, targets } = composeMessage(
        c?.external && c.impact.length
          ? { ...input, upstreamImpact: c.impact.map((x) => impactLine(x, input.language, inc.component_names)) }
          : input,
      );
      return {
        ...(c?.external && !c.impact.length ? { digest: 'external' as const } : {}),
        incidentId: inc.incident_id,
        clusterId: inc.cluster_id,
        label: inc.label,
        severity: inc.severity,
        state: inc.state,
        firstFiringAt: new Date(inc.first_firing_at),
        endedAt: inc.ended_at ? new Date(inc.ended_at) : null,
        lane: laneOf(inc, input.proposals),
        message,
        targets,
        language,
      };
    });
  }

  async delivered(_incidentId: string, proposalIds: string[], at: Date): Promise<void> {
    await this.proposals.delivered(proposalIds, at);
  }

  /** [from, to) 内触发过的事件（推送范围内的严重度、没有被抑制、没有合并）的外部上游统计 */
  private async window(from: Date, to: Date): Promise<ExternalWindowStats> {
    const r = await this.pool.query<{ body: Incident; report: StageAReport }>(
      `SELECT i.body, s.body AS report FROM server.incidents i
         JOIN LATERAL (SELECT body FROM server.stage_a_reports WHERE incident_id = i.incident_id ORDER BY incident_version DESC LIMIT 1) s ON true
        WHERE i.severity = ANY($1::text[]) AND NOT i.suppressed AND i.state <> 'merged'
          AND i.first_firing_at < $3 AND (i.ended_at IS NULL OR i.ended_at >= $2)
        ORDER BY i.first_firing_at`,
      [this.s.severities, from, to],
    );
    const inputs = await this.reports.inputs(r.rows, 'zh');
    return (this.external as ExternalRoots).window(inputs, from, to);
  }

  /**
   * 事件 issue 用（ADR 0147）：根因是外部上游且没有业务影响时返回事件状态（firing 或 ended），issue 不开；
   * 其余事件、没有启用汇总时为 null，照常处理
   */
  async externalState(incidentId: string): Promise<'firing' | 'ended' | null> {
    if (!this.external?.s.enabled) {
      return null;
    }
    const r = await this.pool.query<{ body: Incident; report: StageAReport }>(
      `SELECT i.body, s.body AS report FROM server.incidents i
         JOIN LATERAL (SELECT body FROM server.stage_a_reports WHERE incident_id = i.incident_id ORDER BY incident_version DESC LIMIT 1) s ON true
        WHERE i.incident_id = $1`,
      [incidentId],
    );
    if (!r.rows.length) {
      return null;
    }
    const firing = await this.pool.query<{ body: Incident; report: StageAReport }>(
      `SELECT i.body, s.body AS report FROM server.incidents i
         JOIN LATERAL (SELECT body FROM server.stage_a_reports WHERE incident_id = i.incident_id ORDER BY incident_version DESC LIMIT 1) s ON true
        WHERE i.cluster_id = $1 AND i.state = 'firing' AND NOT i.suppressed AND i.incident_id <> $2`,
      [r.rows[0]!.body.cluster_id, incidentId],
    );
    const inputs = await this.reports.inputs([...r.rows, ...firing.rows], 'zh');
    const c = (await this.external.classify(inputs)).get(incidentId);
    if (!c?.external || c.impact.length) {
      return null;
    }
    return r.rows[0]!.body.state === 'firing' ? 'firing' : 'ended';
  }
}
