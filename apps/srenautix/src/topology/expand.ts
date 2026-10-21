import { parseStoredKey } from './keys.js';
import type { TopologyStore } from './store.js';

/** 工作负载的 kind：自愈模板与证据链按它们组织 */
export const WORKLOAD_KINDS: readonly string[] = ['Deployment', 'StatefulSet', 'DaemonSet'];

/** 逻辑组件的键（component:<值> 或 component:<命名空间>/<值>，ADR 0104 §6） */
export function isLogicalComponent(key: string): boolean {
  return key.startsWith('component:');
}

/** 一个逻辑组件最多映射出的候选数 */
export const MAX_LOGICAL_CANDIDATES = 6;

/** 逻辑组件上的告警提供的线索：service 标签与 namespace 标签 */
export interface LogicalHint {
  service: string | null;
  namespace: string | null;
}

/** 告警标签 → 逻辑组件的线索 */
export function hintOf(labels: Readonly<Record<string, unknown>>): LogicalHint {
  const s = (k: string) => (typeof labels[k] === 'string' && labels[k] !== '' ? (labels[k] as string) : null);
  return { service: s('service'), namespace: s('namespace') };
}

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
 * - 逻辑组件取映射出的工作负载（ADR 0130），只有一个时用它；
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

  /**
   * 逻辑组件 → 候选工作负载（ADR 0130），三种来源：
   * 1. 同名的 Service、Deployment、StatefulSet、DaemonSet（逻辑组件带命名空间时只在这个命名空间里找）；
   * 2. 告警的 service 标签指向的 Service（告警带 namespace 标签时只在这个命名空间里找）；
   * 3. 拓扑里前两步找到的 Service 选中的 Pod 所属的工作负载。
   * 工作负载在前（同名的、再是 Service 选中的），然后是 Service，按键排序，最多 MAX_LOGICAL_CANDIDATES 个。
   * 不是逻辑组件时为空。
   */
  async logicalCandidates(clusterId: string, key: string, hints: readonly LogicalHint[], at: Date): Promise<string[]> {
    if (!isLogicalComponent(key)) {
      return [];
    }
    const p = parseStoredKey(key);
    const named: string[] = [];
    const services: string[] = [];
    const look = async (name: string, namespace: string | null, kinds: readonly string[]) => {
      for (const n of await this.store.named(clusterId, kinds, namespace, name, at)) {
        (n.kind === 'Service' ? services : named).push(n.key);
      }
    };
    await look(p.name, p.namespace, ['Service', ...WORKLOAD_KINDS]);
    for (const h of hints) {
      if (h.service) {
        await look(h.service, p.namespace ?? h.namespace, ['Service']);
      }
    }
    const selected: string[] = [];
    for (const s of [...new Set(services)].sort()) {
      selected.push(...(await this.serviceWorkloads(clusterId, s, at)));
    }
    return [...new Set([...named.sort(), ...selected.sort(), ...[...new Set(services)].sort()])].slice(
      0,
      MAX_LOGICAL_CANDIDATES,
    );
  }

  async concrete(
    clusterId: string,
    key: string,
    at: Date,
    hints: readonly LogicalHint[] = [],
  ): Promise<ConcreteObject> {
    let target = (await this.store.ownerOf(clusterId, key, at)) ?? key;
    if (isLogicalComponent(target)) {
      // 逻辑组件只映射出一个工作负载时展开为它
      const workloads = (await this.logicalCandidates(clusterId, target, hints, at)).filter((k) =>
        WORKLOAD_KINDS.includes(parseStoredKey(k).kind),
      );
      if (workloads.length === 1) {
        target = workloads[0]!;
      }
    }
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
