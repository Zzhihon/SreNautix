import type { AlertCatalogEntry, AlertClassification, EntityRef } from '@srenautix/contract';
import { classifyAlert, type AlertCatalog } from '@srenautix/core';
import type { RawAlert } from '../ingest/normalize.js';

/** 拓扑节点查找（由 topology/store 提供）：按 kind/namespace/name 取当前节点或 24 小时内的墓碑。 */
export interface NodeLookup {
  find(
    clusterId: string,
    kind: string,
    namespace: string | null,
    name: string,
    at: Date,
  ): Promise<{ key: string; uid: string | null; tombstone: boolean } | null>;
}

/** kube-state-metrics 历史（DESIGN §3.3 第三层）：Pod IP 或名称 → Pod 与节点。 */
export interface KsmHistory {
  podByName(clusterId: string, namespace: string, name: string, at: Date): Promise<{ uid: string | null } | null>;
}

export interface Resolved {
  classification: AlertClassification;
  entity: EntityRef | null;
  entityResolution: 'labels' | 'informer' | 'tombstone' | 'ksm_history' | 'unresolved';
  component: string | null;
  chains: string[];
}

export interface ResolveDeps {
  catalog: AlertCatalog;
  nodes: NodeLookup;
  ksm: KsmHistory | null;
  /** 规则表达式（rules API）；拿不到为 undefined。 */
  ruleExpr(alertname: string): string | undefined;
  /** 长期告警：告警名 × 实体在 7 天内的触发比例超过阈值。 */
  chronic(alertname: string, entityKey: string | null): boolean;
  /** 拓扑覆盖（Git 中的覆盖文件）：命中时给出组件与角色，优先于领域包的映射。 */
  override?(
    clusterId: string,
    labels: Record<string, string>,
  ): { component: string; role: AlertClassification['role']; ref: string } | null;
}

const NODE_INSTANCE_PORT = /:\d+$/;

/** 按目录条目的实体映射取 (kind, namespace, name)。 */
export function entityFromMapping(
  entry: AlertCatalogEntry,
  labels: Record<string, string>,
): { kind: string; namespace: string | null; name: string } | null {
  const m = entry.entity;
  if (m.kind === 'cluster') {
    return null;
  }
  let name: string | undefined;
  for (const l of m.name_labels) {
    if (labels[l]) {
      name = labels[l];
      break;
    }
  }
  if (!name) {
    return null;
  }
  if (m.kind === 'Node') {
    name = name.replace(NODE_INSTANCE_PORT, '');
    return { kind: 'Node', namespace: null, name };
  }
  return { kind: m.kind, namespace: labels[m.namespace_label ?? 'namespace'] ?? null, name };
}

/** 告警自带标签契约（component、entity_kind、entity）时直接使用。 */
function entityFromContractLabels(
  labels: Record<string, string>,
): { kind: string; namespace: string | null; name: string } | null {
  if (!labels.entity || !labels.entity_kind) {
    return null;
  }
  return { kind: labels.entity_kind, namespace: labels.namespace ?? null, name: labels.entity };
}

export function componentKeyOf(kind: string, namespace: string | null, name: string): string {
  return namespace ? `${kind}:${namespace}/${name}` : `${kind}:${name}`;
}

/** 分类（DESIGN §3.2）与实体解析（§3.3）：标签契约 → informer 缓存 → 24 小时墓碑 → kube-state-metrics 历史。 */
export async function resolveAlert(clusterId: string, a: RawAlert, deps: ResolveDeps): Promise<Resolved> {
  const hit = deps.catalog.lookup(a.labels);
  const labelEntity = entityFromContractLabels(a.labels);
  const mapped = labelEntity ?? (hit ? entityFromMapping(hit.entry, a.labels) : null);
  let entity: EntityRef | null = null;
  let resolution: Resolved['entityResolution'] = 'unresolved';
  let component: string | null = null;
  if (mapped) {
    const node = await deps.nodes.find(clusterId, mapped.kind, mapped.namespace, mapped.name, a.startsAt);
    if (node) {
      entity = {
        cluster_id: clusterId,
        kind: mapped.kind,
        namespace: mapped.namespace,
        name: mapped.name,
        uid: node.uid,
      };
      resolution = labelEntity ? 'labels' : node.tombstone ? 'tombstone' : 'informer';
      component = node.key;
    } else if (deps.ksm && mapped.kind === 'Pod' && mapped.namespace) {
      const p = await deps.ksm.podByName(clusterId, mapped.namespace, mapped.name, a.startsAt);
      if (p) {
        entity = { cluster_id: clusterId, kind: 'Pod', namespace: mapped.namespace, name: mapped.name, uid: p.uid };
        resolution = 'ksm_history';
        component = componentKeyOf('Pod', mapped.namespace, mapped.name);
      }
    }
    if (!entity && labelEntity) {
      entity = { cluster_id: clusterId, kind: mapped.kind, namespace: mapped.namespace, name: mapped.name, uid: null };
      resolution = 'labels';
      component = componentKeyOf(mapped.kind, mapped.namespace, mapped.name);
    }
  }
  if (a.labels.component && /^[A-Za-z][A-Za-z0-9.-]*:/.test(a.labels.component)) {
    component = a.labels.component;
  }
  // 拓扑覆盖由人工在 Git 中给出，优先于领域包与标签的映射；告警自带的 role 标签仍然优先于覆盖的角色
  const ov = deps.override?.(clusterId, a.labels) ?? null;
  if (ov) {
    component = ov.component;
  }
  if (!component && a.labels.namespace) {
    // 未映射的告警归入命名空间伪组件，不丢弃（DESIGN §5）
    component = `Namespace:${a.labels.namespace}`;
  }
  if (ov && a.labels.role === undefined) {
    return {
      classification: {
        role: ov.role,
        source: 'catalog',
        confidence: 1,
        catalog_entry: `topology-overrides/${ov.ref}`,
        chronic: deps.chronic(a.alertname, component),
      },
      entity,
      entityResolution: resolution,
      component,
      chains: hit?.entry.chains ?? [],
    };
  }
  const classification = classifyAlert(
    { labels: a.labels, ruleExpr: deps.ruleExpr(a.alertname), chronic: deps.chronic(a.alertname, component) },
    deps.catalog,
  );
  return { classification, entity, entityResolution: resolution, component, chains: hit?.entry.chains ?? [] };
}
