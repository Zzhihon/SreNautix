import type { TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { logicalEdge } from '../../src/api/routes-research.js';
import type { TaskContext } from '../../src/research/hub.js';
import { componentChoices } from '../../src/research/prompt.js';
import { toSubgraph } from '../../src/research/service.js';
import { hintOf, isLogicalComponent } from '../../src/topology/expand.js';
import { incident, researchCase } from '../support/scenario.js';

// 逻辑组件映射到候选（ADR 0130）：线索取告警的 service 与 namespace 标签；server 在研判输入里给出 maps_to 边，
// worker 的研判子图里候选离根因一跳，进入根因组件的枚举

describe('逻辑组件', () => {
  it('键与告警线索', () => {
    expect(isLogicalComponent('component:catalog')).toBe(true);
    expect(isLogicalComponent('component:shop/worker')).toBe(true);
    expect(isLogicalComponent('Deployment:shop/api')).toBe(false);
    expect(hintOf({ alertname: 'X', service: 'catalog', namespace: 'shop' })).toEqual({
      service: 'catalog',
      namespace: 'shop',
    });
    expect(hintOf({ alertname: 'X', service: '' })).toEqual({ service: null, namespace: null });
  });

  it('研判子图：maps_to 边让候选离逻辑组件一跳，候选进入根因组件的枚举；映射边低于归并阈值', () => {
    const base = incident();
    const inc = {
      ...base,
      root: { ...base.root, component: 'component:catalog', entity: null },
      candidates: [{ ...base.candidates[0]!, component: 'component:catalog' }],
      components: ['component:catalog'],
      members: [{ ...base.members[1]!, component: 'component:catalog' }],
    };
    const n = (kind: string, name: string): TopologyNode => ({
      key: `${kind}:shop/${name}`,
      kind,
      namespace: 'shop',
      name,
      uid: null,
      labels: {},
      component_type: null,
      hub: false,
    });
    const edges = [
      logicalEdge('component:catalog', 'Deployment:shop/api'),
      logicalEdge('component:catalog', 'Service:shop/catalog'),
    ];
    expect(edges.every((e) => e.confidence < 0.6 && e.relation === 'maps_to')).toBe(true);
    const ctx = {
      incident: inc,
      topology: { version: 1, nodes: [n('Deployment', 'api'), n('Service', 'catalog'), n('Deployment', 'web')], edges },
    } as unknown as TaskContext;
    const g = toSubgraph(ctx);
    const hops = Object.fromEntries(g.nodes.map((x) => [x.component, x.hops]));
    expect(hops).toMatchObject({
      'component:catalog': 0,
      'Deployment:shop/api': 1,
      'Service:shop/catalog': 1,
      'Deployment:shop/web': 2,
    });
    expect(componentChoices(researchCase({ incident: inc, subgraph: g }))).toEqual(
      expect.arrayContaining(['component:catalog', 'Deployment:shop/api', 'Service:shop/catalog']),
    );
  });
});
