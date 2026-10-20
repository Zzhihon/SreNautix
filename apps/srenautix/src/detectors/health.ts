import { tryNodeKey } from '@srenautix/core';

// 集群状态检测器的对象健康状态（ADR 0105）：只列出"现在不健康"的对象与进入这个状态的时间，不判断阈值。
// 单集群由 server 的 informer 按这里的规则计算；多集群由 reader 按同样的规则上报（reader 协议的 ReaderHealth）。
// 阈值判断与合成告警在 server（detectors/service.ts）。

export type HealthState = 'pod_pending' | 'pod_init' | 'crash_loop' | 'rollout_stalled' | 'pdb_blocking' | 'job_failed';

export interface ObjectHealth {
  key: string;
  kind: string;
  namespace: string | null;
  name: string;
  uid: string | null;
  state: HealthState;
  /** 进入这个状态的时间（ISO） */
  since: string;
  reason: string;
  message: string;
  /** Pod 的属主工作负载键（经 ReplicaSet 解析）；其他为 null */
  owner: string | null;
  /** PDB 选中的工作负载键 */
  targets?: string[];
  details?: Record<string, string | number>;
}

/** 计算健康状态需要的 Kubernetes 对象字段（list/watch 返回的完整对象的一部分） */
export interface K8sObject {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string | Date;
    labels?: Record<string, string>;
    ownerReferences?: Array<{ kind: string; name: string; controller?: boolean }>;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string | Date;
}

interface ContainerStatus {
  name: string;
  restartCount?: number;
  state?: { waiting?: { reason?: string; message?: string }; running?: unknown; terminated?: { reason?: string } };
}

const iso = (v: string | Date | undefined): string | null =>
  v === undefined ? null : typeof v === 'string' ? new Date(v).toISOString() : v.toISOString();

const MESSAGE_MAX = 1024;
const clip = (s: string | undefined) => (s ?? '').slice(0, MESSAGE_MAX);

function conditions(o: K8sObject): Condition[] {
  return ((o.status?.conditions as Condition[] | undefined) ?? []).filter((c) => c && typeof c.type === 'string');
}

function condition(o: K8sObject, type: string): Condition | undefined {
  return conditions(o).find((c) => c.type === type);
}

/**
 * 只在内存里记录"第一次看到某个状态"的时间：CrashLoopBackOff、rollout 不一致这类没有对应条件时间的状态用它。
 * 状态消失后删除记录；进程重启后从重启时间算起。
 */
export class FirstSeen {
  private readonly seen = new Map<string, number>();
  private live = new Set<string>();

  mark(id: string, now: number): string {
    this.live.add(id);
    const t = this.seen.get(id) ?? now;
    this.seen.set(id, t);
    return new Date(t).toISOString();
  }

