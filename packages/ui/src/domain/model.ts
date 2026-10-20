// 领域展示逻辑（纯函数）：组件键解析、证据排序与计数、降级数据源、反馈状态、时间线条目。

import type { EvidenceResult, Feedback, Incident, IncidentSummary } from '../contract';

export interface ComponentParts {
  kind: string;
  namespace: string | null;
  name: string;
}

const UNRESERVED = /^[A-Za-z0-9._-]$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * 名称段解码（ADR 0034）：A–Z a–z 0–9 '-' '.' '_' 以外的字节写成 %XX。只用于展示；
 * 不是规范编码（例如契约 2.8.0 之前写入的旧键）时原样返回。
 */
export function decodeComponentName(segment: string): string {
  if (!segment.includes('%')) {
    return segment;
  }
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string;
    if (c === '%') {
      const hex = segment.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) {
        return segment;
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (UNRESERVED.test(c)) {
      bytes.push(c.charCodeAt(0));
    } else {
      return segment;
    }
  }
  try {
    return utf8.decode(Uint8Array.from(bytes));
  } catch {
    return segment;
  }
}

/** `<kind>:<namespace>/<名称段>` 或 `<kind>:<名称段>`；name 是解码后的原始对象名（给人看），键本身保持编码形式。 */
export function parseComponent(key: string): ComponentParts {
  const i = key.indexOf(':');
  if (i <= 0) {
    throw new Error(`组件键格式错误：${key}`);
  }
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  const j = rest.indexOf('/');
  return j < 0
    ? { kind, namespace: null, name: decodeComponentName(rest) }
    : { kind, namespace: rest.slice(0, j), name: decodeComponentName(rest.slice(j + 1)) };
}

/** 给人看的完整组件名：ClusterRole:a%3Ab → ClusterRole:a:b */
export function displayComponent(key: string): string {
  try {
    const p = parseComponent(key);
    return p.namespace ? `${p.kind}:${p.namespace}/${p.name}` : `${p.kind}:${p.name}`;
  } catch {
    return key;
  }
}

/**
 * 列表里的短名："worker（StatefulSet · prod-app）"由调用方拼接，这里给出 name 与副标题。
 * 有领域包求出的可读名称时（ADR 0101）name 为名称，副标题带上对象名，例如"智元 API"与"provider · 01a1…"。
 */
export function componentLabel(
  key: string,
  names?: Readonly<Record<string, string | undefined>> | null,
): { name: string; sub: string } {
  const p = parseComponent(key);
  const sub = p.namespace ? `${p.kind} · ${p.namespace}` : p.kind;
  const named = names?.[key];
  return named ? { name: named, sub: `${sub} · ${p.name}` } : { name: p.name, sub };
}

export type DisplayState = EvidenceResult['display_state'];

const EVIDENCE_ORDER: Record<DisplayState, number> = {
  abnormal: 0,
  undeterminable: 1,
  capability_missing: 2,
  normal: 3,
};

/** 证据按"异常、无法判定、正常"排序（DESIGN §12.2），同类按 ref 编号。 */
export function sortEvidence(list: readonly EvidenceResult[]): EvidenceResult[] {
  const n = (r: EvidenceResult) => Number(r.ref.slice(r.ref.indexOf(':') + 1));
  return [...list].sort((a, b) => EVIDENCE_ORDER[a.display_state] - EVIDENCE_ORDER[b.display_state] || n(a) - n(b));
}

export interface EvidenceCounts {
  abnormal: number;
  undeterminable: number;
  normal: number;
  total: number;
}

export function countEvidence(list: readonly EvidenceResult[]): EvidenceCounts {
  const c: EvidenceCounts = { abnormal: 0, undeterminable: 0, normal: 0, total: list.length };
  for (const r of list) {
    if (r.display_state === 'abnormal') {
      c.abnormal++;
    } else if (r.display_state === 'normal') {
      c.normal++;
    } else {
      c.undeterminable++;
    }
  }
  return c;
}

/** 降级的数据源：查询报错、超时或能力缺失的集成实例，附受影响的卡数。 */
export function degradedSources(
  list: readonly EvidenceResult[],
): Array<{ integration: string; cards: number; reason: string }> {
  const m = new Map<string, { cards: Set<string>; reason: string }>();
  for (const r of list) {
    for (const q of r.queries) {
      const bad = q.error !== null || r.reason.kind === 'capability_missing' || r.reason.kind === 'source_error';
      if (!bad || r.display_state === 'normal' || r.display_state === 'abnormal') {
        continue;
      }
      const cur = m.get(q.integration) ?? { cards: new Set<string>(), reason: q.error ?? r.reason.text };
      cur.cards.add(r.ref);
      m.set(q.integration, cur);
    }
  }
  return [...m.entries()].map(([integration, v]) => ({ integration, cards: v.cards.size, reason: v.reason }));
}

export type FeedbackState = 'none' | 'pending' | 'stale' | 'given';

/**
 * 反馈状态：最近一条反馈之后又有研判完成时为 stale；没有完成的研判时阶段 A 的处置判断也可以反馈，
 * 所以只要有处置判断就是 pending。进行中的事件同样可以反馈。
 */
export function feedbackState(latest: Feedback | null, hasVerdict: boolean): FeedbackState {
  if (latest) {
    return latest.stale ? 'stale' : 'given';
  }
  return hasVerdict ? 'pending' : 'none';
}

/** 事件在收件箱中的合并 / 拆分标记。 */
export function lineage(s: Pick<IncidentSummary, 'merged_from_count' | 'split_from'>): Array<'merged' | 'split'> {
  const out: Array<'merged' | 'split'> = [];
  if (s.merged_from_count > 0) {
    out.push('merged');
  }
  if (s.split_from !== null) {
    out.push('split');
  }
  return out;
}

/** 时间线的盲区：事件持续期间与收件箱盲区时段的交集。 */
export function blindWithin(
  spans: ReadonlyArray<{ from: string; to: string | null }>,
  from: number,
  to: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of spans) {
    const a = Math.max(from, Date.parse(s.from));
    const b = Math.min(to, s.to ? Date.parse(s.to) : to);
    if (b > a) {
      out.push([a, b]);
    }
  }
  return out;
}

/** 事件持续时间：恢复的事件到 ended_at，进行中的到 now。 */
export function incidentDuration(i: Pick<Incident, 'first_firing_at' | 'ended_at'>, now: number): number {
  return (i.ended_at ? Date.parse(i.ended_at) : now) - Date.parse(i.first_firing_at);
}
