import type { TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { deriveRollouts, type RolloutOptions, type WorkloadEvent } from '../../src/changes/kubernetes.js';

// 版本标签的抖动不是发布（ADR 0142）。CCHP 2026-10-23 17:42:07：gateway 的 cchp.io/release-id 被短暂去掉又加回
// （canary-3cc28887b49f → 无 → canary-3cc28887b49f），旧代码推导出一次 revision 与 previous_revision 相同的发布。

const T0 = Date.parse('2026-10-23T17:42:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const APP = 'Application.argoproj.io:argocd/cchp-prod';
const LABEL = 'cchp.io/release-id';
const R1 = 'canary-3cc28887b49f';
const R2 = 'canary-147f17829ea1';

const sts = (name: string, labels: Record<string, string>): TopologyNode => ({
  key: `StatefulSet:cchp-prod/${name}`,
  kind: 'StatefulSet',
  namespace: 'cchp-prod',
  name,
  uid: `uid-${name}`,
  labels,
  component_type: null,
  hub: false,
});

let seq = 0;
/** 工作负载的版本标签从 from 变为 to（取值 null 表示没有这个标签） */
const relabel = (
  name: string,
  sec: number,
  from: string | null,
  to: string | null,
  kind = 'StatefulSet',
): WorkloadEvent => {
  const labels = (v: string | null): Record<string, string> => (v === null ? { app: name } : { app: name, [LABEL]: v });
  const prev = { ...sts(name, labels(from)), kind, key: `${kind}:cchp-prod/${name}` };
  return {
    seq: ++seq,
    op: 'node_upsert',
    key: prev.key,
    kind,
    valid_from: at(sec),
    body: { ...prev, labels: labels(to) },
    previous: prev,
    owner: null,
    managers: [APP],
  };
};
const opts: RolloutOptions = { clusterId: 'cchp', revisionLabels: [LABEL], groupWithinMs: 2 * 60_000 };

describe('版本标签的抖动（ADR 0142）', () => {
  it('CCHP 17:42：release-id 往返一次（canary → 无 → canary）不是发布', () => {
    expect(deriveRollouts([relabel('gateway', 0, R1, null), relabel('gateway', 7, null, R1)], opts)).toEqual([]);
  });

  it('多次抖动、或绕经另一个取值回到原值，也不是发布', () => {
    const events = [
      relabel('gateway', 0, R1, null),
      relabel('gateway', 5, null, R1),
      relabel('gateway', 30, R1, R2),
      relabel('gateway', 40, R2, R1),
    ];
    expect(deriveRollouts(events, opts)).toEqual([]);
  });

  it('真正的发布（版本变了）照常推导；同一组里另一个工作负载的抖动不进目标', () => {
    const r = deriveRollouts(
      [relabel('gateway', 0, R1, null), relabel('gateway', 7, null, R1), relabel('control', 10, R1, R2, 'Deployment')],
      opts,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'rollout', revision: R2, previous_revision: R1, time: at(10) });
    expect(r[0]!.targets).toEqual(['Deployment:cchp-prod/control', APP]);
    expect(r[0]!.summary).not.toContain('gateway');
  });

  it('抖动之后真的换了版本：只算换版本的那一次', () => {
    const r = deriveRollouts(
      [relabel('gateway', 0, R1, null), relabel('gateway', 7, null, R1), relabel('gateway', 60, R1, R2)],
      opts,
    );
    expect(r.map((c) => [c.time, c.revision, c.previous_revision])).toEqual([[at(60), R2, R1]]);
  });

  it('去掉标签后没有加回（超出合成范围）：两次都照常算，各自的新旧版本不同', () => {
    const r = deriveRollouts([relabel('gateway', 0, R1, null), relabel('gateway', 300, null, R1)], opts);
    expect(r).toHaveLength(2);
    for (const c of r) {
      expect(c.revision === null || c.revision !== c.previous_revision).toBe(true);
    }
  });

  it('只有版本标签、合成之后新旧版本相同的一组不是发布（标签在两个工作负载之间挪动）', () => {
    const r = deriveRollouts([relabel('gateway', 0, R1, null), relabel('control', 5, null, R1, 'Deployment')], opts);
    expect(r).toEqual([]);
  });

  it('Pod 模板变化（新的 ReplicaSet）不受影响：标签往返的同时有新 ReplicaSet 时仍是发布', () => {
    const rs: WorkloadEvent = {
      seq: ++seq,
      op: 'node_upsert',
      key: 'ReplicaSet:cchp-prod/control-abc',
      kind: 'ReplicaSet',
      valid_from: at(3),
      body: {
        ...sts('control-abc', { 'pod-template-hash': 'abc' }),
        kind: 'ReplicaSet',
        key: 'ReplicaSet:cchp-prod/control-abc',
      },
      previous: null,
      owner: 'Deployment:cchp-prod/control',
      ownerSeenBefore: true,
      managers: [APP],
    };
    const r = deriveRollouts(
      [relabel('control', 0, R1, null, 'Deployment'), rs, relabel('control', 7, null, R1, 'Deployment')],
      opts,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ revision: 'abc', targets: ['Deployment:cchp-prod/control', APP] });
  });
});
