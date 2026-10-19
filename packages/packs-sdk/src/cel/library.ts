// 证据卡 CEL 运行时的函数库（DESIGN §6.1）：
// - 聚合：max/min/last/sum/count/none
// - 序列：points、any_point、transitions、top_share、join、ratio
// - 展示：fmt_pct/fmt_bytes/fmt_secs/fmt_num、label
// let 在判定层声明（judge.let），表达式内的局部绑定用 CEL 标准的 cel.bind。
// 序列在 CEL 中是 map：{labels, times（unix 秒）, values}，只含有值的点。

import { Environment } from '@marcbachmann/cel-js';
import type { CelSeries } from '../judge/data.js';
import { NoSamplesError } from './errors.js';
import { fmtBytes, fmtNum, fmtPct, fmtSecs } from './format.js';

type SeriesLike = CelSeries | { line: string };

function isSeries(x: unknown): x is CelSeries {
  return typeof x === 'object' && x !== null && 'values' in x && Array.isArray((x as CelSeries).values);
}

function asSeriesList(list: unknown[], fn: string): CelSeries[] {
  return list.map((x) => {
    if (!isSeries(x)) {
      throw new TypeError(`${fn}() 只接受指标序列`);
    }
    return x;
  });
}

function allValues(list: unknown[], fn: string): number[] {
  const v = asSeriesList(list, fn).flatMap((s) => s.values);
  if (!v.length) {
    throw new NoSamplesError(`${fn}() 的输入`);
  }
  return v;
}

function lastValues(list: unknown[], fn: string): number[] {
  const v = asSeriesList(list, fn)
    .filter((s) => s.values.length > 0)
    .map((s) => s.values[s.values.length - 1]!);
  if (!v.length) {
    throw new NoSamplesError(`${fn}() 的输入`);
  }
  return v;
}

function seriesValues(s: unknown, fn: string): number[] {
  if (!isSeries(s)) {
    throw new TypeError(`${fn}() 只接受指标序列`);
  }
  if (!s.values.length) {
    throw new NoSamplesError(`${fn}() 的输入`);
  }
  return s.values;
}

const sumOf = (v: number[]) => v.reduce((a, b) => a + b, 0);

/** 两个序列按共同标签匹配时使用的键：只取双方都有的标签 */
function joinKey(labels: Record<string, string>, names: string[]): string {
  return JSON.stringify(names.map((n) => labels[n] ?? ''));
}

function applyOp(op: string, a: number, b: number): number | null {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return b === 0 ? null : a / b;
    default:
      throw new TypeError(`join() 不支持的运算符：${op}`);
  }
}

function points(list: unknown[]) {
  return asSeriesList(list, 'points').flatMap((s) =>
    s.values.map((v, i) => ({ t: s.times[i]!, v, labels: s.labels })),
  );
}

// cel-js 的宏在解析期展开；any_point 复用库内的上下文分叉机制（与 cel.bind 相同）
interface MacroCtx {
  forkWithVariable(name: string, type: unknown): MacroCtx;
  reuse(parent: MacroCtx): MacroCtx;
  setIterValue(v: unknown, ev: unknown): MacroCtx;
}
interface MacroChecker {
  check(ast: unknown, ctx: MacroCtx): { isDynOrBool?: () => boolean };
  getType(name: string): unknown;
}
interface MacroEvaluator {
  run(ast: unknown, ctx: MacroCtx): unknown;
}
interface MacroAst {
  op: string;
  args: unknown;
}

function identifierOf(node: unknown, what: string): string {
  const n = node as MacroAst;
  if (n.op !== 'id' || typeof n.args !== 'string') {
    throw new TypeError(`${what} 的第二个参数必须是变量名`);
  }
  return n.args;
}

interface AnyPointMacro {
  ref: unknown;
  name: string;
  pred: unknown;
  predCtx: MacroCtx | undefined;
  async: boolean;
  typeCheck(checker: MacroChecker, macro: AnyPointMacro, ctx: MacroCtx): unknown;
  evaluate(ev: MacroEvaluator, macro: AnyPointMacro, ctx: MacroCtx): boolean;
}

function registerMacros(env: Environment): Environment {
  env.registerFunction('any_point(ast, ast, ast): bool', ({ args }: { args: unknown[] }) => {
    const m: AnyPointMacro = {
      ref: args[0],
      name: identifierOf(args[1], 'any_point'),
      pred: args[2],
      predCtx: undefined,
      async: false,
      typeCheck(checker, macro, ctx) {
        checker.check(macro.ref, ctx);
        macro.predCtx = ctx.forkWithVariable(macro.name, checker.getType('map'));
        checker.check(macro.pred, macro.predCtx);
        return checker.getType('bool');
      },
      evaluate(ev, macro, ctx) {
        const list = ev.run(macro.ref, ctx);
        if (!Array.isArray(list)) {
          throw new TypeError('any_point() 的第一个参数必须是序列列表');
        }
        for (const p of points(list)) {
          const r = ev.run(macro.pred, macro.predCtx!.reuse(ctx).setIterValue(p, ev));
          if (typeof r !== 'boolean') {
            throw new TypeError('any_point() 的谓词必须返回 bool');
          }
          if (r) {
            return true;
          }
        }
        return false;
      },
    };
    return m;
  });
  return env;
}

