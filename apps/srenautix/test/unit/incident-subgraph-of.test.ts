import type { Incident, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { ServiceCatalog } from '@srenautix/packs-sdk/business';
import { describe, expect, it, vi } from 'vitest';
import { subgraphOf } from '../../src/console-bff/routes-incidents.js';
import type { TopologyStore } from '../../src/topology/store.js';

const baseIncident = (over: Partial<Incident> = {}): Incident =>
  ({
    incident_id: '00000000-0000-4000-8000-000000000001',
    incident_version: 1,
    cluster_id: 'cchp',
    label: 'inc-1',
    state: 'firing',
    severity: 'warning',
    suppressed: false,
    first_firing_at: '2026-11-20T00:00:00Z',
    updated_at: '2026-11-20T00:05:00Z',
    ended_at: null,
    topology_version: 42,
    root: { component: 'component:gateway', entity: null, ambiguous: false, margin: null, silent_root: false },
    candidates: [],
    members: [{ alert_id: 'a1@1', alertname: 'HighErrors', component: 'component:gateway', left_version: null }],
    components: ['component:gateway'],
    primary_service: 'gateway',
    ...over,
  }) as unknown as Incident;

const SERVICES = new ServiceCatalog(
  [
    {
      pack: 'cchp',
      domains: [
        {
          id: 'forwarding',
          title: { 'zh-CN': '转发', en: 'Forwarding' },
          tier: 'core',
          services: [
            {
              id: 'gateway',
              title: { 'zh-CN': '网关', en: 'Gateway' },
              members: [{ match: { kind: 'StatefulSet', namespaces: ['cchp-prod'], name_pattern: '^gateway$' } }],
            },
          ],
        },
        {
          id: 'data',
          title: { 'zh-CN': '数据', en: 'Data' },
          tier: 'core',
          services: [
            {
              id: 'postgres',
              title: { 'zh-CN': 'PG', en: 'PG' },
              members: [
                {
                  match: {
                    kind: 'Cluster',
                    api_group: 'postgresql.cnpg.io',
                    namespaces: ['cchp-data'],
                    name_pattern: '^cchp-postgres$',
                  },
                },
              ],
            },
          ],
        },
      ],
      dependencies: [
        {
          from: [{ kind: 'StatefulSet', namespaces: ['cchp-prod'], name_pattern: '^gateway$' }],
          to: [
            {
              kind: 'Cluster',
              api_group: 'postgresql.cnpg.io',
              namespaces: ['cchp-data'],
              name_pattern: '^cchp-postgres$',
            },
          ],
          reason: 'DATABASE_URL',
        },
      ],
    },
  ],
  [],
);

describe('subgraphOf（ADR 0208）', () => {
  it('传入领域包服务目录时按时间点快照展开逻辑组件并注入声明依赖', async () => {
    const nodes: TopologyNode[] = [
      {
        key: 'StatefulSet:cchp-prod/gateway',
        kind: 'StatefulSet',
        namespace: 'cchp-prod',
        name: 'gateway',
        uid: 'u1',
        labels: {},
        component_type: null,
        hub: false,
      },
      {
        key: 'Pod:cchp-prod/gateway-0',
        kind: 'Pod',
        namespace: 'cchp-prod',
        name: 'gateway-0',
        uid: 'u2',
        labels: {},
        component_type: null,
        hub: false,
      },
      {
        key: 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres',
        kind: 'Cluster.postgresql.cnpg.io',
        namespace: 'cchp-data',
        name: 'cchp-postgres',
        uid: 'u3',
        labels: {},
        component_type: null,
        hub: false,
      },
    ];
    const edges: TopologyEdge[] = [
      {
        from: 'Pod:cchp-prod/gateway-0',
        to: 'StatefulSet:cchp-prod/gateway',
        relation: 'owned_by',
        provenance: 'structural',
        confidence: 1,
        scope: 'instance',
        evidence: 'owner',
      },
    ];
    const at = vi.fn().mockResolvedValue({ version: 42, nodes, edges });
    const subgraph = vi.fn();
    const store = { at, subgraph } as unknown as TopologyStore;

    const out = await subgraphOf(store, baseIncident(), 2, { services: SERVICES });
    expect(at).toHaveBeenCalledWith('cchp', new Date('2026-11-20T00:05:00Z'), 42);
    expect(subgraph).not.toHaveBeenCalled();
    expect(out.root).toBe('StatefulSet:cchp-prod/gateway');
    expect(out.edges).toContainEqual({
      from: 'StatefulSet:cchp-prod/gateway',
      to: 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres',
      relation: 'depends_on',
      provenance: 'declared',
      confidence: 1,
      scope: 'service',
    });
  });

  it('未传领域包服务目录时保持逐跳查询（向后兼容通知等调用方）', async () => {
    const at = vi.fn();
    const subgraph = vi.fn().mockResolvedValue({
      version: 42,
      hops: new Map([['Deployment:app/api', 0]]),
      nodes: [
        {
          key: 'Deployment:app/api',
          kind: 'Deployment',
          namespace: 'app',
          name: 'api',
          uid: 'u1',
          labels: {},
          component_type: null,
          hub: false,
        },
      ],
      edges: [],
    });
    const store = { at, subgraph } as unknown as TopologyStore;

    const out = await subgraphOf(
      store,
      baseIncident({
        root: { component: 'Deployment:app/api', entity: null, ambiguous: false, margin: null, silent_root: false },
        members: [],
        components: ['Deployment:app/api'],
      }),
      2,
    );
    expect(subgraph).toHaveBeenCalledTimes(1);
    expect(at).not.toHaveBeenCalled();
    expect(out.root).toBe('Deployment:app/api');
    expect(out.nodes).toHaveLength(1);
  });
});
