import type { Incident } from '@srenautix/contract';
import { AlertCatalog, DEFAULT_RCA_PARAMS } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectHealth } from '../../src/detectors/health.js';
import { DEFAULT_EQUIVALENTS, DetectorService, type DetectorSettings } from '../../src/detectors/service.js';
import { IncidentEngine } from '../../src/incident/engine.js';
import { IngestService } from '../../src/ingest/service.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 事件引擎经真实 PG（ADR 0132）：
// - CCHP 7c23d70 的时序：检测器事件 resolved → 超出回看窗口 → 检测器以原来的开始时间重新触发 → 重算重开原事件，
//   不撞 (cluster_id, label) 唯一约束；
// - 一组事件写入失败只回滚这一组，其余照常写入。

let db: TestDb;
let topology: TopologyStore;
let detectors: DetectorService;
let engine: IncidentEngine;
const metrics = new ServerMetrics('server', false);
const CCHP = 'cchp';
const WEST = 'west';
const DAY = 24 * 3600_000;

const settings: DetectorSettings = {
  namespaces: ['*'],
  excludeNamespaces: [],
  thresholdsMs: { pdb_blocking: 10 * 60_000 },
  severity: 'warning',
  equivalentAlerts: DEFAULT_EQUIVALENTS,
};

const pdb = (ns: string, name: string, since: number): ObjectHealth => ({
  key: `PodDisruptionBudget:${ns}/${name}`,
  kind: 'PodDisruptionBudget',
  namespace: ns,
  name,
  uid: `uid-${ns}-${name}`,
  state: 'pdb_blocking',
  since: new Date(since).toISOString(),
  reason: 'DisruptionsNotAllowed',
  message: '',
  owner: null,
});

const pdbNode = (ns: string, name: string) => ({
  op: 'node_upsert',
  at: new Date(Date.now() - 30 * DAY),
  source: 'informer',
  node: {
    key: `PodDisruptionBudget:${ns}/${name}`,
    kind: 'PodDisruptionBudget',
    namespace: ns,
    name,
    uid: `uid-${ns}-${name}`,
    labels: {},
    component_type: null,
    hub: false,
  },
});

const rows = async (clusterId: string) =>
  (
    await db.server.query<{ incident_id: string; label: string; state: string; version: number }>(
      'SELECT incident_id, label, state, version FROM server.incidents WHERE cluster_id = $1 ORDER BY label',
      [clusterId],
    )
  ).rows;

