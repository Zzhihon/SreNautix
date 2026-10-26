import type { Alert, ComponentType, EvalSnapshot, Incident, StageAReport } from '@srenautix/contract';
import { isBusinessImpact } from '../alerts/business-impact.js';
import { externalRootSettings } from '../config/server.js';
import {
  dependencyPath,
  ExternalRoots,
  externalTypeLookup,
  type ClassifyInput,
  type ExternalRootSettings,
  type ImpactAlert,
  type ImpactAlertSource,
} from '../notify/external.js';
import type { ReconstructConfig } from './config.js';
import type { BundleTopology, Replay } from './reconstruct.js';
import type { RunRecord } from './score.js';

// 误推送的判定（ADR 0175）：重建出的事件按 server 的通知规则会不会推送新消息，与 notify/source.ts 的 desired 与
// notify/engine.ts 的过滤相同：
// - 严重度在推送范围内（reconstruct.notify.severities）；
// - 没有被抑制；
// - 阶段 A 不是计划内退役（disposition_reason=planned_retirement，ADR 0167）；
// - 不是没有业务影响的外部上游（ADR 0147、0150）：外部上游的分类按这次运行的研判根因（研判完成时取结论选中的根因，
//   否则取事件根因），业务影响取本事件的影响卡、与上游事件相关的业务影响告警、其他触发中事件的影响卡。
// 重建评测的业务影响告警与其他事件取自重建包在分析时刻的状态；快照评测只有快照里的成员告警，没有其他事件与拓扑路径。

export interface PushSettings {
  severities: readonly string[];
  external: ExternalRootSettings;
}

export function pushSettings(r: ReconstructConfig): PushSettings {
  return {
    severities: r.notify.severities,
    external: externalRootSettings(
      r.notify.digest.external_roots,
      r.business_impact_alerts,
      'reconstruct.notify.digest.external_roots',
    ),
  };
}

/** 分析时刻的主事件：事件、阶段 A 报告与成员告警 */
export interface PushSubject {
  incident: Incident;
  stageA: StageAReport;
  alerts: Alert[];
}

const language = (locale: 'zh-CN' | 'en'): 'zh' | 'en' => (locale === 'en' ? 'en' : 'zh');

export class PushJudge {
  private others: Promise<ClassifyInput[]> | null = null;

  constructor(
    private readonly s: PushSettings,
    private readonly subject: PushSubject,
    private readonly lang: 'zh' | 'en',
    /** 外部上游的分类；外部上游汇总没有启用时为 null */
    private readonly classifier: ExternalRoots | null,
    /** 同一集群其他触发中的事件（带阶段 A 的卡）；只在主事件是外部上游时读取一次 */
    private readonly otherIncidents: () => Promise<ClassifyInput[]>,
  ) {}

  /** 这次运行的研判结论下，事件会不会推送新消息 */
  async pushed(r: Pick<RunRecord, 'state' | 'root'>): Promise<boolean> {
    const inc = this.subject.incident;
    if (!this.s.severities.includes(inc.severity) || inc.suppressed) {
      return false;
    }
    if (this.subject.stageA.disposition_reason === 'planned_retirement') {
      return false;
    }
    if (!this.classifier) {
      return true;
    }
    const main: ClassifyInput = {
      incident: inc,
      alerts: this.subject.alerts,
      stageA: this.subject.stageA,
      language: this.lang,
      research:
        r.state === 'completed'
          ? { state: 'completed', output: { conclusion: { root_component: r.root ?? null } } }
          : null,
    };
    if (!(await this.classifier.isExternal(main))) {
      return true;
    }
    this.others ??= this.otherIncidents();
    const c = (await this.classifier.classify([main, ...(await this.others)])).get(inc.incident_id);
    return !(c?.external && !c.impact.length);
  }
}

