import { describe, expect, it } from 'vitest';
import {
  KSM_TOPOLOGY_QUERIES,
  ksmLabelName,
  ksmTopologyIntervals,
  ksmTopologyQueries,
  normalizeImage,
  type KsmTopologyResults,
} from '../src/index.js';

/** kube-state-metrics 的对象标签（pre_step_labels，ADR 0104 §13）：只取配置的 key，sanitize 后的名字映射回原 key */
describe('kube-state-metrics 历史的对象标签', () => {
  const REL = 'cchp.io/release-id';
  const at = (labels: Record<string, string>, times: number[]) => ({ labels, times, values: times.map(() => 1) });

  it('配置为空时不查标签；配置后按 sanitize 后的名字分组查询 Job、ReplicaSet、Deployment、StatefulSet', () => {
    expect(ksmTopologyQueries([])).toEqual({ ...KSM_TOPOLOGY_QUERIES });
    expect(ksmTopologyQueries()).toEqual({ ...KSM_TOPOLOGY_QUERIES });
    expect(ksmLabelName(REL)).toBe('label_cchp_io_release_id');
    const q = ksmTopologyQueries([REL]);
    expect(q.jobLabels).toBe('max by (namespace, job_name, label_cchp_io_release_id) (kube_job_labels)');
    expect(q.replicasetLabels).toBe(
      'max by (namespace, replicaset, label_cchp_io_release_id) (kube_replicaset_labels)',
    );
    expect(q.deploymentLabels).toBe(
      'max by (namespace, deployment, label_cchp_io_release_id) (kube_deployment_labels)',
    );
    expect(q.statefulsetLabels).toBe(
      'max by (namespace, statefulset, label_cchp_io_release_id) (kube_statefulset_labels)',
    );
  });

  it('sanitize 后的标签映射回原 key；不在配置里的标签不进节点；Job 的标签也带到属主序列产生的节点上', () => {
    const results = {
      nodeInfo: [],
      podInfo: [at({ namespace: 'shop', pod: 'migrate-r2-x', node: 'n1', uid: 'u' }, [0])],
      podOwner: [at({ namespace: 'shop', pod: 'migrate-r2-x', owner_kind: 'Job', owner_name: 'migrate-r2' }, [0])],
      replicasetOwner: [],
      podPvc: [],
      jobLabels: [
        at({ namespace: 'shop', job_name: 'migrate-r2', label_cchp_io_release_id: 'r2', label_app: 'migrate' }, [0]),
      ],
    } as unknown as KsmTopologyResults;
    const nodes = ksmTopologyIntervals(results, 30_000, undefined, [REL]).flatMap((x) =>
      'node' in x.item ? [x.item.node] : [],
    );
    const jobs = nodes.filter((n) => n.key === 'Job:shop/migrate-r2');
    expect(jobs.length).toBeGreaterThan(1);
    expect(jobs.every((n) => JSON.stringify(n.labels) === JSON.stringify({ [REL]: 'r2' }))).toBe(true);
    // 没有配置时标签序列被忽略，节点不带标签
    const plain = ksmTopologyIntervals(results, 30_000).flatMap((x) => ('node' in x.item ? [x.item.node] : []));
    expect(plain.filter((n) => n.key === 'Job:shop/migrate-r2').every((n) => Object.keys(n.labels).length === 0)).toBe(
      true,
    );
  });

  it('发布时改了标签的 Deployment：两个区间各带当时的取值，属主序列产生的节点不带标签', () => {
    const MIN = 60_000;
    const results = {
      nodeInfo: [],
      podInfo: [],
      podOwner: [],
      replicasetOwner: [
        at({ namespace: 'shop', replicaset: 'api-1', owner_kind: 'Deployment', owner_name: 'api' }, [0, 10 * MIN]),
      ],
      podPvc: [],
      deploymentLabels: [
        at({ namespace: 'shop', deployment: 'api', label_cchp_io_release_id: 'r1' }, [0, MIN]),
        at({ namespace: 'shop', deployment: 'api', label_cchp_io_release_id: 'r2' }, [10 * MIN, 11 * MIN]),
      ],
    } as unknown as KsmTopologyResults;
    const ivs = ksmTopologyIntervals(results, 30_000, MIN, [REL]).flatMap((x) =>
      'node' in x.item && x.item.node.key === 'Deployment:shop/api'
        ? [{ from: x.from, labels: x.item.node.labels }]
        : [],
    );
    expect(ivs.filter((x) => x.labels[REL] === 'r1').map((x) => x.from)).toEqual([0]);
    expect(ivs.filter((x) => x.labels[REL] === 'r2').map((x) => x.from)).toEqual([10 * MIN]);
    expect(ivs.some((x) => Object.keys(x.labels).length === 0)).toBe(true);
  });
});

describe('kube-state-metrics 历史的 StatefulSet update revision（ADR 0104 §11）', () => {
  it('每个 revision 是一个属于 StatefulSet 的 ControllerRevision 节点，区间是它的样本区间', () => {
    const MIN = 60_000;
    const results = {
      nodeInfo: [],
      podInfo: [],
      podOwner: [],
      replicasetOwner: [],
      podPvc: [],
      statefulsetRevision: [
        {
          labels: { namespace: 'data', statefulset: 'gateway', revision: 'gateway-r1' },
          times: [0, MIN],
          values: [1, 1],
        },
        {
          labels: { namespace: 'data', statefulset: 'gateway', revision: 'gateway-r2' },
          times: [10 * MIN, 11 * MIN],
          values: [1, 1],
        },
      ],
    } as unknown as KsmTopologyResults;
    const ivs = ksmTopologyIntervals(results, 30_000, MIN);
    const crs = ivs.flatMap((x) =>
      'node' in x.item && x.item.node.kind === 'ControllerRevision' ? [[x.item.node.key, x.from]] : [],
    );
    expect(crs).toEqual([
      ['ControllerRevision:data/gateway-r1', 0],
      ['ControllerRevision:data/gateway-r2', 10 * MIN],
    ]);
    const edges = ivs.flatMap((x) =>
      'edge' in x.item ? [`${x.item.edge.from}|${x.item.edge.relation}|${x.item.edge.to}`] : [],
    );
    expect(edges).toContain('ControllerRevision:data/gateway-r2|owned_by|StatefulSet:data/gateway');
    expect(KSM_TOPOLOGY_QUERIES.statefulsetRevision).toBe(
      'max by (namespace, statefulset, revision) (kube_statefulset_status_update_revision)',
    );
  });
});

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
