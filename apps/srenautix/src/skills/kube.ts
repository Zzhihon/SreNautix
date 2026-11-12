import { AppsV1Api, CoreV1Api, KubeConfig, type V1Pod } from '@kubernetes/client-node';
import type { skills as sdk } from '@srenautix/packs-sdk';
import { finish, readLogTail } from '../research/kube-tools.js';

// 技能的 Kubernetes 只读访问（ADR 0181 §7.1）：工作负载的 Pod 状态摘要、Pod 的事件、上一次退出的容器日志尾部。
// 不读环境变量、卷与 Secret；日志经脱敏与截断（与阶段 B 的只读检查相同，ADR 0106）。调用方（SkillContext）负责能力、
// 作用范围与预算的检查。

export interface SkillKube {
  workloadPods(namespace: string, kind: string, name: string): Promise<V1Pod[]>;
  events(namespace: string): Promise<
    Array<{
      object: string;
      type: string | null;
      reason: string | null;
      message: string | null;
      count: number;
      last: number | null;
    }>
  >;
  previousLog(
    namespace: string,
    pod: string,
    container: string,
    tailLines: number,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean; bytes: number }>;
}

const ms = (v: Date | string | undefined | null): number | null =>
  v === undefined || v === null ? null : typeof v === 'string' ? Date.parse(v) : v.getTime();

const UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

/** Kubernetes 的内存数量（4Gi、512Mi、1e9）转成字节；不能识别时为 null */
export function memoryBytes(q: string | undefined): number | null {
  if (!q) {
    return null;
  }
  const m = /^([0-9.]+(?:e[0-9]+)?)([KMGT]i?)?$/.exec(q.trim());
  if (!m) {
    return null;
  }
  return Number(m[1]) * (m[2] ? UNITS[m[2]]! : 1);
}

export function podSummary(p: V1Pod): sdk.PodSummary {
  const limits = new Map((p.spec?.containers ?? []).map((c) => [c.name, memoryBytes(c.resources?.limits?.memory)]));
  return {
    name: p.metadata?.name ?? '',
    node: p.spec?.nodeName ?? null,
    phase: p.status?.phase ?? null,
    reason: p.status?.reason ?? null,
    containers: (p.status?.containerStatuses ?? []).map((c) => ({
      name: c.name,
      image: c.image ?? null,
      ready: c.ready,
      restarts: c.restartCount,
      memory_limit_bytes: limits.get(c.name) ?? null,
      last_terminated: c.lastState?.terminated
        ? {
            reason: c.lastState.terminated.reason ?? null,
            exit_code: c.lastState.terminated.exitCode ?? null,
            finished_at: ms(c.lastState.terminated.finishedAt),
          }
        : null,
    })),
  };
}

export class KubeSkillReader implements SkillKube {
  private readonly core: CoreV1Api;
  private readonly apps: AppsV1Api;

  constructor(kubeconfigPath: string | undefined) {
    const kc = new KubeConfig();
    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      kc.loadFromCluster();
    }
    this.core = kc.makeApiClient(CoreV1Api);
    this.apps = kc.makeApiClient(AppsV1Api);
  }

  async workloadPods(namespace: string, kind: string, name: string): Promise<V1Pod[]> {
    const spec =
      kind === 'Deployment'
        ? (await this.apps.readNamespacedDeployment({ namespace, name })).spec
        : kind === 'StatefulSet'
          ? (await this.apps.readNamespacedStatefulSet({ namespace, name })).spec
          : (await this.apps.readNamespacedDaemonSet({ namespace, name })).spec;
    const labels = spec?.selector?.matchLabels ?? {};
    if (!Object.keys(labels).length) {
      throw new Error(`${kind} ${namespace}/${name} 没有 matchLabels 选择器`);
    }
    const selector = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return (await this.core.listNamespacedPod({ namespace, labelSelector: selector, limit: 100 })).items;
  }

  async events(namespace: string) {
    const list = await this.core.listNamespacedEvent({ namespace, limit: 500 });
    return list.items.map((e) => ({
      object: `${e.involvedObject.kind ?? ''}/${e.involvedObject.name ?? ''}`,
      type: e.type ?? null,
      reason: e.reason ?? null,
      message: e.message ? finish(e.message, 1024).text : null,
      count: e.count ?? 1,
      last: ms(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp),
    }));
  }

  async previousLog(namespace: string, pod: string, container: string, tailLines: number, maxBytes: number) {
    return readLogTail(this.core, { namespace, pod, container, previous: true, tailLines, maxBytes });
  }
}
