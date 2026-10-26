import type { Alert, EvidenceResult, Incident } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { deriveDisposition, type DispositionInput } from '../../src/research/disposition.js';
import { incidentBook } from '../../src/research/incident.js';
import { businessImpactAlerts, disposition } from '../../src/stage-a/report.js';
import { incident, researchCase, stageA, stageACards } from '../support/scenario.js';

// 业务影响告警在触发、证据卡异常时处置不能是 ignore（ADR 0163）。复现部署方的一次事故：数据库主库故障期间，网关错误预算
// 燃烧与边缘错误预算燃烧的 critical 告警被 Alertmanager 的抑制规则抑制，阶段 A 把事件判为 ignore（原因 suppressed），
// 当时网关 5xx 峰值 95%

const IMPACT = [{ labels: { layer: ['L0'], severity: ['critical'] }, exclude_labels: {} }];

/** 场景事件的两个成员告警：第一个是边缘错误预算燃烧（L0），第二个是网关错误预算燃烧（L2） */
function alerts(over: Partial<Alert> = {}): Alert[] {
  const inc = incident();
  return inc.members.map((m, k) => ({
    alert_id: m.alert_id,
    cluster_id: 'test',
    source: 'reconcile',
    fingerprint: m.alert_id.split('@')[0]!,
    alertname: k === 0 ? 'ErrorBudgetBurnFast' : 'GatewayErrorBudgetBurnFast',
    labels: {
      alertname: k === 0 ? 'ErrorBudgetBurnFast' : 'GatewayErrorBudgetBurnFast',
      severity: 'critical',
      layer: k === 0 ? 'L0' : 'L2',
    },
    annotations: {},
    severity: 'critical',
    status: 'firing',
    suppressed: 'inhibited',
    starts_at: m.starts_at,
    ends_at: null,
    generator_url: null,
    classification: { role: 'symptom', source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
    entity: null,
    entity_resolution: 'labels',
    component: m.component,
    received_at: m.starts_at,
    ...over,
  }));
}

const suppressedIncident = (): Incident => ({ ...incident(), suppressed: true });

describe('阶段 A：业务影响告警在触发、证据卡异常时不给 ignore', () => {
  it('事件被抑制（静默），但有触发中的 critical L0 告警与异常卡：不是 ignore', () => {
    const d = disposition({
      incident: suppressedIncident(),
      alerts: alerts(),
      cards: stageACards(),
      ruleActions: 0,
      excludedBy: null,
      impactAlerts: IMPACT,
    });
    expect(d).toEqual({ disposition: 'undetermined', reason: 'default' });
  });

  it('领域包排除与只有长期告警同样不给 ignore', () => {
    const base = { incident: incident(), cards: stageACards(), ruleActions: 0, impactAlerts: IMPACT };
    expect(disposition({ ...base, alerts: alerts(), excludedBy: 'x' }).disposition).not.toBe('ignore');
    const chronic = alerts({
      classification: { role: 'symptom', source: 'catalog', confidence: 1, catalog_entry: null, chronic: true },
    });
    expect(disposition({ ...base, alerts: chronic, excludedBy: null }).disposition).not.toBe('ignore');
  });

  it('没有异常卡、业务影响告警已恢复、不满足匹配器（不是 critical、被排除）或没有匹配器时照常判为 ignore', () => {
    const normal = stageACards().map((c) => ({ ...c, verdict: 'normal' as const }));
    const routine = stageACards().map((c): EvidenceResult =>
      c.verdict === 'abnormal'
        ? {
            ...c,
            novelty: {
              status: 'routine',
              rule: 'abnormal_share',
              value: 7,
              comparisons: [],
              samples: 29,
              abnormal_share: 0.6,
              range: null,
              reason: '常态',
            },
          }
        : c,
    );
    const base = { incident: suppressedIncident(), ruleActions: 0, excludedBy: null };
    expect(disposition({ ...base, alerts: alerts(), cards: normal, impactAlerts: IMPACT }).reason).toBe('suppressed');
    expect(disposition({ ...base, alerts: alerts(), cards: routine, impactAlerts: IMPACT }).reason).toBe('suppressed');
    expect(
      disposition({ ...base, alerts: alerts({ status: 'resolved' }), cards: stageACards(), impactAlerts: IMPACT })
        .reason,
    ).toBe('suppressed');
    const warning = alerts().map((a) => ({
      ...a,
      severity: 'warning' as const,
      labels: { ...a.labels, severity: 'warning' },
    }));
    expect(disposition({ ...base, alerts: warning, cards: stageACards(), impactAlerts: IMPACT }).reason).toBe(
      'suppressed',
    );
    const provider = alerts().map((a) => ({ ...a, labels: { ...a.labels, component: 'provider' } }));
    const excluding = [{ ...IMPACT[0]!, exclude_labels: { component: ['provider'] } }];
    expect(disposition({ ...base, alerts: provider, cards: stageACards(), impactAlerts: excluding }).reason).toBe(
      'suppressed',
    );
    expect(disposition({ ...base, alerts: alerts(), cards: stageACards(), impactAlerts: [] }).reason).toBe(
      'suppressed',
    );
  });

  it('业务影响告警只取事件的成员中触发的告警，按匹配器（任一项）匹配，严重度写在匹配器里', () => {
    const inc = incident();
    expect(businessImpactAlerts(inc, alerts(), IMPACT)).toEqual([inc.members[0]!.alert_id]);
    expect(
      businessImpactAlerts(inc, alerts(), [
        { labels: { layer: ['L0'] }, exclude_labels: {} },
        { labels: { layer: ['L2'] }, exclude_labels: {} },
      ]),
    ).toEqual(inc.members.map((m) => m.alert_id));
    // L0–L2 的 critical，排除 L0 告警所在的 edge 组件
    const edge = alerts().map((a, k) => (k === 0 ? { ...a, labels: { ...a.labels, component: 'edge' } } : a));
    expect(
      businessImpactAlerts(inc, edge, [
        { labels: { layer: ['L0', 'L1', 'L2'], severity: ['critical'] }, exclude_labels: { component: ['edge'] } },
      ]),
    ).toEqual([inc.members[1]!.alert_id]);
    const left = { ...inc, members: inc.members.map((m) => ({ ...m, left_version: 2 })) };
    expect(businessImpactAlerts(left, alerts(), IMPACT)).toEqual([]);
  });
});

describe('阶段 B：业务影响告警在触发、证据卡异常时不给 ignore', () => {
  const PROVIDER = 'provider:p1';
  function input(over: Partial<DispositionInput> = {}): DispositionInput {
    return {
      model: 'ignore',
      incident: incident(),
      stageA: stageA(),
      level: 'likely',
      root: PROVIDER,
      ruleSupport: 1,
      proposals: 0,
      cards: incidentBook(researchCase({ stageA: stageA() })).allCards,
      facts: { external: [PROVIDER], remediations: [], business_impact: [incident().members[0]!.alert_id] },
      ...over,
    };
  }

  it('外部组件为根因、模型给出 ignore，但业务影响告警在触发且有异常卡：按严重度改写为 escalate', () => {
    const r = deriveDisposition(input());
    expect(r.disposition).toBe('escalate');
    expect(r.notes[0]).toMatch(/1 条业务影响告警在触发，2 张证据卡异常（card:1、card:2）.*ADR 0163/);
  });

  it('阶段 A 判为 ignore（抑制）不再是依据', () => {
    const s = { ...stageA(), disposition: 'ignore' as const, disposition_reason: 'suppressed' as const };
    expect(deriveDisposition(input({ model: 'escalate', stageA: s })).disposition).toBe('escalate');
  });

  it('没有业务影响告警或没有异常卡时外部组件仍是 ignore 的依据', () => {
    expect(
      deriveDisposition(input({ facts: { external: [PROVIDER], remediations: [], business_impact: [] } })),
    ).toMatchObject({ disposition: 'ignore', basis: 'external' });
    const normal = stageACards().map((c) => ({ ...c, verdict: 'normal' as const }));
    const cards = incidentBook(researchCase({ stageA: stageA(normal) })).allCards;
    expect(deriveDisposition(input({ cards })).disposition).toBe('ignore');
  });
});
