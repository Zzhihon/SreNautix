import type pg from 'pg';
import type { Alert, EvidenceResult } from '@srenautix/contract';
import type { PackRuntime } from '../stage-a/packs.js';
import { agreeAlerts, type AlertAgreement } from './agreement.js';
import { discoveryRoots, type Label } from './labels.js';
import { faultAlertIds, mainIncident, type Replay } from './reconstruct.js';

// 发现环节的度量（章程第二阶段 §3，ADR 0110）。
// 重建（每次故障）：
// - 事件数：曾经包含这次故障告警的事件数（验收：一次发布事故不超过 2 个）；
// - 根因命中：主事件（包含故障告警最多）在故障窗口结束时的根因落在标注的根因集合内；
// - 成员覆盖：主事件覆盖标注要求的组件（每项给出同义键，任一命中即可），并在某个版本引用过标注时刻前后 2 分钟内的变更；
// - unlabelled 占比：窗口内创建的事件中没有根因的比例；
// - 检测延迟：首个故障告警的 pending 开始时刻（首个症状）到故障告警第一次成为事件成员；重放开始前就在触发的告警不计。
// 影子环境（只读状态库）：一段时间内新建的事件数、unlabelled 占比、检测延迟（first_firing_at 到 created_at）的分位数、
// 阶段 A 报告有证据卡的比例。

export interface DiscoveryCase {
  label: string;
  type: Label['type'];
  fault_alerts: number;
  incidents: number;
  incident_labels: string[];
  main_label: string | null;
  main_root: string | null;
  root_hit: boolean | null;
  missing_members: string[][];
  change_found: boolean | null;
  first_symptom_at: string | null;
  detected_at: string | null;
  detection_latency_s: number | null;
  window_incidents: number;
  window_unlabelled: number;
  /** 发布类验收：事件数 ≤ 2、根因命中、成员与变更齐全 */
  passed: boolean;
}

const CHANGE_NEAR_MS = 2 * 60_000;

export function discoveryCase(r: Replay, l: Label): DiscoveryCase {
  const fault = faultAlertIds(r, l);
  const from = Date.parse(l.window.from);
  const to = Date.parse(l.window.to);
  const touching = [...r.incidents.values()].filter(
    (x) => x.incident.state !== 'merged' && [...x.everMembers].some((id) => fault.has(id)),
  );
  const main = mainIncident(r, fault);
  const comps = new Set(main ? [...main.incident.components, main.incident.root.component ?? ''] : []);
  const missing = main ? l.required_members.filter((alts) => !alts.some((k) => comps.has(k))) : l.required_members;
  const changeFound =
    l.required_change_near === null
      ? null
      : !!main &&
        [...main.everChanges.values()].some(
          (c) => Math.abs(Date.parse(c.time) - Date.parse(l.required_change_near as string)) <= CHANGE_NEAR_MS,
        );
  const roots = new Set(discoveryRoots(l));
  const rootHit =
    l.type === 'benign'
      ? null
      : !!main && main.incident.root.component !== null && roots.has(main.incident.root.component);
  // 只看重放开始之后才触发的故障告警：之前就在触发的告警，接入时刻是重放的起点，不代表检测
  const started = [...r.alerts.values()].filter(
    (x) => fault.has(x.alert.alert_id) && Date.parse(x.instance.firing_from) > r.start,
  );
  const symptom = started.map((x) => Date.parse(x.instance.active_at)).sort((a, b) => a - b)[0];
  const detected = started
    .map((x) => r.memberSince.get(x.alert.alert_id))
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b)[0];
  const inWindow = [...r.incidents.values()].filter(
    (x) => x.incident.state !== 'merged' && x.createdMs >= from && x.createdMs <= to,
  );
  const n = touching.length;
  return {
    label: l.id,
    type: l.type,
    fault_alerts: fault.size,
    incidents: n,
    incident_labels: touching.map((x) => x.incident.label).sort(),
    main_label: main?.incident.label ?? null,
    main_root: main?.incident.root.component ?? null,
    root_hit: rootHit,
    missing_members: missing,
    change_found: changeFound,
    first_symptom_at: symptom === undefined ? null : new Date(symptom).toISOString(),
    detected_at: detected === undefined ? null : new Date(detected).toISOString(),
    detection_latency_s:
      symptom === undefined || detected === undefined ? null : Math.max(0, (detected - symptom) / 1000),
    window_incidents: inWindow.length,
    window_unlabelled: inWindow.filter((x) => x.incident.root.component === null).length,
    passed: n > 0 && n <= 2 && (rootHit ?? true) && missing.length === 0 && (changeFound ?? true),
  };
}

export function quantile(xs: readonly number[], q: number): number | null {
  if (!xs.length) {
    return null;
  }
  const s = [...xs].sort((a, b) => a - b);
  // 最近秩：ceil(q·n) 位
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] as number;
}

export interface DiscoverySummary {
  faults: number;
  incidents_per_fault_mean: number | null;
  incidents_per_fault_max: number | null;
  root_hit: { n: number; d: number };
  unlabelled: { n: number; d: number };
  latency_p50_s: number | null;
  latency_p95_s: number | null;
  passed: { n: number; d: number };
}

export function summarizeDiscovery(cases: readonly DiscoveryCase[]): DiscoverySummary {
  const detected = cases.filter((c) => c.incidents > 0);
  const scored = cases.filter((c) => c.root_hit !== null);
  const lat = cases.map((c) => c.detection_latency_s).filter((x): x is number => x !== null);
  return {
    faults: cases.length,
    incidents_per_fault_mean: detected.length ? detected.reduce((a, c) => a + c.incidents, 0) / detected.length : null,
    incidents_per_fault_max: detected.length ? Math.max(...detected.map((c) => c.incidents)) : null,
    root_hit: { n: scored.filter((c) => c.root_hit).length, d: scored.length },
    unlabelled: {
      n: cases.reduce((a, c) => a + c.window_unlabelled, 0),
      d: cases.reduce((a, c) => a + c.window_incidents, 0),
    },
    latency_p50_s: quantile(lat, 0.5),
    latency_p95_s: quantile(lat, 0.95),
    passed: { n: cases.filter((c) => c.passed).length, d: cases.length },
  };
}

