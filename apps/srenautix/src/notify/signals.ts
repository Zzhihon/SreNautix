import type { EvidenceResult } from '@srenautix/contract';
import { tryNodeKey } from '@srenautix/core';

// 业务关键信号（ADR 0148）：从阶段 A 的卡与研判的检查卡里挑出和业务服务紧密相关的五类信号，
// 只列异常的与接近阈值的卡，一类一组、一行一项（对象、数值、阈值、时间），放在事件消息的现状之后、关键问题之前。

export type SignalCategory = 'storage' | 'memory' | 'cpu' | 'traffic' | 'blocking';

/** 段内的类别顺序 */
export const SIGNAL_CATEGORIES: readonly SignalCategory[] = ['storage', 'memory', 'cpu', 'traffic', 'blocking'];

/** 正常卡的主值达到阈值的这个比例（并且还没有超过阈值）时算接近阈值 */
export const NEAR_RATIO = 0.8;

/**
 * 卡片没有 category 时按卡片 id 与证据链 id 推断：先看卡片 id，再看证据链 id；每段按 - 与 _ 切成词，
 * 按下面的顺序取第一条命中的规则。推断不出时不进入这一段
 */
const RULES: ReadonlyArray<readonly [SignalCategory, ReadonlySet<string>]> = [
  ['memory', new Set(['memory', 'mem', 'oom', 'oomkilled', 'evictions'])],
  ['cpu', new Set(['cpu', 'throttling', 'throttled', 'hpa', 'load', 'runqueue'])],
  [
    'storage',
    new Set([
      'pvc',
      'pv',
      'volume',
      'volumes',
      'disk',
      'filesystem',
      'fs',
      'storage',
      'wal',
      'backup',
      'archive',
      'archiving',
      'seaweedfs',
      'slots',
      's3',
      'object',
      'bucket',
      'io',
      'iops',
    ]),
  ],
  [
    'blocking',
    new Set([
      'pending',
      'waiting',
      'init',
      'stuck',
      'pdb',
      'disruptions',
      'eviction',
      'rollout',
      'deployment',
      'statefulset',
      'daemonset',
      'replicasets',
      'lock',
      'locks',
      'waits',
      'queue',
      'backlog',
      'blocked',
      'blocking',
    ]),
  ],
  ['traffic', new Set(['error', 'errors', '5xx', 'latency', 'ttft', 'traffic', 'slow', 'probe', 'qps', 'throughput'])],
];

function inferFrom(segment: string | undefined): SignalCategory | null {
  if (!segment) {
    return null;
  }
  const words = segment.toLowerCase().split(/[-_.]+/);
  for (const [cat, set] of RULES) {
    if (words.some((w) => set.has(w))) {
      return cat;
    }
  }
  return null;
}

/** 卡片的类别：卡片定义的 category；没有时按卡片 id、再按证据链 id 推断。区分性检查的卡（check/…）只看 category */
export function categoryOf(r: Pick<EvidenceResult, 'card_id' | 'category'>): SignalCategory | null {
  if (r.category) {
    return r.category;
  }
  const [pack, chain, card] = r.card_id.split('/');
  if (pack === 'check') {
    return null;
  }
  return inferFrom(card) ?? inferFrom(chain);
}

export interface SignalItem {
  category: SignalCategory;
  card: EvidenceResult;
  /** 正常但接近阈值 */
  near: boolean;
}

/**
 * 主值的数值：value_number；契约 2.27.0 之前的结果没有它，百分比与无单位的主值从展示文本还原
 * （formatValue 的写法：百分比为 "96.5%"，其余为十进制数），其他单位为 null
 */
export function valueNumber(r: Pick<EvidenceResult, 'value' | 'value_number' | 'unit'>): number | null {
  if (typeof r.value_number === 'number') {
    return r.value_number;
  }
  const s = r.value?.trim() ?? '';
  if ((r.unit ?? 'none') === 'percent' && /^-?\d+(\.\d+)?%$/.test(s)) {
    return Number(s.slice(0, -1)) / 100;
  }
  if (['none', 'ratio', 'count'].includes(r.unit ?? 'none') && /^-?\d+(\.\d+)?$/.test(s)) {
    return Number(s);
  }
  return null;
}

/** 正常卡的主值是否接近阈值：主值与阈值都是正数，主值不低于阈值的 NEAR_RATIO 且低于阈值 */
export function nearThreshold(r: EvidenceResult): boolean {
  const v = valueNumber(r);
  const th = r.threshold;
  return (
    r.verdict === 'normal' &&
    typeof v === 'number' &&
    typeof th === 'number' &&
    th > 0 &&
    v >= NEAR_RATIO * th &&
    v < th
  );
}

const entityOf = (r: EvidenceResult): string =>
  (r.entity ? tryNodeKey(r.entity.kind, r.entity.namespace, r.entity.name) : null) ?? '';

/** 主值相对阈值的比例，用于排序；没有阈值时为 0 */
const pressure = (r: EvidenceResult): number => {
  const v = valueNumber(r);
  return v !== null && typeof r.threshold === 'number' && r.threshold > 0 ? v / r.threshold : 0;
};

const refNo = (r: EvidenceResult): number => Number(r.ref.split(':')[1] ?? 0);

/**
 * 五类信号中异常与接近阈值的卡，按类别顺序；同一类内异常的在前，其次按主值相对阈值的比例从高到低，最后按编号。
 * 同一对象上标题相同的卡（例如阶段 A 的卡与研判时重跑的同一张卡）只保留一张：异常的优先，其次是更晚判定的
 */
export function businessSignals(cards: readonly EvidenceResult[]): SignalItem[] {
  const best = new Map<string, SignalItem>();
  for (const card of cards) {
    const category = categoryOf(card);
    if (!category) {
      continue;
    }
    const abnormal = card.verdict === 'abnormal';
    const near = !abnormal && nearThreshold(card);
    if (!abnormal && !near) {
      continue;
    }
    const key = `${category}|${entityOf(card)}|${card.title.en ?? card.title['zh-CN'] ?? card.card_id}`;
    const prev = best.get(key);
    const better =
      !prev ||
      (abnormal && prev.near) ||
      (abnormal === !prev.near && Date.parse(card.evaluated_at) > Date.parse(prev.card.evaluated_at));
    if (better) {
      best.set(key, { category, card, near });
    }
  }
  const order = new Map(SIGNAL_CATEGORIES.map((c, i) => [c, i]));
  return [...best.values()].sort(
    (a, b) =>
      (order.get(a.category) ?? 9) - (order.get(b.category) ?? 9) ||
      Number(a.near) - Number(b.near) ||
      pressure(b.card) - pressure(a.card) ||
      refNo(a.card) - refNo(b.card),
  );
}
