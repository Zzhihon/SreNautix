import type { Alert, ChangeEvent, Incident } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { deriveDisposition, type DispositionInput } from '../../src/research/disposition.js';
import { incidentBook } from '../../src/research/incident.js';
import { disposition, plannedRetirement } from '../../src/stage-a/report.js';
import { incident as baseIncident, researchCase, stageA, stageACards } from '../support/scenario.js';

// 计划内退役判为 ignore（ADR 0167）：一个存储组件按计划退役，先合并删除它的 Git 提交，再删除 StatefulSet，十分钟后
// "抓取 job 的目标全部消失"告警触发。事件的全部成员告警都由带 planned_by 的退役解释、成员中没有业务影响告警时，
// 阶段 A 判为 ignore（planned_retirement），阶段 B 的依据记为 planned_retirement

const T = Date.parse('2026-10-24T02:52:00Z');
const at = (min: number) => new Date(T + min * 60_000).toISOString();
const APP = 'Application.argoproj.io:argocd/objstore';
const MASTER = 'StatefulSet:storage/objstore-master';
const VOLUME = 'StatefulSet:storage/objstore-volume';

const retire = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  change_id: 'kubernetes:c1:retire-1a2b',
  source: 'kubernetes',
  kind: 'retire',
  refs: [APP],
  revision: null,
  actor: null,
  time: at(0),
  link: null,
  targets: [APP, MASTER, VOLUME],
  summary: 'objstore-master 已删除；objstore-volume 已删除；抓取 job objstore 失去全部 3 个目标',
  scrape_jobs: ['objstore'],
  planned_by: [
    {
      change_id: 'github:ops#302',
      revision: '6a701ff',
      time: at(-8),
      link: 'https://git.example.com/ops/commit/6a701ff',
      summary: 'retire objstore',
    },
  ],
  ...over,
});

interface Spec {
  alertname: string;
  labels: Record<string, string>;
  component: string | null;
  startsMin: number;
  severity?: 'critical' | 'warning';
}

