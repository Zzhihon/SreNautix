import type { Alert, ChangeEvent, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '@srenautix/core';
import { startPrometheus, type FixtureMetricSeries, type TsdbInstance } from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changesTrack } from '../../src/changes/migrations.js';
import { MetricsChanges } from '../../src/changes/metrics-changes.js';
import { mergeChanges } from '../../src/changes/pending-sync.js';
import { EvidenceSource } from '../../src/stage-a/packs.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { topologyTrack } from '../../src/topology/migrations.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

/**
 * server 从指标推导的退役与已合并、尚未同步的提交（ADR 0161），真实 Prometheus 与 PostgreSQL：
 * - store-master 30 分钟前删除，它的 Pod 是抓取 job store 的唯一目标；管理应用 store 的上层应用 platform；
 *   35 分钟前合并的提交触及 platform，是退役的计划依据。worker 20 分钟前缩到 0 并保持；gateway 一直在；
 * - 应用 metrics 50 分钟前之后一直 OutOfSync；45 分钟前与 2 小时前的提交触及它，只有前者在最后一次 Synced 之后；
 * - 事件引擎的输入：抓取 job 消失的告警归到退役变更，根因是管理应用；漂移告警所在的事件列出未同步的提交。
 */
const C = 'east';
const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const T0 = NOW - 180 * MIN;
const APP = 'Application.argoproj.io:argocd/store';
const PARENT = 'Application.argoproj.io:argocd/platform';
const METRICS = 'Application.argoproj.io:argocd/metrics';
const STS = 'StatefulSet:shop-data/store-master';
const POD = 'Pod:shop-data/store-master-0';

let db: TestDb;
let prom: TsdbInstance;
let source: EvidenceSource;

/** [from, to] 内每分钟一个值为 v 的样本 */
const during = (labels: Record<string, string>, from: number, to: number, v = 1): FixtureMetricSeries => ({
  labels,
  points: Array.from({ length: (NOW - T0) / MIN + 1 }, (_, i) => T0 + i * MIN)
    .filter((t) => t >= from && t <= to)
    .map((t) => ({ t, v })),
});

const node = (key: string): TopologyNode => {
  const kind = key.slice(0, key.indexOf(':'));
  const rest = key.slice(key.indexOf(':') + 1);
  const [ns, name] = rest.split('/') as [string, string];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub: false };
};
const edge = (from: string, to: string, relation: string): TopologyEdge =>
  ({ from, to, relation, confidence: 1, provenance: 'structural', scope: 'service', evidence: 'test' }) as TopologyEdge;

const commit = (sha: string, at: number, targets: string[]): ChangeEvent => ({
  change_id: `ops:${sha}`,
  source: 'ops',
  kind: 'config',
  refs: [sha],
  revision: sha,
  actor: null,
  time: new Date(at).toISOString(),
  link: `https://example.com/ops/commit/${sha}`,
  targets,
  summary: `commit ${sha}`,
});

beforeAll(async () => {
  prom = await startPrometheus([
    during(
      { __name__: 'kube_statefulset_replicas', namespace: 'shop-data', statefulset: 'store-master' },
      T0,
      NOW - 30 * MIN,
      3,
    ),
    during({ __name__: 'kube_statefulset_replicas', namespace: 'shop', statefulset: 'gateway' }, T0, NOW, 4),
    during(
      { __name__: 'kube_deployment_spec_replicas', namespace: 'shop', deployment: 'worker' },
      T0,
      NOW - 21 * MIN,
      2,
    ),
    during(
      { __name__: 'kube_deployment_spec_replicas', namespace: 'shop', deployment: 'worker' },
      NOW - 20 * MIN,
      NOW,
      0,
    ),
    during({ __name__: 'up', job: 'store', namespace: 'shop-data', pod: 'store-master-0' }, T0, NOW - 30 * MIN),
    during({ __name__: 'up', job: 'gateway', namespace: 'shop', pod: 'gateway-0' }, T0, NOW),
    during(
      { __name__: 'argocd_app_info', namespace: 'argocd', name: 'metrics', sync_status: 'Synced' },
      T0,
      NOW - 50 * MIN,
    ),
    during(
      { __name__: 'argocd_app_info', namespace: 'argocd', name: 'metrics', sync_status: 'OutOfSync' },
      NOW - 49 * MIN,
      NOW,
    ),
    during({ __name__: 'argocd_app_info', namespace: 'argocd', name: 'fine', sync_status: 'Synced' }, T0, NOW),
  ]);
  source = await EvidenceSource.create({
    id: 'prometheus',
    url: prom.url,
    dialect: 'promql',
    bearerTokenFile: null,
    timeoutMs: 30_000,
  });
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, topologyTrack, changesTrack]);
  const at = new Date(T0);
  await new TopologyStore(db.server).apply(C, [
    { op: 'node_upsert', at, source: 'informer', node: node(STS) },
    { op: 'node_upsert', at, source: 'informer', node: node(POD) },
    { op: 'node_upsert', at, source: 'informer', node: node(APP) },
    { op: 'edge_upsert', at, source: 'informer', edge: edge(POD, STS, 'owned_by') },
    { op: 'edge_upsert', at, source: 'informer', edge: edge(STS, APP, 'managed_by') },
    { op: 'edge_upsert', at, source: 'informer', edge: edge(APP, PARENT, 'managed_by') },
  ]);
  for (const c of [
    commit('plan000', NOW - 35 * MIN, [PARENT]),
    commit('synced0', NOW - 120 * MIN, [METRICS]),
    commit('pending', NOW - 45 * MIN, [METRICS, APP]),
  ]) {
    await db.server.query(
      'INSERT INTO server.change_events (change_id, cluster_id, source, time, targets, body) VALUES ($1, $2, $3, $4, $5, $6)',
      [c.change_id, C, c.source, c.time, c.targets, JSON.stringify(c)],
    );
  }
}, 180_000);

