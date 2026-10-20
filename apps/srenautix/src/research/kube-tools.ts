import { AppsV1Api, BatchV1Api, CoreV1Api, KubeConfig, type V1Pod } from '@kubernetes/client-node';
import { redactText } from '../llm/redact.js';

// 阶段 B 的 Kubernetes 只读检查（ADR 0106）：server 用自己的只读凭证读取当前状态，作为区分性检查的工具交给 worker。
// 只读 Pod 状态、对象事件、Pod 列表与容器日志的尾部；不读 Secret、ConfigMap 的值与容器的环境变量；
// 只允许事件涉及的命名空间；结果按大小截断并脱敏，属于不可信数据。

export interface HubToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface KubeToolSettings {
  tailLines: number;
  maxBytes: number;
}

export interface KubeToolResult {
  text: string;
  truncated: boolean;
  bytes: number;
}

export class KubeToolError extends Error {
  override name = 'KubeToolError';
}

const NS = { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' };
const NAME = { type: 'string', minLength: 1, maxLength: 253, pattern: '^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$' };

export const KUBE_TOOLS: readonly HubToolSpec[] = [
  {
    name: 'kube_pod_status',
    description:
      'Pod 的当前状态：phase、条件、init 容器与容器的状态（等待或终止的原因、消息、重启次数、镜像）、所在节点。不含环境变量与 Secret',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['namespace', 'pod'],
      properties: { namespace: NS, pod: NAME },
    },
  },
  {
    name: 'kube_workload_pods',
    description:
      '工作负载（Deployment、StatefulSet、DaemonSet、Job）当前的 Pod 列表：名称、phase、就绪、重启次数、停住的 init 容器与原因',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['namespace', 'kind', 'name'],
      properties: {
        namespace: NS,
        kind: { type: 'string', enum: ['Deployment', 'StatefulSet', 'DaemonSet', 'Job'] },
        name: NAME,
      },
    },
  },
  {
    name: 'kube_events',
    description: '对象最近的 Kubernetes 事件（类型、原因、消息、次数、最后时间），最多 20 条，新的在前',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['namespace', 'kind', 'name'],
      properties: {
        namespace: NS,
        kind: {
          type: 'string',
          enum: [
            'Pod',
            'Deployment',
            'ReplicaSet',
            'StatefulSet',
            'DaemonSet',
            'Job',
            'PersistentVolumeClaim',
            'Service',
          ],
        },
        name: NAME,
      },
    },
  },
  {
    name: 'kube_logs',
    description:
      '容器或 init 容器日志的最后若干行（已脱敏，按大小截断）。previous 为 true 时读上一次退出的容器。用于看迁移等待、启动失败等原因',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['namespace', 'pod', 'container'],
      properties: {
        namespace: NS,
        pod: NAME,
        container: NAME,
        previous: { type: 'boolean', default: false },
        tail_lines: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
  },
];

const enc = new TextEncoder();

/** 截断到 maxBytes（按 UTF-8 字节，不切开字符）并脱敏 */
export function finish(text: string, maxBytes: number): KubeToolResult {
  const red = redactText(text).text;
  const bytes = enc.encode(red).length;
  if (bytes <= maxBytes) {
    return { text: red, truncated: false, bytes };
  }
  let cut = red.slice(0, maxBytes);
  while (enc.encode(cut).length > maxBytes) {
    cut = cut.slice(0, -1);
  }
  return { text: cut, truncated: true, bytes };
}

/** Pod 的状态摘要（不含 spec 中的环境变量、卷内容） */
export function podSummary(p: V1Pod): Record<string, unknown> {
  const st = p.status ?? {};
  const container = (c: NonNullable<typeof st.containerStatuses>[number]) => ({
    name: c.name,
    image: c.image,
    ready: c.ready,
    restarts: c.restartCount,
    state: c.state?.waiting
      ? { waiting: { reason: c.state.waiting.reason ?? null, message: c.state.waiting.message ?? null } }
      : c.state?.terminated
        ? {
            terminated: {
              reason: c.state.terminated.reason ?? null,
              exit_code: c.state.terminated.exitCode,
              message: c.state.terminated.message ?? null,
              finished_at: c.state.terminated.finishedAt ?? null,
            },
          }
        : c.state?.running
          ? { running: { started_at: c.state.running.startedAt ?? null } }
          : {},
    last_terminated: c.lastState?.terminated
      ? { reason: c.lastState.terminated.reason ?? null, exit_code: c.lastState.terminated.exitCode }
      : null,
  });
  return {
    name: p.metadata?.name,
    namespace: p.metadata?.namespace,
    phase: st.phase ?? null,
    reason: st.reason ?? null,
    message: st.message ?? null,
    node: p.spec?.nodeName ?? null,
    created_at: p.metadata?.creationTimestamp ?? null,
    started_at: st.startTime ?? null,
    owner: p.metadata?.ownerReferences?.map((o) => `${o.kind}/${o.name}`) ?? [],
    conditions: (st.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason ?? null,
      message: c.message ?? null,
      since: c.lastTransitionTime ?? null,
    })),
    init_containers: (st.initContainerStatuses ?? []).map(container),
    containers: (st.containerStatuses ?? []).map(container),
  };
}

