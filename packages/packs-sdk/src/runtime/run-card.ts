// 执行一张证据卡：按信号的选中备选渲染查询、经数据源取数、判定，产出 EvidenceResult（不含 ref 编号）。
// 数据源并发与超时由调用方的数据源实现控制；单个查询失败只影响引用它的规则。

import type { EvidenceResult, LabelProfile, TimeWindow } from '@srenautix/contract';
import { ClockWindowViolation, DatasourceError, toIso, type PromqlEngine } from '@srenautix/integration-sdk';
import type { RefData } from '../judge/data.js';
import { judgeCard, type JudgeInput } from '../judge/card.js';
import type { CardOutcome, Locale } from '../judge/types.js';
import type { CardEntry, PackSet } from '../pack/compile.js';
import { podPattern, renderMetrics, RenderError, substitute, type RenderEntity } from '../signals/render.js';
import type { SignalResolution } from '../signals/resolve.js';
import { CapabilityMissing, type EvidenceDataSource } from './datasource.js';
import { dbstatsCapability, dbstatsSeries, renderDbstats } from './dbstats.js';
import { compileControls, evaluateControls, refsFor } from './controls.js';
import { aggregateSamples, compileSamples, samplesTable, type Redactor } from './samples.js';

/** Prometheus 风格时长转秒 */
export function durationSeconds(d: string): number {
  const re = /([0-9]+)(ms|s|m|h|d|w)/g;
  const unit: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  let consumed = 0;
  for (const m of d.matchAll(re)) {
    total += Number(m[1]) * unit[m[2]!]!;
    consumed += m[0].length;
  }
  if (!consumed || consumed !== d.length) {
    throw new TypeError(`时长格式不对：${d}`);
  }
  return total;
}

export const DEFAULT_WINDOW = { before: '30m', after: '10m' };

export interface RunCardInput {
  set: PackSet;
  card: string;
  entity: RenderEntity;
  /** 事件锚点（首次触发时间），unix 毫秒 */
  anchor: number;
  /** 判定窗口的结束时间不超过这个时刻（实时研判传当前时间） */
  now: number;
  ds: EvidenceDataSource;
  engine: PromqlEngine;
  /** 信号键 → 选中的备选 */
  resolutions: Map<string, SignalResolution>;
  /** 回放时钟窗口；实时研判为 [anchor - 回看, now] */
  clock: TimeWindow;
  params?: Record<string, number | string | boolean>;
  /** 覆盖卡片定义的窗口（阶段 B 把卡片当作区分性检查时，模型可以指定锚点前后的范围） */
  window?: { before: string; after: string };
  /**
   * 长期事件（ADR 0149）：until（评估时刻，unix 毫秒）晚于锚点加 window.after 时，窗口终点取 until，
   * 起点取 max(锚点 − window.before, until − maxWindowMs, notBefore)。不填时窗口只按锚点取。
   */
  extend?: { until: number; maxWindowMs: number; notBefore?: number };
  locale?: Locale;
  timeoutMs?: number;
  /** 错误样例的脱敏函数（ADR 0177）；卡片声明了 samples 时必须提供 */
  redact?: Redactor;
  /** 对照对象随机取样的种子（ADR 0179），事件研判传事件 id，重放时同一个种子得到同一批对象；卡片声明了 controls 时必须提供 */
  controlSeed?: string;
}

export interface RunCardResult extends Omit<EvidenceResult, 'ref'> {
  outcome: CardOutcome;
  /** 每个引用的原始数据，pack test 的自动测试在其上做变换 */
  refs: Record<string, RefData>;
  /** 判定的完整输入，可在变换后的数据上重新判定 */
  judgeInput: JudgeInput;
}

/**
 * 卡片的判定窗口：[锚点 − before, min(锚点 + after, now)]。
 * 长期事件（extend.until 晚于锚点 + after，ADR 0149）：终点取评估时刻，起点不早于终点减去最大窗口，也不早于数据保留期，
 * 锚点留在原处（卡片按 window.anchor 比较前后时，锚点可能早于窗口起点）。
 */
export function cardWindow(
  e: Pick<CardEntry, 'key' | 'def'>,
  anchor: number,
  now: number,
  override?: { before: string; after: string },
  extend?: RunCardInput['extend'],
): { from: number; to: number } {
  const w = override ?? e.def.window ?? DEFAULT_WINDOW;
  let from = anchor - durationSeconds(w.before) * 1000;
  let to = Math.min(anchor + durationSeconds(w.after) * 1000, now);
  if (extend) {
    const until = Math.min(extend.until, now);
    if (until > to) {
      to = until;
      from = Math.max(from, until - extend.maxWindowMs, extend.notBefore ?? -Infinity);
    }
  }
  if (to <= from) {
    throw new RangeError(`卡片 ${e.key} 的窗口为空`);
  }
  return { from, to };
}