afterAll(async () => {
  await prom?.stop();
  await db?.close();
});

const changes = () =>
  new MetricsChanges({
    pool: db.server,
    topology: new TopologyStore(db.server),
    clusterId: C,
    dataSource: (at) => source.dataSource(at),
    retirements: true,
    pendingSync: { enabled: true, lookbackMs: 72 * 3600_000 },
    groupWithinMs: 2 * MIN,
  });

describe('server 从指标推导的变更（ADR 0161）', () => {
  it('删除与缩到 0 的工作负载是退役：带上失去目标的抓取 job、管理应用与计划依据', async () => {
    const out = await changes().retirements(new Date(NOW - 120 * MIN), new Date(NOW));
    const store = out.find((c) => c.targets.includes(STS))!;
    expect(store).toMatchObject({
      source: 'kubernetes',
      kind: 'retire',
      refs: [APP],
      targets: [APP, STS],
      scrape_jobs: ['store'],
      planned_by: [expect.objectContaining({ change_id: 'ops:plan000', revision: 'plan000' })],
    });
    // Prometheus 的回填数据没有过期标记，序列在最后一个样本之后还会按默认回看（5 分钟）出现
    const t = Date.parse(store.time);
    expect(t).toBeGreaterThan(NOW - 30 * MIN);
    expect(t).toBeLessThanOrEqual(NOW - 23 * MIN);
    const worker = out.find((c) => c.targets.includes('Deployment:shop/worker'))!;
    expect(worker).toMatchObject({ refs: [], time: new Date(NOW - 20 * MIN).toISOString() });
    expect(worker.scrape_jobs).toBeUndefined();
    expect(out.some((c) => c.targets.includes('StatefulSet:shop/gateway'))).toBe(false);
  });

  it('OutOfSync 的应用：最后一次 Synced 之后合并的提交标上 pending_sync', async () => {
    const out = await changes().pendingSync(new Date(NOW));
    expect(out.map((c) => c.change_id)).toEqual(['ops:pending']);
    expect(out[0]!.pending_sync).toHaveLength(1);
    const p = out[0]!.pending_sync![0]!;
    expect(p.application).toBe(METRICS);
    // 回填数据没有过期标记：Synced 序列在最后一个样本之后按默认回看还会出现最多 5 分钟
    const since = Date.parse(p.out_of_sync_since!);
    expect(since).toBeGreaterThanOrEqual(NOW - 49 * MIN);
    expect(since).toBeLessThanOrEqual(NOW - 44 * MIN);
  });

  it('事件引擎的输入：抓取 job 消失的告警归到退役变更，漂移告警所在的事件列出未同步的提交', async () => {
    const mc = changes();
    const input = mergeChanges(
      [...(await mc.retirements(new Date(NOW - 120 * MIN), new Date(NOW)))],
      await mc.pendingSync(new Date(NOW)),
    );
    const alert = (alertname: string, start: number, component: string, labels: Record<string, string>): Alert => ({
      alert_id: `${alertname}@${start / 1000}`,
      cluster_id: C,
      source: 'reconcile',
      fingerprint: alertname.padEnd(16, '0').slice(0, 16),
      alertname,
      labels: { alertname, ...labels },
      annotations: {},
      severity: 'warning',
      status: 'firing',
      suppressed: 'none',
      starts_at: new Date(start).toISOString(),
      ends_at: null,
      generator_url: null,
      classification: {
        role: alertname === 'ScrapeJobVanished' ? 'meta' : 'cause',
        source: 'label',
        confidence: 1,
        catalog_entry: null,
        chronic: false,
      },
      entity: null,
      entity_resolution: 'labels',
      component,
      received_at: new Date(start).toISOString(),
    });
    const graph = new TopologyGraph([node(STS), node(METRICS)], [], 1);
    const inc = computeIncidents({
      alerts: [
        alert('ScrapeJobVanished', NOW - 15 * MIN, 'Job:store', { job: 'store' }),
        alert('AppDrift', NOW - 5 * MIN, METRICS, { name: 'metrics' }),
      ],
      changes: input,
      graph,
      params: DEFAULT_RCA_PARAMS,
      now: NOW,
    });
    const scrape = inc.find((x) => x.group.alerts.some((a) => a.alert.alertname === 'ScrapeJobVanished'))!;
    expect(scrape.ranking.root.component).toBe(APP);
    expect(scrape.group.changes.map((c) => c.kind)).toEqual(['retire']);
    const drift = inc.find((x) => x.group.alerts.some((a) => a.alert.alertname === 'AppDrift'))!;
    expect(drift.ranking.root.component).toBe(METRICS);
    expect([...drift.group.changes, ...drift.group.pendingChanges].map((c) => c.change_id)).toEqual(['ops:pending']);
  });
});
