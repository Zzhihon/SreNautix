// PromQL 与 MetricsQL 的严格解析器：官方 Go 解析器
// （github.com/prometheus/prometheus/promql/parser、github.com/VictoriaMetrics/metricsql）
// 编译为 wasm，由 promql-wasm/ 在构建时生成到 wasm/。适配器用它检查回放时钟窗口，
// packs-sdk 用它做 lint、标签档案改写和夹具展开。

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export type Dialect = 'promql' | 'metricsql';

export interface Matcher {
  label: string;
  op: '=' | '!=' | '=~' | '!~';
  value: string;
}

export interface QueryAnalysis {
  /** PromQL 的结果类型（vector、matrix、scalar、string）；MetricsQL 为空串 */
  type: string;
  selectors: Array<{ metric: string; matchers: Matcher[] }>;
  functions: string[];
  /** 匹配器、分组、向量匹配中出现的标签名 */
  labels: string[];
  normalized: string;
  /** 求值一个时刻需要读取的最早数据距该时刻的毫秒数（区间、offset、子查询与 5 分钟回看） */
  lookback_ms: number;
  /** 负 offset 读取求值时刻之后的数据 */
  lookahead_ms: number;
  /** 使用了 @ 修饰符 */
  has_at: boolean;
}

export class QuerySyntaxError extends Error {
  constructor(
    readonly dialect: Dialect,
    readonly query: string,
    detail: string,
  ) {
    super(`${dialect} 语法错误：${detail}：${query}`);
    this.name = 'QuerySyntaxError';
  }
}

interface WasmApi {
  analyze(expr: string, dialect: Dialect): string;
  rewrite(expr: string, dialect: Dialect, spec: string): string;
  parseSeries(desc: string): string;
}

export interface FixtureSeries {
  labels: Record<string, string>;
  /** 数值；null 表示省略的点；'stale' 表示 staleness marker */
  values: Array<number | null | 'stale' | 'NaN' | '+Inf' | '-Inf'>;
}

export class PromqlEngine {
  constructor(private readonly api: WasmApi) {}

  analyze(expr: string, dialect: Dialect): QueryAnalysis {
    const out = JSON.parse(this.api.analyze(expr, dialect)) as QueryAnalysis & { ok: boolean; error: string };
    if (!out.ok) {
      throw new QuerySyntaxError(dialect, expr, out.error);
    }
    const { ok: _ok, error: _error, ...analysis } = out;
    return analysis;
  }

  /**
   * 按标签档案改写查询：rename 改写标签名（匹配器、by/without、on/ignoring/group_*、
   * label_replace/label_join 的标签参数）；inject 给每个选择器加等值匹配器（例如外部标签 cluster）
   */
  rewrite(expr: string, dialect: Dialect, spec: { rename: Record<string, string>; inject: Record<string, string> }): string {
    const out = JSON.parse(this.api.rewrite(expr, dialect, JSON.stringify(spec))) as {
      ok: boolean;
      error: string;
      expr: string;
    };
    if (!out.ok) {
      throw new QuerySyntaxError(dialect, expr, out.error);
    }
    return out.expr;
  }

  /** 展开 promtool input_series 的写法，例如 `up{job="a"}` 与 `1+1x10 _ stale` */
  parseSeries(desc: string): FixtureSeries {
    const out = JSON.parse(this.api.parseSeries(desc)) as FixtureSeries & { ok: boolean; error: string };
    if (!out.ok) {
      throw new QuerySyntaxError('promql', desc, out.error);
    }
    return { labels: out.labels, values: out.values };
  }
}

let loading: Promise<PromqlEngine> | undefined;

/** 加载 wasm（进程内只加载一次） */
export function loadPromqlEngine(): Promise<PromqlEngine> {
  loading ??= (async () => {
    const dir = new URL('../../wasm/', import.meta.url);
    const require = createRequire(import.meta.url);
    // Go 自带的 wasm 运行胶水，构建时从 $(go env GOROOT)/lib/wasm 复制
    require(new URL('wasm_exec.cjs', dir).pathname);
    const g = globalThis as unknown as {
      Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> };
      __srenautixPromql?: WasmApi;
      __srenautixPromqlReady?: () => void;
    };
    const ready = new Promise<void>((resolve) => {
      g.__srenautixPromqlReady = resolve;
    });
    const go = new g.Go();
    const { instance } = await WebAssembly.instantiate(readFileSync(new URL('promql.wasm', dir)), go.importObject);
    void go.run(instance);
    await ready;
    if (!g.__srenautixPromql) {
      throw new Error('promql.wasm 没有注册接口');
    }
    return new PromqlEngine(g.__srenautixPromql);
  })();
  return loading;
}
