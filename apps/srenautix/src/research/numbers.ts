// 模型文字的数值审计（ADR 0125）：模型只能归纳，不能编造数值。文字里的数值断言（时刻、百分比、带单位的数、小数）
// 必须能在本次研判的证据里找到；找不到的连同所在分句一起删掉，由调用方写进 validation_notes。
// 命令与标识符里的数字（--tail=50、gateway-4、card:38、canary-147f）不算数值断言。

import type { EvidenceResult } from '@srenautix/contract';

/** 一次研判的证据语料：证据中出现过的数值与时刻 */
export interface NumberCorpus {
  values: number[];
  /** UTC 的 HH:MM */
  clocks: Set<string>;
}

const NUMBER_IN_TEXT = /\d+(?:\.\d+)?/g;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/g;
const CLOCK_IN_TEXT = /(?<![\d:])(\d{1,2}):(\d{2})(?::\d{2})?(?![\d:])/g;

/** 由证据中的文本（卡片值、表格、理由、告警与变更）、数值与时间戳构造语料 */
export function buildCorpus(
  texts: readonly string[],
  numbers: readonly number[],
  timestamps: readonly string[],
): NumberCorpus {
  const values: number[] = [...numbers.filter((n) => Number.isFinite(n))];
  const clocks = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(NUMBER_IN_TEXT)) {
      values.push(Number(m[0]));
    }
    for (const m of t.matchAll(CLOCK_IN_TEXT)) {
      clocks.add(`${m[1]!.padStart(2, '0')}:${m[2]}`);
    }
    for (const m of t.matchAll(ISO_TIME)) {
      clocks.add(`${m[1]}:${m[2]}`);
    }
  }
  for (const ts of timestamps) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      clocks.add(d.toISOString().slice(11, 16));
    }
  }
  return { values, clocks };
}

type Unit = 'percent' | 'duration' | 'count' | 'bytes' | 'plain';

const UNITS: Record<string, { unit: Unit; factor: number }> = {
  '%': { unit: 'percent', factor: 1 },
  毫秒: { unit: 'duration', factor: 0.001 },
  ms: { unit: 'duration', factor: 0.001 },
  秒: { unit: 'duration', factor: 1 },
  s: { unit: 'duration', factor: 1 },
  分钟: { unit: 'duration', factor: 60 },
  min: { unit: 'duration', factor: 60 },
  小时: { unit: 'duration', factor: 3600 },
  h: { unit: 'duration', factor: 3600 },
  天: { unit: 'duration', factor: 86400 },
  次: { unit: 'count', factor: 1 },
  倍: { unit: 'count', factor: 1 },
  个: { unit: 'count', factor: 1 },
  KiB: { unit: 'bytes', factor: 1024 },
  MiB: { unit: 'bytes', factor: 1024 ** 2 },
  GiB: { unit: 'bytes', factor: 1024 ** 3 },
  Ki: { unit: 'bytes', factor: 1024 },
  Mi: { unit: 'bytes', factor: 1024 ** 2 },
  Gi: { unit: 'bytes', factor: 1024 ** 3 },
  KB: { unit: 'bytes', factor: 1e3 },
  MB: { unit: 'bytes', factor: 1e6 },
  GB: { unit: 'bytes', factor: 1e9 },
};

// 数值断言：前面不是标识符或命令的一部分（字母、数字、点、连字符、冒号、斜线、等号、下划线）
const UNIT_NUMBER =
  /(?<![\p{L}\d.\-:/=_])(\d+(?:\.\d+)?)\s?(%|毫秒|ms|秒|分钟|min|小时|天|次|倍|个|KiB|MiB|GiB|Ki|Mi|Gi|KB|MB|GB|s|h)(?![A-Za-z\d])/gu;
const BARE_DECIMAL = /(?<![\p{L}\d.\-:/=_])(\d+\.\d+)(?![\p{L}\d.%_])/gu;

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.01);

function supported(v: number, u: Unit, factor: number, corpus: NumberCorpus): boolean {
  for (const c of corpus.values) {
    if (close(v, c)) {
      return true;
    }
    if (u === 'percent' && close(v, c * 100)) {
      return true;
    }
    if ((u === 'duration' || u === 'bytes') && factor !== 1) {
      // 语料里的同一个量可能用基本单位（秒、字节）记录
      if (close(v * factor, c) || close(v, c * factor)) {
        return true;
      }
    }
    if (u === 'duration' && (close(v * 60, c) || close(v, c * 60) || close(v * 3600, c))) {
      return true;
    }
  }
  return false;
}

