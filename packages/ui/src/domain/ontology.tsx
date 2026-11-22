// 运维本体与指标词汇表解析（纯函数）：把 GET /v1/ontology/glossary 返回的领域包组件类型、证据卡说明
// 与内置运维概念映射到拓扑节点与证据卡的悬停提示（纯文本，绝不渲染原始 HTML/Markdown）。

import type { EvidenceResult, IncidentSubgraph, OntologyGlossary } from '../contract';

export type SwimlaneLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'external';

export interface NodeOntologyInfo {
  title: string;
  description: string;
  layer?: SwimlaneLayer | null;
  external?: boolean;
  hub?: boolean;
  source: 'pack' | 'concept' | 'fallback';
}

export interface ConceptMatch {
  key: string;
  title: string;
  description: string;
}

export interface EvidenceOntologyInfo {
  cardDescription: string | null;
  concepts: ConceptMatch[];
}

type SubNode = IncidentSubgraph['nodes'][number];
type ComponentTypeMeta = OntologyGlossary['component_types'][string];

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function stripPodSuffix(name: string): string {
  return name.replace(/-(?:[0-9a-f]{8,10}-[a-z0-9]{5}|[0-9a-f]{8,}|[0-9]+|(?=[a-z]*[0-9])[a-z0-9]{5})$/i, '');
}

function baseKindOf(kind: string): string {
  const dot = kind.indexOf('.');
  return (dot >= 0 ? kind.slice(0, dot) : kind).toLowerCase();
}

function safeRegexTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

/**
 * 按领域包 ComponentType 的 match 规则计算匹配具体度（镜像 packs-sdk/src/business.ts 的 byNameSpecificity）：
 * - kind 忽略大小写和 API 组；带 labels 约束的类型无法凭子图节点核对，跳过以避免误抢通用资源；
 * - 命中时返回已核对约束数量，越具体越高（name_pattern、namespaces、已核对的 api_group 各 +1），同分保持声明顺序。
 */
function matchSpecificityForNode(
  match: NonNullable<ComponentTypeMeta['match']>,
  node: Pick<SubNode, 'kind' | 'namespace' | 'name'>,
): number | null {
  if (match.has_labels) {
    return null;
  }
  if (baseKindOf(match.kind) !== baseKindOf(node.kind)) {
    return null;
  }
  const dot = node.kind.indexOf('.');
  const group = dot >= 0 ? node.kind.slice(dot + 1) : null;
  if (match.api_group !== undefined && group !== null && group !== match.api_group) {
    return null;
  }
  if (match.namespaces !== undefined && !match.namespaces.includes(node.namespace ?? '')) {
    return null;
  }
  if (match.name_pattern !== undefined && !safeRegexTest(match.name_pattern, node.name)) {
    return null;
  }
  return (
    (match.name_pattern !== undefined ? 1 : 0) +
    (match.namespaces !== undefined ? 1 : 0) +
    (match.api_group !== undefined && group !== null ? 1 : 0)
  );
}

const KIND_CONCEPT_ALIASES: Readonly<Record<string, string>> = {
  persistentvolumeclaim: 'pvc',
  poddisruptionbudget: 'pdb',
  horizontalpodautoscaler: 'hpa',
  node: 'node',
  cluster: 'cnpg',
  dragonfly: 'dragonfly',
  httproute: 'envoy-gateway',
  gateway: 'envoy-gateway',
};

