// analyze.memory_kind@v1（ADR 0181 §11，docs/skills/oom-rootcause.zh-CN.md §4.2）：每次发生的分类。
// kind：node_pressure（驱逐、节点内存压力）、container_limit（容器 limit 触发的 OOMKilled）、near_limit（持续贴近 limit、没有终止）、
// unknown。Go 服务另给 heap：live_heap_at_limit（存活堆贴着 GOMEMLIMIT、GC 连续运行也收不回）、non_heap（堆之外的内存占满 limit）、
// no_gomemlimit、no_data，以及没有 GC CPU 指标、用容器 CPU 代替时的推断标注。

import type { AroundWindow, EvidenceRow, KubeEvent, Lang, Occurrence, PodSummary } from './data.js';
import { fmtTime, fmtValue, maxOf, pick, sumSeries, valueAt, within } from './stats.js';

export interface MemorySignals {
  /** Go：存活堆（heap_inuse）；其他：RSS */
  heap: string;
  next_gc: string;
  gomemlimit: string;
  gc_cpu: string;
  gomaxprocs: string;
  rss: string;
  container_limit: string;
  cpu: string;
  node_memory_available: string;
}

export interface MemoryThresholds {
  heap_near_limit_ratio: number;
  next_gc_near_limit_ratio: number;
  gc_cpu_ratio: number;
  gc_cpu_sustain_seconds: number;
  /** 节点可用内存比例低于它算节点压力 */
  node_available_min: number;
}

export type MemoryKind = 'node_pressure' | 'container_limit' | 'near_limit' | 'unknown';
export type HeapState = 'live_heap_at_limit' | 'non_heap' | 'no_gomemlimit' | 'not_at_limit' | 'no_data' | 'not_go';

export interface ClassifiedOccurrence extends Occurrence {
  at_text: string;
  kind: MemoryKind;
  kind_text: string;
  heap: HeapState;
  heap_text: string;
  /** 用容器 CPU 代替 GC CPU */
  gc_proxy: boolean;
  /** 发生之前 5 分钟内内存序列的峰值与上限 */
  memory_peak: number | null;
  memory_limit: number | null;
  note: string;
}

export interface MemoryKindOutput {
  runtime: 'go' | 'other';
  /** 后续步骤使用的内存序列与上限：Go 为 heap_inuse 与 GOMEMLIMIT，其他为 RSS 与容器 limit */
  memory_signal: string;
  limit_signal: string;
  occurrences: ClassifiedOccurrence[];
  /** 现象一节的事实：limit、GOMEMLIMIT、GOMAXPROCS、镜像 */
  facts: { limit: string | null; gomemlimit: string | null; gomaxprocs: string | null; image: string | null };
  rows: EvidenceRow[];
  inferred: string[];
}

const FIVE_MIN = 5 * 60_000;

function podSeries(w: AroundWindow, key: string) {
  const d = w.signals[key];
  if (!d) {
    return { expr: '', points: [] };
  }
  const own = d.series.filter((s) => !s.labels.pod || s.labels.pod === w.pod);
  return { expr: d.expr, points: sumSeries(own) };
}

