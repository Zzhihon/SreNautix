import type { TopologyEdge, TopologyNode } from '@srenautix/contract';
import {
  PrometheusApiAdapter,
  startPrometheus,
  type FixtureMetricSeries,
  type TsdbInstance,
} from '@srenautix/integration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ksmRollouts } from '../../src/changes/ksm-rollouts.js';
import { migrateExpand } from '../../src/store/migrate.js';
import { storeTrack } from '../../src/store/migrations.js';
import { topologyTrack } from '../../src/topology/migrations.js';
import { TopologyStore } from '../../src/topology/store.js';
import { newTestDb, type TestDb } from '../support/db.js';

/**
 * informer 空窗时从 kube-state-metrics 推导发布（ADR 0104 §11），真实 Prometheus 与 PostgreSQL：
 * 拓扑里没有记录、属主 Deployment 早已存在的新 ReplicaSet 是一次发布，管理应用取拓扑里的 managed_by；
 * 拓扑里记录过的 ReplicaSet、新建的 Deployment 带出的第一个 ReplicaSet、窗口之外创建的都不算。
 */
const C = 'east';
const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const T0 = NOW - 60 * MIN;
const APP = 'Application.argoproj.io:argocd/shop';

let db: TestDb;
let prom: TsdbInstance;
let adapter: PrometheusApiAdapter;

/** 一条值恒为 v 的序列，覆盖 [T0, NOW] */
const constant = (labels: Record<string, string>, v: number): FixtureMetricSeries => ({
  labels,
  points: Array.from({ length: 61 }, (_, i) => ({ t: T0 + i * MIN, v })),
});
const s = (t: number) => Math.floor(t / 1000);

beforeAll(async () => {
  prom = await startPrometheus([
    // api：Deployment 一天前就有，30 分钟前出现新的 ReplicaSet api-new（informer 没有记录）
    constant({ __name__: 'kube_deployment_created', namespace: 'shop', deployment: 'api' }, s(NOW - 24 * 3600_000)),
    constant({ __name__: 'kube_replicaset_created', namespace: 'shop', replicaset: 'api-new' }, s(NOW - 30 * MIN)),
    constant(
      {
        __name__: 'kube_replicaset_owner',
        namespace: 'shop',
        replicaset: 'api-new',
        owner_kind: 'Deployment',
        owner_name: 'api',
      },
      1,
    ),
    // api 的旧 ReplicaSet：窗口之外创建
    constant({ __name__: 'kube_replicaset_created', namespace: 'shop', replicaset: 'api-old' }, s(NOW - 48 * 3600_000)),
    constant(
      {
        __name__: 'kube_replicaset_owner',
        namespace: 'shop',
        replicaset: 'api-old',
        owner_kind: 'Deployment',
        owner_name: 'api',
      },
      1,
    ),
    // web：新建的 Deployment 带出的第一个 ReplicaSet，不是发布
    constant({ __name__: 'kube_deployment_created', namespace: 'shop', deployment: 'web' }, s(NOW - 20 * MIN)),
    constant({ __name__: 'kube_replicaset_created', namespace: 'shop', replicaset: 'web-1' }, s(NOW - 20 * MIN)),
    constant(
      {
        __name__: 'kube_replicaset_owner',
        namespace: 'shop',
        replicaset: 'web-1',
        owner_kind: 'Deployment',
        owner_name: 'web',
      },
      1,
    ),
    // pay：拓扑里记录过的 ReplicaSet，由拓扑事件推导，这里不重复
    constant({ __name__: 'kube_deployment_created', namespace: 'shop', deployment: 'pay' }, s(NOW - 24 * 3600_000)),
    constant({ __name__: 'kube_replicaset_created', namespace: 'shop', replicaset: 'pay-2' }, s(NOW - 25 * MIN)),
    constant(
      {
        __name__: 'kube_replicaset_owner',
        namespace: 'shop',
        replicaset: 'pay-2',
        owner_kind: 'Deployment',
        owner_name: 'pay',
      },
      1,
    ),
  ]);
  adapter = new PrometheusApiAdapter({ id: 'prometheus', url: prom.url, dialects: ['promql'] });
  db = await newTestDb();
  await migrateExpand(db.server, 'server', [storeTrack, topologyTrack]);
  const node = (kind: string, name: string): TopologyNode => ({
    key: `${kind}:shop/${name}`,
    kind,
    namespace: 'shop',
    name,
    uid: null,
    labels: {},
    component_type: null,
    hub: false,
  });
  const at = new Date(NOW - 26 * 3600_000);
  await new TopologyStore(db.server).apply(C, [
    { op: 'node_upsert', at, source: 'informer', node: node('Deployment', 'api') },
    { op: 'node_upsert', at, source: 'informer', node: node('ReplicaSet', 'pay-2') },
    {
      op: 'edge_upsert',
      at,
      source: 'informer',
      edge: {
        from: 'Deployment:shop/api',
        to: APP,
        relation: 'managed_by',
        confidence: 1,
        provenance: 'structural',
      } as TopologyEdge,
    },
  ]);
}, 180_000);

afterAll(async () => {
  await prom?.stop();
  await db?.close();
});