/** 为拓扑节点查找最匹配的本体说明：先按 match 规则取最具体的领域包 component_types，再按无 match 的 id 后缀回退，最后查 concepts 与兜底说明。 */
export function lookupNodeOntology(
  node: Pick<SubNode, 'component' | 'kind' | 'namespace' | 'name'>,
  glossary: OntologyGlossary | null | undefined,
  locale: 'zh-CN' | 'en' = 'zh-CN',
): NodeOntologyInfo {
  const lowerName = node.name.toLowerCase();
  const stem = stripPodSuffix(lowerName);
  const baseKind = baseKindOf(node.kind);

  if (glossary) {
    // 1a. 优先按领域包 component_types 的 match 规则（kind + namespaces + name_pattern + api_group）取最具体匹配
    let bestPack: { ct: ComponentTypeMeta; specificity: number } | undefined;
    for (const ct of Object.values(glossary.component_types)) {
      if (!ct.match) {
        continue;
      }
      const specificity = matchSpecificityForNode(ct.match, node);
      if (specificity !== null && (!bestPack || specificity > bestPack.specificity)) {
        bestPack = { ct, specificity };
      }
    }
    if (bestPack) {
      const { ct } = bestPack;
      return {
        title: ct.title,
        description: ct.description,
        layer: (ct.layer as SwimlaneLayer | null | undefined) ?? null,
        external: ct.external,
        hub: ct.hub,
        source: 'pack',
      };
    }

    // 1b. 仅对未携带 match 规则（或带 labels 无法凭名称校验）的旧版/简写条目按 id/后缀精确回退
    for (const [id, ct] of Object.entries(glossary.component_types)) {
      if (ct.match && !ct.match.has_labels) {
        continue;
      }
      const idLower = id.toLowerCase();
      const suffix = idLower.includes('.') ? idLower.slice(idLower.indexOf('.') + 1) : idLower;
      if (
        idLower === lowerName ||
        suffix === lowerName ||
        suffix === stem ||
        (baseKind === 'provider' && suffix === 'provider') ||
        (baseKind === 'model' && suffix === 'model')
      ) {
        return {
          title: ct.title,
          description: ct.description,
          layer: (ct.layer as SwimlaneLayer | null | undefined) ?? null,
          external: ct.external,
          hub: ct.hub,
          source: 'pack',
        };
      }
    }

    // 2. 匹配内置概念词汇表（按组件名、词干、子串或类型别名，使用 Object.hasOwn 防止原型链污染）
    const directCandidates = [lowerName, stem, own(KIND_CONCEPT_ALIASES, baseKind), baseKind].filter((x): x is string =>
      Boolean(x),
    );
    for (const cand of directCandidates) {
      const hit = own(glossary.concepts, cand);
      if (hit) {
        return {
          title: hit.title,
          description: hit.description,
          source: 'concept',
        };
      }
    }
    for (const [key, item] of Object.entries(glossary.concepts)) {
      if (key.length >= 4 && (lowerName.includes(key) || stem.includes(key))) {
        return {
          title: item.title,
          description: item.description,
          source: 'concept',
        };
      }
    }
  }

  // 3. 兜底说明：不阻断悬停提示，确保即使 glossary 未加载也能看到清晰的结构化角色说明
  const nsPart = node.namespace ? ` (${node.namespace})` : '';
  return {
    title: node.name,
    description:
      locale === 'en'
        ? `${node.kind}${nsPart} component in the incident topology.`
        : `事件拓扑中的 ${node.kind}${nsPart} 组件。`,
    source: 'fallback',
  };
}

/** 按观测键或指标术语查找概念解释（例如 volume_reserve_bytes、effective_budget、wal）。 */
export function lookupConcept(term: string, glossary: OntologyGlossary | null | undefined): ConceptMatch | null {
  if (!glossary) {
    return null;
  }
  const normalized = term.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const exact = own(glossary.concepts, normalized);
  if (exact) {
    return { key: normalized, ...exact };
  }
  // 去掉 _bytes / _ratio / _seconds 等常见指标后缀再尝试匹配
  const trimmed = normalized.replace(/_(bytes|ratio|seconds|total|count|percent)$/, '');
  const trimmedHit = trimmed ? own(glossary.concepts, trimmed) : undefined;
  if (trimmed && trimmedHit) {
    return { key: trimmed, ...trimmedHit };
  }
  for (const [key, item] of Object.entries(glossary.concepts)) {
    if (key.length >= 4 && normalized.includes(key)) {
      return { key, ...item };
    }
  }
  return null;
}

/** 为证据卡提取卡片说明与文中出现的运维指标/概念解释（最多返回 3 条最相关概念，保持悬停浮层紧凑）。 */
export function lookupEvidenceOntology(
  card: Pick<EvidenceResult, 'card_id' | 'reason' | 'observations' | 'queries'>,
  glossary: OntologyGlossary | null | undefined,
): EvidenceOntologyInfo {
  if (!glossary) {
    return { cardDescription: null, concepts: [] };
  }
  const cardMeta = own(glossary.cards, card.card_id);
  const cardDescription = cardMeta?.description || null;

  const haystack = [
    card.card_id,
    card.reason?.text ?? '',
    ...Object.keys(card.observations ?? {}),
    ...card.queries.map((q) => `${q.name} ${q.query}`),
  ]
    .join(' ')
    .toLowerCase();

  const concepts: ConceptMatch[] = [];
  const seen = new Set<string>();
  // 优先匹配较长、更具体的术语（例如 volume_reserve_bytes 先于 node）
  const entries = Object.entries(glossary.concepts).sort((a, b) => b[0].length - a[0].length);
  for (const [key, item] of entries) {
    if (seen.has(key)) {
      continue;
    }
    const re = new RegExp(`(^|[^a-z0-9_-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9_-]|$)`, 'i');
    if (re.test(haystack)) {
      seen.add(key);
      concepts.push({ key, ...item });
      if (concepts.length >= 3) {
        break;
      }
    }
  }
  return { cardDescription, concepts };
}
