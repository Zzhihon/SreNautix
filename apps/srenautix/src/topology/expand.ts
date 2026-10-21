import { parseStoredKey } from './keys.js';
import type { TopologyStore } from './store.js';

/** 工作负载的 kind：自愈模板与证据链按它们组织 */
export const WORKLOAD_KINDS: readonly string[] = ['Deployment', 'StatefulSet', 'DaemonSet'];

export interface ConcreteObject {
  key: string;
  kind: string;
  namespace: string | null;
  name: string;
  uid: string | null;
}

/**
 * 组件键 → 拓扑里的具体对象（ADR 0126）：
 * - 由控制器拥有的对象（Pod、ReplicaSet）取顶层属主；
 * - Service 取它选中的 Pod 所属的工作负载，只有一个时用它；
 * - 其余是对象本身，uid 取拓扑节点（没有节点时为 null）。
 */
export class ComponentExpander {
  constructor(private readonly store: TopologyStore) {}

  /** Service 选中的 Pod 的顶层属主（去重、按键排序）；没有属主的 Pod 不计入 */
  async serviceWorkloads(clusterId: string, serviceKey: string, at: Date): Promise<string[]> {
    const owners = new Set<string>();
    for (const pod of await this.store.targets(clusterId, serviceKey, 'selects', at)) {
      const owner = await this.store.ownerOf(clusterId, pod, at);
      if (owner) {
        owners.add(owner);
      }
    }
    return [...owners].sort();
  }

  async concrete(clusterId: string, key: string, at: Date): Promise<ConcreteObject> {
    let target = (await this.store.ownerOf(clusterId, key, at)) ?? key;
    if (parseStoredKey(target).kind === 'Service') {
      const workloads = await this.serviceWorkloads(clusterId, target, at);
      if (workloads.length === 1) {
        target = workloads[0]!;
      }
    }
    const p = parseStoredKey(target);
    return {
      key: target,
      kind: p.kind,
      namespace: p.namespace,
      name: p.name,
      uid: (await this.store.uidOf(clusterId, target, at)) ?? null,
    };
  }
}
