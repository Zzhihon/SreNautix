import { describe, expect, it } from 'vitest';
import { ksmTopologyIntervals, normalizeImage, type KsmTopologyResults } from '../src/index.js';

/** kube-state-metrics 历史：Job 的 Pod、Job 的 CronJob 属主与 Pod 的镜像（ADR 0104 §13） */
describe('kube-state-metrics 历史的 Job 与镜像', () => {
  const one = (labels: Record<string, string>) => ({ labels, times: [0], values: [1] });
  const results = {
    nodeInfo: [],
    podInfo: [
      one({ namespace: 'shop', pod: 'migrate-abc-x1', node: 'n1', uid: 'u1' }),
      one({ namespace: 'shop', pod: 'report-29069-y1', node: 'n1', uid: 'u2' }),
    ],
    podOwner: [
      one({ namespace: 'shop', pod: 'migrate-abc-x1', owner_kind: 'Job', owner_name: 'migrate-abc' }),
      one({ namespace: 'shop', pod: 'report-29069-y1', owner_kind: 'Job', owner_name: 'report-29069' }),
    ],
    replicasetOwner: [],
    podPvc: [],
    jobOwner: [
      one({ namespace: 'shop', job_name: 'migrate-abc', owner_kind: '<none>', owner_name: '<none>' }),
      one({ namespace: 'shop', job_name: 'report-29069', owner_kind: 'CronJob', owner_name: 'report' }),
    ],
    podImages: [
      one({
        namespace: 'shop',
        pod: 'migrate-abc-x1',
        image: 'ghcr.io/acme/api:sha-abc',
        image_id: 'docker-pullable://ghcr.io/acme/api@sha256:0123',
      }),
    ],
  } as unknown as KsmTopologyResults;
  const items = ksmTopologyIntervals(results, 30_000).map((x) => x.item);
  const edges = items.flatMap((i) => ('edge' in i ? [`${i.edge.from}|${i.edge.relation}|${i.edge.to}`] : []));

  it('Pod 属于 Job；CronJob 创建的 Job 有到 CronJob 的 owned_by 边，单独创建的 Job 没有', () => {
    expect(edges).toContain('Pod:shop/migrate-abc-x1|owned_by|Job:shop/migrate-abc');
    expect(edges).toContain('Job:shop/report-29069|owned_by|CronJob:shop/report');
    expect(edges.some((e) => e.startsWith('Job:shop/migrate-abc|'))).toBe(false);
  });

  it('Pod 节点带镜像：image 去掉运行时前缀，image_id 取 digest；没有 container_info 的 Pod 不带', () => {
    const pod = (k: string) => items.find((i) => 'node' in i && i.node.key === k) as { node: { images?: string[] } };
    expect(pod('Pod:shop/migrate-abc-x1').node.images).toEqual(['ghcr.io/acme/api:sha-abc', 'sha256:0123']);
    expect(pod('Pod:shop/report-29069-y1').node.images).toBeUndefined();
    expect(normalizeImage('GHCR.io/acme/api:sha-abc')).toBe('ghcr.io/acme/api:sha-abc');
    expect(normalizeImage('ghcr.io/acme/api@sha256:0123')).toBe('sha256:0123');
  });
});

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
