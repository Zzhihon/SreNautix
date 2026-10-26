import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AlertCatalog, DEFAULT_EXTERNAL_LABELS, setExternalLabels } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertId, fingerprint } from '../../src/ingest/normalize.js';
import { reconcileFromReader, type ReaderAlertSnapshot } from '../../src/ingest/reconcile.js';
import { IngestService } from '../../src/ingest/service.js';
import { upsertAlert } from '../../src/ingest/store.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { tx } from '../../src/store/pool.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

/**
 * Prometheus 的 external labels 不属于告警身份（ADR 0117）。Kind kind-e2e 39595887396：Alertmanager webhook 送来的
 * ShopPodRestarted 带 prometheus="monitoring/kps-prometheus"（12:13:13.312），reader 对账读到的规则告警不带（12:13:13），
 * 两者指纹不同，对账把它当成新告警补写，事件从 v1 升到 v2。
 */
const C = 'kind';
const ROOT = resolve(import.meta.dirname, '../../../../.scratch', `external-labels-${process.pid}`);
const TOKEN = 'ingest-token-external-0123456789';
const metrics = new ServerMetrics('server', false);
const STARTS = new Date(Math.floor(Date.now() / 1000) * 1000 - 5 * 60_000);
const LABELS = {
  alertname: 'ShopPodRestarted',
  namespace: 'shop',
  pod: 'api-5b7bb87bc4-cwtzh',
  container: 'db-check',
  severity: 'critical',
};

let db: TestDb;
let ingest: IngestService;

const firing = async () =>
  (
    await db.server.query<{ alert_id: string; fingerprint: string; labels: Record<string, string> }>(
      "SELECT alert_id, fingerprint, labels FROM server.alert_state WHERE cluster_id = $1 AND status = 'firing' ORDER BY alert_id",
      [C],
    )
  ).rows;
const snapshot = (): ReaderAlertSnapshot => ({
  taken_at: new Date().toISOString(),
  alertmanager: null,
  rules: {
    status: 'ok',
    truncated: false,
    items: [{ labels: LABELS, state: 'firing', active_at: STARTS.toISOString() }],
  },
});

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'token'), TOKEN);
  ingest = new IngestService(
    db.server,
    [{ id: 'am', kind: 'alertmanager', token_file: join(ROOT, 'token') }],
    { clusterId: C, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
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
}, 120_000);

afterAll(async () => {
  setExternalLabels(DEFAULT_EXTERNAL_LABELS);
  await db?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('Prometheus 的 external labels', () => {
  it('webhook 带 prometheus 标签、对账的规则告警不带：同一个指纹，对账不补写第二份', async () => {
    const r = await ingest.ingest('am', {
      receiver: 'srenautix',
      status: 'firing',
      alerts: [
        {
          labels: { ...LABELS, prometheus: 'monitoring/kps-prometheus', prometheus_replica: 'prometheus-kps-0' },
          annotations: {},
          startsAt: new Date(STARTS.getTime() + 312).toISOString(),
          endsAt: '0001-01-01T00:00:00Z',
          generatorURL: '',
          fingerprint: '',
          status: 'firing',
        },
      ],
      groupLabels: {},
      commonLabels: {},
      commonAnnotations: {},
      externalURL: 'http://alertmanager.example:9093',
      version: '4',
      groupKey: '{}',
      truncatedAlerts: 0,
    });
    expect(r).toMatchObject({ accepted: 1 });
    const res = await reconcileFromReader(db.server, C, snapshot(), ingest, metrics, 'srenautix_self', 'Watchdog');
    expect(res).toMatchObject({ added: 0, resolved: 0 });
    const rows = await firing();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fingerprint).toBe(fingerprint(LABELS));
    expect(rows[0]!.labels.prometheus).toBeUndefined();
  });

  it('修复之前按带 external labels 的指纹存下的重复告警：下一次对账合并，只保留一份', async () => {
    // 修复之前的指纹：prometheus 标签计入身份
    setExternalLabels([]);
    const oldLabels = { ...LABELS, pod: 'api-old', prometheus: 'monitoring/kps-prometheus' };
    const oldFp = fingerprint(oldLabels);
    setExternalLabels(DEFAULT_EXTERNAL_LABELS);
    const newLabels = { ...LABELS, pod: 'api-old' };
    const newFp = fingerprint(newLabels);
    expect(oldFp).not.toBe(newFp);
    const resolved = {
      classification: {
        role: 'cause' as const,
        source: 'default' as const,
        confidence: 0.3,
        catalog_entry: null,
        chronic: false,
      },
      entity: null,
      entityResolution: 'unresolved' as const,
      component: 'Namespace:shop',
      chains: [],
    };
    const raw = (labels: Record<string, string>, fp: string, source: 'alertmanager' | 'reconcile') => ({
      source,
      labels,
      annotations: {},
      severity: 'critical' as const,
      status: 'firing' as const,
      suppressed: 'none' as const,
      startsAt: STARTS,
      endsAt: null,
      generatorUrl: null,
      fingerprint: fp,
      alertname: 'ShopPodRestarted',
      alertmanagerSeenAt: STARTS,
    });
    await tx(db.server, (c) => upsertAlert(c, C, raw(oldLabels, oldFp, 'alertmanager'), resolved));
    await tx(db.server, (c) => upsertAlert(c, C, raw(newLabels, newFp, 'reconcile'), resolved));
    expect((await firing()).filter((a) => a.labels.pod === 'api-old')).toHaveLength(2);
    const snap = snapshot();
    snap.rules!.items.push({ labels: newLabels, state: 'firing', active_at: STARTS.toISOString() });
    const res = await reconcileFromReader(db.server, C, snap, ingest, metrics, 'srenautix_self', 'Watchdog');
    expect(res.added).toBe(0);
    const left = (await firing()).filter((a) => a.labels.pod === 'api-old');
    expect(left.map((a) => a.alert_id)).toEqual([alertId(newFp, STARTS)]);
  });

  it('配置可以改：ingest.external_labels 给出的标签都不计入身份', () => {
    setExternalLabels(['cluster']);
    expect(fingerprint({ ...LABELS, cluster: 'east' })).toBe(fingerprint(LABELS));
    expect(fingerprint({ ...LABELS, prometheus: 'x' })).not.toBe(fingerprint(LABELS));
    setExternalLabels(DEFAULT_EXTERNAL_LABELS);
  });
});
