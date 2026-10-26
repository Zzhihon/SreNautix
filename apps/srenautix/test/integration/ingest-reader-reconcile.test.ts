import { AlertCatalog } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverConditions, type ServerObservations } from '../../src/console-bff/conditions.js';
import { reconcileFromReader, type ReaderAlertSnapshot } from '../../src/ingest/reconcile.js';
import { IngestService } from '../../src/ingest/service.js';
import { activeAlerts } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

/** 多集群：reader 推送的告警快照按同样的规则对账；读取失败或截断的快照不能结束告警。 */
let db: TestDb;
let ingest: IngestService;
const metrics = new ServerMetrics('server', false);
const T0 = new Date(Date.now() - 600_000).toISOString();

const am = (alertname: string) => ({
  labels: { alertname, severity: 'warning', namespace: 'shop' },
  annotations: {},
  startsAt: T0,
  endsAt: new Date(Date.now() + 3600_000).toISOString(),
  status: { state: 'active', silencedBy: [], inhibitedBy: [] },
});

const snap = (
  items: unknown[],
  rules: ReaderAlertSnapshot['rules'],
  amStatus: 'ok' | 'error' = 'ok',
  truncated = false,
): ReaderAlertSnapshot => ({
  taken_at: new Date().toISOString(),
  alertmanager: { status: amStatus, truncated, items },
  rules,
});

const run = (s: ReaderAlertSnapshot) =>
  reconcileFromReader(db.server, 'east', s, ingest, metrics, 'srenautix_self', 'Watchdog');

const firing = async () =>
  (await activeAlerts(db.server, 'east', 0))
    .filter((a) => a.status === 'firing')
    .map((a) => a.alertname)
    .sort();

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  ingest = new IngestService(
    db.server,
    [],
    { clusterId: 'east', selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    {
      catalog: new AlertCatalog([]),
      nodes: new TopologyStore(db.server),
      ksm: null,
      ruleExpr: () => undefined,
      chronic: () => false,
    },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );
});

afterAll(async () => {
  await db.close();
});

describe('reader 告警快照对账', () => {
  it('补写 Alertmanager 与规则引擎中触发、本地没有的告警；Watchdog 不入库', async () => {
    const r = await run(
      snap([am('A'), am('Watchdog')], {
        status: 'ok',
        truncated: false,
        items: [
          { labels: { alertname: 'B', severity: 'critical' }, state: 'firing', active_at: T0 },
          { labels: { alertname: 'C', severity: 'warning' }, state: 'pending', active_at: T0 },
        ],
      }),
    );
    expect(r.added).toBe(2);
    expect(await firing()).toEqual(['A', 'B']);
    // 快照的读取时刻是在 Alertmanager 中看到 A 的时刻；只在规则引擎中的 B 没有这个时刻，交给快速轮询（ADR 0165）
    const seen = await db.server.query<{ alertname: string; alertmanager_seen_at: Date | null; alert_id: string }>(
      "SELECT alertname, alertmanager_seen_at, alert_id FROM server.alert_state WHERE cluster_id = 'east' ORDER BY alertname",
    );
    expect(seen.rows.map((x) => [x.alertname, x.alertmanager_seen_at === null])).toEqual([
      ['A', false],
      ['B', true],
    ]);
    expect([...r.unseen.values()]).toEqual([[seen.rows[1]!.alert_id]]);
  });

  it('Alertmanager 读取失败或结果被截断时不结束任何告警', async () => {
    expect((await run(snap([], { status: 'ok', truncated: false, items: [] }, 'error'))).resolved).toBe(0);
    expect((await run(snap([], { status: 'ok', truncated: false, items: [] }, 'ok', true))).resolved).toBe(0);
    // 两个部分都没有（reader 没有配置告警源）：不能据此判断告警已消失
    expect((await run({ taken_at: new Date().toISOString(), alertmanager: null, rules: null })).resolved).toBe(0);
    expect(await firing()).toEqual(['A', 'B']);
  });

  it('快照完整时结束告警源中已经没有的告警', async () => {
    const r = await run(snap([am('A')], { status: 'ok', truncated: false, items: [] }));
    expect(r.resolved).toBe(1);
    expect(await firing()).toEqual(['A']);
  });

  it('只用对账、不接 webhook 时：完整读取成功计入接入与 Watchdog，不误报 IngestSilent、WatchdogMissing', async () => {
    const watchdogBefore = ingest.lastWatchdogAt;
    // 读取失败的快照不算接入
    await run(snap([am('Watchdog')], { status: 'ok', truncated: false, items: [] }, 'error'));
    expect(ingest.lastWatchdogAt).toBe(watchdogBefore);
    await run(snap([am('A'), am('Watchdog')], { status: 'ok', truncated: false, items: [] }));
    expect(ingest.lastWatchdogAt).not.toBeNull();
    const row = await db.admin.query<{ last_received_at: Date }>(
      "SELECT last_received_at FROM server.ingest_sources WHERE source_id = 'reconcile'",
    );
    expect(row.rows[0]?.last_received_at).toBeInstanceOf(Date);
    expect(
      (await metrics.registry.getSingleMetric('srenautix_ingest_last_received_timestamp_seconds')?.get())?.values,
    ).toContainEqual(expect.objectContaining({ labels: { source: 'reconcile' } }));

    const now = new Date();
    const base: ServerObservations = {
      ingestSources: [{ id: 'alertmanager', lastReceivedAt: null }],
      silenceThresholdMs: 600_000,
      lastWatchdogAt: ingest.lastWatchdogAt,
      reconcile: { enabled: true, lastAt: row.rows[0]!.last_received_at },
      startedAt: new Date(now.getTime() - 3600_000),
      reconcileOk: true,
      evidenceDatasourceError: null,
      changeSources: [],
      packFailures: [],
      packsDisabled: [],
      degraded: false,
      storm: false,
      budgetRatio: 0,
      audit: { sink: 'pg', lagSeconds: 0, thresholdSeconds: 300 },
      channelFailures: [],
      notifyAbandoned: [],
      restoredAt: null,
      frozenClusters: [],
      now,
    };
    const pick = (o: ServerObservations) =>
      serverConditions(o)
        .filter((c) => c.type === 'IngestSilent' || c.type === 'WatchdogMissing')
        .map((c) => [c.type, c.subject, c.active, c.reason]);
    expect(pick(base)).toEqual([
      ['IngestSilent', 'alertmanager', false, 'ReconcileOnly'],
      ['WatchdogMissing', null, false, 'Present'],
    ]);
    // 对账也停了：两项都成立
    const stale = new Date(now.getTime() - 3600_000);
    expect(pick({ ...base, reconcile: { enabled: true, lastAt: stale }, lastWatchdogAt: stale })).toEqual([
      ['IngestSilent', 'alertmanager', true, 'NoPayload'],
      ['WatchdogMissing', null, true, 'NoWatchdog'],
    ]);
    // 没有配置 webhook 接入源、只有对账
    expect(pick({ ...base, ingestSources: [] })).toEqual([
      ['IngestSilent', 'reconcile', false, 'Receiving'],
      ['WatchdogMissing', null, false, 'Present'],
    ]);
  });
});
