// 拓扑节点与组件的键（ADR 0034，contract/schemas/common.schema.json 的 ComponentKey）：
// 命名空间内的对象 <kind>:<namespace>/<名称段>，集群级对象 <kind>:<名称段>。
// 名称段由对象名的 UTF-8 字节得出：A–Z a–z 0–9 '-' '.' '_' 原样保留，其余每个字节写成 '%' 加两位大写十六进制。
// DNS 名称不变；含 ':'、'/'、空格或非 ASCII 字符的名称（例如 RBAC 对象）经编码后仍是唯一、可还原的键。
// 拓扑节点的 name 字段保留原始名称，只有 key、from、to 是编码后的形式。
import type { ComponentKey, EntityRef } from '@srenautix/contract';

export const NAMESPACE_KIND = 'Namespace';

/**
 * 集群级的 Kubernetes kind：键里没有 namespace。告警标签里的 namespace（例如节点告警带着抓取目标的命名空间）
 * 与静态 Pod 指向 Node 的 ownerReference 都不能把命名空间带进这些对象的键。
 */
export const CLUSTER_SCOPED_KINDS: ReadonlySet<string> = new Set([
  'Node',
  'Namespace',
  'PersistentVolume',
  'StorageClass',
  'ClusterRole',
  'ClusterRoleBinding',
  'CustomResourceDefinition',
  'PriorityClass',
  'IngressClass',
  'RuntimeClass',
  'CSIDriver',
  'CSINode',
  'VolumeAttachment',
  'APIService',
  'MutatingWebhookConfiguration',
  'ValidatingWebhookConfiguration',
  'ValidatingAdmissionPolicy',
  'ValidatingAdmissionPolicyBinding',
  'ClusterIssuer',
  'GatewayClass',
]);

/** 小写或简写的 Kubernetes kind（告警标签 entity_kind 等）→ 规范写法 */
const KIND_ALIASES: Record<string, string> = Object.fromEntries([
  ...[
    'Pod',
    'Node',
    'Namespace',
    'Service',
    'Endpoints',
    'ConfigMap',
    'Secret',
    'Deployment',
    'StatefulSet',
    'DaemonSet',
    'ReplicaSet',
    'Job',
    'CronJob',
    'Ingress',
    'PersistentVolume',
    'PersistentVolumeClaim',
    'HorizontalPodAutoscaler',
    'PodDisruptionBudget',
    'ServiceAccount',
    'Role',
    'RoleBinding',
    'StorageClass',
    // 领域包按这些 CRD 的 kind 声明组件类型（argocd、cert-manager）
    'Application',
    'Certificate',
    ...CLUSTER_SCOPED_KINDS,
  ].map((k) => [k.toLowerCase(), k]),
  ['pvc', 'PersistentVolumeClaim'],
  ['pv', 'PersistentVolume'],
  ['hpa', 'HorizontalPodAutoscaler'],
  ['pdb', 'PodDisruptionBudget'],
  ['ns', 'Namespace'],
  ['svc', 'Service'],
  ['deploy', 'Deployment'],
  ['sts', 'StatefulSet'],
  ['ds', 'DaemonSet'],
  ['rs', 'ReplicaSet'],
  ['cm', 'ConfigMap'],
  ['sa', 'ServiceAccount'],
]);

/**
 * kind 的规范写法：已知的 Kubernetes kind（不区分大小写，含常见简写）写成规范的大小写；
 * 其他值（领域包的自定义 kind，例如 postgres.cluster、provider）原样返回。
 */
export function canonicalKind(kind: string): string {
  return KIND_ALIASES[kind.toLowerCase()] ?? kind;
}

export function isClusterScoped(kind: string): boolean {
  return CLUSTER_SCOPED_KINDS.has(kind);
}

/** 对象键里的 namespace：集群级 kind 忽略给出的 namespace */
export function scopedNamespace(kind: string, namespace: string | null | undefined): string | null {
  return isClusterScoped(kind) ? null : (namespace ?? null);
}

/** 键的最大长度（按编码后的字节计） */
export const MAX_KEY_LENGTH = 400;

const KIND = /^[A-Za-z][A-Za-z0-9.-]*$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const UNRESERVED = /^[A-Za-z0-9._-]$/;
/** 孤立的代理项（String.prototype.isWellFormed 属于 ES2024，这里的目标是 ES2023） */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export class ComponentKeyError extends Error {
  override name = 'ComponentKeyError';
}

const fail = (msg: string) => new ComponentKeyError(msg);

