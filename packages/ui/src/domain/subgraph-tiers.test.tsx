import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { IncidentSubgraph } from '../contract';
import type { DataPort } from '../port';
import { incident } from '../test/fixtures';
import { renderUi } from '../test/render';
import { incidentMapLink, IncidentView } from '../views/IncidentView';
import { Subgraph } from './Subgraph';
import { defaultSubgraphLevel, filterSubgraph, subgraphEdgeLevel } from './subgraph-model';

const GW = 'StatefulSet:cchp-prod/gateway';
const PG = 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres';
const NODE = 'Node:appservice-01';
const CM = 'ConfigMap:cchp-prod/cchp-runtime';
const RS = 'ReplicaSet:cchp-prod/gateway-old';
const SCRAPER = 'StatefulSet:observability/vmsingle';
const ALLOY = 'DaemonSet:observability/alloy';
const ALLOY_POD = 'Pod:observability/alloy-0';
const ALLOY_PVC = 'PersistentVolumeClaim:observability/alloy-wal';
const OTHER = 'Deployment:ops/helper';

const richGraph: IncidentSubgraph = {
  topology_version: 99,
  root: GW,
  nodes: [
    {
      component: GW,
      kind: 'StatefulSet',
      namespace: 'cchp-prod',
      name: 'gateway',
      role: 'root',
      alerts: ['a1@1'],
      hops: 0,
    },
    {
      component: PG,
      kind: 'Cluster.postgresql.cnpg.io',
      namespace: 'cchp-data',
      name: 'cchp-postgres',
      role: 'neighbor',
      alerts: [],
      hops: 1,
    },
    { component: NODE, kind: 'Node', namespace: null, name: 'appservice-01', role: 'neighbor', alerts: [], hops: 1 },
    {
      component: CM,
      kind: 'ConfigMap',
      namespace: 'cchp-prod',
      name: 'cchp-runtime',
      role: 'neighbor',
      alerts: [],
      hops: 1,
    },
    {
      component: RS,
      kind: 'ReplicaSet',
      namespace: 'cchp-prod',
      name: 'gateway-old',
      role: 'neighbor',
      alerts: [],
      hops: 1,
    },
    {
      component: SCRAPER,
      kind: 'StatefulSet',
      namespace: 'observability',
      name: 'vmsingle',
      role: 'neighbor',
      alerts: [],
      hops: 1,
    },
    {
      component: ALLOY,
      kind: 'DaemonSet',
      namespace: 'observability',
      name: 'alloy',
      role: 'neighbor',
      alerts: [],
      hops: 1,
    },
    {
      component: ALLOY_POD,
      kind: 'Pod',
      namespace: 'observability',
      name: 'alloy-0',
      role: 'neighbor',
      alerts: [],
      hops: 2,
    },
    {
      component: ALLOY_PVC,
      kind: 'PersistentVolumeClaim',
      namespace: 'observability',
      name: 'alloy-wal',
      role: 'neighbor',
      alerts: [],
      hops: 2,
    },
    { component: OTHER, kind: 'Deployment', namespace: 'ops', name: 'helper', role: 'neighbor', alerts: [], hops: 2 },
  ],
  edges: [
    { from: GW, to: PG, relation: 'depends_on', provenance: 'declared', confidence: 1, scope: 'service' },
    { from: GW, to: NODE, relation: 'runs_on', provenance: 'structural', confidence: 1, scope: 'instance' },
    { from: GW, to: CM, relation: 'references', provenance: 'config_ref', confidence: 0.7, scope: 'service' },
    { from: RS, to: GW, relation: 'owned_by', provenance: 'structural', confidence: 1, scope: 'instance' },
    { from: GW, to: SCRAPER, relation: 'egress_to', provenance: 'network_policy', confidence: 0.5, scope: 'service' },
    { from: PG, to: OTHER, relation: 'egress_to', provenance: 'network_policy', confidence: 0.6, scope: 'service' },
    // 经 network_policy 挂出的 alloy 及其内部 core 边（mounts），用于验证隐藏策略边后不会留下断连孤岛
    { from: GW, to: ALLOY, relation: 'egress_to', provenance: 'network_policy', confidence: 0.6, scope: 'service' },
    { from: ALLOY_POD, to: ALLOY, relation: 'owned_by', provenance: 'structural', confidence: 1, scope: 'instance' },
    { from: ALLOY_POD, to: ALLOY_PVC, relation: 'mounts', provenance: 'structural', confidence: 1, scope: 'instance' },
  ],
};

