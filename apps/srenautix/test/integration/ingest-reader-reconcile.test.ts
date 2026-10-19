import { AlertCatalog } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
