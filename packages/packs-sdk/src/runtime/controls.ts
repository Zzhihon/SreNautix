// 对照对象（契约 2.44.0，ADR 0179）：卡片声明 controls 时，refs 列出的指标引用返回同一入口上全部对象的序列，
// 序列的 by 标签取值就是对象的键。卡片对故障对象与选出的对照对象各判定一次，每次只看标签值等于该对象的序列。
// 选择方式是可扩展的枚举：本文件实现 entry_peers，其他取值在 selectControls 的 switch 中增加分支。

import { createHash } from 'node:crypto';
import type { CardControls, EvidenceControlResult, EvidenceControls } from '@srenautix/contract';
import { toIso } from '@srenautix/integration-sdk';
import { judgeCard, type CompiledCard, type JudgeInput } from '../judge/card.js';
import type { RefData } from '../judge/data.js';

export const CONTROLS_DEFAULTS = { top_n: 2, sample_count: 1 } as const;

export interface CompiledControls {
  spec: CardControls;
  /** 按 by 标签拆分的引用名 */
  refs: ReadonlySet<string>;
}

/**
 * 编译并校验对照对象的声明：refs 必须是卡片中 mode 为 range 或 instant 的指标引用且不重复，
 * volume 必须在 refs 中。不合法时抛出 TypeError
 */
export function compileControls(
  spec: CardControls,
  refs: ReadonlyArray<{ name: string; mode: string }>,
): CompiledControls {
  const modes = new Map(refs.map((r) => [r.name, r.mode]));
  for (const name of spec.refs) {
    const mode = modes.get(name);
    if (mode === undefined) {
      throw new TypeError(`refs 中的 ${name} 不是卡片中的引用`);
    }
    if (mode !== 'range' && mode !== 'instant') {
      throw new TypeError(`refs 中的 ${name} 的 mode 是 ${mode}，必须是 range 或 instant`);
    }
  }
  if (new Set(spec.refs).size !== spec.refs.length) {
    throw new TypeError('refs 中有重复的引用名');
  }
  if (!spec.refs.includes(spec.volume)) {
    throw new TypeError(`volume ${spec.volume} 必须在 refs 中`);
  }
  return { spec, refs: new Set(spec.refs) };
}

function metricsOf(data: RefData | undefined) {
  return data?.kind === 'metrics' ? data.series : [];
}

/** refs 中全部序列上 by 标签的取值（至少有一个点的序列），按字典序 */
export function controlKeys(c: CompiledControls, data: Readonly<Record<string, RefData>>): string[] {
  const keys = new Set<string>();
  for (const name of c.spec.refs) {
    for (const s of metricsOf(data[name])) {
      const k = s.labels[c.spec.by];
      if (k !== undefined && s.values.some((v) => v !== null)) {
        keys.add(k);
      }
    }
  }
  return [...keys].sort();
}

/** 一个对象在 volume 引用上的请求量：序列取值之和；这个对象没有序列时为 null */
export function controlVolume(
  c: CompiledControls,
  data: Readonly<Record<string, RefData>>,
  key: string,
): number | null {
  const mine = metricsOf(data[c.spec.volume]).filter((s) => s.labels[c.spec.by] === key);
  if (!mine.length) {
    return null;
  }
  return mine.reduce(
    (sum, s) => sum + s.values.reduce<number>((a, v) => (v !== null && Number.isFinite(v) ? a + v : a), 0),
    0,
  );
}

/** 只保留 by 标签等于 key 的序列：refs 中的引用按它过滤，其余的引用原样保留 */
export function refsFor(
  c: CompiledControls,
  data: Readonly<Record<string, RefData>>,
  key: string,
): Record<string, RefData> {
  return Object.fromEntries(
    Object.entries(data).map(([name, d]) => [
      name,
      c.refs.has(name) && d.kind === 'metrics'
        ? { ...d, series: d.series.filter((s) => s.labels[c.spec.by] === key) }
        : d,
    ]),
  );
}

export interface ControlPick {
  subject: string;
  picked_by: 'top_n' | 'sampled';
  volume: number | null;
}

/** 种子与对象键的哈希：随机取样按它排序，同一个种子与同一批对象总是得到同样的结果 */
function seeded(seed: string, key: string): string {
  return createHash('sha256').update(`${seed}\0${key}`).digest('hex');
}

/**
 * 选出对照对象。entry_peers：同一入口上除故障对象之外的对象，按请求量从多到少取前 top_n 个（请求量相同按键排序），
 * 其余的对象按种子的哈希排序取前 sample_count 个。candidates 是可作为对照的对象数
 */
export function selectControls(
  c: CompiledControls,
  data: Readonly<Record<string, RefData>>,
  subject: string,
  seed: string,
): { candidates: number; picks: ControlPick[] } {
  switch (c.spec.method) {
    case 'entry_peers': {
      const peers = controlKeys(c, data)
        .filter((k) => k !== subject)
        .map((k) => ({ key: k, volume: controlVolume(c, data, k) }));
      const byVolume = [...peers].sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || (a.key < b.key ? -1 : 1));
      const top = byVolume.slice(0, c.spec.top_n ?? CONTROLS_DEFAULTS.top_n);
      const rest = byVolume
        .slice(top.length)
        .sort((a, b) => (seeded(seed, a.key) < seeded(seed, b.key) ? -1 : 1))
        .slice(0, c.spec.sample_count ?? CONTROLS_DEFAULTS.sample_count);
      return {
        candidates: peers.length,
        picks: [
          ...top.map((p): ControlPick => ({ subject: p.key, picked_by: 'top_n', volume: p.volume })),
          ...rest.map((p): ControlPick => ({ subject: p.key, picked_by: 'sampled', volume: p.volume })),
        ],
      };
    }
  }
}

/**
 * 对每个选出的对照对象各判定一次（与故障对象用同一张卡、同一个判定输入，只换成这个对象的序列）。
 * 对象的序列没有数据点时判定为无法判定，不会是正常
 */
export function evaluateControls(
  c: CompiledControls,
  card: CompiledCard,
  input: JudgeInput,
  subject: string,
  seed: string,
): EvidenceControls {
  const { candidates, picks } = selectControls(c, input.refs, subject, seed);
  const results = picks.map((p): EvidenceControlResult => {
    const out = judgeCard(card, { ...input, refs: refsFor(c, input.refs, p.subject) });
    return {
      subject: p.subject,
      picked_by: p.picked_by,
      volume: p.volume,
      verdict: out.verdict,
      display_state: out.display_state,
      reason: out.reason,
      value: out.value,
      value_number: out.value_number,
      anomaly_started_at: out.anomaly_started_at === null ? null : toIso(out.anomaly_started_at * 1000),
    };
  });
  return { method: c.spec.method, by: c.spec.by, subject, candidates, results };
}