describe('从 kube-state-metrics 推导发布', () => {
  it('只有 informer 漏掉的那次发布：目标是 Deployment 与管理它的应用，change_id 与拓扑事件的不冲突', async () => {
    const out = await ksmRollouts(db.server, (req) => adapter.query(req), new Date(NOW - 45 * MIN), new Date(NOW), {
      clusterId: C,
      revisionLabels: [],
      groupWithinMs: 120_000,
    });
    expect(out).toEqual([
      expect.objectContaining({
        source: 'kubernetes',
        kind: 'rollout',
        targets: ['Deployment:shop/api', APP],
        time: new Date(NOW - 30 * MIN).toISOString(),
        change_id: expect.stringMatching(/^kubernetes:east:ksm-\d+$/),
      }),
    ]);
  });

  it('窗口里没有新建的 ReplicaSet：没有发布', async () => {
    const out = await ksmRollouts(db.server, (req) => adapter.query(req), new Date(NOW - 10 * MIN), new Date(NOW), {
      clusterId: C,
      revisionLabels: [],
      groupWithinMs: 120_000,
    });
    expect(out).toEqual([]);
  });

  it('时钟窗口的起点不是整秒时也能查询（回看不早于窗口起点）', async () => {
    const from = new Date(NOW - 45 * MIN + 123);
    const out = await ksmRollouts(db.server, (req) => adapter.query(req), from, new Date(NOW + 456), {
      clusterId: C,
      revisionLabels: [],
      groupWithinMs: 120_000,
    });
    expect(out.map((c) => c.targets)).toEqual([['Deployment:shop/api', APP]]);
  });
});

describe('从 kube-state-metrics 推导 StatefulSet 的发布（update revision，ADR 0104 §11）', () => {
  let p: TsdbInstance;
  let a: PrometheusApiAdapter;
  /** 只在 [from, to] 内有样本的序列 */
  const during = (labels: Record<string, string>, from: number, to: number): FixtureMetricSeries => ({
    labels,
    points: Array.from({ length: 61 }, (_, i) => T0 + i * MIN)
      .filter((t) => t >= from && t <= to)
      .map((t) => ({ t, v: 1 })),
  });
  const rev = (sts: string, revision: string, from: number, to: number) =>
    during(
      { __name__: 'kube_statefulset_status_update_revision', namespace: 'data', statefulset: sts, revision },
      from,
      to,
    );
  const created = (sts: string, at: number) =>
    constant({ __name__: 'kube_statefulset_created', namespace: 'data', statefulset: sts }, s(at));

  beforeAll(async () => {
    p = await startPrometheus([
      // gateway：25 分钟前换了 revision（informer 没有记录）
      created('gateway', NOW - 24 * 3600_000),
      rev('gateway', 'gateway-r1', T0, NOW - 26 * MIN),
      rev('gateway', 'gateway-r2', NOW - 25 * MIN, NOW),
      // cache：15 分钟前换了 revision，拓扑在同一时间记录了 StatefulSet 的变化（版本标签变化），不重复
      created('cache', NOW - 24 * 3600_000),
      rev('cache', 'cache-r1', T0, NOW - 16 * MIN),
      rev('cache', 'cache-r2', NOW - 15 * MIN, NOW),
      // db：整个窗口都是同一个 revision，没有变化
      created('db', NOW - 24 * 3600_000),
      rev('db', 'db-r1', T0, NOW),
      // queue：新建的 StatefulSet 的第一个 revision 不是发布
      created('queue', NOW - 20 * MIN),
      rev('queue', 'queue-r1', NOW - 20 * MIN, NOW),
    ]);
    a = new PrometheusApiAdapter({ id: 'prometheus', url: p.url, dialects: ['promql'] });
    const sts = (name: string, release: string): TopologyNode => ({
      key: `StatefulSet:data/${name}`,
      kind: 'StatefulSet',
      namespace: 'data',
      name,
      uid: null,
      labels: { release },
      component_type: null,
      hub: false,
    });
    const store = new TopologyStore(db.server);
    await store.apply(C, [
      { op: 'node_upsert', at: new Date(NOW - 26 * 3600_000), source: 'informer', node: sts('gateway', 'r1') },
      { op: 'node_upsert', at: new Date(NOW - 26 * 3600_000), source: 'informer', node: sts('cache', 'r1') },
      {
        op: 'edge_upsert',
        at: new Date(NOW - 26 * 3600_000),
        source: 'informer',
        edge: {
          from: 'StatefulSet:data/gateway',
          to: APP,
          relation: 'managed_by',
          confidence: 1,
          provenance: 'structural',
        } as TopologyEdge,
      },
    ]);
    await store.apply(C, [
      { op: 'node_upsert', at: new Date(NOW - 15 * MIN + 20_000), source: 'informer', node: sts('cache', 'r2') },
    ]);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  it('窗口内第一次出现的 revision 是一次发布；起点就在的、拓扑已记录的、新建 StatefulSet 的都不算', async () => {
    const out = await ksmRollouts(db.server, (req) => a.query(req), new Date(NOW - 45 * MIN), new Date(NOW), {
      clusterId: C,
      revisionLabels: ['release'],
      groupWithinMs: 120_000,
    });
    expect(out).toEqual([
      expect.objectContaining({
        kind: 'rollout',
        targets: ['StatefulSet:data/gateway', APP],
        revision: 'gateway-r2',
        change_id: expect.stringMatching(/^kubernetes:east:ksm-\d+$/),
      }),
    ]);
    // revision 第一次出现的时刻精确到子查询的步长
    expect(Math.abs(Date.parse(out[0]!.time) - (NOW - 25 * MIN))).toBeLessThanOrEqual(30_000);
  });
});
