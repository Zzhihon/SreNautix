import type { V1Pod } from '@kubernetes/client-node';
import { finish } from '../../src/research/kube-tools.js';
import type { SkillKube } from '../../src/skills/kube.js';

/**
 * 录制的 Kubernetes 只读结果（DESIGN §14.2 的快照）：工作负载的 Pod、事件与上一次退出的容器日志。日志经与线上相同的
 * 脱敏与截断（finish）。记下每次读取，测试据此断言被拒绝的访问没有到达 Kubernetes
 */
export class RecordedKube implements SkillKube {
  readonly reads: Array<{ op: string; namespace: string; target: string }> = [];

  constructor(
    private readonly workloads: Map<string, V1Pod[]>,
    private readonly logs: Map<string, string>,
  ) {}

  async workloadPods(namespace: string, kind: string, name: string): Promise<V1Pod[]> {
    this.reads.push({ op: 'workload_pods', namespace, target: `${kind}/${name}` });
    const pods = this.workloads.get(`${kind}:${namespace}/${name}`);
    if (!pods) {
      throw Object.assign(new Error(`${kind} ${namespace}/${name} not found`), { code: 404 });
    }
    return pods;
  }

  async events(namespace: string) {
    this.reads.push({ op: 'events', namespace, target: '' });
    return [];
  }

  async previousLog(namespace: string, pod: string, container: string, tailLines: number, maxBytes: number) {
    this.reads.push({ op: 'pod_logs_previous', namespace, target: `${pod}/${container}` });
    const text = this.logs.get(`${namespace}/${pod}`);
    if (text === undefined) {
      throw Object.assign(new Error(`previous terminated container "${container}" in pod "${pod}" not found`), {
        code: 400,
      });
    }
    return finish(text.split('\n').slice(-tailLines).join('\n'), maxBytes);
  }
}
