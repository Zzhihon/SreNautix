import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { IncidentSubgraph } from '../contract';
import type { DataPort } from '../port';
import { incident } from '../test/fixtures';
import { renderUi } from '../test/render';
import { incidentMapLink, IncidentView } from '../views/IncidentView';
import { Subgraph } from './Subgraph';
import { filterSubgraph } from './subgraph-model';

const GW = 'StatefulSet:cchp-prod/gateway';
const PG = 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres';
const NODE = 'Node:appservice-01';
const SCRAPER = 'StatefulSet:observability/vmsingle';
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
      component: SCRAPER,
      kind: 'StatefulSet',
      namespace: 'observability',
      name: 'vmsingle',
      role: 'neighbor',
      alerts: [],
      hops: 1,
    },
    { component: OTHER, kind: 'Deployment', namespace: 'ops', name: 'helper', role: 'neighbor', alerts: [], hops: 2 },
  ],
  edges: [
    { from: GW, to: PG, relation: 'depends_on', provenance: 'declared', confidence: 1, scope: 'service' },
    { from: GW, to: NODE, relation: 'runs_on', provenance: 'structural', confidence: 1, scope: 'instance' },
    { from: GW, to: SCRAPER, relation: 'egress_to', provenance: 'network_policy', confidence: 0.5, scope: 'service' },
    { from: PG, to: OTHER, relation: 'egress_to', provenance: 'network_policy', confidence: 0.6, scope: 'service' },
  ],
};

describe('根因子图边分档（ADR 0208）', () => {
  it('默认 deps 档保留声明依赖与宿主机边，隐藏 <0.6 的网络策略放行边及仅靠它相连的邻居', () => {
    const deps = filterSubgraph(richGraph, 'deps');
    expect(deps.hiddenEdges).toBe(1);
    expect(deps.graph.edges.map((e) => e.to)).toEqual([PG, NODE, OTHER]);
    expect(deps.graph.nodes.map((n) => n.component)).not.toContain(SCRAPER);

    const core = filterSubgraph(richGraph, 'core');
    expect(core.hiddenEdges).toBe(2);
    expect(core.graph.edges.map((e) => e.to)).toEqual([PG, NODE]);
    expect(core.graph.nodes.map((n) => n.component)).toEqual([GW, PG, NODE]);

    const allowed = filterSubgraph(richGraph, 'allowed');
    expect(allowed.hiddenEdges).toBe(0);
    expect(allowed.graph.edges).toHaveLength(4);
    expect(allowed.graph.nodes.map((n) => n.component)).toContain(SCRAPER);
  });

  it('画布默认在全部依赖档隐藏 0.5 网络策略边并显示隐藏计数，切到网络放行后显现', async () => {
    renderUi(<Subgraph graph={richGraph} clusterId="cchp" />);
    await screen.findByRole('group', { name: 'gateway，根因，1 条告警' });
    await screen.findByRole('group', { name: 'cchp-postgres，邻居，0 条告警' });
    const host = await screen.findByRole('group', { name: 'appservice-01，邻居，0 条告警' });
    expect(host.querySelector('[data-substrate]')).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'vmsingle，邻居，0 条告警' })).toBeNull();

    const tierGroup = screen.getByRole('group', { name: '画哪些边' });
    expect(within(tierGroup).getByRole('button', { name: '全部依赖' }).getAttribute('aria-pressed')).toBe('true');

    const badge = screen.getByRole('button', { name: '已隐藏 1 条边' });
    fireEvent.click(badge);

    await screen.findByRole('group', { name: 'vmsingle，邻居，0 条告警' });
    expect(within(tierGroup).getByRole('button', { name: '网络放行' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(screen.queryByRole('button', { name: /已隐藏/ })).toBeNull());

    fireEvent.click(within(tierGroup).getByRole('button', { name: '核心链路' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'helper，邻居，0 条告警' })).toBeNull());
    expect(screen.getByRole('button', { name: '已隐藏 2 条边' })).toBeTruthy();
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
