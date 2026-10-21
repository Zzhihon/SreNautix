import type { TopologyEdge, TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { deriveRollouts, type RolloutOptions, type WorkloadEvent } from '../../src/changes/kubernetes.js';
import type { TopologyRow } from '../../src/eval/bundle.js';
import { BundleTopology } from '../../src/eval/reconstruct.js';

// 发布之前的 Job 关联到发布（ADR 0104 §13）：managed_by → 镜像 → 同一命名空间与时间窗，依次判定

const T0 = Date.parse('2026-10-19T06:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const APP = 'Application.argoproj.io:argocd/shop';
const OTHER_APP = 'Application.argoproj.io:argocd/billing';

const body = (kind: string, name: string, ns = 'shop'): TopologyNode => ({
  key: `${kind}:${ns}/${name}`,
  kind,
  namespace: ns,
  name,
  uid: null,
  labels: {},
  component_type: null,
  hub: false,
});

let seq = 0;
/** 20 分钟：api 的新 ReplicaSet api-new（发布本身） */
const rs = (managers: string[] = [APP]): WorkloadEvent => ({
  seq: ++seq,
  op: 'node_upsert',
  key: 'ReplicaSet:shop/api-new',
  kind: 'ReplicaSet',
  valid_from: at(20),
  body: { ...body('ReplicaSet', 'api-new'), labels: { 'pod-template-hash': 'new' } },
  previous: null,
  owner: 'Deployment:shop/api',
  ownerSeenBefore: true,
  managers,
});
const job = (
  name: string,
  min: number,
  o: { managers?: string[]; owner?: string; ns?: string } = {},
): WorkloadEvent => ({
  seq: ++seq,
  op: 'node_upsert',
  key: `Job:${o.ns ?? 'shop'}/${name}`,
  kind: 'Job',
  valid_from: at(min),
  body: body('Job', name, o.ns),
  previous: null,
  owner: o.owner ?? null,
  managers: o.managers ?? [],
});
const opts = (images: Record<string, string[]> = {}): RolloutOptions => ({
  clusterId: 'east',
  revisionLabels: [],
  groupWithinMs: 2 * 60_000,
  images: (owner) => images[owner] ?? null,
});
const only = (events: WorkloadEvent[], o = opts()) => {
  const r = deriveRollouts(events, o);
  expect(r).toHaveLength(1);
  return r[0]!;
};

describe('发布之前的 Job', () => {
  it('第 1 档：Job 与发布由同一个应用管理时挂上，发布时间提前到 Job 新建的时刻', () => {
    const c = only([job('migrate', 10, { managers: [APP] }), rs()]);
    expect(c.time).toBe(at(10));
    expect(c.targets).toContain('Job:shop/migrate');
    expect(c.attachments).toEqual([{ target: 'Job:shop/migrate', basis: 'managed_by' }]);
    expect(c.change_id).toBe(`kubernetes:east:${seq}`);
  });

  it('第 1 档：管理 Job 的应用与发布的不一致时不挂，即使镜像相同', () => {
    const c = only(
      [job('migrate', 10, { managers: [OTHER_APP] }), rs()],
      opts({ 'Job:shop/migrate': ['sha256:same'], 'ReplicaSet:shop/api-new': ['sha256:same'] }),
    );
    expect(c.time).toBe(at(20));
    expect(c.attachments).toBeUndefined();
    expect(c.targets).not.toContain('Job:shop/migrate');
  });

  it('第 2 档：没有 managed_by 时，镜像（digest 或 tag）与新 ReplicaSet 的相同就挂上', () => {
    const c = only(
      [job('migrate', 10), job('report', 12), rs()],
      opts({
        'Job:shop/migrate': ['ghcr.io/acme/api:sha-1', 'sha256:aaa'],
        'Job:shop/report': ['ghcr.io/acme/report:v3'],
        'ReplicaSet:shop/api-new': ['ghcr.io/acme/api:sha-1', 'sha256:bbb'],
      }),
    );
    expect(c.time).toBe(at(10));
    expect(c.attachments).toEqual([{ target: 'Job:shop/migrate', basis: 'image' }]);
  });

  it('第 2 档：镜像不一致时不挂，也不退回命名空间规则', () => {
    const c = only(
      [job('cleanup', 10), rs()],
      opts({ 'Job:shop/cleanup': ['ghcr.io/acme/tools:v1'], 'ReplicaSet:shop/api-new': ['ghcr.io/acme/api:sha-1'] }),
    );
    expect(c.time).toBe(at(20));
    expect(c.attachments).toBeUndefined();
  });

  it('第 3 档：没有 managed_by 与镜像数据时，同一命名空间、窗口内唯一的 Job 按弱推导挂上并标明依据', () => {
    const c = only([job('migrate', 10), rs()]);
    expect(c.time).toBe(at(10));
    expect(c.attachments).toEqual([{ target: 'Job:shop/migrate', basis: 'namespace_window' }]);
    expect(c.summary).toContain('只按同一命名空间与时间窗推断');
  });

  it('第 3 档：窗口内有多个候选 Job 时一个都不挂', () => {
    const c = only([job('migrate', 10), job('migstat', 10), rs()]);
    expect(c.time).toBe(at(20));
    expect(c.attachments).toBeUndefined();
  });

  it('不挂：CronJob 创建的 Job、其他命名空间的 Job（没有数据时）、窗口（30 分钟）之前或发布之后新建的 Job', () => {
    for (const j of [
      job('nightly-29069', 10, { owner: 'CronJob:shop/nightly' }),
      job('migrate', 10, { ns: 'billing' }),
      job('migrate', -15),
      job('migrate', 25),
    ]) {
      const c = only([j, rs()]);
      expect(c.attachments, j.key).toBeUndefined();
      expect(c.time).toBe(at(20));
    }
  });

  it('同一个 Job 只挂到它之后最近的那次发布', () => {
    const later: WorkloadEvent = { ...rs(), seq: ++seq, key: 'ReplicaSet:shop/api-newer', valid_from: at(35) };
    const r = deriveRollouts([job('migrate', 10, { managers: [APP] }), rs(), later], opts());
    expect(r).toHaveLength(2);
    expect(r[0]!.attachments).toEqual([{ target: 'Job:shop/migrate', basis: 'managed_by' }]);
    expect(r[1]!.attachments).toBeUndefined();
  });
});

describe('重建包（kube-state-metrics 历史）中的前置 Job', () => {
  // 状态库只有 Deployment；新 ReplicaSet、迁移 Job、CronJob 的 Job 与它们的 Pod（带镜像）只在 kube-state-metrics 历史里
  const row = (s: number, min: number, b: TopologyNode | TopologyEdge, source = 'ksm_history'): TopologyRow =>
    'key' in b
      ? { seq: s, op: 'node_upsert', item: 'node', key: b.key, valid_from: at(min), valid_to: null, source, body: b }
      : {
          seq: s,
          op: 'edge_upsert',
          item: 'edge',
          key: `${b.from}|${b.relation}|${b.to}`,
          valid_from: at(min),
          valid_to: null,
          source,
          body: b,
        };
  const owned = (from: string, to: string): TopologyEdge =>
    ({
      from,
      to,
      relation: 'owned_by',
      provenance: 'structural',
      confidence: 1,
      scope: 'service',
      evidence: 't',
    }) as TopologyEdge;
  const pod = (name: string, images: string[]): TopologyNode => ({ ...body('Pod', name), images });
  const topo = new BundleTopology([
    row(1, 0, body('Deployment', 'api'), 'informer'),
    row(-20, 0, body('Node', 'n1')),
    row(-19, 10, body('Job', 'migrate')),
    row(-18, 10, pod('migrate-x1', ['sha256:222'])),
    row(-17, 10, owned('Pod:shop/migrate-x1', 'Job:shop/migrate')),
    row(-16, 10, body('Job', 'nightly-29069')),
    row(-15, 10, owned('Job:shop/nightly-29069', 'CronJob:shop/nightly')),
    row(-14, 20, body('ReplicaSet', 'api-new')),
    row(-13, 20, owned('ReplicaSet:shop/api-new', 'Deployment:shop/api')),
    row(-12, 20, pod('api-new-z1', ['sha256:222'])),
    row(-11, 20, owned('Pod:shop/api-new-z1', 'ReplicaSet:shop/api-new')),
  ]);

  it('Job 来自 kube-state-metrics 历史，镜像取它的 Pod；CronJob 的 Job 不挂；按镜像挂上迁移 Job', () => {
    const events = topo.workloadEvents(T0, T0 + 30 * 60_000);
    expect(events.filter((e) => e.kind === 'Job').map((e) => [e.key, e.owner])).toEqual([
      ['Job:shop/migrate', null],
      ['Job:shop/nightly-29069', 'CronJob:shop/nightly'],
    ]);
    expect(topo.podImages('Job:shop/migrate')).toEqual(['sha256:222']);
    expect(topo.podImages('Job:shop/nightly-29069')).toBeNull();
    const r = deriveRollouts(events, { ...opts(), images: (o) => topo.podImages(o) });
    expect(r.map((c) => [c.time, c.attachments])).toEqual([[at(10), [{ target: 'Job:shop/migrate', basis: 'image' }]]]);
  });
});
