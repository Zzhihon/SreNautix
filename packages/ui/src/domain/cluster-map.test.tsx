import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ClusterMap as MapData } from '../contract';
import { renderUi } from '../test/render';
import { ClusterMap } from './ClusterMap';
import { buildMapModel, incidentOverlay, MAP_FOLD_MIN, nameStem, packMap, UNASSIGNED } from './cluster-map-model';

const t = (zh: string) => ({ 'zh-CN': zh, en: zh });
type C = MapData['components'][number];
const comp = (key: string, service: string | null, nodes: string[], extra: Partial<C> = {}): C => {
  const [kind, rest] = key.split(':') as [string, string];
  const [namespace, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return {
    key,
    kind,
    namespace,
    name,
    component_type: null,
    service,
    service_source: service ? 'component' : 'default',
    members: { Pod: nodes.length },
    attachments: {},
    nodes,
    ...extra,
  };
};
const edge = (from: string, to: string, confidence: number, relation = 'references') => ({
  from,
  to,
  relations: [relation],
  count: 1,
  provenance: confidence < 0.7 ? ('network_policy' as const) : ('config_ref' as const),
  confidence,
});
const API = 'Deployment:shop/api';
const PG = 'Cluster.postgresql.cnpg.io:shop/pg';
const WORKER = 'Deployment:shop/worker';
const FRONT = 'Deployment:web/frontend';
const ING = 'Ingress:web/frontend';
const etcd = (i: number) => `Pod:kube-system/etcd-cp-${i}`;

const map: MapData = {
  topology_version: 9,
  at: '2026-11-12T13:00:00Z',
  domains: [
    // 声明顺序里底座在前：地图仍然把核心领域排在第一列
    { id: 'base', title: t('底座'), tier: 'foundation', services: [{ id: 'none', title: t('没有组件') }] },
    {
      id: 'shop',
      title: t('商城'),
      tier: 'core',
      services: [
        { id: 'orders-api', title: t('订单接口') },
        { id: 'orders-db', title: t('订单库') },
      ],
    },
    { id: 'web', title: t('前端'), tier: 'supporting', services: [{ id: 'frontend', title: t('前端站点') }] },
  ],
  components: [
    comp(PG, 'orders-db', ['Node:node-2']),
    comp(API, 'orders-api', ['Node:node-1', 'Node:node-2'], { attachments: { Secret: 1 } }),
    comp(WORKER, 'orders-api', ['Node:node-2'], { service_source: 'namespace' }),
    comp(FRONT, 'frontend', ['Node:node-1']),
    comp(ING, null, []),
    ...[1, 2, 3].map((i) => comp(etcd(i), null, [`Node:cp-${i}`], { members: {} })),
  ],
  edges: [
    edge(API, PG, 0.7),
    edge(WORKER, PG, 0.6, 'egress_to'),
    edge(FRONT, API, 0.7),
    edge(ING, FRONT, 1, 'routes_to'),
  ],
  nodes: ['node-1', 'node-2', 'cp-1', 'cp-2', 'cp-3'].map((n) => ({
    key: `Node:${n}`,
    name: n,
    components: 1,
    pods: 2,
  })),
  hubs: [
    { key: 'DaemonSet:kube-system/cilium', kind: 'DaemonSet', namespace: 'kube-system', name: 'cilium', dependents: 6 },
  ],
  omitted: 42,
  incidents: [
    {
      incident_id: '00000000-0000-4000-8000-000000000001',
      label: 'pg-down',
      severity: 'critical',
      headline: null,
      first_firing_at: '2026-11-12T12:50:00Z',
      root: `Pod:shop/pg-1`,
      component: PG,
      service: 'orders-db',
    },
  ],
};

describe('全集群地图的画法（ADR 0199）', () => {
  it('名称词干去掉节点、运行编号与哈希后缀，普通的词保留', () => {
    expect(nameStem({ name: 'kube-apiserver-control-plane-01', nodes: ['Node:control-plane-01'] })).toBe(
      'kube-apiserver',
    );
    expect(nameStem({ name: 'cchp-discover-1794488820', nodes: [] })).toBe('cchp-discover');
    expect(nameStem({ name: 'instance-manager-22e45c86836873a233b2f1ce05ec086c', nodes: [] })).toBe('instance-manager');
    expect(nameStem({ name: 'cchp-dev-xh6cl', nodes: [] })).toBe('cchp-dev');
    expect(nameStem({ name: 'envoy-proxy', nodes: [] })).toBe('envoy-proxy');
  });

  it('按 业务领域 → 服务 分组，没有归属的按命名空间放进"未归属"；同名静态 Pod 合并，根因不合并', () => {
    const m = buildMapModel(map, { fold: true, expanded: new Set(), roots: new Set([PG]) });
    expect(m.domains.map((d) => [d.domain, d.services.map((s) => s.id)])).toEqual([
      ['shop', ['s:orders-api', 's:orders-db']],
      ['web', ['s:frontend']],
      [UNASSIGNED, ['s:ns:kube-system', 's:ns:web']],
    ]);
    const kube = m.domains[2]!.services[0]!.items;
    expect(kube.map((i) => [i.id, i.name, i.members.length])).toEqual([[`fold:${etcd(1)}`, 'etcd', 3]]);
    expect(MAP_FOLD_MIN).toBe(3);
    expect(m.nodeOf.get(etcd(2))).toBe(`fold:${etcd(1)}`);
    // 展开或关掉合并后成员单独画出
    const open = buildMapModel(map, { fold: true, expanded: new Set([`fold:${etcd(1)}`]), roots: new Set() });
    expect(open.domains[2]!.services[0]!.items.map((i) => i.id)).toEqual([etcd(1), etcd(2), etcd(3)]);
    expect(buildMapModel(map, { fold: false, expanded: new Set(), roots: new Set() }).nodeOf.get(etcd(3))).toBe(
      etcd(3),
    );
  });

  it('受影响沿置信度不低于 0.7 的依赖边反向传播；网络策略推断的边不传播', () => {
    const o = incidentOverlay(map, map.incidents);
    expect(Object.fromEntries(o.tone)).toEqual({ [PG]: 'bad', [API]: 'hit', [FRONT]: 'hit', [ING]: 'hit' });
    expect(o.byService.get('orders-db')?.map((i) => i.label)).toEqual(['pg-down']);
    // 根因不在地图上的事件按主服务计入
    const loose = incidentOverlay(map, [{ ...map.incidents[0]!, component: null, service: 'frontend' }]);
    expect(loose.tone.size).toBe(0);
    expect(loose.byService.get('frontend')).toHaveLength(1);
  });

  it('排布是确定的：核心领域在前，框互不重叠，组件在服务框里', () => {
    const m = buildMapModel(map, { fold: true, expanded: new Set(), roots: new Set() });
    const tier = (d: string) => map.domains.find((x) => x.id === d)?.tier;
    const p = packMap(m, tier);
    expect(packMap(m, tier)).toEqual(p);
    const domains = m.domains.map((d) => ({ id: d.id, ...p.get(d.id)! }));
    expect(domains[0]).toMatchObject({ id: 'd:shop', x: 0, y: 0 });
    for (const a of domains) {
      for (const b of domains) {
        if (a !== b) {
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `${a.id} 与 ${b.id} 重叠`).toBe(true);
        }
      }
    }
    for (const d of m.domains) {
      for (const s of d.services) {
        const sp = p.get(s.id)!;
        expect(sp.parent).toBe(d.id);
        for (const it of s.items) {
          const ip = p.get(it.id)!;
          expect(ip.parent).toBe(s.id);
          expect(ip.x + ip.w).toBeLessThanOrEqual(sp.w);
          expect(ip.y + ip.h).toBeLessThanOrEqual(sp.h);
        }
      }
    }
  });
});

