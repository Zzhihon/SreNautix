import { describe, expect, it } from 'vitest';
import type { Alert } from '@srenautix/contract';
import { computeIncidents, DEFAULT_RCA_PARAMS, reconcileIncidents, TopologyGraph } from '../src/index.js';

// 告警源的抑制规则（inhibited）与静默（silenced）（ADR 0163）。部署方的一次事故中，数据库主库故障的告警按 Alertmanager
// 的抑制规则抑制了网关错误预算燃烧的 critical 告警：抑制规则表示"另一条触发中的告警能解释它"，事件照常处理；
// 只有静默（人决定不处理）让事件被抑制

const T0 = Date.parse('2026-10-25T10:27:30Z');
const MIN = 60_000;

const burn = (alertname: string, suppressed: Alert['suppressed'], at: number): Alert => ({
  alert_id: `${alertname.length.toString(16).padStart(16, '0')}@${at / 1000}`,
  cluster_id: 'c1',
  source: 'reconcile',
  fingerprint: alertname.length.toString(16).padStart(16, '0'),
  alertname,
  labels: { alertname, severity: 'critical', layer: 'L2', component: 'gateway', entity: 'gateway', entity_kind: 'job' },
  annotations: {},
  severity: 'critical',
  status: 'firing',
  suppressed,
  starts_at: new Date(at).toISOString(),
  ends_at: null,
  generator_url: null,
  classification: { role: 'symptom', source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
  entity: { cluster_id: 'c1', kind: 'Job', namespace: null, name: 'gateway', uid: null },
  entity_resolution: 'labels',
  component: 'Job:gateway',
  received_at: new Date(at).toISOString(),
});

function incident(alerts: Alert[]) {
  const computed = computeIncidents({
    alerts,
    changes: [],
    graph: new TopologyGraph([], [], 1),
    params: DEFAULT_RCA_PARAMS,
    now: T0 + 30 * MIN,
  });
  const r = reconcileIncidents({ clusterId: 'c1', previous: [], computed, topologyVersion: 1, now: T0 + 30 * MIN });
  expect(r.incidents).toHaveLength(1);
  return r.incidents[0]!;
}

describe('告警源的抑制状态', () => {
  it('成员都被抑制规则抑制（inhibited）时事件不算被抑制', () => {
    const inc = incident([
      burn('GatewayErrorBudgetBurnFast', 'inhibited', T0),
      burn('GatewayErrorBudgetBurnSlow', 'inhibited', T0 + 18 * MIN),
    ]);
    expect(inc).toMatchObject({ severity: 'critical', state: 'firing', suppressed: false });
  });

  it('触发中的成员都被静默（silenced）时事件被抑制；有一条只是被抑制规则抑制时不算', () => {
    expect(incident([burn('GatewayErrorBudgetBurnFast', 'silenced', T0)]).suppressed).toBe(true);
    expect(
      incident([
        burn('GatewayErrorBudgetBurnFast', 'silenced', T0),
        burn('GatewayErrorBudgetBurnSlow', 'inhibited', T0 + MIN),
      ]).suppressed,
    ).toBe(false);
  });
});