export interface LiveStats {
  since: string;
  until: string;
  incidents: number;
  unlabelled: number;
  latency_p50_s: number | null;
  latency_p95_s: number | null;
  latency_n: number;
  /** 阶段 A 最新报告有证据卡的事件 / 有阶段 A 报告的事件 */
  with_cards: { n: number; d: number };
  /** 有证据卡的事件中，至少一张卡得出结论（正常或异常）的比例 */
  with_determinate_card: { n: number; d: number };
  cards_median: number | null;
  /** 研判完成的事件与其中结论为 likely 或 evidence_consistent 的事件 */
  research: { finished: number; likely_or_better: number };
}

/**
 * 影子环境的证据卡与告警结论一致率（只读会话）：时间窗口内渲染的每份阶段 A 报告（每个事件取最新版本），
 * 成员告警在报告渲染时仍在触发的，与报告中的卡对照。
 */
export async function liveAgreement(
  q: Pick<pg.Client, 'query'>,
  rt: PackRuntime,
  clusterId: string,
  since: Date,
  until: Date,
): Promise<AlertAgreement[]> {
  const reports = await q.query<{ incident_id: string; rendered_at: Date; cards: EvidenceResult[] }>(
    `SELECT DISTINCT ON (s.incident_id) s.incident_id, s.rendered_at, s.body->'cards' AS cards
       FROM server.stage_a_reports s JOIN server.incidents i USING (incident_id)
      WHERE i.cluster_id = $1 AND s.rendered_at >= $2 AND s.rendered_at < $3
      ORDER BY s.incident_id, s.incident_version DESC`,
    [clusterId, since, until],
  );
  const out: AlertAgreement[] = [];
  for (const r of reports.rows) {
    const alerts = await q.query<{
      alertname: string;
      labels: Record<string, string>;
      entity: Alert['entity'];
    }>(
      `SELECT a.alertname, a.labels, a.entity FROM server.incident_members m JOIN server.alert_state a USING (alert_id)
        WHERE m.incident_id = $1 AND m.left_version IS NULL
          AND a.starts_at <= $2 AND (a.ends_at IS NULL OR a.ends_at > $2)`,
      [r.incident_id, r.rendered_at],
    );
    out.push(...agreeAlerts(rt, alerts.rows as unknown as Alert[], r.cards));
  }
  return out;
}

/** 影子环境的发现与阶段 A 统计（只读会话；时间窗口内新建、且首次触发不早于窗口起点的事件） */
export async function liveStats(
  q: Pick<pg.Client, 'query'>,
  clusterId: string,
  since: Date,
  until: Date,
): Promise<LiveStats> {
  const r = await q.query<{
    label: string;
    root_component: string | null;
    latency_s: number;
    cards: number | null;
    determinate: number | null;
  }>(
    `SELECT i.label, i.root_component,
            extract(epoch FROM (i.created_at - i.first_firing_at))::float8 AS latency_s,
            (SELECT jsonb_array_length(s.body->'cards') FROM server.stage_a_reports s
              WHERE s.incident_id = i.incident_id ORDER BY s.incident_version DESC LIMIT 1) AS cards,
            (SELECT count(*)::int FROM server.stage_a_reports s, jsonb_array_elements(s.body->'cards') c
              WHERE s.incident_id = i.incident_id
                AND s.incident_version = (SELECT max(s2.incident_version) FROM server.stage_a_reports s2 WHERE s2.incident_id = i.incident_id)
                AND c->>'verdict' IN ('normal', 'abnormal')) AS determinate
       FROM server.incidents i
      WHERE i.cluster_id = $1 AND i.created_at >= $2 AND i.created_at < $3 AND i.first_firing_at >= $2
        AND i.state <> 'merged'
      ORDER BY i.created_at`,
    [clusterId, since, until],
  );
  const rows = r.rows;
  const reported = rows.filter((x) => x.cards !== null);
  const withCards = reported.filter((x) => (x.cards as number) > 0);
  const research = await q.query<{ finished: number; likely: number }>(
    `SELECT count(DISTINCT rr.incident_id)::int AS finished,
            count(DISTINCT rr.incident_id) FILTER (WHERE rr.conclusion_level IN ('likely', 'evidence_consistent'))::int AS likely
       FROM server.research_runs rr JOIN server.incidents i USING (incident_id)
      WHERE i.cluster_id = $1 AND i.created_at >= $2 AND i.created_at < $3 AND rr.state = 'completed'`,
    [clusterId, since, until],
  );
  const lat = rows.map((x) => x.latency_s);
  const cardCounts = withCards.map((x) => x.cards as number);
  return {
    since: since.toISOString(),
    until: until.toISOString(),
    incidents: rows.length,
    unlabelled: rows.filter((x) => x.root_component === null).length,
    latency_p50_s: quantile(lat, 0.5),
    latency_p95_s: quantile(lat, 0.95),
    latency_n: lat.length,
    with_cards: { n: withCards.length, d: reported.length },
    with_determinate_card: { n: withCards.filter((x) => (x.determinate ?? 0) > 0).length, d: withCards.length },
    cards_median: quantile(cardCounts, 0.5),
    research: { finished: research.rows[0]?.finished ?? 0, likely_or_better: research.rows[0]?.likely ?? 0 },
  };
}
