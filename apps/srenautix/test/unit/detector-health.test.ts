import { describe, expect, it } from 'vitest';
import { FirstSeen, objectHealth, type K8sObject } from '../../src/detectors/health.js';
import {
  belowThreshold,
  DEFAULT_EQUIVALENTS,
  findingAlert,
  type DetectorSettings,
} from '../../src/detectors/service.js';

// 集群状态检测器的对象健康判定（ADR 0105）

const NOW = Date.parse('2026-10-20T17:00:00Z');
const T = (min: number) => new Date(NOW + min * 60_000).toISOString();
const meta = (kind: string, name: string, extra: Partial<K8sObject['metadata']> = {}) => ({
  kind,
  metadata: { name, namespace: 'shop', uid: `uid-${name}`, creationTimestamp: T(-30), ...extra },
});
const rs: K8sObject = {
  ...meta('ReplicaSet', 'api-7d9f8', { ownerReferences: [{ kind: 'Deployment', name: 'api', controller: true }] }),
};
const podOf = (name: string, status: Record<string, unknown>, spec: Record<string, unknown> = {}): K8sObject => ({
  ...meta('Pod', name, {
    labels: { app: 'api' },
    ownerReferences: [{ kind: 'ReplicaSet', name: 'api-7d9f8', controller: true }],
  }),
  spec,
  status,
});

const settings: DetectorSettings = {
  namespaces: ['*'],
  excludeNamespaces: ['kube-system'],
  thresholdsMs: { pod_init: 10 * 60_000, pod_pending: 10 * 60_000, crash_loop: 5 * 60_000, job_failed: 0 },
  severity: 'warning',
  equivalentAlerts: DEFAULT_EQUIVALENTS,
};

