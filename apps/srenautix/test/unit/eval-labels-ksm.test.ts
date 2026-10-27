import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TopologyEdge, TopologyNode } from '@srenautix/contract';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveRollouts } from '../../src/changes/kubernetes.js';
import { type TopologyRow } from '../../src/eval/bundle.js';
import { discoveryRoots, loadLabels, type Label } from '../../src/eval/labels.js';
import { compareRoots } from '../../src/eval/phase2.js';
import type { RunRecord } from '../../src/eval/score.js';
import { BundleTopology } from '../../src/eval/reconstruct.js';
import { TEST_ENVIRONMENT } from '../support/eval-environment.js';

// 标注的发现根因与修订记录；重建包拓扑在状态库没有记录时用 kube-state-metrics 历史推导新的 ReplicaSet（ADR 0110）

const DIR = resolve(import.meta.dirname, '../../../../.scratch', `eval-labels-${process.pid}`);

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe('标注', () => {
  it('discovery_roots 为空时与 roots 相同；修订记录随标注读入', () => {
    mkdirSync(DIR, { recursive: true });
    const path = join(DIR, 'labels.yaml');
    writeFileSync(
      path,
      [
        'version: 1',
        'cluster_id: prod',
        'labels:',
        '  - id: a',
        '    title: 迁移被拒绝',
        '    type: incident',
        '    window: { from: 2026-10-16T01:20:00Z, to: 2026-10-16T02:00:00Z }',
        '    as_of: 2026-10-16T01:35:00Z',
        '    fault_alerts: [{ alertname: KubeJobFailed }]',
        '    roots: [cluster:db]',
        '    discovery_roots: [cluster:db, Job:prod/migrate-1, component:release]',
        '    revisions:',
        '      - { date: 2026-10-21, change: 增加 discovery_roots, reason: 发布与迁移是变更源头 }',
        '    evidence: [{ kind: report, ref: r.md }]',
        '  - id: b',
        '    title: 其他',
        '    type: incident',
        '    window: { from: 2026-10-16T01:20:00Z, to: 2026-10-16T02:00:00Z }',
        '    as_of: 2026-10-16T01:35:00Z',
        '    fault_alerts: [{ alertname: X }]',
        '    roots: [Deployment:prod/api]',
        '    evidence: [{ kind: report, ref: r.md }]',
      ].join('\n'),
    );
    const f = loadLabels(path);
    expect(discoveryRoots(f.labels[0]!)).toEqual(['cluster:db', 'Job:prod/migrate-1', 'component:release']);
    expect(f.labels[0]!.roots).toEqual(['cluster:db']);
    expect(f.labels[0]!.revisions).toHaveLength(1);
    expect(discoveryRoots(f.labels[1]!)).toEqual(['Deployment:prod/api']);
  });
});

const node = (key: string, kind: string, namespace: string | null, name: string): TopologyNode => ({
  key,
  kind,
  namespace,
  name,
  uid: null,
  labels: {},
  component_type: null,
  hub: false,
});
const edge = (from: string, to: string, relation: string): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: 'structural',
  confidence: 1,
  scope: 'service',
  evidence: 'test',
});