describe('根因子图边分档与可达性裁剪（ADR 0208）', () => {
  it('按语义准确分档：全部 network_policy 归 allowed，config_ref 与向下 owned_by 归 deps，向上 owned_by 与核心链路归 core', () => {
    const inc = new Set([GW]);
    expect(subgraphEdgeLevel({ from: GW, to: SCRAPER, provenance: 'network_policy', relation: 'egress_to' }, inc)).toBe(
      'allowed',
    );
    expect(subgraphEdgeLevel({ from: PG, to: OTHER, provenance: 'network_policy', relation: 'egress_to' }, inc)).toBe(
      'allowed',
    );
    expect(subgraphEdgeLevel({ from: GW, to: PG, provenance: 'declared', relation: 'depends_on' }, inc)).toBe('core');
    expect(subgraphEdgeLevel({ from: GW, to: PG, provenance: 'runtime', relation: 'connects_to' }, inc)).toBe('core');
    for (const rel of ['routes_to', 'primary', 'replica', 'mounts', 'bound_to', 'provisioned_by', 'csi_node_plugin']) {
      expect(subgraphEdgeLevel({ from: PG, to: OTHER, provenance: 'structural', relation: rel }, inc), rel).toBe(
        'core',
      );
    }
    expect(subgraphEdgeLevel({ from: GW, to: NODE, provenance: 'structural', relation: 'runs_on' }, inc)).toBe('core');
    expect(subgraphEdgeLevel({ from: PG, to: NODE, provenance: 'structural', relation: 'runs_on' }, inc)).toBe('deps');
    // 向上归属（incident 为 from）进 core，向下归属（incident 为 to）进 deps
    expect(subgraphEdgeLevel({ from: GW, to: RS, provenance: 'structural', relation: 'owned_by' }, inc)).toBe('core');
    expect(subgraphEdgeLevel({ from: RS, to: GW, provenance: 'structural', relation: 'owned_by' }, inc)).toBe('deps');
    expect(subgraphEdgeLevel({ from: GW, to: CM, provenance: 'config_ref', relation: 'references' }, inc)).toBe('deps');
    for (const rel of ['managed_by', 'selects', 'scales', 'protects', 'operator_convention']) {
      expect(subgraphEdgeLevel({ from: GW, to: OTHER, provenance: 'structural', relation: rel }, inc), rel).toBe(
        'deps',
      );
    }
  });

  it('隐藏 network_policy 后从事件节点做无向 BFS 裁剪断连孤岛（零悬空节点/边），且准确统计隐藏边数', () => {
    const core = filterSubgraph(richGraph, 'core');
    expect(core.graph.nodes.map((n) => n.component)).toEqual([GW, PG, NODE]);
    expect(core.graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual([`${GW}->${PG}`, `${GW}->${NODE}`]);
    expect(core.hiddenEdges).toBe(7);
    // alloy-pod -> alloy-pvc 虽然是 mounts（core），但与事件节点不连通，绝不能成为悬空孤岛
    expect(core.graph.nodes.map((n) => n.component)).not.toContain(ALLOY_POD);
    expect(core.graph.nodes.map((n) => n.component)).not.toContain(ALLOY_PVC);

    const deps = filterSubgraph(richGraph, 'deps');
    expect(deps.graph.nodes.map((n) => n.component)).toEqual([GW, PG, NODE, CM, RS]);
    expect(deps.graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      `${GW}->${PG}`,
      `${GW}->${NODE}`,
      `${GW}->${CM}`,
      `${RS}->${GW}`,
    ]);
    expect(deps.hiddenEdges).toBe(5);
    expect(deps.graph.nodes.map((n) => n.component)).not.toContain(SCRAPER);
    expect(deps.graph.nodes.map((n) => n.component)).not.toContain(OTHER);
    expect(deps.graph.nodes.map((n) => n.component)).not.toContain(ALLOY);
    expect(deps.graph.nodes.map((n) => n.component)).not.toContain(ALLOY_POD);

    const allowed = filterSubgraph(richGraph, 'allowed');
    expect(allowed.hiddenEdges).toBe(0);
    expect(allowed.graph.edges).toHaveLength(9);
    expect(allowed.graph.nodes).toHaveLength(10);
  });

  it('defaultSubgraphLevel 有核心边时选 core，无核心边时依次回退到 deps 与 allowed', () => {
    expect(defaultSubgraphLevel(richGraph)).toBe('core');

    const depsOnly: IncidentSubgraph = {
      topology_version: 100,
      root: GW,
      nodes: [
        {
          component: GW,
          kind: 'StatefulSet',
          namespace: 'cchp-prod',
          name: 'gateway',
          role: 'root',
          alerts: ['a1@1'],
          hops: 0,
        },
        {
          component: CM,
          kind: 'ConfigMap',
          namespace: 'cchp-prod',
          name: 'cchp-runtime',
          role: 'neighbor',
          alerts: [],
          hops: 1,
        },
        {
          component: SCRAPER,
          kind: 'StatefulSet',
          namespace: 'observability',
          name: 'vmsingle',
          role: 'neighbor',
          alerts: [],
          hops: 1,
        },
      ],
      edges: [
        { from: GW, to: CM, relation: 'references', provenance: 'config_ref', confidence: 0.7, scope: 'service' },
        {
          from: GW,
          to: SCRAPER,
          relation: 'egress_to',
          provenance: 'network_policy',
          confidence: 0.5,
          scope: 'service',
        },
      ],
    };
    expect(defaultSubgraphLevel(depsOnly)).toBe('deps');

    const policyOnly: IncidentSubgraph = {
      ...depsOnly,
      topology_version: 101,
      edges: [
        {
          from: GW,
          to: SCRAPER,
          relation: 'egress_to',
          provenance: 'network_policy',
          confidence: 0.5,
          scope: 'service',
        },
      ],
    };
    expect(defaultSubgraphLevel(policyOnly)).toBe('allowed');
  });

  it('画布默认落在 core 档并隐藏配置、策略与断连孤岛；切换档位与更换图根因时行为正确', async () => {
    const { rerender } = renderUi(<Subgraph graph={richGraph} clusterId="cchp" />);
    await screen.findByRole('group', { name: 'gateway，根因，1 条告警' });
    await screen.findByRole('group', { name: 'cchp-postgres，邻居，0 条告警' });
    const host = await screen.findByRole('group', { name: 'appservice-01，邻居，0 条告警' });
    expect(host.querySelector('[data-substrate]')).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'cchp-runtime，邻居，0 条告警' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'vmsingle，邻居，0 条告警' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'alloy-0，邻居，0 条告警' })).toBeNull();

    const tierGroup = screen.getByRole('group', { name: '画哪些边' });
    expect(within(tierGroup).getByRole('button', { name: '核心链路' }).getAttribute('aria-pressed')).toBe('true');

    // 切到全部依赖：显示 config_ref 与向下 owned_by，仍隐藏网络策略与 alloy 孤岛
    fireEvent.click(within(tierGroup).getByRole('button', { name: '全部依赖' }));
    await screen.findByRole('group', { name: 'cchp-runtime，邻居，0 条告警' });
    expect(screen.queryByRole('group', { name: 'vmsingle，邻居，0 条告警' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'alloy-0，邻居，0 条告警' })).toBeNull();
    expect(screen.getByRole('button', { name: '已隐藏 5 条边' })).toBeTruthy();

    // 点击隐藏边提示切到网络放行：全部节点显现，隐藏计数消失
    fireEvent.click(screen.getByRole('button', { name: '已隐藏 5 条边' }));
    await screen.findByRole('group', { name: 'vmsingle，邻居，0 条告警' });
    await screen.findByRole('group', { name: 'alloy-0，邻居，0 条告警' });
    expect(within(tierGroup).getByRole('button', { name: '网络放行' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(screen.queryByRole('button', { name: /已隐藏/ })).toBeNull());

    // 切换到另一张只有 deps 边的新图时，自动重置为该图的默认档位（全部依赖）
    const depsOnlyGraph: IncidentSubgraph = {
      topology_version: 102,
      root: CM,
      nodes: [
        {
          component: CM,
          kind: 'ConfigMap',
          namespace: 'cchp-prod',
          name: 'cchp-runtime',
          role: 'root',
          alerts: [],
          hops: 0,
        },
        {
          component: GW,
          kind: 'StatefulSet',
          namespace: 'cchp-prod',
          name: 'gateway',
          role: 'neighbor',
          alerts: [],
          hops: 1,
        },
      ],
      edges: [
        { from: GW, to: CM, relation: 'references', provenance: 'config_ref', confidence: 0.7, scope: 'service' },
      ],
    };
    rerender(<Subgraph graph={depsOnlyGraph} clusterId="cchp" />);
    await screen.findByRole('group', { name: 'cchp-runtime，根因，0 条告警' });
    expect(
      within(screen.getByRole('group', { name: '画哪些边' }))
        .getByRole('button', { name: '全部依赖' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('事件详情跳转集群拓扑图发生时刻（ADR 0208）', () => {
  const portWith = (
    incOverrides: Parameters<typeof incident>[0] = {},
    rawPatch: Record<string, unknown> = {},
  ): Partial<DataPort> => {
    const inc = { ...incident(incOverrides), ...rawPatch };
    return {
      getIncident: async () => inc,
      getStageAReport: async () => null,
      listResearchRuns: async () => [],
      getEvidenceSnapshot: async () => [],
      getIncidentTimeline: async () => [],
      getIncidentSubgraph: async () => richGraph,
      listFeedback: async () => [],
      listConditions: async () => [],
      listProposals: async () => [],
    };
  };

  it('宿主提供 clusterMap 链接时，子图面板显示带 first_firing_at 的跳转链接', async () => {
    renderUi(
      <IncidentView incidentRef="inc-1" tab="evidence" onTab={() => {}} now={Date.parse('2026-10-19T06:24:00Z')} />,
      {
        port: portWith({ cluster_id: 'cchp', business_domain: 'forwarding', first_firing_at: '2026-10-19T06:10:00Z' }),
        links: {
          clusterMap: (c, d, at) =>
            `/topology?cluster=${c}&view=map${d ? `&domain=${d}` : ''}${at ? `&at=${encodeURIComponent(at)}` : ''}`,
        },
      },
    );
    const link = await screen.findByRole('link', { name: '在集群拓扑图查看发生时刻' });
    expect(link.getAttribute('href')).toBe(
      '/topology?cluster=cchp&view=map&domain=forwarding&at=2026-10-19T06%3A10%3A00Z',
    );
  });

  it('first_firing_at 缺失或非法时回退为打开实时集群地图，宿主不提供 clusterMap 时不渲染链接', async () => {
    const mk = (c: string, _d?: string, at?: string) => `/topology?cluster=${c}${at ? `&at=${at}` : ''}`;
    expect(incidentMapLink(mk, { cluster_id: 'cchp', first_firing_at: 'not-a-time' })).toEqual({
      href: '/topology?cluster=cchp',
      hasOnset: false,
    });
    expect(incidentMapLink(mk, { cluster_id: 'cchp', first_firing_at: null })).toEqual({
      href: '/topology?cluster=cchp',
      hasOnset: false,
    });
    expect(incidentMapLink(undefined, { cluster_id: 'cchp', first_firing_at: '2026-10-19T06:10:00Z' })).toBeNull();

    renderUi(
      <IncidentView incidentRef="inc-1" tab="evidence" onTab={() => {}} now={Date.parse('2026-10-19T06:24:00Z')} />,
      {
        port: portWith({ cluster_id: 'cchp' }),
      },
    );
    await screen.findByRole('group', { name: 'gateway，根因，1 条告警' });
    expect(screen.queryByRole('link', { name: /在集群拓扑图查看/ })).toBeNull();
  });
});