/** 业务影响告警的来源：分析时刻触发中的告警里满足条件的 */
function impactAlertsOf(firing: readonly Alert[]): ImpactAlertSource {
  return async (clusterIds, matchers) =>
    firing
      .filter((a) => clusterIds.includes(a.cluster_id) && isBusinessImpact(a.labels, matchers))
      .sort((x, y) => x.starts_at.localeCompare(y.starts_at) || x.alert_id.localeCompare(y.alert_id))
      .map((a): ImpactAlert => ({
        cluster_id: a.cluster_id,
        alertname: a.alertname,
        component: a.component,
        starts_at: a.starts_at,
        ends_at: null,
      }));
}

/**
 * 重建评测的判定：业务影响告警取重建包在分析时刻触发中的告警，组件类型与依赖路径取重建拓扑在分析时刻的状态，
 * 其他事件取分析时刻触发中的事件（阶段 A 的卡由 cardsOf 计算）
 */
export function replayPushJudge(o: {
  settings: PushSettings;
  replay: Replay;
  topology: BundleTopology;
  types: () => readonly ComponentType[];
  subject: PushSubject;
  asOf: number;
  locale: 'zh-CN' | 'en';
  cardsOf: (inc: Incident, alerts: Alert[]) => Promise<StageAReport['cards']>;
}): PushJudge {
  const lang = language(o.locale);
  // 分析时刻触发中的告警（与重放相同：firing_from 之后、firing_to 之前）
  const alerts = [...o.replay.alerts.values()]
    .filter(
      ({ instance }) =>
        Date.parse(instance.firing_from) <= o.asOf &&
        (instance.firing_to === null || Date.parse(instance.firing_to) > o.asOf),
    )
    .map(({ alert }) => alert);
  const graph = o.topology.at(o.asOf).graph;
  const xr = o.settings.external;
  const classifier = xr.enabled
    ? new ExternalRoots(
        impactAlertsOf(alerts),
        xr,
        externalTypeLookup(o.types, async (_c, key) => o.topology.componentType(key, o.asOf)),
        async (_c, from, to) =>
          xr.impact.topologyHops > 0 ? dependencyPath(graph, from, to, xr.impact.topologyHops) : null,
        () => o.asOf,
      )
    : null;
  return new PushJudge(o.settings, o.subject, lang, classifier, async () => {
    const out: ClassifyInput[] = [];
    for (const x of (o.replay.captured ?? o.replay.incidents).values()) {
      const inc = x.incident;
      if (inc.incident_id === o.subject.incident.incident_id || inc.state !== 'firing') {
        continue;
      }
      const active = new Set(inc.members.filter((m) => m.left_version === null).map((m) => m.alert_id));
      const members = alerts.filter((a) => active.has(a.alert_id));
      out.push({
        incident: inc,
        alerts: members,
        stageA: { cards: xr.impact.impactCards ? await o.cardsOf(inc, members) : [] },
        language: lang,
        research: null,
      });
    }
    return out;
  });
}

/**
 * 快照评测的判定：只有快照里的事件、阶段 A 报告与成员告警。组件类型按领域包的组件类型与名字匹配；没有其他事件与拓扑路径，
 * 业务影响只看本事件的影响卡与在时间窗内开始的成员告警
 */
export function snapshotPushJudge(
  settings: PushSettings,
  s: EvalSnapshot,
  types: () => readonly ComponentType[],
  locale: 'zh-CN' | 'en',
): PushJudge {
  const alerts = s.context.alerts as unknown as Alert[];
  const subject: PushSubject = {
    incident: s.context.incident as unknown as Incident,
    stageA: s.context.stage_a as unknown as StageAReport,
    alerts,
  };
  const xr = settings.external;
  const asOf = Date.parse(s.as_of);
  const classifier = xr.enabled
    ? new ExternalRoots(
        impactAlertsOf(alerts.filter((a) => a.status === 'firing' && Date.parse(a.starts_at) <= asOf)),
        xr,
        externalTypeLookup(types, async () => null),
        async () => null,
        () => asOf,
      )
    : null;
  return new PushJudge(settings, subject, language(locale), classifier, async () => []);
}