describe('kube-state-metrics 回退', () => {
  const T0 = Date.parse('2026-10-18T00:00:00Z');
  const iso = (m: number) => new Date(T0 + m * 60_000).toISOString();
  let seq = 0;
  const row = (
    source: string,
    item: 'node' | 'edge',
    body: TopologyNode | TopologyEdge,
    from: number,
    to: number | null,
  ): TopologyRow => ({
    seq: source === 'ksm_history' ? -1000 + ++seq : ++seq,
    op: item === 'node' ? 'node_upsert' : 'edge_upsert',
    item,
    key:
      item === 'node'
        ? (body as TopologyNode).key
        : `${(body as TopologyEdge).from}|${(body as TopologyEdge).relation}|${(body as TopologyEdge).to}`,
    valid_from: iso(from),
    valid_to: to === null ? null : iso(to),
    source,
    body,
  });
  const dep = node('Deployment:prod/api', 'Deployment', 'prod', 'api');
  const app = node('Application.argoproj.io:argocd/prod', 'Application.argoproj.io', 'argocd', 'prod');
  const oldRs = node('ReplicaSet:prod/api-1', 'ReplicaSet', 'prod', 'api-1');
  const newRs = node('ReplicaSet:prod/api-2', 'ReplicaSet', 'prod', 'api-2');
  const stateRs = node('ReplicaSet:prod/web-2', 'ReplicaSet', 'prod', 'web-2');
  const rows: TopologyRow[] = [
    // 状态库只有应用与 Deployment 的管理关系，没有 api 的 ReplicaSet
    row('informer', 'node', app, 0, null),
    row('informer', 'node', dep, 0, null),
    row('informer', 'edge', edge(dep.key, app.key, 'managed_by'), 0, null),
    // kube-state-metrics：导出起点就存在的旧 ReplicaSet，与 60 分钟时出现的新 ReplicaSet
    row('ksm_history', 'node', dep, 0, null),
    row('ksm_history', 'node', oldRs, 0, 70),
    row('ksm_history', 'edge', edge(oldRs.key, dep.key, 'owned_by'), 0, 70),
    row('ksm_history', 'node', newRs, 60, null),
    row('ksm_history', 'edge', edge(newRs.key, dep.key, 'owned_by'), 60, null),
    // 状态库有记录的 ReplicaSet：kube-state-metrics 的同名记录不再使用
    row('informer', 'node', stateRs, 30, null),
    row('ksm_history', 'node', stateRs, 25, null),
  ];

  it('kube-state-metrics 的边端点改写成状态库中同一个对象的键（kind 不带 API 组）', () => {
    const cluster = node('Cluster.postgresql.cnpg.io:data/pg', 'Cluster.postgresql.cnpg.io', 'data', 'pg');
    const ksmCluster = node('Cluster:data/pg', 'Cluster', 'data', 'pg');
    const pod = node('Pod:data/pg-1', 'Pod', 'data', 'pg-1');
    const topo = new BundleTopology([
      row('informer', 'node', cluster, 0, null),
      row('ksm_history', 'node', ksmCluster, 0, null),
      row('ksm_history', 'node', pod, 0, null),
      row('ksm_history', 'edge', edge(pod.key, ksmCluster.key, 'owned_by'), 0, null),
    ]);
    const g = topo.at(T0 + 10 * 60_000);
    expect(g.edges.filter((e) => e.from === pod.key).map((e) => e.to)).toEqual([cluster.key]);
    expect(g.graph.componentOf(pod.key)).toBe(cluster.key);
  });

  it('研判根因与发现根因按属主粒度比较：同一工作负载的 Pod 算一致，弃权与没有根因的运行不比较', () => {
    const pod = node('Pod:prod/api-2-x', 'Pod', 'prod', 'api-2-x');
    const topo = new BundleTopology([
      ...rows,
      row('informer', 'node', pod, 0, null),
      row('informer', 'edge', edge(pod.key, newRs.key, 'owned_by'), 0, null),
      row('ksm_history', 'edge', edge(newRs.key, dep.key, 'owned_by'), 0, null),
    ]);
    const asOf = T0 + 90 * 60_000;
    expect(topo.ownerAt(pod.key, asOf)).toBe(dep.key);
    const run = (caseId: string, i: number, top: string[], level: RunRecord['level']): RunRecord => ({
      caseId,
      run: i,
      routeId: 'r',
      model: 'm',
      environment: TEST_ENVIRONMENT,
      state: 'completed',
      structuredFailure: false,
      level,
      disposition: null,
      top,
      cost: 0,
      currency: 'USD',
      inputTokens: 0,
      outputTokens: 0,
      missRate: null,
      fingerprints: [],
      durationMs: 0,
      error: null,
      proposals: [],
    });
    const incidents = new Map([
      ['label:a', { root: dep.key, ownerOf: (k: string) => topo.ownerAt(k, asOf) }],
      ['label:b', { root: null, ownerOf: (k: string) => topo.ownerAt(k, asOf) }],
    ]);
    const label = { roots: [app.key] } as unknown as Label;
    const r = compareRoots(
      [
        run('label:a', 0, [pod.key], 'likely'),
        run('label:a', 1, [app.key], 'likely'),
        run('label:a', 2, [app.key], 'inconclusive'),
        run('label:b', 0, [app.key], 'likely'),
      ],
      incidents,
      new Map([['label:a', label]]),
    );
    expect(r.by_route).toEqual({ r: { compared: 2, mismatched: 1 } });
    expect(r.mismatches).toEqual([
      {
        case: 'label:a',
        route: 'r',
        run: 1,
        incident_root: dep.key,
        research_root: app.key,
        research_hit: true,
        incident_hit: false,
      },
    ]);
  });

  it('节点查找命中 kube-state-metrics 的同名对象时返回状态库中同一个对象的键', async () => {
    const cluster = node('Cluster.postgresql.cnpg.io:data/pg', 'Cluster.postgresql.cnpg.io', 'data', 'pg');
    const ksmCluster = node('Cluster:data/pg', 'Cluster', 'data', 'pg');
    const topo = new BundleTopology([
      row('informer', 'node', cluster, 0, null),
      row('ksm_history', 'node', ksmCluster, 0, null),
    ]);
    topo.now = T0 + 10 * 60_000;
    // 告警目录的实体 kind 写 Cluster：kind 完全相同的是 kube-state-metrics 的节点
    const hit = await topo.find('c', 'Cluster', 'data', 'pg', new Date(T0 + 10 * 60_000));
    expect(hit?.key).toBe(cluster.key);
  });

  it('状态库没有的 ReplicaSet 用 kube-state-metrics 第一次出现的时刻，属主与管理应用齐全；导出起点就存在的不算', () => {
    const topo = new BundleTopology(rows);
    const ev = topo.workloadEvents(T0, T0 + 120 * 60_000);
    const fromKsm = ev.filter((e) => e.seq < 0);
    expect(fromKsm).toHaveLength(1);
    expect(fromKsm[0]).toMatchObject({
      key: newRs.key,
      owner: dep.key,
      ownerSeenBefore: true,
      managers: [app.key],
      previous: null,
      valid_from: iso(60),
    });
    // 状态库的记录照常推导（没有属主边时 owner 为 null）
    expect(ev.filter((e) => e.key === stateRs.key).map((e) => e.seq > 0)).toEqual([true]);
  });

  it('StatefulSet 的 update revision（ADR 0104 §11）：状态库没有记录的变化用 kube-state-metrics 推导；起点就在的与状态库已记录的不算', () => {
    const gw = node('StatefulSet:prod/gateway', 'StatefulSet', 'prod', 'gateway');
    const cache = node('StatefulSet:prod/cache', 'StatefulSet', 'prod', 'cache');
    const cr = (name: string) => node(`ControllerRevision:prod/${name}`, 'ControllerRevision', 'prod', name);
    const labelled = (n: TopologyNode, v: string): TopologyNode => ({ ...n, labels: { release: v } });
    const stsRows: TopologyRow[] = [
      row('informer', 'node', app, 0, null),
      row('informer', 'node', labelled(gw, 'r1'), 0, null),
      row('informer', 'edge', edge(gw.key, app.key, 'managed_by'), 0, null),
      // cache：状态库在 90 分钟时记录了版本标签变化
      row('informer', 'node', labelled(cache, 'r1'), 0, 90),
      row('informer', 'node', labelled(cache, 'r2'), 90, null),
      // kube-state-metrics：gateway-r1 起点就在；gateway-r2 在 60 分钟时出现；cache-r2 在 92 分钟时出现
      row('ksm_history', 'node', gw, 0, null),
      row('ksm_history', 'node', cr('gateway-r1'), 0, 60),
      row('ksm_history', 'edge', edge(`ControllerRevision:prod/gateway-r1`, gw.key, 'owned_by'), 0, 60),
      row('ksm_history', 'node', cr('gateway-r2'), 60, null),
      row('ksm_history', 'edge', edge(`ControllerRevision:prod/gateway-r2`, gw.key, 'owned_by'), 60, null),
      row('ksm_history', 'node', cache, 0, null),
      row('ksm_history', 'node', cr('cache-r1'), 0, 92),
      row('ksm_history', 'edge', edge(`ControllerRevision:prod/cache-r1`, cache.key, 'owned_by'), 0, 92),
      row('ksm_history', 'node', cr('cache-r2'), 92, null),
      row('ksm_history', 'edge', edge(`ControllerRevision:prod/cache-r2`, cache.key, 'owned_by'), 92, null),
    ];
    const ev = new BundleTopology(stsRows).workloadEvents(T0, T0 + 120 * 60_000);
    const revs = ev.filter((e) => e.kind === 'ControllerRevision');
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({
      key: 'ControllerRevision:prod/gateway-r2',
      owner: gw.key,
      ownerSeenBefore: true,
      managers: [app.key],
      valid_from: iso(60),
    });
    // 推导出的发布目标是 StatefulSet 与它的管理应用
    const r = deriveRollouts(ev, { clusterId: 'prod', revisionLabels: ['release'], groupWithinMs: 120_000 });
    expect(r.find((c) => c.targets.includes(gw.key))).toMatchObject({
      time: iso(60),
      targets: [gw.key, app.key],
      revision: 'gateway-r2',
    });
  });
});
