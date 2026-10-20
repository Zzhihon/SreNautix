import type { Alert, EvidenceResult } from '@srenautix/contract';
import type { PackRuntime } from '../stage-a/packs.js';

// 证据卡与告警结论的一致率（ADR 0110）：告警正在触发时，它在告警目录中对应的卡应当判为异常。
// - 主卡：目录条目的 primary_card（<chain>/<card> 或 <pack>/<chain>/<card>），在告警实体上的结果；
// - 链级：目录条目声明的证据链中，在告警实体上执行的卡里有没有判为异常的（有一张即为异常，否则按正常、无法判定的顺序）。
// 一致率 = 判为异常 / （异常 + 正常 + 无法判定 + 没有卡）。没有目录条目、条目没有声明主卡、告警没有实体的告警单独计数，
// 不进入分母。

export type CardOutcome = 'abnormal' | 'normal' | 'undeterminable' | 'no_card';
export type AgreementOutcome = CardOutcome | 'undeclared' | 'uncatalogued' | 'no_entity';

export interface AlertAgreement {
  alertname: string;
  entity: string | null;
  entry: string | null;
  primary_card: string | null;
  primary: AgreementOutcome;
  chain: AgreementOutcome;
  /** 主卡的判定说明（不一致时便于核对） */
  primary_reason: string | null;
}

const entityText = (e: { kind: string; namespace: string | null; name: string }) =>
  `${e.kind}:${e.namespace ? `${e.namespace}/` : ''}${e.name}`;

function sameEntity(
  a: { kind: string; namespace: string | null; name: string },
  b: { kind: string; namespace: string | null; name: string } | null,
): boolean {
  if (!b) {
    return false;
  }
  // 告警标签里的 kind 可能不带 API 组（application 与 Application.argoproj.io）
  const k = (x: string) => x.split('.')[0]!.toLowerCase();
  return k(a.kind) === k(b.kind) && (a.namespace ?? null) === (b.namespace ?? null) && a.name === b.name;
}

function outcome(cards: readonly EvidenceResult[]): CardOutcome {
  if (!cards.length) {
    return 'no_card';
  }
  if (cards.some((c) => c.verdict === 'abnormal')) {
    return 'abnormal';
  }
  if (cards.some((c) => c.verdict === 'normal')) {
    return 'normal';
  }
  return 'undeterminable';
}

/** 一个事件的触发中成员告警与它的阶段 A 证据卡 → 每条告警的一致情况 */
export function agreeAlerts(
  rt: PackRuntime,
  firing: readonly Alert[],
  cards: readonly EvidenceResult[],
): AlertAgreement[] {
  const catalog = rt.alertCatalog();
  return firing.map((a): AlertAgreement => {
    const hit = catalog.lookup(a.labels);
    if (!hit) {
      return {
        alertname: a.alertname,
        entity: a.entity ? entityText(a.entity) : null,
        entry: null,
        primary_card: null,
        primary: 'uncatalogued',
        chain: 'uncatalogued',
        primary_reason: null,
      };
    }
    const entryKey = `${hit.pack}/${hit.entry.id}`;
    const declared = hit.entry.primary_card ?? null;
    const primaryKey =
      declared === null ? null : declared.split('/').length === 3 ? declared : `${hit.pack}/${declared}`;
    if (!a.entity) {
      return {
        alertname: a.alertname,
        entity: null,
        entry: entryKey,
        primary_card: primaryKey,
        primary: primaryKey === null ? 'undeclared' : 'no_entity',
        chain: 'no_entity',
        primary_reason: null,
      };
    }
    const onEntity = cards.filter((c) => sameEntity(a.entity!, c.entity));
    const chains = rt.alertChains(entryKey).map((c) => `${c}/`);
    const chainCards = onEntity.filter((c) => chains.some((p) => c.card_id.startsWith(p)));
    const primaryCards = primaryKey === null ? [] : onEntity.filter((c) => c.card_id === primaryKey);
    return {
      alertname: a.alertname,
      entity: entityText(a.entity),
      entry: entryKey,
      primary_card: primaryKey,
      primary: primaryKey === null ? 'undeclared' : outcome(primaryCards),
      chain: outcome(chainCards),
      primary_reason: primaryCards[0] ? `${primaryCards[0].verdict}：${primaryCards[0].reason.text}` : null,
    };
  });
}

export interface AgreementSummary {
  /** 一致率的分母：有主卡（或链上有卡）且有实体的触发中告警 */
  primary: Record<AgreementOutcome, number>;
  chain: Record<AgreementOutcome, number>;
  /** 主卡不一致（判为正常或无法判定）的告警，按告警名与主卡计数 */
  primary_disagreements: Array<{ alertname: string; primary_card: string; outcome: AgreementOutcome; n: number }>;
}

const empty = (): Record<AgreementOutcome, number> => ({
  abnormal: 0,
  normal: 0,
  undeterminable: 0,
  no_card: 0,
  undeclared: 0,
  uncatalogued: 0,
  no_entity: 0,
});

export function summarizeAgreement(xs: readonly AlertAgreement[]): AgreementSummary {
  const primary = empty();
  const chain = empty();
  const dis = new Map<string, { alertname: string; primary_card: string; outcome: AgreementOutcome; n: number }>();
  for (const x of xs) {
    primary[x.primary]++;
    chain[x.chain]++;
    if (x.primary === 'normal' || x.primary === 'undeterminable' || x.primary === 'no_card') {
      const k = `${x.alertname}|${x.primary_card}|${x.primary}`;
      const cur = dis.get(k) ?? { alertname: x.alertname, primary_card: x.primary_card!, outcome: x.primary, n: 0 };
      cur.n++;
      dis.set(k, cur);
    }
  }
  return { primary, chain, primary_disagreements: [...dis.values()].sort((a, b) => b.n - a.n) };
}

/** 一致率：判为异常 / （异常 + 正常 + 无法判定 + 没有卡） */
export function agreementRate(r: Record<AgreementOutcome, number>): { n: number; d: number } {
  return { n: r.abnormal, d: r.abnormal + r.normal + r.undeterminable + r.no_card };
}
