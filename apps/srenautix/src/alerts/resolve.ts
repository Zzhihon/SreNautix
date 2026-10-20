import type { AlertCatalogEntry, AlertClassification, EntityRef } from '@srenautix/contract';
import {
  alertEntityCandidate,
  classifyAlert,
  isComponentKey,
  NAMESPACE_KIND,
  tryNodeKey,
  type AlertCatalog,
} from '@srenautix/core';
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

/**
 * 告警标签 → 实体候选（packages/core 的 alertEntityCandidate）：标签契约（entity、entity_kind）→ 目录条目的映射 →
 * 按标签推断（pod、deployment、node、kubernetes_node、节点级抓取任务的 instance 等）。kind 统一成规范写法（node → Node），
 * 集群级对象忽略 namespace 标签；领域包的自定义 kind（provider、cluster 等）原样保留，并保留 namespace。
 */
function candidateOf(
  clusterId: string,
  labels: Record<string, string>,
  entry: AlertCatalogEntry | undefined,
): {
  entity: { kind: string; namespace: string | null; name: string } | null;
  source: 'labels' | 'catalog' | 'heuristic';
} {
  const c = alertEntityCandidate(labels, entry, clusterId);
  if (!c.entity) {
    return { entity: null, source: 'heuristic' };
  }
  return {
    entity: { kind: c.entity.kind, namespace: c.entity.namespace, name: c.entity.name },
    source: c.fromLabels ? 'labels' : entry ? 'catalog' : 'heuristic',
  };
}

/** 组件键（ADR 0034：名称段编码）；标签里的对象不能构成合法的键时为 null */
export function componentKeyOf(kind: string, namespace: string | null, name: string): string | null {
  return tryNodeKey(kind, namespace, name);
}

/** 分类（DESIGN §3.2）与实体解析（§3.3）：标签契约 → informer 缓存 → 24 小时墓碑 → kube-state-metrics 历史。 */
export async function resolveAlert(clusterId: string, a: RawAlert, deps: ResolveDeps): Promise<Resolved> {
  const hit = deps.catalog.lookup(a.labels);
  const { entity: mapped, source } = candidateOf(clusterId, a.labels, hit?.entry);
  let entity: EntityRef | null = null;
  let resolution: Resolved['entityResolution'] = 'unresolved';
  let component: string | null = null;
  if (mapped) {
    const node = await deps.nodes.find(clusterId, mapped.kind, mapped.namespace, mapped.name, a.startsAt);
    if (node) {
      // 拓扑里的 kind 可能带 API 组（告警写 application，拓扑是 Application.argoproj.io）：实体取拓扑的 kind
      const kind = node.key.slice(0, node.key.indexOf(':'));
      entity = { cluster_id: clusterId, ...mapped, kind: kind || mapped.kind, uid: node.uid };
      resolution = source === 'labels' ? 'labels' : node.tombstone ? 'tombstone' : 'informer';
      component = node.key;
    } else if (deps.ksm && mapped.kind === 'Pod' && mapped.namespace) {
      const p = await deps.ksm.podByName(clusterId, mapped.namespace, mapped.name, a.startsAt);
      if (p) {
        entity = { cluster_id: clusterId, ...mapped, uid: p.uid };
        resolution = 'ksm_history';
        component = componentKeyOf('Pod', mapped.namespace, mapped.name);
      }
    }
    // 标签契约与目录映射给出的实体即使拓扑里没有（领域包的自定义 kind、CRD 对象、已删除超过 24 小时的对象）也保留，
    // 按实体的 kind 执行证据卡（ADR 0097）；只按标签推断出的实体必须在拓扑中找到
    if (!entity && source !== 'heuristic') {
      const key = componentKeyOf(mapped.kind, mapped.namespace, mapped.name);
      if (key) {
        entity = { cluster_id: clusterId, ...mapped, uid: null };
        resolution = 'labels';
        component = key;
      }
    }
  }
  if (a.labels.component && isComponentKey(a.labels.component)) {
    component = a.labels.component;
  }
  // 拓扑覆盖由人工在 Git 中给出，优先于领域包与标签的映射；告警自带的 role 标签仍然优先于覆盖的角色
  const ov = deps.override?.(clusterId, a.labels) ?? null;
  if (ov) {
    component = ov.component;
  }
  if (!component && a.labels.namespace) {
    // 未映射的告警归入命名空间伪组件，不丢弃（DESIGN §5）
    component = tryNodeKey(NAMESPACE_KIND, null, a.labels.namespace);
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