const persistErrors = async (clusterId: string) =>
  (await metrics.incidentPersistErrors.get()).values.find((v) => v.labels.cluster_id === clusterId)?.value ?? 0;

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  topology = new TopologyStore(db.server);
  const ingest = new IngestService(
    db.server,
    [],
    { clusterId: CCHP, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    { catalog: new AlertCatalog([]), nodes: topology, ksm: null, ruleExpr: () => undefined, chronic: () => false },
    metrics,
    () => {
      throw new Error('测试中状态库一直可用');
    },
  );
  detectors = new DetectorService(
    db.server,
    settings,
    async (cl, alerts) => {
      await ingest.write(cl, 'detector', 'detector', alerts, { detector: alerts.length });
    },
    metrics,
  );
  engine = new IncidentEngine({
    pool: db.server,
    topology,
    params: () => DEFAULT_RCA_PARAMS,
    changes: async () => [],
    probes: async () => [],
    stale: { markStale: async () => 0 },
    metrics,
    suppressedAlertIds: async () => new Set<string>(),
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('事件引擎', () => {
  it('CCHP 时序：resolved 事件超出回看窗口后，检测器以原来的开始时间重新触发，重算重开原事件而不是撞唯一约束', async () => {
    const names = ['cchp-postgres-primary', 'cchp-postgres-replica', 'cchp-dragonfly'];
    await topology.apply(CCHP, names.map((n) => pdbNode('cchp-data', n)) as Parameters<TopologyStore['apply']>[1]);
    // 发现从 11 天前开始（CCHP 上 starts_at 是 2026-10-11）
    const since = Date.now() - 11 * DAY;
    const findings = names.map((n) => pdb('cchp-data', n, since));
    await detectors.report(CCHP, findings, true, new Date());
    expect((await detectors.scan(Date.now()))[CCHP]?.firing).toHaveLength(names.length);
    const created = await engine.recompute(CCHP);
    expect(created.changes.map((c) => c.type)).toEqual(names.map(() => 'incident.created'));
    const before = await rows(CCHP);
    expect(before.map((r) => [r.label.split(':').slice(0, 2).join(':'), r.state, r.version])).toEqual(
      [...names].sort().map((n) => [`PodDisruptionBudget:cchp-data/${n}`, 'firing', 1]),
    );

    // 旧 server Pod 把检测器告警标成 resolved（CCHP 上是 15:18:39），下一轮重算事件随之 resolved
    await db.server.query(
      "UPDATE server.alert_state SET status = 'resolved', ends_at = now() WHERE cluster_id = $1 AND source = 'detector'",
      [CCHP],
    );
    const resolved = await engine.recompute(CCHP);
    expect(resolved.changes.map((c) => c.type)).toEqual(names.map(() => 'incident.resolved'));
    expect((await rows(CCHP)).map((r) => r.state)).toEqual(names.map(() => 'resolved'));

    // 七个小时过去（数据库的 now() 拨不动，把结束时间往前挪）：告警与事件都在 30 分钟的回看窗口之外
    await db.server.query(
      "UPDATE server.alert_state SET ends_at = ends_at - interval '7 hours' WHERE cluster_id = $1",
      [CCHP],
    );
    await db.server.query(
      `UPDATE server.incidents SET ended_at = ended_at - interval '7 hours',
         body = jsonb_set(body, '{ended_at}', to_jsonb(to_char((ended_at - interval '7 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
       WHERE cluster_id = $1`,
      [CCHP],
    );
    expect((await engine.recompute(CCHP)).changes).toEqual([]);

    // 发现表里它们仍是活跃的：检测器以同一个告警（指纹与开始时间不变）重新触发（ADR 0128）
    expect((await detectors.scan(Date.now()))[CCHP]?.refired).toHaveLength(names.length);
    const reopened = await engine.recompute(CCHP);
    expect(reopened.changes.map((c) => c.type)).toEqual(names.map(() => 'incident.updated'));
    // incident_id 与标签不变，状态回到 firing，版本加一；没有新建事件
    const after = await rows(CCHP);
    expect(after).toEqual(before.map((r) => ({ ...r, state: 'firing', version: 2 })));
    expect(reopened.toReport.map((i) => i.incident_id).sort()).toEqual(before.map((r) => r.incident_id).sort());
    const versions = await db.server.query<{ version: number; reason: string }>(
      'SELECT version, reason FROM server.incident_versions WHERE incident_id = ANY($1::uuid[]) ORDER BY incident_id, version',
      [before.map((r) => r.incident_id)],
    );
    expect(versions.rows).toEqual(
      names.flatMap(() => [
        { version: 1, reason: 'created' },
        { version: 2, reason: 'reopened' },
      ]),
    );
    const body = await db.server.query<{ body: Incident }>('SELECT body FROM server.incidents WHERE incident_id = $1', [
      before[0]!.incident_id,
    ]);
    expect(body.rows[0]!.body).toMatchObject({ state: 'firing', ended_at: null, incident_version: 2 });
    expect(await persistErrors(CCHP)).toBe(0);
    // 再算一次：仍是这三个事件，版本不再变化
    expect((await engine.recompute(CCHP)).toReport).toEqual([]);
    expect(await rows(CCHP)).toEqual(after);
  });

  it('一组事件写入失败：这一组回滚、记指标，其余事件照常更新；故障消失后下一轮补上', async () => {
    await topology.apply(WEST, [pdbNode('shop-a', 'api'), pdbNode('shop-b', 'web')] as Parameters<
      TopologyStore['apply']
    >[1]);
    const since = Date.now() - 2 * 3600_000;
    await detectors.report(WEST, [pdb('shop-a', 'api', since), pdb('shop-b', 'web', since)], true, new Date());
    expect((await detectors.scan(Date.now()))[WEST]?.firing).toHaveLength(2);
    await engine.recompute(WEST);
    const before = await rows(WEST);
    expect(before.map((r) => [r.label.split(':').slice(0, 2).join(':'), r.state])).toEqual([
      ['PodDisruptionBudget:shop-a/api', 'firing'],
      ['PodDisruptionBudget:shop-b/web', 'firing'],
    ]);
    const [a, b] = before as [(typeof before)[0], (typeof before)[0]];

    // shop-a 的事件写入时出错（以触发器注入）
    await db.admin.query(`CREATE FUNCTION public.fail_incident_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.cluster_id = '${WEST}' AND NEW.label LIKE 'PodDisruptionBudget:shop-a/%' THEN
          RAISE EXCEPTION 'injected failure for %', NEW.label;
        END IF;
        RETURN NEW;
      END $$`);
    await db.admin.query(
      'CREATE TRIGGER fail_incident_write BEFORE INSERT OR UPDATE ON server.incidents FOR EACH ROW EXECUTE FUNCTION public.fail_incident_write()',
    );
    const outbox = async () =>
      (
        await db.server.query<{ type: string; incident_id: string }>(
          "SELECT type, payload->>'incident_id' AS incident_id FROM server.outbox WHERE cluster_id = $1 ORDER BY seq",
          [WEST],
        )
      ).rows;
    const outboxBefore = (await outbox()).length;
    try {
      // 两个对象都恢复了
      await detectors.report(WEST, [], true, new Date());
      expect((await detectors.scan(Date.now()))[WEST]?.resolved).toHaveLength(2);
      const r = await engine.recompute(WEST);
      expect(r.changes.map((c) => [c.type, 'incident' in c ? c.incident.incident_id : null])).toEqual([
        ['incident.resolved', b.incident_id],
      ]);
      expect((await rows(WEST)).map((x) => [x.incident_id, x.state])).toEqual([
        [a.incident_id, 'firing'],
        [b.incident_id, 'resolved'],
      ]);
      expect((await outbox()).slice(outboxBefore)).toEqual([{ type: 'incident.resolved', incident_id: b.incident_id }]);
      expect(r.state.incidents.find((i) => i.incident_id === a.incident_id)?.state).toBe('firing');
      expect(await persistErrors(WEST)).toBe(1);
    } finally {
      await db.admin.query('DROP TRIGGER fail_incident_write ON server.incidents');
      await db.admin.query('DROP FUNCTION public.fail_incident_write()');
    }
    const healed = await engine.recompute(WEST);
    expect(
      healed.changes
        .filter((c) => c.type === 'incident.resolved')
        .map((c) => 'incident' in c && c.incident.incident_id),
    ).toEqual([a.incident_id]);
    expect((await rows(WEST)).map((x) => x.state)).toEqual(['resolved', 'resolved']);
    expect(await persistErrors(WEST)).toBe(1);
  });
});