/** 一段文字里无法核实的数值断言 */
export function unsupportedClaims(text: string, corpus: NumberCorpus): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CLOCK_IN_TEXT)) {
    const hh = Number(m[1]);
    if (hh > 23) {
      continue;
    }
    if (!corpus.clocks.has(`${m[1]!.padStart(2, '0')}:${m[2]}`)) {
      out.push(m[0]);
    }
  }
  // 时刻里的数字不再按数值检查
  const rest = text.replace(CLOCK_IN_TEXT, ' ');
  for (const m of rest.matchAll(UNIT_NUMBER)) {
    const u = UNITS[m[2]!]!;
    if (!supported(Number(m[1]), u.unit, u.factor, corpus)) {
      out.push(m[0]);
    }
  }
  for (const m of rest.replace(UNIT_NUMBER, ' ').matchAll(BARE_DECIMAL)) {
    if (!supported(Number(m[1]), 'plain', 1, corpus)) {
      out.push(m[0]);
    }
  }
  return out;
}

/** 一张证据卡里可以作为数值依据的文本、数值与时刻 */
export function cardMaterial(r: EvidenceResult): { texts: string[]; numbers: number[]; times: string[] } {
  const texts = [r.value ?? '', r.reason.text, ...(r.table?.rows.flat() ?? []), ...(r.table?.head ?? [])];
  for (const c of r.conditions ?? []) {
    if (c.say) {
      texts.push(c.say);
    }
  }
  const numbers: number[] = [];
  for (const v of [...Object.values(r.observations ?? {}), ...Object.values(r.params ?? {})]) {
    if (typeof v === 'number') {
      numbers.push(v);
    } else if (typeof v === 'string') {
      texts.push(v);
    }
  }
  for (const v of [r.threshold, r.baseline]) {
    if (typeof v === 'number') {
      numbers.push(v);
    }
  }
  const times = [r.window.from, r.window.to, ...(r.anomaly_started_at ? [r.anomaly_started_at] : [])];
  // 错误样例（ADR 0177）：维度值、类别标题与样例原文里的数值（状态码、超时阈值）和各级计数都是证据
  const s = r.samples;
  if (s) {
    numbers.push(s.lines);
    for (const g of s.groups) {
      numbers.push(g.count);
      texts.push(...Object.values(g.dimensions).filter((v): v is string => v !== null));
      times.push(g.first_at, g.last_at);
    }
    for (const k of s.classes) {
      numbers.push(k.count);
      texts.push(k.title?.['zh-CN'] ?? '', k.title?.en ?? '');
      for (const m of k.samples) {
        texts.push(m.text, ...Object.values(m.dimensions).filter((v): v is string => v !== null));
        times.push(m.at);
      }
    }
  }
  return { texts, numbers, times };
}

/** 分句的边界：中英文逗号、分号、句号、问号、叹号、因果箭头与换行 */
const CLAUSE = /([，,；;。！？!?\n]|\s*→\s*)/;
/** 括号内的补充说明（不嵌套） */
const PAREN = /（[^（）]*）|\([^()]*\)/g;

/**
 * 删除含无法核实数值的文字：数值在括号内的补充说明里时只删除这段括号，否则删除所在分句。
 * 返回删除后的文字与被删除的断言；全部分句都被删除时文字为空字符串。
 */
export function auditText(text: string, corpus: NumberCorpus): { text: string; removed: string[] } {
  const removed: string[] = [];
  const unbracketed = text.replace(PAREN, (p) => {
    const bad = unsupportedClaims(p, corpus);
    if (bad.length) {
      removed.push(...bad);
      return '';
    }
    return p;
  });
  const parts = unbracketed.split(CLAUSE);
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i]!;
    const sep = parts[i + 1] ?? '';
    const bad = unsupportedClaims(clause, corpus);
    if (bad.length) {
      removed.push(...bad);
      continue;
    }
    kept.push(clause + sep);
  }
  if (!removed.length) {
    return { text, removed };
  }
  const joined = kept
    .join('')
    .replace(/^[，,；;。→\s]+/, '')
    .replace(/[，,；;→\s]+$/, '')
    .trim();
  return { text: joined, removed };
}
