import type { ComponentType, EvidenceResult, Incident } from '@srenautix/contract';
import { sameKind } from '@srenautix/core';
import type { CardEntry, PackSet } from '@srenautix/packs-sdk';
import type { CheckTemplate } from '../research/types.js';
import { parseStoredKey } from '../topology/keys.js';

/**
 * 卡片即检查（ADR 0116）：已加载领域包里证据链的卡，只要 applies_to 的 kind 与研判子图中某个组件相同（sameKind），
 * 就可以作为阶段 B 的区分性检查，在那个组件上、在指定的窗口内执行，结果按卡片的 CEL 判定成新的证据卡。
 *
 * - 检查 id：`cardcheck:<包>/<链>/<卡>@<组件键>`；执行方（server 的 /query、评测的 ReconstructedQueryRunner）按 id 里的组件
 *   执行，不按假设的根因；
 * - 参数全部可选：`window_before`、`window_after`（相对事件首次触发时间的时长，例如 2h、10m）与卡片声明的可覆盖参数
 *   （卡片 params 的键，类型取默认值的类型）；
 * - 列表按相关性截断：根因与候选根因在前（按得分），其次事件的成员组件，最后其余子图节点；每个组件最多
 *   PER_COMPONENT 张，合计最多 TOTAL 张。同一组件上依次是组件自身类型的证据链、这个 kind 的通用证据链、阶段 A 在本事件里
 *   执行过的证据链、其余只按 kind 适用的卡；阶段 A 已在该组件上执行过的卡排在同档之后。
 */
export const CARD_CHECK_PREFIX = 'cardcheck:';
export const PER_COMPONENT = 4;
export const TOTAL = 20;

const DURATION = { type: 'string', pattern: '^([0-9]+(ms|s|m|h|d|w))+$' } as const;

export interface CardCheckNode {
  key: string;
  kind: string;
  namespace: string | null;
  name: string;
  component_type: string | null;
}

export interface CardCheckRuntime {
  set: PackSet;
  typeChains(componentType: string): string[];
  componentTypes(): readonly ComponentType[];
}

export function cardCheckId(card: string, component: string): string {
  return `${CARD_CHECK_PREFIX}${card}@${component}`;
}

/** 解析检查 id；不是卡片检查时为 null */
export function parseCardCheckId(id: string): { card: string; component: string } | null {
  if (!id.startsWith(CARD_CHECK_PREFIX)) {
    return null;
  }
  const rest = id.slice(CARD_CHECK_PREFIX.length);
  const at = rest.indexOf('@');
  if (at <= 0 || at === rest.length - 1) {
    return null;
  }
  return { card: rest.slice(0, at), component: rest.slice(at + 1) };
}

/** 卡片检查的参数 schema：全部可选，不允许其他字段 */
export function cardCheckArgs(e: CardEntry): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    window_before: { ...DURATION, description: '窗口起点：事件首次触发之前多久（默认取卡片定义）' },
    window_after: { ...DURATION, description: '窗口终点：事件首次触发之后多久，不晚于当前时间（默认取卡片定义）' },
  };
  for (const [k, v] of Object.entries(e.def.params ?? {})) {
    properties[k] = { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' };
  }
  return { type: 'object', additionalProperties: false, properties };
}

/** 检查参数 → 卡片参数与窗口覆盖（没有给出的窗口端点取卡片定义） */
export function splitCardCheckArgs(
  e: CardEntry,
  args: Record<string, unknown>,
): { params: Record<string, number | string | boolean>; window: { before: string; after: string } | undefined } {
  const params: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k !== 'window_before' && k !== 'window_after' && ['number', 'string', 'boolean'].includes(typeof v)) {
      params[k] = v as number | string | boolean;
    }
  }
  const before = typeof args.window_before === 'string' ? args.window_before : undefined;
  const after = typeof args.window_after === 'string' ? args.window_after : undefined;
  const def = e.def.window ?? { before: '30m', after: '10m' };
  return { params, window: before || after ? { before: before ?? def.before, after: after ?? def.after } : undefined };
}

/** 卡片能否在这个 kind 的组件上执行 */
export function cardApplies(e: CardEntry, kind: string): boolean {
  return (e.def.applies_to?.kinds ?? ['Pod']).some((k) => sameKind(k, kind));
}

function text(t: Record<string, string | undefined> | undefined, locale: 'zh-CN' | 'en'): string {
  return (t?.[locale] ?? t?.['zh-CN'] ?? t?.en ?? '').trim();
}

