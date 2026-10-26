import type { Alert, ComponentType, EvidenceResult, Incident, TopologyEdge } from '@srenautix/contract';
import { matchTypeByName, NAMESPACE_KIND, sameKind, tryNodeKey } from '@srenautix/core';
import { applicableRemediations, type PackSet, type RemediationContext } from '@srenautix/packs-sdk';
import type { AlertMatcher } from '../alerts/business-impact.js';
import { matchesLabels } from '../notify/external.js';
import {
  hintOf,
  isLogicalComponent,
  WORKLOAD_KINDS,
  type ConcreteObject,
  type LogicalHint,
} from '../topology/expand.js';
import { parseStoredKey } from '../topology/keys.js';
import type { DispositionFacts } from '../research/types.js';
import { FIX_CATEGORIES } from '../research/disposition.js';
import { businessImpactAlerts } from '../stage-a/report.js';
import { alertsOf, cardsOf, type AlertFacts } from './render.js';

// 处置推导的确定性依据（ADR 0138），server 写进研判输入，重建评测写进快照：
// - external：候选根因中组件类型声明为集群外部（external）的组件；
// - declared：候选根因中由 GitOps 仓库声明的运行中组件（ADR 0162）：展开后的对象沿 owned_by 的顶层属主由 GitOps 应用管理
//   （managed_by）。修改仓库中的声明就能处置它们；管理着候选根因的 GitOps 应用与逻辑组件不在其中；
// - remediations：每个候选根因上适用的修复模板，按"研判以它为根因、结论 likely、处置 act"求值，
//   只保留启用的类别中能消除根因的两类（release_rollback、config_resource）；
// - business_impact：触发中的业务影响告警（notify.business_impact_alerts，ADR 0163、0166），这些告警在、并且有异常卡时
//   处置不能是 ignore。
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
  /** 每个根因自己的卡与顶层属主的管理应用（RootCardScope） */
  scope: Pick<RootCardScope, 'cards' | 'resolve'>;
  /** 成员告警的拓扑事实（alertFacts） */
  alertFacts: ReadonlyMap<string, AlertFacts>;
  /** 业务影响告警（ADR 0163、0166）；为空时 business_impact 为空 */
  impactAlerts: readonly AlertMatcher[];
}

export interface RootLookup {
  /** 组件键 → 拓扑里的具体对象（ComponentExpander.concrete） */
  concrete: (clusterId: string, key: string, at: Date, hints: readonly LogicalHint[]) => Promise<ConcreteObject>;
  componentType: (clusterId: string, key: string) => Promise<string | null>;
  componentTypes: () => readonly ComponentType[];
  /** 组件键沿 owned_by 的顶层属主（TopologyStore.ownerOf）；没有属主时为 null */
  owner: (clusterId: string, key: string, at: Date) => Promise<string | null>;
  /** 管理这个对象的 GitOps 应用（managed_by 边的另一端） */
  managers: (clusterId: string, key: string, at: Date) => Promise<string[]>;
}

/**
 * 根因自己的卡（ADR 0139）：修复模板的 root_cards。一张卡属于根因，当它的实体沿 owned_by 的顶层属主
 * - 就是根因（展开后的对象）：根因本身、它拥有的 ReplicaSet 与 Pod；
 * - 由根因管理（managed_by 指向根因）：根因是 Argo 或 Flux 应用时，它管理的工作负载及其 Pod；
 * - 管理根因：根因的 GitOps 应用本身的卡（不含这个应用管理的其他对象）；
 * - 根因是逻辑组件（没有拓扑上的属主与成员，ADR 0104 §6）时，是事件组件中的工作负载：与发布回退模板取正在服务的版本
 *   的实体相同。
 * 实体为空或不是合法组件键的卡不属于任何根因。属主与管理应用按键缓存，一个实例只用于一个事件与时刻。
 */
export class RootCardScope {
  private readonly tops = new Map<string, Promise<{ top: string; managers: string[] }>>();

  constructor(
    private readonly d: Pick<RootLookup, 'owner' | 'managers'>,
    private readonly incident: Pick<Incident, 'cluster_id' | 'components'>,
    private readonly at: Date,
  ) {}

  /** 组件键沿 owned_by 的顶层属主，以及管理这个属主的 GitOps 应用（managed_by） */
  resolve(key: string): Promise<{ top: string; managers: string[] }> {
    let p = this.tops.get(key);
    if (!p) {
      p = (async () => {
        const top = (await this.d.owner(this.incident.cluster_id, key, this.at)) ?? key;
        return { top, managers: await this.d.managers(this.incident.cluster_id, top, this.at) };
      })();
      this.tops.set(key, p);
    }
    return p;
  }

