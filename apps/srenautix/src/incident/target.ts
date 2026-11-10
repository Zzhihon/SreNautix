import type { Incident } from '@srenautix/contract';
import { NAMESPACE_KIND } from '@srenautix/core';
import { scopeMatches, type RoleBinding, type Target } from '../identity/bindings.js';
import { parseStoredKey } from '../topology/keys.js';

// 事件与组件的授权对象：控制台路由、导出、研判 API 与聊天渠道的操作按它判断可见性与权限

/** 组件的授权对象：组件所在的命名空间；没有组件时为集群级对象。 */
export function componentTarget(clusterId: string, key: string | null): Target {
  if (!key) {
    return { cluster: clusterId, namespace: null, labels: {} };
  }
  const k = parseStoredKey(key);
  return { cluster: clusterId, namespace: k.kind === NAMESPACE_KIND ? k.name : k.namespace, labels: {} };
}

/** 事件的授权对象：根因组件（没有时取第一个组件）所在的命名空间。 */
export function incidentTarget(inc: Pick<Incident, 'cluster_id' | 'root' | 'components'>): Target {
  return componentTarget(inc.cluster_id, inc.root.component ?? inc.components[0] ?? null);
}

export function visible(scopes: RoleBinding[] | 'all', t: Target): boolean {
  return scopes === 'all' || scopes.some((b) => scopeMatches(b, t));
}