export function classifyMemory(i: {
  runtime: 'go' | 'other';
  container: string;
  occurrences: readonly Occurrence[];
  pods: readonly PodSummary[];
  kubeEvents: readonly KubeEvent[];
  around: readonly AroundWindow[];
  signals: MemorySignals;
  thresholds: MemoryThresholds;
  lang: Lang;
}): MemoryKindOutput {
  const L = i.lang;
  const go = i.runtime === 'go';
  const memorySignal = go ? i.signals.heap : i.signals.rss;
  const limitSignal = go ? i.signals.gomemlimit : i.signals.container_limit;
  const rows: EvidenceRow[] = [];
  const inferred: string[] = [];
  const out: ClassifiedOccurrence[] = [];
  let facts: MemoryKindOutput['facts'] = { limit: null, gomemlimit: null, gomaxprocs: null, image: null };

  for (const o of i.occurrences) {
    const w = i.around.find((x) => x.pod === o.pod && x.at === o.at);
    const pod = i.pods.find((p) => p.name === o.pod);
    const c = pod?.containers.find((x) => x.name === o.container);
    const evicted =
      o.cause === 'evicted' ||
      pod?.reason === 'Evicted' ||
      i.kubeEvents.some(
        (e) =>
          e.object.endsWith(`/${o.pod}`) &&
          e.reason === 'Evicted' &&
          e.last !== null &&
          Math.abs(e.last - o.at) < FIVE_MIN,
      );
    const pre = (key: string) => (w ? within(podSeries(w, key).points, o.at - FIVE_MIN, o.at) : []);
    const nodeAvail = pre(i.signals.node_memory_available);
    const nodeMin = nodeAvail.length ? Math.min(...nodeAvail.map((p) => p.v)) : null;
    let kind: MemoryKind;
    if (evicted || (nodeMin !== null && nodeMin < i.thresholds.node_available_min)) {
      kind = 'node_pressure';
    } else if (o.cause === 'near_limit') {
      kind = 'near_limit';
    } else if (o.cause === 'oom_killed') {
      kind = 'container_limit';
    } else {
      kind = 'unknown';
    }

    const heapPts = pre(i.signals.heap);
    const limitPts = pre(i.signals.gomemlimit);
    const nextGcPts = pre(i.signals.next_gc);
    const rssPts = pre(i.signals.rss);
    const climitPts = pre(i.signals.container_limit);
    const climit = maxOf(climitPts) ?? c?.memory_limit_bytes ?? null;
    const gomemlimit = maxOf(limitPts);
    const gomaxprocs = maxOf(pre(i.signals.gomaxprocs));
    let heap: HeapState = 'not_go';
    let gcProxy = false;
    let gcText = '';
    if (go) {
      const heapMax = maxOf(heapPts);
      if (heapMax === null) {
        heap = 'no_data';
      } else if (gomemlimit === null || (climit !== null && gomemlimit >= climit)) {
        heap = 'no_gomemlimit';
      } else {
        const nextGc = maxOf(nextGcPts);
        let gc = within(podSeries(w!, i.signals.gc_cpu).points, o.at - FIVE_MIN, o.at);
        if (!gc.length) {
          gc = within(podSeries(w!, i.signals.cpu).points, o.at - FIVE_MIN, o.at);
          gcProxy = gc.length > 0;
        }
        const procs = gomaxprocs ?? 0;
        const busy = gc.filter((p) => procs > 0 && p.v >= i.thresholds.gc_cpu_ratio * procs);
        const step = gc.length > 1 ? (gc[gc.length - 1]!.t - gc[0]!.t) / (gc.length - 1) : 0;
        const sustained = busy.length * step >= i.thresholds.gc_cpu_sustain_seconds * 1000;
        const rssMax = maxOf(rssPts);
        if (
          heapMax / gomemlimit >= i.thresholds.heap_near_limit_ratio &&
          nextGc !== null &&
          nextGc / gomemlimit >= i.thresholds.next_gc_near_limit_ratio &&
          sustained
        ) {
          heap = 'live_heap_at_limit';
        } else if (rssMax !== null && climit !== null && rssMax / climit >= 0.95 && heapMax / gomemlimit < 0.7) {
          heap = 'non_heap';
        } else {
          heap = 'not_at_limit';
        }
        const cpuMax = maxOf(gc);
        gcText =
          cpuMax !== null && procs > 0
            ? pick(
                L,
                `${gcProxy ? '容器 CPU' : 'GC CPU'} 最高 ${fmtValue(cpuMax, 'cores')} 核（GOMAXPROCS ${procs} 的 ${Math.round((cpuMax / procs) * 100)}%）`,
                `${gcProxy ? 'container CPU' : 'GC CPU'} peaked at ${fmtValue(cpuMax, 'cores')} cores (${Math.round((cpuMax / procs) * 100)}% of GOMAXPROCS ${procs})`,
              )
            : '';
        if (gcProxy && heap === 'live_heap_at_limit') {
          const t = pick(
            L,
            `${o.pod} ${fmtTime(o.at)}：没有 GC CPU 指标，用容器 CPU 作为 GC 连续运行的依据`,
            `${o.pod} ${fmtTime(o.at)}: no GC CPU metric; container CPU is used as the sign of continuous GC`,
          );
          inferred.push(t);
        }
      }
    }
    const memoryPeak = maxOf(go ? heapPts : rssPts);
    const memoryLimit = go ? gomemlimit : climit;
    if (!facts.limit && climit !== null) {
      facts = {
        limit: fmtValue(climit, 'bytes'),
        gomemlimit: gomemlimit !== null ? String(Math.round(gomemlimit)) : null,
        gomaxprocs: gomaxprocs !== null ? String(Math.round(gomaxprocs)) : null,
        image: c?.image ?? null,
      };
    }
    const KIND: Record<MemoryKind, [string, string]> = {
      node_pressure: ['节点内存压力', 'node memory pressure'],
      container_limit: ['容器 limit 触发', 'container limit'],
      near_limit: ['持续贴近 limit', 'near the limit'],
      unknown: ['原因不明', 'unknown'],
    };
    const HEAP: Record<HeapState, [string, string]> = {
      live_heap_at_limit: [
        '存活堆贴着 GOMEMLIMIT，GC 连续运行也收不回：占用的是存活数据',
        'the live heap sat at GOMEMLIMIT and continuous GC could not reclaim it: the memory is live data',
      ],
      non_heap: ['堆之外的内存（goroutine stack、mmap、cgo）占满了 limit', 'memory outside the heap filled the limit'],
      no_gomemlimit: ['GOMEMLIMIT 没有生效', 'GOMEMLIMIT is not in effect'],
      not_at_limit: ['存活堆没有贴近 GOMEMLIMIT', 'the live heap was not near GOMEMLIMIT'],
      no_data: ['没有 Go 运行时指标', 'no Go runtime metrics'],
      not_go: ['', ''],
    };
    const kindText = pick(L, ...KIND[kind]);
    const heapText = pick(L, ...HEAP[heap]);
    const rssAt = valueAt(rssPts, o.at);
    out.push({
      ...o,
      at_text: fmtTime(o.at),
      kind,
      kind_text: kindText,
      heap,
      heap_text: heapText,
      gc_proxy: gcProxy,
      memory_peak: memoryPeak,
      memory_limit: memoryLimit,
      note: [
        memoryPeak !== null
          ? pick(L, `内存峰值 ${fmtValue(memoryPeak, 'bytes')}`, `memory peak ${fmtValue(memoryPeak, 'bytes')}`)
          : '',
        gcText,
      ]
        .filter(Boolean)
        .join(pick(L, '，', ', ')),
    });
    if (w) {
      const memExpr = podSeries(w, memorySignal).expr;
      const heapStart = valueAt(podSeries(w, memorySignal).points, w.from + 60_000);
      rows.push({
        when: fmtTime(o.at),
        pod: o.pod,
        what: pick(L, go ? 'heap_inuse / GOMEMLIMIT' : 'RSS / limit', go ? 'heap_inuse / GOMEMLIMIT' : 'RSS / limit'),
        value: `${fmtValue(heapStart, 'bytes')} → ${fmtValue(memoryPeak, 'bytes')} / ${fmtValue(memoryLimit, 'bytes')}`,
        basis: pick(L, '观测', 'observed'),
        query: memExpr,
      });
      if (go && rssAt !== null) {
        rows.push({
          when: fmtTime(o.at),
          pod: o.pod,
          what: 'RSS / limit',
          value: `${fmtValue(maxOf(rssPts), 'bytes')} / ${fmtValue(climit, 'bytes')}`,
          basis: pick(L, '观测', 'observed'),
          query: podSeries(w, i.signals.rss).expr,
        });
      }
      if (gcText) {
        rows.push({
          when: fmtTime(o.at),
          pod: o.pod,
          what: gcProxy ? pick(L, '容器 CPU（代替 GC CPU）', 'container CPU (for GC CPU)') : 'GC CPU',
          value: gcText,
          basis: gcProxy ? pick(L, '推断（代替）', 'inferred (proxy)') : pick(L, '观测', 'observed'),
          query: podSeries(w, gcProxy ? i.signals.cpu : i.signals.gc_cpu).expr,
        });
      }
      if (nodeMin !== null) {
        rows.push({
          when: fmtTime(o.at),
          pod: o.pod,
          what: pick(L, '节点可用内存', 'node memory available'),
          value: fmtValue(nodeMin, 'ratio'),
          basis: pick(L, '观测', 'observed'),
          query: podSeries(w, i.signals.node_memory_available).expr,
        });
      }
    }
  }
  return {
    runtime: i.runtime,
    memory_signal: memorySignal,
    limit_signal: limitSignal,
    occurrences: out,
    facts,
    rows,
    inferred,
  };
}
