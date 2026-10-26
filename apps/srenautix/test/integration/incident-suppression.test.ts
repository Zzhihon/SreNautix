import { AlertCatalog, DEFAULT_RCA_PARAMS } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IncidentEngine } from '../../src/incident/engine.js';
import { IngestService } from '../../src/ingest/service.js';
import type { RawAlert } from '../../src/ingest/normalize.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { suppressedAlertIds } from '../../src/roles/server.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 事件的抑制状态经真实 PG（ADR 0163）。复现部署方的一次事故：数据库主库故障期间，网关错误预算燃烧的 critical 告警被
// Alertmanager 的抑制规则抑制（inhibited），事件因此被当作被抑制：阶段 A 判为 ignore，事件期间不发消息；事件恢复、没有
// 触发中的成员之后抑制状态变回 false，才补发了一条"已恢复"。
// - 抑制规则（inhibited）不算抑制，静默（silenced）与状态库的抑制规则才算；
// - 没有触发中的成员时保持最后的抑制状态。

let db: TestDb;
let ingest: IngestService;
let engine: IncidentEngine;
const CLUSTER = 'inh';
const metrics = new ServerMetrics('server', false);

function alert(name: string, deployment: string, suppressed: RawAlert['suppressed'], at: Date, ended: Date | null) {
  return {
    source: 'reconcile',
    labels: { alertname: name, severity: 'critical', namespace: 'shop', deployment },
    annotations: {},
    severity: 'critical',
    status: ended ? 'resolved' : 'firing',
    suppressed,
    startsAt: at,
    endsAt: ended,
    generatorUrl: null,
    fingerprint: `${name}-${deployment}`.padEnd(16, '0').slice(0, 16),
    alertname: name,
    alertmanagerSeenAt: at,
  } satisfies RawAlert;
}

const node = (name: string) => ({
  op: 'node_upsert' as const,
  at: new Date(Date.now() - 24 * 3600_000),
  source: 'informer' as const,
  node: {
    key: `Deployment:shop/${name}`,
    kind: 'Deployment',
    namespace: 'shop',
    name,
    uid: `uid-${name}`,
    labels: {},
    component_type: null,
    hub: false,
  },
});

const state = async () =>
  (
    await db.server.query<{ label: string; state: string; suppressed: boolean }>(
      'SELECT label, state, suppressed FROM server.incidents WHERE cluster_id = $1 ORDER BY label',
      [CLUSTER],
    )
  ).rows.map((r) => [r.label.split(':').slice(0, 2).join(':'), r.state, r.suppressed]);

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topology = new TopologyStore(db.server);
  await topology.apply(CLUSTER, [node('gateway'), node('billing')]);
  ingest = new IngestService(
    db.server,
    [],
    { clusterId: CLUSTER, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    { catalog: new AlertCatalog([]), nodes: topology, ksm: null, ruleExpr: () => undefined, chronic: () => false },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );
  engine = new IncidentEngine({
    pool: db.server,
    topology,
    params: () => DEFAULT_RCA_PARAMS,
    changes: async () => [],
    probes: async () => [],
    stale: { markStale: async () => 0 },
    metrics,
    suppressedAlertIds: (c, clusterId, ids) => suppressedAlertIds(c as typeof db.server, clusterId, ids),
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('事件的抑制状态', () => {
  it('抑制规则抑制的告警照常成事件；静默的告警使事件被抑制，恢复后保持被抑制，不补发消息', async () => {
    const at = new Date(Date.now() - 20 * 60_000);
    await ingest.write(
      CLUSTER,
      'am',
      'reconcile',
      [
        alert('GatewayErrorBudgetBurnFast', 'gateway', 'inhibited', at, null),
        alert('BillingLagHigh', 'billing', 'silenced', at, null),
      ],
      {},
    );
    await engine.recompute(CLUSTER);
    expect(await state()).toEqual([
      ['Deployment:shop/billing', 'firing', true],
      ['Deployment:shop/gateway', 'firing', false],
    ]);
    // 通知按 NOT suppressed 选事件：被抑制规则抑制的网关事件在触发期间就会发出
    const notified = await db.server.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM server.incidents WHERE cluster_id = $1 AND NOT suppressed AND state = 'firing'",
      [CLUSTER],
    );
    expect(notified.rows[0]!.n).toBe(1);

    // 两条告警都恢复：没有触发中的成员，抑制状态保持恢复之前的值
    const end = new Date(Date.now() - 60_000);
    await ingest.write(
      CLUSTER,
      'am',
      'reconcile',
      [
        alert('GatewayErrorBudgetBurnFast', 'gateway', 'inhibited', at, end),
        alert('BillingLagHigh', 'billing', 'silenced', at, end),
      ],
      {},
    );
    await engine.recompute(CLUSTER);
    expect(await state()).toEqual([
      ['Deployment:shop/billing', 'resolved', true],
      ['Deployment:shop/gateway', 'resolved', false],
    ]);
  });
});
