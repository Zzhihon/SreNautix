// 业务领域与服务（契约 2.53.0，ADR 0193）：business.yaml 编译成的服务目录与一条告警的服务归属，以及组件类型与服务成员
// 共用的匹配条件（ComponentMatch）。只依赖契约：server 与部署方的领域包工具都用它。
import type {
  BusinessDomain,
  BusinessDomainId,
  BusinessTier,
  ComponentMatch,
  ComponentType,
  Labels,
  LocalizedText,
  ServiceId,
  ServiceSource,
} from '@srenautix/contract';

/**
 * 两个 kind 是否是同一种对象：不区分大小写，忽略 API 组（application、Application 与 Application.argoproj.io 相同）。
 * 领域包按不带组的 kind 声明（组件类型、卡片的 applies_to），拓扑与解析后的实体带组。
 */
export function sameKind(a: string, b: string): boolean {
  const k = (x: string) => x.split('.')[0]!.toLowerCase();
  return k(a) === k(b);
}

/** 匹配条件的个数：同时命中一个对象时，条件多（更具体）的优先 */
export function matchSpecificity(m: ComponentMatch): number {
  return (
    Object.keys(m.labels ?? {}).length +
    (m.name_pattern === undefined ? 0 : 1) +
    (m.namespaces === undefined ? 0 : 1) +
    (m.api_group === undefined ? 0 : 1)
  );
}

/**
 * 只凭 kind、命名空间与名称核对一条匹配条件：不命中时为 null，命中时为实际核对过的条件个数（按名称匹配的具体度）。
 * 带 labels 约束的条件无法核对，不命中。api_group 只在 kind 带 API 组时核对；kind 不带组时 api_group 没有核对，
 * 不计入具体度：否则 Cluster（api_group postgresql.cnpg.io）与部署方按名称写的 cluster:dragonfly 一样具体，
 * 先声明的内置类型就会抢走部署方的类型。
 */
export function byNameSpecificity(
  m: ComponentMatch,
  kind: string,
  namespace: string | null,
  name: string,
): number | null {
  // 实体的 kind 可能带 API 组（Application.argoproj.io），条件按不带组的 kind 声明
  const group = kind.includes('.') ? kind.slice(kind.indexOf('.') + 1) : null;
  const ok =
    sameKind(m.kind, kind) &&
    (m.api_group === undefined || group === null || group === m.api_group) &&
    Object.keys(m.labels ?? {}).length === 0 &&
    (m.name_pattern === undefined || new RegExp(m.name_pattern).test(name)) &&
    (m.namespaces === undefined || m.namespaces.includes(namespace ?? ''));
  if (!ok) {
    return null;
  }
  return matchSpecificity(m) - (m.api_group !== undefined && group === null ? 1 : 0);
}

export function matchesByName(m: ComponentMatch, kind: string, namespace: string | null, name: string): boolean {
  return byNameSpecificity(m, kind, namespace, name) !== null;
}

/** 告警规则用这个标签指定服务，优先于其他全部来源 */
export const SERVICE_LABEL = 'srenautix_service';

export interface ServiceInfo {
  id: ServiceId;
  title: LocalizedText;
  business_domain: BusinessDomainId;
  business_domain_title: LocalizedText;
  tier: BusinessTier;
  /** 声明它的包 */
  pack: string;
}

/** 一个对象与它的组件类型（求不出时为 null） */
export interface TypedObject {
  kind: string;
  namespace: string | null;
  name: string;
  componentType: string | null;
}

interface Member {
  service: ServiceId;
  /** 声明顺序：具体度与写法都相同时取小的 */
  order: number;
  /** 直接写出的 match：同样具体时优先于组件类型引用，因为它是为区分这个服务写的 */
  explicit: boolean;
  /** 不命中时为 null，命中时为这个对象上的具体度 */
  specificity(o: TypedObject): number | null;
}

/** 服务目录的声明错误：重复的服务 id、业务领域的 title 或 tier 缺失或不一致、引用不存在的组件类型、重复的默认命名空间 */
export class ServiceCatalogError extends Error {
  constructor(
    readonly pack: string,
    message: string,
  ) {
    super(message);
  }
}

/** 全部启用的包声明的业务领域与服务。包按加载顺序传入 */
export class ServiceCatalog {
  private readonly byId = new Map<ServiceId, ServiceInfo>();
  private readonly members: Member[] = [];
  private readonly namespaceDefault = new Map<string, ServiceId>();
  private readonly declared: Array<{ pack: string; domains: readonly BusinessDomain[] }>;