/** 研判子图组件 × 适用的卡 → 区分性检查列表（按相关性截断） */
export function cardChecks(
  rt: CardCheckRuntime,
  incident: Incident,
  nodes: readonly CardCheckNode[],
  stageACards: readonly EvidenceResult[],
  locale: 'zh-CN' | 'en',
  edges: ReadonlyArray<{ from: string; to: string; relation: string }> = [],
): CheckTemplate[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  // 研判按属主粒度提出假设：属主已在列表里的对象（Deployment 的 Pod、ReplicaSet）不重复提供检查
  const ownerOf = new Map(edges.filter((e) => e.relation === 'owned_by').map((e) => [e.from, e.to]));
  const order: string[] = [];
  const push = (k: string | null | undefined) => {
    if (k && !order.includes(k)) {
      order.push(k);
    }
  };
  push(incident.root.component);
  [...incident.candidates].sort((a, b) => b.score - a.score).forEach((c) => push(c.component));
  incident.components.forEach(push);
  nodes.forEach((n) => push(n.key));

  const chainCards = [...rt.set.cards.values()].filter((e) => e.chain !== null);
  const chainOf = (e: CardEntry) => `${e.pack}/${e.chain}`;
  // 阶段 A 在这个事件里执行过的证据链（任意实体上）
  const incidentChains = new Set(stageACards.map((c) => c.card_id.split('/').slice(0, 2).join('/')));
  // 只按 kind 匹配的通用组件类型（没有名称、标签、命名空间约束）的证据链，例如 Deployment 的工作负载链
  const genericChains = (kind: string) =>
    new Set(
      rt
        .componentTypes()
        .filter(
          (t) =>
            sameKind(t.match.kind, kind) &&
            t.match.name_pattern === undefined &&
            Object.keys(t.match.labels ?? {}).length === 0 &&
            t.match.namespaces === undefined,
        )
        .flatMap((t) => rt.typeChains(t.id)),
    );
  const ran = new Set(
    stageACards.flatMap((c) =>
      c.entity ? [`${c.card_id}|${c.entity.kind}|${c.entity.namespace ?? ''}|${c.entity.name}`] : [],
    ),
  );
  const out: CheckTemplate[] = [];
  const offered = new Set<string>();
  for (const component of order) {
    if (out.length >= TOTAL) {
      break;
    }
    let owner = ownerOf.get(component);
    for (let i = 0; owner !== undefined && i < 8; i++) {
      if (offered.has(owner)) {
        break;
      }
      owner = ownerOf.get(owner);
    }
    if (owner !== undefined && offered.has(owner)) {
      continue;
    }
    const node = byKey.get(component);
    let kind: string;
    let namespace: string | null;
    let name: string;
    try {
      const k = node ?? parseStoredKey(component);
      ({ kind, namespace, name } = k);
    } catch {
      continue;
    }
    // 相关性：组件自身类型的证据链 → 这个 kind 的通用证据链 → 阶段 A 在本事件里执行过的证据链 → 其余只按 kind 适用的卡
    // （例如 kafka 消费延迟对任意 Deployment 都"适用"）；阶段 A 已在这个组件上执行过的卡排在同档之后
    const own = new Set(node?.component_type ? rt.typeChains(node.component_type) : []);
    const generic = genericChains(kind);
    const applicable = chainCards.filter((e) => cardApplies(e, kind));
    const rank = (e: CardEntry) =>
      (own.has(chainOf(e)) ? 0 : generic.has(chainOf(e)) ? 2 : incidentChains.has(chainOf(e)) ? 4 : 6) +
      (ran.has(`${e.key}|${kind}|${namespace ?? ''}|${name}`) ? 1 : 0);
    // 同一档内各条证据链轮流取（每条链先取第一张卡），不让一条链占满这个组件的名额
    const posInChain = new Map<CardEntry, number>();
    const seenInChain = new Map<string, number>();
    for (const e of applicable) {
      const n = seenInChain.get(chainOf(e)) ?? 0;
      posInChain.set(e, n);
      seenInChain.set(chainOf(e), n + 1);
    }
    const picked = applicable
      .map((e, i) => ({ e, r: rank(e), p: posInChain.get(e)!, i }))
      .sort((a, b) => a.r - b.r || a.p - b.p || a.i - b.i)
      .slice(0, Math.min(PER_COMPONENT, TOTAL - out.length));
    if (picked.length) {
      offered.add(component);
    }
    for (const { e } of picked) {
      const title = text(e.def.title as Record<string, string>, locale) || e.key;
      const note = text(e.def.note as Record<string, string> | undefined, locale);
      out.push({
        id: cardCheckId(e.key, component),
        description:
          locale === 'zh-CN'
            ? `${title}，在 ${component} 上；异常表示${note ? `：${note}` : '卡片按规则判定为异常'}`
            : `${title} on ${component}; abnormal means ${note || 'the card rules judged it abnormal'}`,
        args: cardCheckArgs(e),
      });
    }
  }
  return out;
}