/** 只读的 Kubernetes 访问；所有调用都限定在 allowedNamespaces 里 */
export class KubeTools {
  private readonly core: CoreV1Api;
  private readonly apps: AppsV1Api;
  private readonly batch: BatchV1Api;

  constructor(
    kubeconfigPath: string | undefined,
    private readonly s: KubeToolSettings,
  ) {
    const kc = new KubeConfig();
    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      kc.loadFromCluster();
    }
    this.core = kc.makeApiClient(CoreV1Api);
    this.apps = kc.makeApiClient(AppsV1Api);
    this.batch = kc.makeApiClient(BatchV1Api);
  }

  specs(): readonly HubToolSpec[] {
    return KUBE_TOOLS;
  }

  async run(
    name: string,
    args: Record<string, unknown>,
    allowedNamespaces: ReadonlySet<string>,
  ): Promise<KubeToolResult> {
    const ns = String(args.namespace ?? '');
    if (!allowedNamespaces.has(ns)) {
      throw new KubeToolError(
        `命名空间 ${ns} 不在本次事件涉及的范围内（${[...allowedNamespaces].sort().join('、') || '无'}）`,
      );
    }
    try {
      switch (name) {
        case 'kube_pod_status': {
          const p = await this.core.readNamespacedPod({ namespace: ns, name: String(args.pod) });
          return finish(JSON.stringify(podSummary(p)), this.s.maxBytes);
        }
        case 'kube_workload_pods': {
          const selector = await this.selectorOf(ns, String(args.kind), String(args.name));
          const list = await this.core.listNamespacedPod({ namespace: ns, labelSelector: selector, limit: 50 });
          const pods = list.items.map((p) => {
            const s = podSummary(p) as { init_containers: Array<{ name: string; state: unknown }> };
            const stuck = s.init_containers.find((c) => !('terminated' in (c.state as object)));
            return {
              name: p.metadata?.name,
              phase: p.status?.phase ?? null,
              ready: (p.status?.containerStatuses ?? []).every((c) => c.ready),
              restarts: (p.status?.containerStatuses ?? []).reduce((a, c) => a + c.restartCount, 0),
              stuck_init_container: stuck ? { name: stuck.name, state: stuck.state } : null,
              waiting: (p.status?.containerStatuses ?? [])
                .filter((c) => c.state?.waiting)
                .map((c) => ({ name: c.name, reason: c.state?.waiting?.reason ?? null })),
              created_at: p.metadata?.creationTimestamp ?? null,
              node: p.spec?.nodeName ?? null,
            };
          });
          return finish(JSON.stringify({ selector, pods }), this.s.maxBytes);
        }
        case 'kube_events': {
          const list = await this.core.listNamespacedEvent({
            namespace: ns,
            fieldSelector: `involvedObject.kind=${String(args.kind)},involvedObject.name=${String(args.name)}`,
          });
          const events = list.items
            .map((e) => ({
              type: e.type ?? null,
              reason: e.reason ?? null,
              message: e.message ?? null,
              count: e.count ?? 1,
              last: e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? null,
            }))
            .sort((a, b) => String(b.last).localeCompare(String(a.last)))
            .slice(0, 20);
          return finish(JSON.stringify(events), this.s.maxBytes);
        }
        case 'kube_logs': {
          const tail = Math.min(
            this.s.tailLines * 5,
            typeof args.tail_lines === 'number' ? args.tail_lines : this.s.tailLines,
          );
          const text = await this.core.readNamespacedPodLog({
            namespace: ns,
            name: String(args.pod),
            container: String(args.container),
            previous: args.previous === true,
            tailLines: tail,
            limitBytes: this.s.maxBytes * 4,
          });
          return finish(String(text ?? ''), this.s.maxBytes);
        }
        default:
          throw new KubeToolError(`没有工具 ${name}`);
      }
    } catch (e) {
      if (e instanceof KubeToolError) {
        throw e;
      }
      const code = (e as { code?: number }).code;
      const body = (e as { body?: unknown }).body;
      const msg = typeof body === 'string' ? body : JSON.stringify(body ?? (e as Error).message);
      throw new KubeToolError(`Kubernetes API 返回${code ? ` ${code}` : '错误'}：${msg.slice(0, 300)}`);
    }
  }

  private async selectorOf(ns: string, kind: string, name: string): Promise<string> {
    const spec =
      kind === 'Deployment'
        ? (await this.apps.readNamespacedDeployment({ namespace: ns, name })).spec
        : kind === 'StatefulSet'
          ? (await this.apps.readNamespacedStatefulSet({ namespace: ns, name })).spec
          : kind === 'DaemonSet'
            ? (await this.apps.readNamespacedDaemonSet({ namespace: ns, name })).spec
            : (await this.batch.readNamespacedJob({ namespace: ns, name })).spec;
    const labels = spec?.selector?.matchLabels ?? {};
    if (!Object.keys(labels).length) {
      throw new KubeToolError(`${kind} ${ns}/${name} 没有 matchLabels 选择器`);
    }
    return Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
  }
}
