import { describe, expect, it } from 'vitest';
import type { TopologyEdge, TopologyNode } from '@srenautix/contract';
import { ServiceCatalog } from '@srenautix/packs-sdk/business';
import { buildKubeTopology, clusterMap } from '../src/index.js';
import { clusterObjects, COMPONENT_TYPES, CONVENTIONS } from './fixtures.js';

const snapshot = () => ({
  ...buildKubeTopology(clusterObjects(), { componentTypes: COMPONENT_TYPES, conventions: CONVENTIONS }),
  version: 7,
});
const t = (zh: string) => ({ 'zh-CN': zh, en: zh });
const catalog = new ServiceCatalog(
  [
    {
      pack: 'test',
      domains: [
        {
          id: 'shop',
          title: t('商城'),
          tier: 'core',
          services: [
            {
              id: 'orders-api',
              title: t('订单接口'),
              members: [{ match: { kind: 'Deployment', name_pattern: '^api$' } }],
              namespaces: ['shop'],
            },
            { id: 'orders-db', title: t('订单库'), members: [{ component_type: 'postgres.cluster' }] },
            {
              id: 'unused',
              title: t('没有组件'),
              members: [{ match: { kind: 'Deployment', name_pattern: '^nope$' } }],
            },
          ],
        },
        {
          id: 'web',
          title: t('前端'),
          tier: 'supporting',
          services: [{ id: 'frontend', title: t('前端'), members: [{ match: { kind: 'Pod', namespaces: ['web'] } }] }],
        },
      ],
    },
  ],
  COMPONENT_TYPES,
);

describe('全集群地图（ADR 0199）', () => {
  const m = () => clusterMap(snapshot(), catalog, COMPONENT_TYPES);
  const edge = (e: ReturnType<typeof m>['edges'][number]) =>
    `${e.from} -> ${e.to} [${e.relations.join(',')} ×${e.count} ${e.provenance} ${e.confidence}]`;

  it('组件是有 Pod 的顶层对象与路由入口；Pod、ReplicaSet、PVC 计入成员，枢纽与节点单独列出', () => {
    const map = m();
    expect(map.components.map((c) => c.key)).toEqual([
      'Cluster:shop/pg',
      'Deployment:shop/api',
      'Deployment:shop/worker',
      'Deployment:web/frontend',
      'Ingress:web/frontend',
      'StatefulSet:shop/search',
    ]);
    expect(map.components[0]).toMatchObject({
      component_type: 'postgres.cluster',
      members: { PersistentVolumeClaim: 2, Pod: 2, Service: 2 },
      attachments: { PersistentVolume: 2 },
      nodes: ['Node:node-2', 'Node:node-3'],
    });
    expect(map.hubs.map((h) => [h.key, h.dependents])).toEqual([
      ['CSIDriver:rbd.csi.ceph.com', 0],
      ['DaemonSet:kube-system/cilium', 5],
      ['Deployment:kube-system/coredns', 0],
    ]);
    expect(map.nodes).toEqual([
      { key: 'Node:node-1', name: 'node-1', components: 2, pods: 2 },
      { key: 'Node:node-2', name: 'node-2', components: 3, pods: 3 },
      { key: 'Node:node-3', name: 'node-3', components: 2, pods: 2 },
    ]);
    expect(map.topology_version).toBe(7);
  });

  it('经 Service 与 Operator 约定的 Secret 接到它们指向的组件；同一对组件只有一条边，取最高的置信度', () => {
    expect(m().edges.map(edge)).toEqual([
      // 两个 Pod 各引用 Service pg-rw（属于 Cluster）与 Secret pg-app（Operator 约定指向 Cluster）
      'Deployment:shop/api -> Cluster:shop/pg [references ×4 config_ref 0.7]',
      'Deployment:shop/worker -> Cluster:shop/pg [egress_to,references ×3 config_ref 0.7]',
      'Deployment:web/frontend -> Deployment:shop/api [references ×1 config_ref 0.7]',
      'Ingress:web/frontend -> Deployment:web/frontend [routes_to ×1 structural 1]',
    ]);
  });

  it('服务归属：组件自己，其次成员，再其次命名空间默认服务；领域只列出有组件的服务', () => {
    const map = m();
    expect(map.components.map((c) => [c.name, c.service, c.service_source])).toEqual([
      ['pg', 'orders-db', 'component'],
      ['api', 'orders-api', 'component'],
      ['worker', 'orders-api', 'namespace'],
      ['frontend', 'frontend', 'member'],
      ['frontend', null, 'default'],
      ['search', 'orders-api', 'namespace'],
    ]);
    expect(map.domains.map((d) => [d.id, d.tier, d.services.map((s) => s.id)])).toEqual([
      ['shop', 'core', ['orders-api', 'orders-db']],
      ['web', 'supporting', ['frontend']],
    ]);
    // 没有服务目录时全部没有归属
    expect(clusterMap(snapshot(), null, COMPONENT_TYPES).components.every((c) => c.service === null)).toBe(true);
  });

  it('静态 Pod 的属主是 Node：Pod 自己是组件，Node 仍然只在节点条上', () => {
    const s = snapshot();
    const pod: TopologyNode = {
      key: 'Pod:kube-system/kube-apiserver-node-1',
      kind: 'Pod',
      namespace: 'kube-system',
      name: 'kube-apiserver-node-1',
      uid: null,
      labels: {},
      component_type: null,
      hub: false,
    };
    const e = (relation: string): TopologyEdge => ({
      from: pod.key,
      to: 'Node:node-1',
      relation,
      provenance: 'structural',
      confidence: 1,
      scope: 'instance',
      evidence: 'ownerReference',
    });
    const map = clusterMap(
      { ...s, nodes: [...s.nodes, pod], edges: [...s.edges, e('owned_by'), e('runs_on')] },
      catalog,
      [],
    );
    expect(map.components.find((c) => c.key === pod.key)).toMatchObject({ members: {}, nodes: ['Node:node-1'] });
    expect(map.components.some((c) => c.kind === 'Node')).toBe(false);
    expect(map.nodes[0]).toMatchObject({ components: 3, pods: 3 });
  });

  it('结果与输入顺序无关', () => {
    const s = snapshot();
    const reversed = { ...s, nodes: [...s.nodes].reverse(), edges: [...s.edges].reverse() };
    expect(clusterMap(reversed, catalog, COMPONENT_TYPES)).toEqual(m());
  });
});
