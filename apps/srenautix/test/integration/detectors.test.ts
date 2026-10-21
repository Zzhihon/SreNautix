import { AlertCatalog, computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '@srenautix/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectHealth } from '../../src/detectors/health.js';
import { DEFAULT_EQUIVALENTS, DetectorService, type DetectorSettings } from '../../src/detectors/service.js';
import { applyRemote } from '../../src/ingest/reconcile.js';
import { activeAlerts } from '../../src/ingest/store.js';
import { IngestService } from '../../src/ingest/service.js';
import { ServerMetrics } from '../../src/metrics.js';
import { serverTracks } from '../../src/roles/server-schema.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

// 集群状态检测器经真实 PG 与接入路径（ADR 0105）：上报 → 按阈值合成告警 → alert_state → 事件；
// 同一对象已有告警规则时去重；状态消失时恢复

let db: TestDb;
let ingest: IngestService;
let detectors: DetectorService;
const C = 'east';
const metrics = new ServerMetrics('server', false);
const NOW = Date.parse('2026-10-20T17:00:00Z');
const T = (min: number) => new Date(NOW + min * 60_000);

const settings: DetectorSettings = {
  namespaces: ['*'],
  excludeNamespaces: [],
  thresholdsMs: { pod_init: 10 * 60_000, rollout_stalled: 15 * 60_000, crash_loop: 5 * 60_000 },
  severity: 'warning',
  equivalentAlerts: DEFAULT_EQUIVALENTS,
};

const health = (over: Partial<ObjectHealth> & Pick<ObjectHealth, 'key' | 'state'>): ObjectHealth => {
  const [kind, rest] = over.key.split(':') as [string, string];
  const [ns, name] = rest.split('/') as [string, string];
  return {
    kind,
    namespace: ns,
    name,
    uid: `uid-${name}`,
    since: T(-20).toISOString(),
    reason: 'R',
    message: '',
    owner: null,
    ...over,
  };
};

const firing = async () =>
  (
    await db.server.query<{ alertname: string; component: string | null; status: string; source: string }>(
      "SELECT alertname, component, status, source FROM server.alert_state WHERE cluster_id = $1 AND source = 'detector' ORDER BY alertname, component",
      [C],
    )
  ).rows.map((r) => [r.alertname, r.component, r.status]);

beforeAll(async () => {
  db = await newTestDb();
  await migrateExpand(db.server, 'server', serverTracks);
  const topo = new TopologyStore(db.server);
  const node = (kind: string, name: string) => ({
    key: `${kind}:shop/${name}`,
    kind,
    namespace: 'shop',
    name,
    uid: `uid-${name}`,
    labels: {},
    component_type: null,
    hub: false,
  });
  await topo.apply(C, [
    { op: 'node_upsert', at: T(-60), source: 'informer', node: node('Deployment', 'api') },
    { op: 'node_upsert', at: T(-60), source: 'informer', node: node('ReplicaSet', 'api-1') },
    { op: 'node_upsert', at: T(-60), source: 'informer', node: node('Pod', 'api-1-x') },
    { op: 'node_upsert', at: T(-60), source: 'informer', node: node('Pod', 'api-1-y') },
    { op: 'node_upsert', at: T(-60), source: 'informer', node: node('Deployment', 'web') },
    {
      op: 'edge_upsert',
      at: T(-60),
      source: 'informer',
      edge: {
        from: 'ReplicaSet:shop/api-1',
        to: 'Deployment:shop/api',
        relation: 'owned_by',
        confidence: 1,
        provenance: 'structural',
        scope: 'instance',
        evidence: 'ownerReferences',
      },
    },
    {
      op: 'edge_upsert',
      at: T(-60),
      source: 'informer',
      edge: {
        from: 'Pod:shop/api-1-y',
        to: 'ReplicaSet:shop/api-1',
        relation: 'owned_by',
        confidence: 1,
        provenance: 'structural',
        scope: 'instance',
        evidence: 'ownerReferences',
      },
    },
    {
      op: 'edge_upsert',
      at: T(-60),
      source: 'informer',
      edge: {
        from: 'Pod:shop/api-1-x',
        to: 'ReplicaSet:shop/api-1',
        relation: 'owned_by',
        confidence: 1,
        provenance: 'structural',
        scope: 'instance',
        evidence: 'ownerReferences',
      },
    },
  ] as Parameters<TopologyStore['apply']>[1]);
  ingest = new IngestService(
    db.server,
    [],
    { clusterId: C, selfLabel: 'srenautix_self', watchdogAlertname: 'Watchdog' },
    { catalog: new AlertCatalog([]), nodes: topo, ksm: null, ruleExpr: () => undefined, chronic: () => false },
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
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe('集群状态检测器', () => {
  it('超过阈值的状态合成为告警，经接入路径写入 alert_state；没到阈值的不合成；Pod 的告警组件是它的 Deployment', async () => {
    await detectors.report(
      C,
      [
        health({ key: 'Pod:shop/api-1-x', state: 'pod_init', owner: 'Deployment:shop/api' }),
        health({ key: 'Deployment:shop/web', state: 'rollout_stalled', since: T(-5).toISOString() }),
      ],
      true,
      T(0),
    );
    const r = await detectors.scan(NOW);
    expect(r[C]?.firing.map((a) => a.alertname)).toEqual(['SreNautixPodInitStuck']);
    // 告警的组件是 Pod 沿 owned_by 的顶层属主（ADR 0104）
    expect(await firing()).toEqual([['SreNautixPodInitStuck', 'Deployment:shop/api', 'firing']]);
    // 再扫一次不重复写入
    expect((await detectors.scan(NOW))[C]).toEqual({ firing: [], resolved: [], refired: [] });
    // 收敛：检测器告警成为事件，组件归到 Deployment
    const topo = await new TopologyStore(db.server).at(C, T(0));
    const alerts = await activeAlerts(db.server, C, 30 * 60_000);
    const incs = computeIncidents({
      alerts,
      changes: [],
      graph: new TopologyGraph(topo.nodes, topo.edges, topo.version),
      params: DEFAULT_RCA_PARAMS,
      now: NOW,
    });
    expect(incs.map((i) => [i.ranking.root.component, i.group.alerts.map((x) => x.alert.source)])).toEqual([
      ['Deployment:shop/api', ['detector']],
    ]);
  });

  it('同一对象上同类告警规则在触发时去重：已合成的告警恢复，新的不合成', async () => {
    // 同一工作负载另一个 Pod 上的同类规则不算同一对象（两者的组件都是 Deployment:shop/api）
    const rule = (pod: string, fp: string) => ({
      source: 'alertmanager' as const,
      labels: { alertname: 'KubePodInitializingTooLong', namespace: 'shop', pod, severity: 'warning' },
      annotations: {},
      severity: 'warning' as const,
      status: 'firing' as const,
      suppressed: 'none' as const,
      startsAt: T(-1),
      endsAt: null,
      generatorUrl: null,
      fingerprint: fp,
      alertname: 'KubePodInitializingTooLong',
    });
    await ingest.write(C, 'am', 'alertmanager', [rule('api-1-y', 'bbbbbbbbbbbbbbbb')], {});
    expect((await detectors.scan(NOW + 30_000))[C]).toEqual({ firing: [], resolved: [], refired: [] });
    expect(await firing()).toEqual([['SreNautixPodInitStuck', 'Deployment:shop/api', 'firing']]);
    await ingest.write(
      C,
      'am',
      'alertmanager',
      [
        {
          source: 'alertmanager',
          labels: { alertname: 'KubePodInitializingTooLong', namespace: 'shop', pod: 'api-1-x', severity: 'warning' },
          annotations: {},
          severity: 'warning',
          status: 'firing',
          suppressed: 'none',
          startsAt: T(-1),
          endsAt: null,
          generatorUrl: null,
          fingerprint: 'aaaaaaaaaaaaaaaa',
          alertname: 'KubePodInitializingTooLong',
        },
      ],
      {},
    );
    const r = await detectors.scan(NOW + 60_000);
    expect(r[C]?.resolved.map((a) => a.alertname)).toEqual(['SreNautixPodInitStuck']);
    expect(await firing()).toEqual([['SreNautixPodInitStuck', 'Deployment:shop/api', 'resolved']]);
  });

  it('完整上报里没有了：恢复；不完整的上报不据此恢复', async () => {
    await detectors.report(C, [health({ key: 'Deployment:shop/web', state: 'rollout_stalled' })], true, T(2));
    expect((await detectors.scan(NOW + 2 * 60_000))[C]?.firing.map((a) => a.alertname)).toEqual([
      'SreNautixRolloutStalled',
    ]);
    await detectors.report(C, [], false, T(3));
    expect((await detectors.scan(NOW + 3 * 60_000))[C]).toEqual({ firing: [], resolved: [], refired: [] });
    await detectors.report(C, [], true, T(4));
    expect((await detectors.scan(NOW + 4 * 60_000))[C]?.resolved.map((a) => a.alertname)).toEqual([
      'SreNautixRolloutStalled',
    ]);
    expect((await firing()).find((x) => x[0] === 'SreNautixRolloutStalled')?.[2]).toBe('resolved');
  });

  it('主实例切换（ADR 0128）：对账不结束检测器告警；不是主实例时不写入；新主实例重新触发仍然成立的发现，阈值从重启时间算起时也不恢复', async () => {
    const t0 = NOW + 10 * 60_000;
    const crash = (since: number) =>
      health({
        key: 'Pod:shop/api-1-y',
        state: 'crash_loop',
        since: new Date(since).toISOString(),
        owner: 'Deployment:shop/api',
      });
    await detectors.report(C, [crash(t0 - 8 * 60_000)], true, new Date(t0));
    expect((await detectors.scan(t0))[C]?.firing.map((a) => a.alertname)).toEqual(['SreNautixCrashLoop']);
    const state = async () =>
      (
        await db.server.query<{ alert_id: string; status: string }>(
          "SELECT alert_id, status FROM server.alert_state WHERE cluster_id = $1 AND alertname = 'SreNautixCrashLoop'",
          [C],
        )
      ).rows;
    const [before] = await state();
    expect(before?.status).toBe('firing');

    // 对账读到的告警源里没有检测器告警：不据此结束它
    await applyRemote(db.server, C, new Map(), ['alertmanager'], ingest, metrics, 'srenautix_self', 'Watchdog');
    expect(await state()).toEqual([{ alert_id: before!.alert_id, status: 'firing' }]);

    // 正在退出（或已失去主实例身份）的实例：即使上报里没有了也不写入
    const exiting = new DetectorService(
      db.server,
      settings,
      async () => {
        throw new Error('不是主实例时不应写入');
      },
      metrics,
      () => false,
    );
    await detectors.report(C, [], true, new Date(t0 + 60_000));
    expect(await exiting.scan(t0 + 60_000)).toEqual({});
    expect(await state()).toEqual([{ alert_id: before!.alert_id, status: 'firing' }]);

    // 旧实例退出时告警被标成恢复，发现表里它仍是活跃的；新主实例的上报从重启时间算起（还没到 5 分钟的阈值）
    await db.server.query("UPDATE server.alert_state SET status = 'resolved', ends_at = $2 WHERE alert_id = $1", [
      before!.alert_id,
      new Date(t0 + 90_000),
    ]);
    await detectors.report(C, [crash(t0 + 2 * 60_000)], true, new Date(t0 + 2 * 60_000));
    const r = await detectors.scan(t0 + 2 * 60_000);
    expect(r[C]).toMatchObject({ firing: [], resolved: [] });
    expect(r[C]?.refired.map((a) => a.alertname)).toEqual(['SreNautixCrashLoop']);
    // 同一个告警重新触发（指纹与开始时间不变）
    expect(await state()).toEqual([{ alert_id: before!.alert_id, status: 'firing' }]);
    // 告警在触发时不重复写入；对象恢复后照常恢复
    expect((await detectors.scan(t0 + 3 * 60_000))[C]).toEqual({ firing: [], resolved: [], refired: [] });
    await detectors.report(C, [], true, new Date(t0 + 4 * 60_000));
    expect((await detectors.scan(t0 + 4 * 60_000))[C]?.resolved.map((a) => a.alertname)).toEqual([
      'SreNautixCrashLoop',
    ]);
    expect(await state()).toEqual([{ alert_id: before!.alert_id, status: 'resolved' }]);
  });
});
