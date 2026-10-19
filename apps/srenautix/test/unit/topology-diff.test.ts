import type { TopologyEdge, TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { diffTopology } from '../../src/topology/informer.js';
import { edgeKey, sameContent } from '../../src/topology/store.js';

const node = (name: string, labels: Record<string, string> = {}): TopologyNode => ({
  key: `Pod:shop/${name}`,
  kind: 'Pod',
  namespace: 'shop',
  name,
  uid: `u-${name}`,
  labels,
  component_type: null,
  hub: false,
});
const edge = (from: string, to: string): TopologyEdge => ({
  from,
  to,
  relation: 'runs_on',
  provenance: 'structural',
  confidence: 1,
  scope: 'instance',
  evidence: 'spec.nodeName',
});

describe('拓扑差异', () => {
  it('内容比较与键的顺序无关', () => {
    expect(sameContent({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameContent(node('a', { x: '1' }), node('a', { x: '2' }))).toBe(false);
  });

  it('删除在前；只写新增与变化；内容相同（键顺序不同）的不写', () => {
    const at = new Date('2026-10-20T00:00:00Z');
    const keep = node('keep');
    const reordered = JSON.parse(
      JSON.stringify({
        hub: keep.hub,
        labels: keep.labels,
        uid: keep.uid,
        name: keep.name,
        namespace: keep.namespace,
        kind: keep.kind,
        key: keep.key,
        component_type: null,
      }),
    ) as TopologyNode;
    const gone = node('gone');
    const changedOld = node('chg', { v: '1' });
    const e1 = edge('Pod:shop/gone', 'Node:n1');
    const changes = diffTopology(
      { nodes: [keep, node('chg', { v: '2' }), node('new')], edges: [edge('Pod:shop/new', 'Node:n1')] },
      new Map<string, TopologyNode | TopologyEdge>([
        [keep.key, reordered],
        [gone.key, gone],
        [changedOld.key, changedOld],
      ]),
      new Map<string, TopologyNode | TopologyEdge>([[edgeKey(e1), e1]]),
      at,
    );
    expect(changes.map((c) => `${c.op} ${c.node?.key ?? edgeKey(c.edge as TopologyEdge)}`)).toEqual([
      'edge_delete Pod:shop/gone|runs_on|Node:n1',
      'node_delete Pod:shop/gone',
      'node_upsert Pod:shop/chg',
      'node_upsert Pod:shop/new',
      'edge_upsert Pod:shop/new|runs_on|Node:n1',
    ]);
    expect(changes.every((c) => c.at === at && c.source === 'informer')).toBe(true);
  });
});