describe('全集群地图（ADR 0199）', () => {
  const links = {
    topology: (c: string, k: string) => `/topology?cluster=${c}&component=${encodeURIComponent(k)}`,
  };
  const item = (name: RegExp) => screen.findByRole('group', { name });
  const card = (el: HTMLElement) => el.querySelector('[data-tone], [class]') as HTMLElement;

  it('领域框写未恢复的事件数；根因、受影响与正常的组件状态写在可访问名称与 data-tone 上', async () => {
    renderUi(<ClusterMap map={map} clusterId="prod" />, { links });
    expect(await screen.findByRole('group', { name: '集群地图：8 个组件，4 条依赖' })).toBeTruthy();
    const pg = await item(/^pg，/);
    expect(pg.getAttribute('aria-label')).toBe('pg，Cluster.postgresql.cnpg.io，根因（严重）');
    expect(card(pg).getAttribute('data-tone')).toBe('bad');
    expect((await item(/^api，/)).getAttribute('aria-label')).toContain('受影响');
    expect((await item(/^worker，/)).getAttribute('aria-label')).toContain('正常');
    expect(await item(/^etcd × 3，/)).toBeTruthy();
    expect(screen.getAllByText('1 个未恢复').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/另有 42 个对象不画在地图上/)).toBeTruthy();
  });

  it('单击组件打开侧栏：归属、成员、所在节点、依赖与事件；节点条标出它所在的节点', async () => {
    renderUi(<ClusterMap map={map} clusterId="prod" />, { links });
    fireEvent.click(await item(/^api，/));
    const panel = await screen.findByTestId('subgraph-panel');
    expect(within(panel).getByRole('heading', { name: 'api' })).toBeTruthy();
    expect(within(panel).getByText('商城 / 订单接口')).toBeTruthy();
    expect(within(panel).getByText('node-1、node-2')).toBeTruthy();
    expect(within(panel).getByText('pg')).toBeTruthy();
    expect(within(panel).getByText('它依赖的组件上有未恢复的事件')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: '以它为中心查看拓扑邻域' }).getAttribute('href')).toBe(
      links.topology('prod', API),
    );
    const strip = screen.getByRole('list', { name: '节点' });
    await waitFor(() =>
      expect(
        within(strip)
          .getAllByRole('listitem')
          .filter((n) => n.hasAttribute('data-on'))
          .map((n) => n.firstChild?.textContent),
      ).toEqual(['node-1', 'node-2']),
    );
    fireEvent.click(await item(/^pg，/));
    const pgPanel = await screen.findByTestId('subgraph-panel');
    expect(within(pgPanel).getByRole('link', { name: 'pg-down' }).getAttribute('href')).toContain('pg-down');
  });

  it('指向节点条上的节点：只突出运行在它上面的组件', async () => {
    renderUi(<ClusterMap map={map} clusterId="prod" />);
    const front = await item(/^frontend，Deployment/);
    const pg = await item(/^pg，/);
    const node1 = within(screen.getByRole('list', { name: '节点' })).getByText('node-1');
    await userEvent.hover(node1);
    await waitFor(() => expect(card(pg).hasAttribute('data-dim')).toBe(true));
    expect(card(front).hasAttribute('data-dim')).toBe(false);
    await userEvent.unhover(node1);
    await waitFor(() => expect(card(pg).hasAttribute('data-dim')).toBe(false));
  });

  it('只看异常：只留下根因与受影响的组件', async () => {
    renderUi(<ClusterMap map={map} clusterId="prod" />);
    await item(/^worker，/);
    await userEvent.click(screen.getByRole('button', { name: '只看异常' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: /^worker，/ })).toBeNull());
    expect(screen.queryByRole('group', { name: /^etcd × 3，/ })).toBeNull();
    expect(await item(/^pg，/)).toBeTruthy();
    expect(await item(/^frontend，Deployment/)).toBeTruthy();
  });

  it('双击合并的组在图上展开；双击组件交给宿主', async () => {
    const opened: string[] = [];
    renderUi(<ClusterMap map={map} clusterId="prod" onOpenComponent={(c) => opened.push(c)} />);
    fireEvent.doubleClick(await item(/^etcd × 3，/));
    expect(await item(/^etcd-cp-2，/)).toBeTruthy();
    fireEvent.doubleClick(await item(/^api，/));
    expect(opened).toEqual([API]);
  });

  it('没有组件时说明原因', async () => {
    renderUi(<ClusterMap map={{ ...map, components: [], edges: [] }} clusterId="prod" />);
    expect(await screen.findByText('地图上没有组件')).toBeTruthy();
  });
});
