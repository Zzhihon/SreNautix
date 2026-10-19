// 拓扑节点与组件的键：命名空间内的对象 <kind>:<namespace>/<name>，集群级对象 <kind>:<name>
import type { ComponentKey, EntityRef } from '@srenautix/contract';

export const NAMESPACE_KIND = 'Namespace';

export function nodeKey(kind: string, namespace: string | null | undefined, name: string): ComponentKey {
  if (!kind || !name) {
    throw new Error(`节点键缺少 kind 或 name：${kind}/${namespace ?? ''}/${name}`);
  }
  return namespace ? `${kind}:${namespace}/${name}` : `${kind}:${name}`;
}

export interface ParsedKey {
  kind: string;
  namespace: string | null;
  name: string;
}

export function parseKey(key: ComponentKey): ParsedKey {
  const i = key.indexOf(':');
  if (i <= 0) {
    throw new Error(`不是合法的节点键：${key}`);
  }
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  const j = rest.indexOf('/');
  return j < 0 ? { kind, namespace: null, name: rest } : { kind, namespace: rest.slice(0, j), name: rest.slice(j + 1) };
}

/** 命名空间伪组件：映射不到实体、只有 namespace 标签的告警归入这里（DESIGN §5） */
export function namespacePseudoKey(namespace: string): ComponentKey {
  return nodeKey(NAMESPACE_KIND, null, namespace);
}

export function isNamespacePseudo(key: ComponentKey): boolean {
  return key.startsWith(`${NAMESPACE_KIND}:`);
}

export function entityKey(e: Pick<EntityRef, 'kind' | 'namespace' | 'name'>): ComponentKey {
  return nodeKey(e.kind, e.namespace, e.name);
}
