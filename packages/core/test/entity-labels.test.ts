import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Labels } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { alertEntityCandidate, nodeFromInstance } from '../src/entity.js';
import { canonicalKind, entityKey, scopedNamespace } from '../src/keys.js';

/** CCHP 影子环境的真实告警标签：解析出的实体与拓扑键一致（规范 kind、集群级对象没有命名空间）。 */
const F = JSON.parse(readFileSync(resolve(import.meta.dirname, 'testdata/cchp-alert-labels.json'), 'utf8')) as {
  alerts: Array<{
    alertname: string;
    labels: Labels;
    expect: { kind: string; namespace: string | null; name: string; key: string; fromLabels: boolean };
  }>;
};

describe('告警标签 → 实体（CCHP 真实标签）', () => {
  it.each(F.alerts.map((a) => [a.alertname, a] as const))('%s', (_n, a) => {
    const c = alertEntityCandidate(a.labels, undefined, 'cchp');
    expect(c.entity).toMatchObject({ kind: a.expect.kind, namespace: a.expect.namespace, name: a.expect.name });
    expect(entityKey(c.entity!)).toBe(a.expect.key);
    expect(c.fromLabels).toBe(a.expect.fromLabels);
  });

  it('entity_kind 为 none 时按其他标签推断，没有可用标签时没有实体', () => {
    expect(
      alertEntityCandidate({ alertname: 'X', entity_kind: 'none', entity: 'x', namespace: 'app' }, undefined, 'c1')
        .entity,
    ).toBeNull();
  });

  it('kubernetes_node 与节点级抓取任务的 instance 映射到 Node；IP 与非节点级任务的 instance 不取', () => {
    expect(alertEntityCandidate({ alertname: 'X', kubernetes_node: 'n1' }, undefined, 'c1').entity).toMatchObject({
      kind: 'Node',
      namespace: null,
      name: 'n1',
    });
    expect(nodeFromInstance({ job: 'node-exporter', instance: 'storage-01:9100' })).toBe('storage-01');
    expect(nodeFromInstance({ job: 'kubelet', instance: 'storage-01' })).toBe('storage-01');
    expect(nodeFromInstance({ job: 'node-exporter', instance: '10.77.0.4:9100' })).toBeNull();
    expect(nodeFromInstance({ job: 'cchp-control', instance: 'control:8080' })).toBeNull();
    expect(
      alertEntityCandidate({ alertname: 'NodeDown', job: 'node-exporter', instance: 'app-01:9100' }, undefined, 'c1')
        .entity,
    ).toMatchObject({ kind: 'Node', name: 'app-01' });
  });

  it('kind 的规范写法与集群级对象的命名空间', () => {
    expect(canonicalKind('node')).toBe('Node');
    expect(canonicalKind('pvc')).toBe('PersistentVolumeClaim');
    expect(canonicalKind('STATEFULSET')).toBe('StatefulSet');
    expect(canonicalKind('postgres.cluster')).toBe('postgres.cluster');
    expect(canonicalKind('provider')).toBe('provider');
    expect(scopedNamespace('Node', 'kube-system')).toBeNull();
    expect(scopedNamespace('ClusterRole', 'x')).toBeNull();
    expect(scopedNamespace('Pod', 'kube-system')).toBe('kube-system');
  });
});