function build(specs: Spec[], changes: ChangeEvent[] = [retire()]): { incident: Incident; alerts: Alert[] } {
  const alerts = specs.map((s, k): Alert => {
    const id = `${String(k + 1).padStart(16, '0')}@${Math.floor(Date.parse(at(s.startsMin)) / 1000)}`;
    const severity = s.severity ?? 'warning';
    return {
      alert_id: id,
      cluster_id: 'c1',
      source: 'reconcile',
      fingerprint: id.split('@')[0]!,
      alertname: s.alertname,
      labels: { alertname: s.alertname, severity, ...s.labels },
      annotations: {},
      severity,
      status: 'firing',
      suppressed: 'none',
      starts_at: at(s.startsMin),
      ends_at: null,
      generator_url: null,
      classification: { role: 'symptom', source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
      entity: null,
      entity_resolution: 'unresolved',
      component: s.component,
      received_at: at(s.startsMin),
    };
  });
  const incident: Incident = {
    ...baseIncident(),
    severity: alerts.some((a) => a.severity === 'critical') ? 'critical' : 'warning',
    root: { component: APP, entity: null, ambiguous: false, margin: 0.5, silent_root: false },
    members: alerts.map((a) => ({
      alert_id: a.alert_id,
      alertname: a.alertname,
      role: 'symptom',
      component: a.component,
      severity: a.severity,
      status: 'firing',
      starts_at: a.starts_at,
      ends_at: null,
      joined_version: 1,
      left_version: null,
    })),
    changes,
  };
  return { incident, alerts };
}

const VANISHED: Spec = {
  alertname: 'ObservabilityScrapeJobVanished',
  labels: { job: 'objstore' },
  component: 'Job:objstore',
  startsMin: 10,
};
const MISMATCH: Spec = {
  alertname: 'KubeStatefulSetReplicasMismatch',
  labels: { job: 'kube-state-metrics', statefulset: 'objstore-volume' },
  component: VOLUME,
  startsMin: 1,
};
const IMPACT = [
  { labels: { layer: ['L0', 'L1', 'L2'], severity: ['critical'] }, exclude_labels: { component: ['provider'] } },
];

const stageAOf = (b: { incident: Incident; alerts: Alert[] }) =>
  disposition({ ...b, cards: stageACards(), ruleActions: 0, excludedBy: null, impactAlerts: IMPACT });

describe('阶段 A：计划内退役', () => {
  it('抓取 job 消失与被退役工作负载上的告警都由退役解释：ignore，原因 planned_retirement', () => {
    const b = build([VANISHED, MISMATCH]);
    expect(plannedRetirement(b.incident, b.alerts, IMPACT)).toEqual([retire()]);
    // 异常卡与 critical 都不影响：没有业务影响告警
    expect(stageAOf(b)).toEqual({ disposition: 'ignore', reason: 'planned_retirement' });
  });

  it('退役没有计划依据（planned_by 为空）时不判为 ignore', () => {
    const b = build([VANISHED], [retire({ planned_by: [] })]);
    expect(plannedRetirement(b.incident, b.alerts, IMPACT)).toBeNull();
    expect(stageAOf(b).reason).toBe('default');
  });

  it('有一条告警不由退役解释时不判为 ignore：job 不在 scrape_jobs、落在管理应用上、在退役之前超过容差开始', () => {
    const other = { ...VANISHED, alertname: 'TargetDown', labels: { job: 'gateway' }, component: 'Job:gateway' };
    expect(plannedRetirement(build([VANISHED, other]).incident, build([VANISHED, other]).alerts, IMPACT)).toBeNull();
    const onApp = { ...MISMATCH, alertname: 'ArgoCDAppMissing', labels: {}, component: APP };
    const a = build([VANISHED, onApp]);
    expect(plannedRetirement(a.incident, a.alerts, IMPACT)).toBeNull();
    const early = build([VANISHED, { ...MISMATCH, startsMin: -11 }]);
    expect(plannedRetirement(early.incident, early.alerts, IMPACT)).toBeNull();
    // 容差以内（退役时刻取第一个 0 的采样点，缩容告警可能略早）
    const near = build([VANISHED, { ...MISMATCH, startsMin: -9 }]);
    expect(plannedRetirement(near.incident, near.alerts, IMPACT)).toEqual([retire()]);
  });

  it('成员中有业务影响告警（不论状态）时不判为 ignore', () => {
    const impact = {
      ...VANISHED,
      labels: { job: 'objstore', layer: 'L1' },
      severity: 'critical' as const,
    };
    const b = build([impact]);
    expect(plannedRetirement(b.incident, b.alerts, IMPACT)).toBeNull();
    const resolved = { ...b, alerts: b.alerts.map((x) => ({ ...x, status: 'resolved' as const, ends_at: at(20) })) };
    expect(plannedRetirement(resolved.incident, resolved.alerts, IMPACT)).toBeNull();
    // provider 组件被排除在业务影响告警之外
    const provider = build([{ ...impact, labels: { ...impact.labels, component: 'provider' } }]);
    expect(plannedRetirement(provider.incident, provider.alerts, IMPACT)).toEqual([retire()]);
  });

  it('成员告警没有全部读到时不判为 ignore', () => {
    const b = build([VANISHED, MISMATCH]);
    expect(plannedRetirement(b.incident, b.alerts.slice(0, 1), IMPACT)).toBeNull();
  });

  it('被静默与领域包排除仍然优先', () => {
    const b = build([VANISHED]);
    expect(stageAOf({ ...b, incident: { ...b.incident, suppressed: true } }).reason).toBe('suppressed');
  });
});

describe('阶段 B：计划内退役的依据', () => {
  const s = { ...stageA(), disposition: 'ignore' as const, disposition_reason: 'planned_retirement' as const };
  const input = (over: Partial<DispositionInput> = {}): DispositionInput => ({
    model: 'escalate',
    incident: baseIncident(),
    stageA: s,
    level: 'likely',
    root: APP,
    ruleSupport: 1,
    proposals: 0,
    cards: incidentBook(researchCase({ stageA: s })).allCards,
    facts: { external: [], declared: [], remediations: [], business_impact: [] },
    ...over,
  });

  it('阶段 A 判为 planned_retirement 时处置为 ignore，依据记为 planned_retirement', () => {
    const r = deriveDisposition(input());
    expect(r).toMatchObject({ disposition: 'ignore', basis: 'planned_retirement' });
    expect(r.notes[0]).toBe(
      '处置改为 ignore（模型给出 escalate）：阶段 A 判为 ignore：全部成员告警由计划内的退役解释，没有业务影响告警',
    );
  });

  it('其他阶段 A 原因的依据仍记为 stage_a', () => {
    const r = deriveDisposition(input({ stageA: { ...s, disposition_reason: 'pack_exclude' } }));
    expect(r).toMatchObject({ disposition: 'ignore', basis: 'stage_a' });
  });
});