/** 名称段的编码 */
export function encodeKeyName(name: string): string {
  if (!name) {
    throw fail('对象名为空');
  }
  if (LONE_SURROGATE.test(name)) {
    throw fail(`对象名不是合法的 Unicode（含孤立的代理项）：${JSON.stringify(name)}`);
  }
  let out = '';
  for (const b of Buffer.from(name, 'utf8')) {
    const c = String.fromCharCode(b);
    out += b < 0x80 && UNRESERVED.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** 名称段的解码：只接受规范编码（大写十六进制、不转义保留字符、完整的转义、合法的 UTF-8） */
export function decodeKeyName(segment: string): string {
  if (!segment) {
    throw fail('名称段为空');
  }
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string;
    if (c === '%') {
      const hex = segment.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) {
        throw fail(`名称段 ${segment} 的转义不合法：'%' 后必须是两位大写十六进制`);
      }
      const b = parseInt(hex, 16);
      if (b < 0x80 && UNRESERVED.test(String.fromCharCode(b))) {
        throw fail(`名称段 ${segment} 转义了不需要转义的字符 %${hex}`);
      }
      bytes.push(b);
      i += 2;
    } else if (UNRESERVED.test(c)) {
      bytes.push(c.charCodeAt(0));
    } else {
      throw fail(`名称段 ${segment} 中的 ${JSON.stringify(c)} 必须转义`);
    }
  }
  try {
    return utf8.decode(Uint8Array.from(bytes));
  } catch {
    throw fail(`名称段 ${segment} 解码后不是合法的 UTF-8`);
  }
}

export function nodeKey(kind: string, namespace: string | null | undefined, name: string): ComponentKey {
  if (!KIND.test(kind)) {
    throw fail(`节点键的 kind 不合法（以字母开头，只含字母、数字、'.' 与 '-'）：${JSON.stringify(kind)}`);
  }
  if (namespace && !DNS_LABEL.test(namespace)) {
    throw fail(`节点键的 namespace 不是 DNS 标签：${JSON.stringify(namespace)}`);
  }
  const key = namespace ? `${kind}:${namespace}/${encodeKeyName(name)}` : `${kind}:${encodeKeyName(name)}`;
  if (key.length > MAX_KEY_LENGTH) {
    throw fail(`节点键超过 ${MAX_KEY_LENGTH} 个字符：${key.slice(0, 80)}…`);
  }
  return key;
}

/** 对象不能构成合法的键（kind、namespace 或名称不合法，或超长）时返回 null，用于跳过这样的对象 */
export function tryNodeKey(kind: string, namespace: string | null | undefined, name: string): ComponentKey | null {
  try {
    return nodeKey(kind, namespace, name);
  } catch (e) {
    if (e instanceof ComponentKeyError) {
      return null;
    }
    throw e;
  }
}

/** 合法的键返回 true（与 nodeKey 相同的规则） */
export function isComponentKey(key: string): boolean {
  try {
    parseKey(key);
    return true;
  } catch {
    return false;
  }
}

export interface ParsedKey {
  kind: string;
  namespace: string | null;
  /** 原始对象名（已解码） */
  name: string;
}

export function parseKey(key: ComponentKey): ParsedKey {
  if (key.length > MAX_KEY_LENGTH) {
    throw fail(`节点键超过 ${MAX_KEY_LENGTH} 个字符`);
  }
  const i = key.indexOf(':');
  if (i < 0) {
    throw fail(`不是合法的节点键（缺少 ':'）：${key}`);
  }
  const kind = key.slice(0, i);
  if (!KIND.test(kind)) {
    throw fail(`节点键的 kind 不合法：${key}`);
  }
  const rest = key.slice(i + 1);
  const j = rest.indexOf('/');
  if (j < 0) {
    return { kind, namespace: null, name: decodeKeyName(rest) };
  }
  const namespace = rest.slice(0, j);
  if (!DNS_LABEL.test(namespace)) {
    throw fail(`节点键的 namespace 不是 DNS 标签：${key}`);
  }
  return { kind, namespace, name: decodeKeyName(rest.slice(j + 1)) };
}

/**
 * 给人看的组件名：名称段解码后的 <kind>:<namespace>/<原始名称>，例如
 * ClusterRole:cert-manager-controller-approve%3Acert-manager-io → ClusterRole:cert-manager-controller-approve:cert-manager-io。
 * 只用于展示；键本身（存储、比较、链接）始终是编码形式。不是规范编码的键原样返回。
 */
export function displayKey(key: string): string {
  try {
    const p = parseKey(key);
    return p.namespace ? `${p.kind}:${p.namespace}/${p.name}` : `${p.kind}:${p.name}`;
  } catch {
    return key;
  }
}

/**
 * 给人看的组件名（ADR 0101）：有领域包求出的可读名称时为"名称（组件键）"，例如"智元 API（provider:01a1…）"，
 * 否则为解码后的组件键。组件键本身不变，仍用于引用与回复解析。
 */
export function displayComponentName(key: string, names?: Readonly<Record<string, string | undefined>> | null): string {
  const shown = displayKey(key);
  const name = names?.[key];
  return name ? `${name}（${shown}）` : shown;
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
