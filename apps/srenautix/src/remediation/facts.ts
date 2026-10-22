import type { Alert, ComponentType, EvidenceResult, Incident, TopologyEdge } from '@srenautix/contract';
import { matchTypeByName } from '@srenautix/core';
import { applicableRemediations, type PackSet, type RemediationContext } from '@srenautix/packs-sdk';
import { hintOf, type ConcreteObject, type LogicalHint } from '../topology/expand.js';
import type { DispositionFacts } from '../research/types.js';
import { FIX_CATEGORIES } from '../research/disposition.js';
import { alertsOf, cardsOf } from './render.js';

// 处置推导的确定性依据（ADR 0138），server 写进研判输入，重建评测写进快照：
// - external：候选根因中组件类型声明为集群外部（external）的组件；
// - remediations：每个候选根因上适用的修复模板，按"研判以它为根因、结论 likely、处置 act"求值，
//   只保留启用的类别中能消除根因的两类（release_rollback、config_resource）。
// 模板匹配的上下文与自愈 PR（remediation/service.ts）相同：事件、根因展开后的具体对象、阶段 A 的卡与成员告警。

/** 一次研判输入最多为这么多个候选根因求值修复模板 */
export const MAX_FACT_ROOTS = 40;

/** 组件键 → 模板上下文里的根因（展开到具体对象，带组件类型） */
export type RootResolver = (key: string) => Promise<RemediationContext['root']>;

export interface FactsInput {
  set: Pick<PackSet, 'remediations'>;
  componentTypes: readonly ComponentType[];
  /** 启用的修复类别（remediation.categories）；没有启用自愈 PR 时为空 */
  categories: readonly string[];
  incident: Incident;
  alerts: Alert[];
  cards: EvidenceResult[];
  /** 候选根因，按优先顺序（超过 MAX_FACT_ROOTS 的不求值） */
  roots: readonly string[];
  resolve: RootResolver;
}

export interface RootLookup {
  /** 组件键 → 拓扑里的具体对象（ComponentExpander.concrete） */
  concrete: (clusterId: string, key: string, at: Date, hints: readonly LogicalHint[]) => Promise<ConcreteObject>;
  componentType: (clusterId: string, key: string) => Promise<string | null>;
  componentTypes: () => readonly ComponentType[];
}

/**
 * 修复模板的根因（ADR 0126、0130）：组件键展开到具体对象——Pod 取属主工作负载，Service 取它选中的唯一工作负载，
 * 逻辑组件取映射出的唯一工作负载（线索是落在它上面的告警的 service 与 namespace 标签）；组件类型先查拓扑，再按名字匹配
 */
export async function remediationRoot(
  d: RootLookup,
  inc: Incident,
  alerts: readonly Alert[],
  key: string,
  at: Date,
): Promise<NonNullable<RemediationContext['root']>> {
  const hints = alerts.filter((a) => a.component === key).map((a) => hintOf(a.labels));
  const o = await d.concrete(inc.cluster_id, key, at, hints);
  const e =
    o.key === inc.root.component && inc.root.entity
      ? inc.root.entity
      : { cluster_id: inc.cluster_id, kind: o.kind, namespace: o.namespace, name: o.name };
  const type =
    (await d.componentType(inc.cluster_id, o.key)) ??
    matchTypeByName(e.kind, e.namespace, e.name, d.componentTypes())?.id ??
    null;
  return {
    cluster_id: e.cluster_id,
    kind: e.kind,
    namespace: e.namespace,
    name: e.name,
    node: e.kind === 'Node' ? e.name : null,
    component_type: type,
  };
}

/**
 * 处置依据求值的候选根因（ADR 0138）：事件根因、候选根因、事件组件、逻辑组件映射出的对象，再是邻域里不由控制器拥有的
 * 对象（Pod、ReplicaSet 由属主代表），按这个顺序去重
 */
export function factRoots(
  incident: Incident,
  topo: { nodes: readonly { key: string }[]; edges: readonly TopologyEdge[] },
): string[] {
  const owned = new Set(topo.edges.filter((e) => e.relation === 'owned_by').map((e) => e.from));
  return [
    ...new Set([
      ...(incident.root.component ? [incident.root.component] : []),
      ...incident.candidates.map((c) => c.component),
      ...incident.components,
      ...topo.edges.filter((e) => e.relation === 'maps_to').map((e) => e.to),
      ...topo.nodes.map((n) => n.key).filter((k) => !owned.has(k)),
    ]),
  ];
}

/** 模板匹配的上下文（与 RemediationService.context 相同的字段） */
export function remediationContext(
  incident: Incident,
  alerts: Alert[],
  cards: EvidenceResult[],
  root: RemediationContext['root'],
  research: { disposition: string; level: string } | null,
): RemediationContext {
  return {
    incident: incident as unknown as Record<string, unknown>,
    root,
    cards: cardsOf(cards),
    alerts: alertsOf(alerts),
    research,
  };
}

/** 适用的模板（不限类别）；条件求值出错的模板不适用 */
export function matchTemplates(
  set: Pick<PackSet, 'remediations'>,
  ctx: RemediationContext,
): Array<{ key: string; category: string }> {
  return applicableRemediations(set as PackSet, ctx).applicable.map((a) => ({ key: a.key, category: a.category }));
}

export async function dispositionFacts(i: FactsInput): Promise<DispositionFacts> {
  const external = new Set(i.componentTypes.filter((t) => t.external === true).map((t) => t.id));
  const enabled = new Set(i.categories.filter((c) => FIX_CATEGORIES.has(c)));
  const out: DispositionFacts = { external: [], remediations: [] };
  for (const key of [...new Set(i.roots)].slice(0, MAX_FACT_ROOTS)) {
    const root = await i.resolve(key);
    if (root?.component_type && external.has(root.component_type)) {
      out.external.push(key);
    }
    if (!enabled.size || !root) {
      continue;
    }
    const ctx = remediationContext(i.incident, i.alerts, i.cards, root, { disposition: 'act', level: 'likely' });
    const templates = matchTemplates(i.set, ctx).filter((t) => enabled.has(t.category));
    if (templates.length) {
      out.remediations.push({ root: key, templates });
    }
  }
  return out;
}