  constructor(
    packs: ReadonlyArray<{ pack: string; domains: readonly BusinessDomain[] }>,
    types: readonly ComponentType[],
  ) {
    this.declared = packs.map((p) => ({ pack: p.pack, domains: p.domains }));
    const typeById = new Map(types.map((t) => [t.id, t]));
    // 同一 id 的业务领域在几个包中声明时合并（与 ADR 0146 的领域相同）：title、tier 给出多处时必须相同
    const heads = new Map<BusinessDomainId, { title?: LocalizedText; tier?: BusinessTier; pack: string }>();
    for (const { pack, domains } of packs) {
      for (const d of domains) {
        const head = heads.get(d.id) ?? { pack };
        for (const k of ['title', 'tier'] as const) {
          if (d[k] === undefined) {
            continue;
          }
          if (head[k] !== undefined && JSON.stringify(head[k]) !== JSON.stringify(d[k])) {
            throw new ServiceCatalogError(pack, `业务领域 ${d.id} 的 ${k} 与 ${head.pack} 中的声明不同`);
          }
          (head as Record<string, unknown>)[k] = d[k];
        }
        heads.set(d.id, head);
      }
    }
    for (const [id, head] of heads) {
      if (head.title === undefined || head.tier === undefined) {
        throw new ServiceCatalogError(
          head.pack,
          `业务领域 ${id} 在任何包中都没有给出 ${head.title === undefined ? 'title' : 'tier'}`,
        );
      }
    }
    for (const { pack, domains } of packs) {
      for (const d of domains) {
        const head = heads.get(d.id)!;
        for (const s of d.services) {
          if (this.byId.has(s.id)) {
            throw new ServiceCatalogError(pack, `服务 ${s.id} 重复声明`);
          }
          this.byId.set(s.id, {
            id: s.id,
            title: s.title,
            business_domain: d.id,
            business_domain_title: head.title!,
            tier: head.tier!,
            pack,
          });
          for (const m of s.members) {
            if ('component_type' in m) {
              const t = typeById.get(m.component_type);
              if (!t) {
                throw new ServiceCatalogError(pack, `服务 ${s.id} 引用了不存在的组件类型 ${m.component_type}`);
              }
              const specificity = matchSpecificity(t.match);
              this.members.push({
                service: s.id,
                order: this.members.length,
                explicit: false,
                specificity: (o) => (o.componentType === t.id ? specificity : null),
              });
            } else {
              const match: ComponentMatch = m.match;
              this.members.push({
                service: s.id,
                order: this.members.length,
                explicit: true,
                specificity: (o) => byNameSpecificity(match, o.kind, o.namespace, o.name),
              });
            }
          }
          for (const ns of s.namespaces ?? []) {
            const prev = this.namespaceDefault.get(ns);
            if (prev !== undefined) {
              throw new ServiceCatalogError(pack, `命名空间 ${ns} 已经是服务 ${prev} 的默认命名空间`);
            }
            this.namespaceDefault.set(ns, s.id);
          }
        }
      }
    }
  }

  service(id: string): ServiceInfo | undefined {
    return this.byId.get(id);
  }

  /** 全部服务，按领域与服务的声明顺序 */
  services(): ServiceInfo[] {
    return [...this.byId.values()];
  }

  /**
   * 对象命中的最具体的成员的服务：先比具体度，同样具体时 match 优先于组件类型引用，再取先声明的；都不命中时为 null
   */
  ofObject(o: TypedObject): ServiceId | null {
    let best: { member: Member; specificity: number } | undefined;
    for (const member of this.members) {
      const specificity = member.specificity(o);
      if (
        specificity !== null &&
        (!best ||
          specificity > best.specificity ||
          (specificity === best.specificity && member.explicit && !best.member.explicit))
      ) {
        best = { member, specificity };
      }
    }
    return best?.member.service ?? null;
  }

  /** 以这个命名空间为默认命名空间的服务 */
  ofNamespace(namespace: string | null): ServiceId | null {
    return namespace === null ? null : (this.namespaceDefault.get(namespace) ?? null);
  }

  /** 服务归属的声明输入（ADR 0193 §5），并入归类输入的指纹 */
  inputs(): Array<{ pack: string; domains: readonly BusinessDomain[] }> {
    return this.declared;
  }
}

export interface ServiceResolution {
  service: ServiceId | null;
  service_source: ServiceSource;
  business_domain: BusinessDomainId | null;
}

export interface ServiceInput {
  labels: Labels;
  /** 命中的告警目录条目声明的 service */
  catalogService?: string;
  namespace: string | null;
  /** 告警归属的组件、告警实体、实体的顶层属主；只在前面的来源都没有给出服务时才求，求不出时为 null */
  component: () => Promise<TypedObject | null>;
  entity: () => Promise<TypedObject | null>;
  owner: () => Promise<TypedObject | null>;
  /** srenautix_service 标签的取值不是已声明的服务时调用（标签被忽略） */
  onInvalidLabel?: (value: string) => void;
}

/** 一条告警的服务（ADR 0193 §3）：按来源的优先级取第一个给出服务的 */
export async function resolveService(input: ServiceInput, catalog: ServiceCatalog): Promise<ServiceResolution> {
  const found = (service: ServiceId, source: ServiceSource): ServiceResolution => ({
    service,
    service_source: source,
    business_domain: catalog.service(service)!.business_domain,
  });
  const label = input.labels[SERVICE_LABEL];
  if (label !== undefined) {
    if (catalog.service(label)) {
      return found(label, 'label');
    }
    input.onInvalidLabel?.(label);
  }
  if (input.catalogService !== undefined && catalog.service(input.catalogService)) {
    return found(input.catalogService, 'catalog');
  }
  for (const [source, get] of [
    ['component', input.component],
    ['entity', input.entity],
    ['owner', input.owner],
  ] as const) {
    const o = await get();
    const s = o ? catalog.ofObject(o) : null;
    if (s !== null) {
      return found(s, source);
    }
  }
  const ns = catalog.ofNamespace(input.namespace);
  if (ns !== null) {
    return found(ns, 'namespace');
  }
  return { service: null, service_source: 'default', business_domain: null };
}
