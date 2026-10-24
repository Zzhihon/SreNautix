import type { Alert, EntityRef, EvidenceResult, StageAReport } from '@srenautix/contract';
import { sameKind } from '@srenautix/core';

// 最低取证集合（ADR 0153）：告警目录条目的 required_cards 是告警触发时研判之前必须得出结论的卡（告警自身的指标族、
// 相关的配置与状态，即 runbook 的只读检查）。卡所在的证据链随告警执行（pack lint 保证），阶段 A 在告警实体上执行后，
// 按这里的规则记录哪些卡没有得出结论；研判把区分性检查得到的卡也算进来，仍有缺口时结论档位只能是 undetermined。

export type RequiredEvidence = NonNullable<StageAReport['required_evidence']>[number];

type EntityLike = Pick<EntityRef, 'cluster_id' | 'kind' | 'namespace' | 'name'>;

export function sameEntity(a: EntityLike, b: EntityLike | null | undefined): boolean {
  return (
    !!b &&
    a.cluster_id === b.cluster_id &&
    sameKind(a.kind, b.kind) &&
    (a.namespace ?? null) === (b.namespace ?? null) &&
    a.name === b.name
  );
}

/** 卡在实体上得出了结论（正常或异常） */
function covered(
  key: string,
  entity: EntityLike,
  cards: ReadonlyArray<Pick<EvidenceResult, 'card_id' | 'entity' | 'verdict'>>,
) {
  return cards.some((c) => c.card_id === key && c.verdict !== 'undeterminable' && sameEntity(entity, c.entity));
}

/** 阶段 A：目录条目声明了 required_cards、能解析出实体的成员告警，每条一项 */
export function requiredEvidence(
  requiredCards: (catalogEntry: string) => string[],
  alerts: readonly Alert[],
  cards: ReadonlyArray<Pick<EvidenceResult, 'card_id' | 'entity' | 'verdict'>>,
): RequiredEvidence[] {
  const out: RequiredEvidence[] = [];
  for (const a of alerts) {
    const entry = a.classification.catalog_entry;
    if (!entry || !a.entity) {
      continue;
    }
    const keys = requiredCards(entry);
    if (!keys.length) {
      continue;
    }
    out.push({
      alert_id: a.alert_id,
      alertname: a.alertname,
      catalog_entry: entry,
      entity: a.entity,
      cards: keys,
      missing: keys.filter((k) => !covered(k, a.entity!, cards)),
    });
  }
  return out;
}

/**
 * 研判：阶段 A 记录的缺口中，区分性检查也没有补上的卡（同一张卡、同一实体、得出结论）。
 * 返回 "<告警名>（<实体>）缺少 <卡>" 形式的说明，没有缺口时为空
 */
export function missingRequired(
  required: readonly RequiredEvidence[] | undefined,
  cards: ReadonlyArray<Pick<EvidenceResult, 'card_id' | 'entity' | 'verdict'>>,
): string[] {
  const out: string[] = [];
  for (const r of required ?? []) {
    const missing = r.missing.filter((k) => !covered(k, r.entity, cards));
    if (missing.length) {
      const where = `${r.entity.kind}:${r.entity.namespace ? `${r.entity.namespace}/` : ''}${r.entity.name}`;
      out.push(`${r.alertname}（${where}）缺少 ${missing.join('、')}`);
    }
  }
  return out;
}