/** 函数库的固定部分；每张卡在它的克隆上声明自己的变量 */
export function createBaseEnvironment(): Environment {
  const env = new Environment({
    homogeneousAggregateLiterals: false,
    limits: { maxAstNodes: 400, maxDepth: 40, maxListElements: 64, maxMapEntries: 64, maxCallArguments: 8 },
  });
  env
    .registerFunction('max(list): double', (l: unknown[]) => Math.max(...allValues(l, 'max')))
    .registerFunction('max(map): double', (s: unknown) => Math.max(...seriesValues(s, 'max')))
    .registerFunction('min(list): double', (l: unknown[]) => Math.min(...allValues(l, 'min')))
    .registerFunction('min(map): double', (s: unknown) => Math.min(...seriesValues(s, 'min')))
    // 多条序列时取各序列最后一个点中的最大值，结果与后端返回序列的顺序无关
    .registerFunction('last(list): double', (l: unknown[]) => Math.max(...lastValues(l, 'last')))
    .registerFunction('last(map): double', (s: unknown) => {
      const v = seriesValues(s, 'last');
      return v[v.length - 1]!;
    })
    .registerFunction('sum(list): double', (l: unknown[]) => sumOf(lastValues(l, 'sum')))
    .registerFunction('sum(map): double', (s: unknown) => sumOf(seriesValues(s, 'sum')))
    .registerFunction('count(list): int', (l: unknown[]) =>
      BigInt(l.filter((x) => !isSeries(x) || x.values.length > 0).length),
    )
    .registerFunction('none(list): bool', (l: unknown[]) =>
      (l as SeriesLike[]).every((x) => isSeries(x) && x.values.length === 0),
    )
    .registerFunction('points(list): list', (l: unknown[]) => points(l))
    .registerFunction('transitions(list): list', (l: unknown[]) =>
      asSeriesList(l, 'transitions').flatMap((s) => {
        const out: Array<{ t: number; from: number; to: number; labels: Record<string, string> }> = [];
        for (let i = 1; i < s.values.length; i++) {
          if (s.values[i] !== s.values[i - 1]) {
            out.push({ t: s.times[i]!, from: s.values[i - 1]!, to: s.values[i]!, labels: s.labels });
          }
        }
        return out;
      }),
    )
    .registerFunction('top_share(list, int): double', (l: unknown[], k: bigint) => {
      const v = lastValues(l, 'top_share').sort((a, b) => b - a);
      const total = sumOf(v);
      if (total === 0) {
        throw new NoSamplesError('top_share() 的非零总量');
      }
      return sumOf(v.slice(0, Number(k))) / total;
    })
    .registerFunction('ratio(list, list): double', (a: unknown[], b: unknown[]) => {
      const den = sumOf(lastValues(b, 'ratio'));
      if (den === 0) {
        throw new NoSamplesError('ratio() 的非零分母');
      }
      return sumOf(lastValues(a, 'ratio')) / den;
    })
    .registerFunction('join(list, list, string): list', (a: unknown[], b: unknown[], op: string) => {
      const left = asSeriesList(a, 'join').filter((s) => s.values.length);
      const right = asSeriesList(b, 'join').filter((s) => s.values.length);
      const out: CelSeries[] = [];
      for (const l of left) {
        for (const r of right) {
          const shared = Object.keys(l.labels).filter((k) => k in r.labels);
          if (joinKey(l.labels, shared) !== joinKey(r.labels, shared)) {
            continue;
          }
          const v = applyOp(op, l.values[l.values.length - 1]!, r.values[r.values.length - 1]!);
          if (v === null) {
            continue;
          }
          const t = Math.max(l.times[l.times.length - 1]!, r.times[r.times.length - 1]!);
          out.push({ labels: { ...r.labels, ...l.labels }, times: [t], values: [v] });
        }
      }
      return out;
    })
    .registerFunction('label(map, string): string', (s: unknown, name: string) => {
      const labels = (s as { labels?: Record<string, string> }).labels;
      if (!labels) {
        throw new TypeError('label() 的第一个参数必须是序列或日志行');
      }
      return labels[name] ?? '';
    })
    .registerFunction('abs(double): double', (x: number) => Math.abs(x))
    .registerFunction('fmt_pct(double): string', (x: number) => fmtPct(x))
    .registerFunction('fmt_bytes(double): string', (x: number) => fmtBytes(x))
    .registerFunction('fmt_secs(double): string', (x: number) => fmtSecs(x))
    .registerFunction('fmt_num(double): string', (x: number) => fmtNum(x));
  return registerMacros(env);
}

/** 运行时为卡片提供的保留变量名 */
export const RESERVED_NAMES = new Set(['params', 'entity', 'window', 'row', 'cards', 'incident', 'root']);