  async cards(root: RemediationContext['root'], cards: readonly EvidenceResult[]): Promise<EvidenceResult[]> {
    const rootKey = root ? tryNodeKey(root.kind, root.namespace, root.name) : null;
    if (!rootKey) {
      return [];
    }
    const r = await this.resolve(rootKey);
    const members = new Set<string>();
    if (isLogicalComponent(rootKey)) {
      for (const k of this.incident.components) {
        if (WORKLOAD_KINDS.includes(parseStoredKey(k).kind)) {
          members.add((await this.resolve(k)).top);
        }
      }
    }
    const out: EvidenceResult[] = [];
    for (const c of cards) {
      const key = c.entity ? tryNodeKey(c.entity.kind, c.entity.namespace, c.entity.name) : null;
      if (!key) {
        continue;
      }
      const e = await this.resolve(key);
      if (e.top === r.top || e.managers.includes(r.top) || r.managers.includes(e.top) || members.has(e.top)) {
        out.push(c);
      }
    }
    return out;
  }
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
    // 组件类型声明在集群之外（ADR 0138）：告警调优模板不对外部上游的告警降级（ADR 0139）
    external: type !== null && d.componentTypes().some((t) => t.id === type && t.external === true),
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

/**
 * 另外按外部上游处理的告警（ADR 0147 的 notify.digest.external_roots）：归属组件在 components 里，或标签满足
 * alertLabels。组件类型声明为 external 的告警不需要配置
 */
export interface ExternalAlertSettings {
  components: readonly string[];
  alertLabels: Readonly<Record<string, readonly string[]>>;
}

export const NO_EXTERNAL_ALERTS: ExternalAlertSettings = { components: [], alertLabels: {} };

/**
 * 成员告警的拓扑事实（ADR 0155），按 alert_id：
 * - component_object：归属组件对应的具体对象（ComponentExpander.concrete）。组件是对象时就是它（Pod 取顶层属主），
 *   逻辑组件只映射出一个工作负载时是这个工作负载；逻辑组件没有映射出对象、或只归入命名空间伪组件时为 null；
 * - external：归属组件或实体的组件类型声明在集群之外（拓扑节点上的类型，节点不在拓扑里时按 kind 与名字匹配），
 *   或命中外部上游的配置。
 */
export async function alertFacts(
  d: Pick<RootLookup, 'concrete' | 'componentType' | 'componentTypes'>,
  inc: Pick<Incident, 'cluster_id'>,
  alerts: readonly Alert[],
  at: Date,
  ext: ExternalAlertSettings,
): Promise<Map<string, AlertFacts>> {
  const types = d.componentTypes();
  const externalTypes = new Set(types.filter((t) => t.external === true).map((t) => t.id));
  const typeIsExternal = async (key: string): Promise<boolean> => {
    if (!externalTypes.size) {
      return false;
    }
    const k = parseStoredKey(key);
    const id = (await d.componentType(inc.cluster_id, key)) ?? matchTypeByName(k.kind, k.namespace, k.name, types)?.id;
    return id !== undefined && id !== null && externalTypes.has(id);
  };
  const out = new Map<string, AlertFacts>();
  for (const a of alerts) {
    const component = a.component ?? null;
    let object: string | null = null;
    if (component) {
      const o = await d.concrete(inc.cluster_id, component, at, [hintOf(a.labels)]);
      object = isLogicalComponent(o.key) || o.kind === NAMESPACE_KIND ? null : o.key;
    }
    const entityKey = a.entity ? tryNodeKey(a.entity.kind, a.entity.namespace, a.entity.name) : null;
    const external =
      (component !== null && ext.components.includes(component)) ||
      matchesLabels(a.labels, ext.alertLabels) ||
      (component !== null && (await typeIsExternal(component))) ||
      (entityKey !== null && entityKey !== component && (await typeIsExternal(entityKey)));
    out.set(a.alert_id, { component_object: object, external });
  }
  return out;
}

/** 模板匹配的上下文（与 RemediationService.context 相同的字段）；rootCards 是 RootCardScope 选出的根因自己的卡 */
export function remediationContext(
  incident: Incident,
  alerts: Alert[],
  cards: EvidenceResult[],
  root: RemediationContext['root'],
  research: { disposition: string; level: string } | null,
  rootCards: readonly EvidenceResult[],
  facts: ReadonlyMap<string, AlertFacts>,
): RemediationContext {
  return {
    incident: incident as unknown as Record<string, unknown>,
    root,
    cards: cardsOf(cards),
    root_cards: cardsOf([...rootCards]),
    alerts: alertsOf(alerts, facts),
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
  const declared: string[] = [];
  const out: DispositionFacts = {
    external: [],
    declared,
    business_impact: businessImpactAlerts(i.incident, i.alerts, i.impactAlerts),
    remediations: [],
  };
  const keys = [...new Set(i.roots)].slice(0, MAX_FACT_ROOTS);
  const roots = new Map<string, RemediationContext['root']>();
  // 展开后对象沿 owned_by 的顶层属主与管理它的 GitOps 应用（managed_by）
  const tops = new Map<string, { top: string; managers: string[] }>();
  for (const key of keys) {
    const root = await i.resolve(key);
    roots.set(key, root);
    const concrete = root ? tryNodeKey(root.kind, root.namespace, root.name) : null;
    if (concrete) {
      tops.set(key, await i.scope.resolve(concrete));
    }
  }
  // 管理着候选根因的 GitOps 应用是变更的载体，排除在外（应用的应用管理它时也一样）
  // 拓扑与事件根因的写法可能不同（Application.argoproj.io 与 application），按同一个对象比较
  const apps = [...new Set([...tops.values()].flatMap((t) => t.managers))].map(parseStoredKey);
  const isApp = (key: string) => {
    const k = parseStoredKey(key);
    return apps.some((a) => sameKind(a.kind, k.kind) && a.namespace === k.namespace && a.name === k.name);
  };
  for (const key of keys) {
    const root = roots.get(key) ?? null;
    if (root?.component_type && external.has(root.component_type)) {
      out.external.push(key);
    }
    const t = tops.get(key);
    // 组件键本身是 GitOps 应用时也排除：事件根因是应用时，展开后的对象是事件里的一个工作负载（根因实体）
    if (t && t.managers.length > 0 && !isApp(t.top) && !isApp(key) && !isLogicalComponent(key)) {
      declared.push(key);
    }
    if (!enabled.size || !root) {
      continue;
    }
    const ctx = remediationContext(
      i.incident,
      i.alerts,
      i.cards,
      root,
      { disposition: 'act', level: 'likely' },
      await i.scope.cards(root, i.cards),
      i.alertFacts,
    );
    const templates = matchTemplates(i.set, ctx).filter((t) => enabled.has(t.category));
    if (templates.length) {
      out.remediations.push({ root: key, templates });
    }
  }
  return out;
}