/** 区间查询的步长：不小于抓取间隔，最多约 300 个点 */
export function stepSeconds(windowMs: number, profile: LabelProfile): number {
  return Math.max(profile.scrape_interval_seconds, Math.ceil(windowMs / 1000 / 300));
}

export async function runCard(input: RunCardInput): Promise<RunCardResult> {
  const e = input.set.cards.get(input.card);
  if (!e) {
    throw new Error(`没有卡片 ${input.card}`);
  }
  if (e.def.samples && !input.redact) {
    throw new Error(`卡片 ${e.key} 声明了错误样例，执行时必须提供脱敏函数`);
  }
  if (e.def.controls && input.controlSeed === undefined) {
    throw new Error(`卡片 ${e.key} 声明了对照对象，执行时必须提供随机取样的种子`);
  }
  const w = cardWindow(e, input.anchor, input.now, input.window, input.extend);
  const window = { from: toIso(w.from), to: toIso(w.to) };
  const timeout = input.timeoutMs ?? 10_000;
  const refs: Record<string, RefData> = {};
  const queries: EvidenceResult['queries'] = [];

  for (const r of e.def.refs) {
    const sk = e.signals[r.name]!;
    const res = input.resolutions.get(sk);
    const started = Date.now();
    const params = { ...(e.def.params ?? {}), ...(input.params ?? {}), ...(r.params ?? {}) } as Record<
      string,
      number | string | boolean
    >;
    const record = (
      capability: string,
      query: string,
      sampleCount: number,
      truncated: boolean,
      error: string | null,
      integration: string | null,
    ) =>
      queries.push({
        name: r.name,
        integration: integration ?? '',
        capability,
        query,
        sample_count: sampleCount,
        truncated,
        error,
        duration_ms: Date.now() - started,
      });

    if (!res?.alternative) {
      const why = res ? res.rejected.map((x) => `备选 ${x.index}：${x.reason}`).join('；') : '信号没有探测';
      const all = (c: string) => !!res && res.rejected.length > 0 && res.rejected.every((x) => x.cause === c);
      if (all('capability')) {
        // 所有备选都因能力缺失被拒绝：显示能力缺失
        refs[r.name] = { kind: 'capability_missing', capability: res!.rejected[0]!.capability! };
      } else if (all('missing_metric') && (r.empty_is ?? 'no_data') === 'normal') {
        // 过滤型引用的指标不存在：等于没有命中（例如 kube-state-metrics 只在容器等待时才输出等待原因）
        refs[r.name] =
          res!.kind === 'logs'
            ? { kind: 'logs', lines: [], truncated: false }
            : res!.kind === 'traces'
              ? { kind: 'traces', traces: [], truncated: false }
              : { kind: 'metrics', series: [], truncated: false };
      } else {
        refs[r.name] = { kind: 'error', message: `信号 ${sk} 没有可用备选（${why}）` };
      }
      record('unresolved', '', 0, false, why, null);
      continue;
    }
    const alt = res.alternative;
    try {
      if (res.kind === 'metrics') {
        const profile = input.ds.labelProfile;
        if (!profile) {
          throw new CapabilityMissing('metrics.query');
        }
        const ctx = { entity: input.entity, params, windowSeconds: (w.to - w.from) / 1000, profile };
        const expr = renderMetrics(input.engine, alt, ctx);
        const dialect = alt.dialect === 'metricsql' ? 'metricsql' : 'promql';
        const out =
          r.mode === 'range'
            ? await input.ds.queryRange({
                expr,
                dialect,
                window,
                step_seconds: stepSeconds(w.to - w.from, profile),
                clock_window: input.clock,
                timeout_ms: timeout,
                max_series: 200,
              })
            : await input.ds.query({ expr, dialect, time: window.to, clock_window: input.clock, timeout_ms: timeout });
        refs[r.name] = { kind: 'metrics', series: out.series, truncated: out.truncated };
        record(
          r.mode === 'range' ? 'metrics.query_range' : 'metrics.query',
          expr,
          out.series.reduce((a, s) => a + s.values.filter((v) => v !== null).length, 0),
          out.truncated,
          null,
          input.ds.ids.metrics,
        );
      } else if (res.kind === 'logs') {
        const limit = r.limit ?? 50;
        if (alt.dialect === 'logs_match') {
          if (!input.entity.namespace) {
            throw new RenderError('logs.match 需要实体的命名空间');
          }
          const pods = input.entity.kind === 'Pod' ? [input.entity.name] : [];
          const regex = substitute(alt.expr, {
            entity: input.entity,
            params,
            windowSeconds: (w.to - w.from) / 1000,
            profile: input.ds.labelProfile ?? lintProfile(),
          });
          const out = await input.ds.logsMatch({
            selector: {
              cluster_id: input.entity.cluster_id,
              namespace: input.entity.namespace,
              pods,
              containers: [],
              labels: {},
            },
            contains: null,
            regex,
            window,
            limit,
            clock_window: input.clock,
          });
          refs[r.name] = {
            kind: 'logs',
            lines: out.lines.map((l) => ({ time: Date.parse(l.time), labels: l.labels, line: l.line })),
            truncated: out.truncated,
          };
          record('logs.match', regex, out.lines.length, out.truncated, null, input.ds.ids.logs);
        } else {
          const lp = input.ds.logsProfile;
          if (!lp) {
            throw new CapabilityMissing('logs.query');
          }
          const query = substitute(alt.expr.replaceAll('$selector', logsSelector(input.entity, lp)), {
            entity: input.entity,
            params,
            windowSeconds: (w.to - w.from) / 1000,
            profile: input.ds.labelProfile ?? lintProfile(),
          });
          const out = await input.ds.logsQuery({ query, dialect: 'logql', window, limit, clock_window: input.clock });
          refs[r.name] = {
            kind: 'logs',
            lines: out.lines.map((l) => ({ time: Date.parse(l.time), labels: l.labels, line: l.line })),
            truncated: out.truncated,
          };
          record('logs.query', query, out.lines.length, out.truncated, null, input.ds.ids.logs);
        }
      } else if (res.kind === 'dbstats') {
        // dbstats（契约 2.28.0）：每行一条序列，点在采样时刻；速率需要两次采样
        const req = renderDbstats(alt, params);
        const cap = dbstatsCapability(req.op);
        if (!input.ds.dbstats) {
          throw new CapabilityMissing(cap);
        }
        const rate = alt.rate ?? false;
        const out = await input.ds.dbstats(input.entity, req, { at: w.to, rate });
        const series = dbstatsSeries(input.ds.ids.dbstats ?? 'dbstats', out, alt.column ?? '', rate);
        refs[r.name] = { kind: 'metrics', series, truncated: out.current.truncated };
        record(cap, JSON.stringify(req), series.length, out.current.truncated, null, input.ds.ids.dbstats ?? null);
      } else {
        const query = substitute(alt.expr, {
          entity: input.entity,
          params,
          windowSeconds: (w.to - w.from) / 1000,
          profile: input.ds.labelProfile ?? lintProfile(),
        });
        const out = await input.ds.tracesSearch({
          query,
          dialect: 'traceql',
          window,
          limit: r.limit ?? 20,
          clock_window: input.clock,
        });
        refs[r.name] = {
          kind: 'traces',
          traces: out.hits.map((h) => ({ ...h, start: Date.parse(h.start) })),
          truncated: out.truncated,
        };
        record('traces.search', query, out.hits.length, out.truncated, null, input.ds.ids.traces);
      }
    } catch (err) {
      if (err instanceof CapabilityMissing) {
        refs[r.name] = { kind: 'capability_missing', capability: err.capability };
        record(err.capability, '', 0, false, err.message, null);
      } else if (err instanceof DatasourceError || err instanceof ClockWindowViolation || err instanceof RenderError) {
        refs[r.name] = {
          kind: 'error',
          message: err.message,
          ...(err instanceof DatasourceError && err.timeout ? { timeout: true } : {}),
        };
        record(res.kind, '', 0, false, err.message, null);
      } else {
        throw err;
      }
    }
  }

  // 对照对象（ADR 0179）：引用返回同一入口上全部对象的序列，故障对象自己的判定只看它自己的序列（键等于实体名）
  const cc = e.def.controls ? compileControls(e.def.controls, e.def.refs) : null;
  const judgeInput: JudgeInput = {
    refs: cc ? refsFor(cc, refs, input.entity.name) : refs,
    ...(input.params ? { params: input.params } : {}),
    entity: {
      cluster_id: input.entity.cluster_id,
      kind: input.entity.kind,
      namespace: input.entity.namespace,
      name: input.entity.name,
    },
    window: { from: w.from / 1000, to: w.to / 1000, anchor: input.anchor / 1000 },
    ...(input.locale ? { locale: input.locale } : {}),
  };
  const outcome = judgeCard(e.compiled, judgeInput);
  // 对照对象与故障对象用同一张卡、同一个判定输入，换成各自的序列；原始引用数据取全部序列
  const controls = cc
    ? evaluateControls(cc, e.compiled, { ...judgeInput, refs }, input.entity.name, input.controlSeed!)
    : null;
  // 错误样例（ADR 0177）：没有声明 display.table 时维度组合写成卡片的表格
  const sc = e.def.samples ? compileSamples(e.def.samples, e.def.refs, e.def.egress) : null;
  const samples = sc ? aggregateSamples(sc, refs[sc.spec.ref], input.redact!) : null;
  const table =
    sc && samples && !e.def.display?.table ? samplesTable(sc, samples, input.locale ?? 'zh-CN') : outcome.table;
  return {
    judgeInput,
    card_id: e.key,
    title: e.def.title,
    threshold: outcome.threshold,
    series: sketches(refs),
    entity: {
      cluster_id: input.entity.cluster_id,
      kind: input.entity.kind,
      namespace: input.entity.namespace,
      name: input.entity.name,
      uid: null,
    },
    window,
    verdict: outcome.verdict,
    display_state: outcome.display_state,
    reason: outcome.reason,
    value: outcome.value,
    table,
    queries,
    egress: e.def.egress,
    anomaly_started_at: outcome.anomaly_started_at === null ? null : toIso(outcome.anomaly_started_at * 1000),
    evaluated_at: new Date().toISOString(),
    unit: e.def.display?.unit ?? 'none',
    observations: outcome.observations,
    params: outcome.params,
    conditions: outcome.conditions,
    baseline: outcome.baseline,
    impact: e.def.impact ?? false,
    category: e.def.category ?? null,
    value_number: outcome.value_number,
    ...(samples ? { samples } : {}),
    ...(controls ? { controls } : {}),
    outcome,
    refs,
  };
}

