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
  locale?: Locale;
  timeoutMs?: number;
}

export interface RunCardResult extends Omit<EvidenceResult, 'ref'> {
  outcome: CardOutcome;
  /** 每个引用的原始数据，pack test 的自动测试在其上做变换 */
  refs: Record<string, RefData>;
  /** 判定的完整输入，可在变换后的数据上重新判定 */
  judgeInput: JudgeInput;
}

function cardWindow(e: CardEntry, anchor: number, now: number): { from: number; to: number } {
  const w = e.def.window ?? DEFAULT_WINDOW;
  const from = anchor - durationSeconds(w.before) * 1000;
  const to = Math.min(anchor + durationSeconds(w.after) * 1000, now);
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
  const w = cardWindow(e, input.anchor, input.now);
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
      // 所有备选都因能力缺失被拒绝时显示能力缺失，否则为数据源侧没有这个信号
      const caps = res?.rejected.filter((x) => x.reason.startsWith('数据源没有能力')) ?? [];
      if (res && caps.length === res.rejected.length && caps.length > 0) {
        refs[r.name] = { kind: 'capability_missing', capability: caps[0]!.reason.replace('数据源没有能力 ', '') };
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
        refs[r.name] = { kind: 'error', message: err.message };
        record(res.kind, '', 0, false, err.message, null);
      } else {
        throw err;
      }
    }
  }

  const judgeInput: JudgeInput = {
    refs,
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
    table: outcome.table,
    queries,
    egress: e.def.egress,
    anomaly_started_at: outcome.anomaly_started_at === null ? null : toIso(outcome.anomaly_started_at * 1000),
    evaluated_at: new Date().toISOString(),
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