  /** 一轮计算结束：忘掉这一轮没有出现的状态 */
  sweep(): void {
    for (const id of this.seen.keys()) {
      if (!this.live.has(id)) {
        this.seen.delete(id);
      }
    }
    this.live = new Set();
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/** 对象的组件键；不能构成合法的键时为 null */
const keyOf = (kind: string, ns: string | undefined, name: string) => tryNodeKey(kind, ns ?? null, name);

/**
 * 当前不健康的对象。objects 是同一集群全部命名空间的对象（Pod、ReplicaSet、Deployment、StatefulSet、DaemonSet、
 * Job、PodDisruptionBudget）；firstSeen 保存没有条件时间的状态第一次出现的时间。
 */
export function objectHealth(objects: readonly K8sObject[], firstSeen: FirstSeen, now: number): ObjectHealth[] {
  const out: ObjectHealth[] = [];
  const rsOwner = new Map<string, string>();
  for (const o of objects) {
    if (o.kind === 'ReplicaSet') {
      const c = o.metadata.ownerReferences?.find((r) => r.controller !== false && r.kind === 'Deployment');
      if (c) {
        const k = keyOf('Deployment', o.metadata.namespace, c.name);
        if (k) {
          rsOwner.set(`${o.metadata.namespace ?? ''}/${o.metadata.name}`, k);
        }
      }
    }
  }
  const ownerOf = (o: K8sObject): string | null => {
    const r = o.metadata.ownerReferences?.find((x) => x.controller !== false) ?? o.metadata.ownerReferences?.[0];
    if (!r) {
      return null;
    }
    if (r.kind === 'ReplicaSet') {
      return (
        rsOwner.get(`${o.metadata.namespace ?? ''}/${r.name}`) ?? keyOf('ReplicaSet', o.metadata.namespace, r.name)
      );
    }
    return keyOf(r.kind, o.metadata.namespace, r.name);
  };
  const base = (o: K8sObject) => {
    const key = keyOf(o.kind, o.metadata.namespace, o.metadata.name);
    return key
      ? {
          key,
          kind: o.kind,
          namespace: o.metadata.namespace ?? null,
          name: o.metadata.name,
          uid: o.metadata.uid ?? null,
        }
      : null;
  };
  const created = (o: K8sObject) => iso(o.metadata.creationTimestamp) ?? new Date(now).toISOString();

  for (const o of objects) {
    const b = base(o);
    if (!b) {
      continue;
    }
    switch (o.kind) {
      case 'Pod': {
        const phase = o.status?.phase as string | undefined;
        if (phase === 'Succeeded' || phase === 'Failed' || o.metadata.creationTimestamp === undefined) {
          break;
        }
        if ((o.metadata as { deletionTimestamp?: unknown }).deletionTimestamp) {
          break;
        }
        const owner = ownerOf(o);
        const statuses = (o.status?.containerStatuses as ContainerStatus[] | undefined) ?? [];
        const crash = statuses.find((s) => s.state?.waiting?.reason === 'CrashLoopBackOff');
        if (crash) {
          out.push({
            ...b,
            state: 'crash_loop',
            since: firstSeen.mark(`${b.key}|crash_loop`, now),
            reason: 'CrashLoopBackOff',
            message: clip(crash.state?.waiting?.message),
            owner,
            details: { container: crash.name, restarts: num(crash.restartCount) },
          });
        }
        if (phase !== 'Pending') {
          break;
        }
        const inits = (o.status?.initContainerStatuses as ContainerStatus[] | undefined) ?? [];
        const initSpec = (o.spec?.initContainers as unknown[] | undefined) ?? [];
        const stuckInit = inits.find((s) => s.state?.terminated?.reason !== 'Completed');
        if (initSpec.length > 0 && (stuckInit || inits.length < initSpec.length)) {
          const initialized = condition(o, 'Initialized');
          const since = [created(o), iso(initialized?.lastTransitionTime)]
            .filter((x): x is string => x !== null)
            .sort()
            .at(-1)!;
          out.push({
            ...b,
            state: 'pod_init',
            since,
            reason:
              stuckInit?.state?.waiting?.reason ??
              (stuckInit?.state?.running ? 'InitContainerRunning' : 'PodInitializing'),
            message: clip(stuckInit?.state?.waiting?.message ?? initialized?.message),
            owner,
            details: { init_container: stuckInit?.name ?? '' },
          });
          break;
        }
        const scheduled = condition(o, 'PodScheduled');
        const waiting = statuses.find((s) => s.state?.waiting);
        out.push({
          ...b,
          state: 'pod_pending',
          since:
            scheduled && scheduled.status === 'False' ? (iso(scheduled.lastTransitionTime) ?? created(o)) : created(o),
          reason:
            scheduled && scheduled.status === 'False'
              ? (scheduled.reason ?? 'Unschedulable')
              : (waiting?.state?.waiting?.reason ?? 'Pending'),
          message: clip(
            scheduled && scheduled.status === 'False' ? scheduled.message : waiting?.state?.waiting?.message,
          ),
          owner,
          ...(waiting ? { details: { container: waiting.name } } : {}),
        });
        break;
      }
      case 'Deployment': {
        const replicas = o.spec?.replicas === undefined ? 1 : num(o.spec.replicas);
        const progressing = condition(o, 'Progressing');
        const updated = num(o.status?.updatedReplicas);
        const available = num(o.status?.availableReplicas);
        const ready = num(o.status?.readyReplicas);
        const details = { desired: replicas, updated, available, ready };
        if (progressing?.reason === 'ProgressDeadlineExceeded') {
          out.push({
            ...b,
            state: 'rollout_stalled',
            since: iso(progressing.lastTransitionTime) ?? firstSeen.mark(`${b.key}|rollout_stalled`, now),
            reason: 'ProgressDeadlineExceeded',
            message: clip(progressing.message),
            owner: null,
            details,
          });
        } else if (replicas > 0 && (updated < replicas || available < replicas)) {
          out.push({
            ...b,
            state: 'rollout_stalled',
            since: firstSeen.mark(`${b.key}|rollout_stalled`, now),
            reason: updated < replicas ? 'UpdatedReplicasBehind' : 'AvailableReplicasBehind',
            message: '',
            owner: null,
            details,
          });
        }
        break;
      }
      case 'StatefulSet': {
        const replicas = o.spec?.replicas === undefined ? 1 : num(o.spec.replicas);
        const ready = num(o.status?.readyReplicas);
        const cur = o.status?.currentRevision as string | undefined;
        const upd = o.status?.updateRevision as string | undefined;
        const strategy = (o.spec?.updateStrategy as { type?: string } | undefined)?.type;
        const revisionBehind = strategy !== 'OnDelete' && cur !== undefined && upd !== undefined && cur !== upd;
        if (replicas > 0 && (ready < replicas || revisionBehind)) {
          out.push({
            ...b,
            state: 'rollout_stalled',
            since: firstSeen.mark(`${b.key}|rollout_stalled`, now),
            reason: revisionBehind ? 'UpdateRevisionNotRolledOut' : 'ReadyReplicasBehind',
            message: '',
            owner: null,
            details: { desired: replicas, ready, updated: num(o.status?.updatedReplicas) },
          });
        }
        break;
      }
      case 'DaemonSet': {
        const desired = num(o.status?.desiredNumberScheduled);
        const updated = num(o.status?.updatedNumberScheduled);
        const available = num(o.status?.numberAvailable);
        if (desired > 0 && (updated < desired || available < desired)) {
          out.push({
            ...b,
            state: 'rollout_stalled',
            since: firstSeen.mark(`${b.key}|rollout_stalled`, now),
            reason: updated < desired ? 'UpdatedNumberScheduledBehind' : 'NumberAvailableBehind',
            message: '',
            owner: null,
            details: { desired, updated, available },
          });
        }
        break;
      }
      case 'Job': {
        const failed = conditions(o).find((c) => c.type === 'Failed' && c.status === 'True');
        if (failed) {
          out.push({
            ...b,
            state: 'job_failed',
            since: iso(failed.lastTransitionTime) ?? created(o),
            reason: failed.reason ?? 'Failed',
            message: clip(failed.message),
            owner: ownerOf(o),
            details: { failed: num(o.status?.failed) },
          });
        }
        break;
      }
      case 'PodDisruptionBudget': {
        const expected = num(o.status?.expectedPods);
        const allowed = num(o.status?.disruptionsAllowed);
        if (expected > 0 && allowed === 0) {
          const c = condition(o, 'DisruptionAllowed');
          out.push({
            ...b,
            state: 'pdb_blocking',
            since: (c?.status === 'False' ? iso(c.lastTransitionTime) : null) ?? firstSeen.mark(`${b.key}|pdb`, now),
            reason: c?.reason ?? 'InsufficientPods',
            message: clip(c?.message),
            owner: null,
            targets: pdbTargets(o, objects),
            details: {
              disruptions_allowed: allowed,
              expected_pods: expected,
              current_healthy: num(o.status?.currentHealthy),
              desired_healthy: num(o.status?.desiredHealthy),
            },
          });
        }
        break;
      }
    }
  }
  firstSeen.sweep();
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.state.localeCompare(b.state));
}

/** PDB 选中的 Pod 的属主工作负载 */
function pdbTargets(pdb: K8sObject, objects: readonly K8sObject[]): string[] {
  const sel = (pdb.spec?.selector as { matchLabels?: Record<string, string> } | undefined)?.matchLabels;
  if (!sel || Object.keys(sel).length === 0) {
    return [];
  }
  const out = new Set<string>();
  const rsOwner = new Map<string, string>();
  for (const o of objects) {
    if (o.kind === 'ReplicaSet' && o.metadata.namespace === pdb.metadata.namespace) {
      const r = o.metadata.ownerReferences?.find((x) => x.kind === 'Deployment');
      if (r) {
        rsOwner.set(o.metadata.name, r.name);
      }
    }
  }
  for (const o of objects) {
    if (o.kind !== 'Pod' || o.metadata.namespace !== pdb.metadata.namespace) {
      continue;
    }
    const labels = o.metadata.labels ?? {};
    if (!Object.entries(sel).every(([k, v]) => labels[k] === v)) {
      continue;
    }
    const r = o.metadata.ownerReferences?.find((x) => x.controller !== false);
    if (!r) {
      continue;
    }
    const k =
      r.kind === 'ReplicaSet' && rsOwner.has(r.name)
        ? keyOf('Deployment', o.metadata.namespace, rsOwner.get(r.name)!)
        : keyOf(r.kind, o.metadata.namespace, r.name);
    if (k) {
      out.add(k);
    }
  }
  return [...out].sort();
}