describe('对象健康判定', () => {
  it('Pod 停在 Init：since 为创建时间，原因与停住的 init 容器写明，属主经 ReplicaSet 解析到 Deployment', () => {
    const pod = podOf(
      'api-7d9f8-x2k4p',
      {
        phase: 'Pending',
        initContainerStatuses: [{ name: 'wait-migrations', state: { running: { startedAt: T(-29) } } }],
        conditions: [
          { type: 'Initialized', status: 'False', lastTransitionTime: T(-30), reason: 'ContainersNotInitialized' },
        ],
      },
      { initContainers: [{ name: 'wait-migrations' }] },
    );
    const [h] = objectHealth([rs, pod], new FirstSeen(), NOW);
    expect(h).toMatchObject({
      key: 'Pod:shop/api-7d9f8-x2k4p',
      state: 'pod_init',
      since: T(-30),
      reason: 'InitContainerRunning',
      owner: 'Deployment:shop/api',
      details: { init_container: 'wait-migrations' },
    });
  });

  it('Pod 未调度：since 为 PodScheduled=False 的时间；拉镜像失败：原因取容器的 waiting.reason', () => {
    const unsched = podOf('api-a', {
      phase: 'Pending',
      conditions: [
        {
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message: '0/3 nodes are available',
          lastTransitionTime: T(-20),
        },
      ],
    });
    const pull = podOf('api-b', {
      phase: 'Pending',
      conditions: [{ type: 'PodScheduled', status: 'True' }],
      containerStatuses: [{ name: 'api', state: { waiting: { reason: 'ImagePullBackOff', message: 'not found' } } }],
    });
    const hs = objectHealth([rs, unsched, pull], new FirstSeen(), NOW);
    expect(hs.map((h) => [h.name, h.state, h.reason, h.since])).toEqual([
      ['api-a', 'pod_pending', 'Unschedulable', T(-20)],
      ['api-b', 'pod_pending', 'ImagePullBackOff', T(-30)],
    ]);
  });

  it('CrashLoopBackOff：since 为第一次看到的时间，状态消失后重新计时', () => {
    const fs = new FirstSeen();
    const crash = podOf('api-c', {
      phase: 'Running',
      containerStatuses: [{ name: 'api', restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }],
    });
    expect(objectHealth([crash], fs, NOW)[0]).toMatchObject({
      state: 'crash_loop',
      since: T(0),
      details: { restarts: 7 },
    });
    expect(objectHealth([crash], fs, NOW + 60_000)[0]!.since).toBe(T(0));
    expect(objectHealth([], fs, NOW + 120_000)).toEqual([]);
    expect(objectHealth([crash], fs, NOW + 180_000)[0]!.since).toBe(T(3));
  });

  it('Deployment 超过 progressDeadline；StatefulSet 版本没滚完；DaemonSet 不可用；Job 失败；PDB 阻塞驱逐', () => {
    const objs: K8sObject[] = [
      {
        ...meta('Deployment', 'api'),
        spec: { replicas: 2 },
        status: {
          updatedReplicas: 1,
          availableReplicas: 1,
          conditions: [
            { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', lastTransitionTime: T(-12) },
          ],
        },
      },
      {
        ...meta('StatefulSet', 'db'),
        spec: { replicas: 3 },
        status: { readyReplicas: 3, currentRevision: 'db-1', updateRevision: 'db-2' },
      },
      {
        ...meta('DaemonSet', 'agent'),
        status: { desiredNumberScheduled: 3, updatedNumberScheduled: 3, numberAvailable: 2 },
      },
      {
        ...meta('Job', 'migrate'),
        status: {
          failed: 4,
          conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', lastTransitionTime: T(-2) }],
        },
      },
      {
        ...meta('PodDisruptionBudget', 'api'),
        spec: { selector: { matchLabels: { app: 'api' } } },
        status: {
          expectedPods: 2,
          disruptionsAllowed: 0,
          currentHealthy: 1,
          desiredHealthy: 2,
          conditions: [
            { type: 'DisruptionAllowed', status: 'False', reason: 'InsufficientPods', lastTransitionTime: T(-8) },
          ],
        },
      },
      rs,
      podOf('api-7d9f8-ok', { phase: 'Running', containerStatuses: [{ name: 'api', state: { running: {} } }] }),
      { ...meta('Deployment', 'idle'), spec: { replicas: 0 }, status: {} },
    ];
    const hs = objectHealth(objs, new FirstSeen(), NOW);
    expect(hs.map((h) => [h.key, h.state, h.reason, h.since])).toEqual([
      ['DaemonSet:shop/agent', 'rollout_stalled', 'NumberAvailableBehind', T(0)],
      ['Deployment:shop/api', 'rollout_stalled', 'ProgressDeadlineExceeded', T(-12)],
      ['Job:shop/migrate', 'job_failed', 'BackoffLimitExceeded', T(-2)],
      ['PodDisruptionBudget:shop/api', 'pdb_blocking', 'InsufficientPods', T(-8)],
      ['StatefulSet:shop/db', 'rollout_stalled', 'UpdateRevisionNotRolledOut', T(0)],
    ]);
    expect(hs.find((h) => h.state === 'pdb_blocking')?.targets).toEqual(['Deployment:shop/api']);
  });
});

describe('阈值与合成告警', () => {
  const init = {
    key: 'Pod:shop/api-x',
    kind: 'Pod',
    namespace: 'shop',
    name: 'api-x',
    uid: 'u',
    state: 'pod_init' as const,
    since: T(-12),
    reason: 'InitContainerRunning',
    message: 'waiting for migrations',
    owner: 'Deployment:shop/api',
    details: { init_container: 'wait-migrations' },
  };

  it('超过阈值后合成告警：开始时间是进入状态加阈值，标签契约给出实体，来源 detector', () => {
    const a = findingAlert('east', init, settings, NOW)!;
    expect(a).toMatchObject({
      source: 'detector',
      alertname: 'SreNautixPodInitStuck',
      status: 'firing',
      labels: {
        alertname: 'SreNautixPodInitStuck',
        namespace: 'shop',
        pod: 'api-x',
        entity: 'api-x',
        entity_kind: 'Pod',
        role: 'cause',
        srenautix_detector: 'pod_init',
      },
    });
    expect(a.startsAt.toISOString()).toBe(T(-2));
    expect(a.annotations.summary).toBe('Pod 停在 Init：shop/api-x（InitContainerRunning）');
    expect(a.annotations.description).toContain('init_container=wait-migrations');
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('没到阈值、命名空间被排除、状态没有阈值（关闭）时不合成', () => {
    expect(findingAlert('east', { ...init, since: T(-5) }, settings, NOW)).toBeNull();
    expect(findingAlert('east', { ...init, namespace: 'kube-system' }, settings, NOW)).toBeNull();
    expect(findingAlert('east', { ...init, state: 'rollout_stalled' }, settings, NOW)).toBeNull();
  });

  it('只是还没到阈值（重启后进入时间从头算起）：已触发的发现据此保持，命名空间被排除或状态关闭时不算（ADR 0128）', () => {
    expect(belowThreshold({ ...init, since: T(-5) }, settings, NOW)).toBe(true);
    expect(belowThreshold(init, settings, NOW)).toBe(false);
    expect(belowThreshold({ ...init, since: T(-5), namespace: 'kube-system' }, settings, NOW)).toBe(false);
    expect(belowThreshold({ ...init, since: T(-5), state: 'rollout_stalled' }, settings, NOW)).toBe(false);
  });
});
