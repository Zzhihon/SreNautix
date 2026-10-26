import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestTrack } from '../../src/ingest/migrations.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 告警第一次在 Alertmanager 中被看到的时刻（ADR 0165）：升级前写入的 Alertmanager、Grafana 与对账来源的告警
// 取第一次写入的时刻；集群状态检测器、夜莺与通用 webhook 的告警没有这个时刻。

let db: TestDb;
const RECEIVED = '2026-10-25T10:25:31.000Z';
const SOURCES = ['alertmanager', 'grafana', 'reconcile', 'detector', 'nightingale', 'generic'] as const;

beforeAll(async () => {
  db = await newTestDb();
  // 先建到 ingest 迁移 1，写入各来源的告警，再升级
  await migrateExpand(
    db.server,
    'server',
    serverTracks.map((t) =>
      t.track === ingestTrack.track ? { ...ingestTrack, migrations: ingestTrack.migrations.slice(0, 1) } : t,
    ),
  );
  for (const [i, source] of SOURCES.entries()) {
    const fp = `${i}`.padStart(16, '0');
    await db.admin.query(
      `INSERT INTO server.alert_state (alert_id, cluster_id, fingerprint, source, alertname, labels, annotations, severity, status,
         suppressed, starts_at, classification, entity_resolution, received_at, last_seen_at, updated_at)
       VALUES ($1, 'c1', $2, $3, 'A', '{"alertname":"A"}', '{}', 'warning', 'firing', 'none', '2026-10-25T10:25:00Z',
         '{"role":"symptom","source":"default","confidence":0.3,"catalog_entry":null,"chronic":false}', 'unresolved',
         $4, now(), now())`,
      [`${fp}@1`, fp, source, RECEIVED],
    );
  }
  await migrateExpand(db.server, 'server', serverTracks);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('告警第一次在 Alertmanager 中被看到的时刻：迁移', () => {
  it('Alertmanager、Grafana 与对账来源取第一次写入的时刻，其他来源为空', async () => {
    const r = await db.admin.query<{ source: string; alertmanager_seen_at: Date | null }>(
      'SELECT source, alertmanager_seen_at FROM server.alert_state ORDER BY alert_id',
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.source, x.alertmanager_seen_at?.toISOString() ?? null]))).toEqual({
      alertmanager: RECEIVED,
      grafana: RECEIVED,
      reconcile: RECEIVED,
      detector: null,
      nightingale: null,
      generic: null,
    });
  });
});
