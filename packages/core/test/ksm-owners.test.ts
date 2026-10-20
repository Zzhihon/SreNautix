import { describe, expect, it } from 'vitest';
import { ksmTopologyIntervals, type KsmTopologyResults } from '../src/index.js';

/** kube-state-metrics 历史：静态 Pod 的属主是 Node，属主的键不带 Pod 的命名空间。 */
describe('kube-state-metrics 历史的集群级属主', () => {
  it('kube_pod_owner 的 owner_kind 为 Node：节点与边都用 Node:<name>', () => {
    const one = (labels: Record<string, string>) => ({ labels, times: [0], values: [1] });
    const results: KsmTopologyResults = {
      nodeInfo: [one({ node: 'control-plane-01' })],
      podInfo: [],
      podOwner: [
        one({
          namespace: 'kube-system',
          pod: 'etcd-control-plane-01',
          owner_kind: 'Node',
          owner_name: 'control-plane-01',
        }),
      ],
      replicasetOwner: [],
      podPvc: [],
    } as unknown as KsmTopologyResults;
    const items = ksmTopologyIntervals(results, 30_000).map((x) => x.item);
    const nodeKeys = items.flatMap((i) => ('node' in i ? [i.node.key] : []));
    expect(nodeKeys).toEqual(['Node:control-plane-01', 'Node:control-plane-01']);
    expect(items.find((i) => 'node' in i && i.node.key === 'Node:control-plane-01')).toMatchObject({
      node: { namespace: null },
    });
    expect(items.flatMap((i) => ('edge' in i ? [[i.edge.from, i.edge.to]] : []))).toEqual([
      ['Pod:kube-system/etcd-control-plane-01', 'Node:control-plane-01'],
    ]);
  });
});