const SKETCH_POINTS = 300;
const SKETCH_SERIES = 20;

/** 迷你图用的降采样序列：每个指标引用最多 20 条，每条最多 300 点（等间隔抽取，保留首尾） */
function sketches(refs: Record<string, RefData>): EvidenceResult['series'] {
  const out: EvidenceResult['series'] = [];
  for (const [ref, d] of Object.entries(refs)) {
    if (d.kind !== 'metrics') {
      continue;
    }
    for (const s of d.series.slice(0, SKETCH_SERIES)) {
      const n = s.times.length;
      const idx =
        n <= SKETCH_POINTS
          ? s.times.map((_, i) => i)
          : Array.from({ length: SKETCH_POINTS }, (_, i) => Math.round((i * (n - 1)) / (SKETCH_POINTS - 1)));
      out.push({
        ref,
        labels: s.labels,
        points: idx.map((i) => {
          const v = s.values[i]!;
          return [s.times[i]! / 1000, v === null || Number.isFinite(v) ? v : null] as [number, number | null];
        }),
      });
    }
  }
  return out;
}

function lintProfile(): LabelProfile {
  return {
    namespace: 'namespace',
    pod: 'pod',
    container: 'container',
    node: 'node',
    cluster: null,
    scrape_interval_seconds: 30,
    tenant: null,
  };
}

/** LogQL 流选择器中的实体匹配器 */
function logsSelector(e: RenderEntity, lp: { namespace: string; pod: string; cluster: string | null }): string {
  const q = (v: string) => JSON.stringify(v);
  const parts: string[] = [];
  if (lp.cluster) {
    parts.push(`${lp.cluster}=${q(e.cluster_id)}`);
  }
  if (e.namespace) {
    parts.push(`${lp.namespace}=${q(e.namespace)}`);
  }
  if (e.kind === 'Pod') {
    parts.push(`${lp.pod}=${q(e.name)}`);
  } else {
    const p = podPattern(e);
    if (p) {
      parts.push(`${lp.pod}=~${q(p)}`);
    }
  }
  if (!parts.length) {
    throw new RenderError(`${e.kind} ${e.name} 无法生成日志流选择器`);
  }
  return parts.join(', ');
}
