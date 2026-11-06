import type { KubeWarningQuery, LabelProfile, MetricSeries } from '@srenautix/contract';
import { assertValid } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { parseServerConfig } from '../../src/config/server.js';
import {
  eventObservations,
  eventsLogql,
  ksmObservations,
  ksmQueries,
  kubeEventsSource,
  type Observation,
} from '../../src/export/kube-events.js';
import {
  buildKubeWarningReport,
  DEFAULT_GROUPING,
  stepSecondsFor,
  type KubeWarningIncident,
  type Placement,
} from '../../src/export/kube-warnings.js';

// 导出用的 Warning 摘要与疑似同一根因分组（ADR 0185）。场景：两个 8GiB 节点 node-a、node-b 内存不足，kubelet 驱逐
// api 与 control 的 Pod；随后 HPA 到顶、control 的新 Pod 调度失败（Insufficient memory + PV 节点亲和）、api 的 5xx 与
// 错误预算燃烧。node-c 上的 worker 只有重启退避，6 小时之后 node-a 上还有一个无关的事件。

const T0 = Date.parse('2026-11-03T08:00:00Z');
const min = (m: number) => T0 + m * 60_000;
const at = (m: number) => new Date(min(m)).toISOString();
const STEP_MS = 60_000;

const API = 'Deployment:shop/api';
const CONTROL = 'StatefulSet:shop/control';
const WORKER = 'Deployment:shop/worker';

const ids = {
  controlHpa: '00000000-0000-4000-8000-000000000001',
  apiHpa: '00000000-0000-4000-8000-000000000002',
  schedule: '00000000-0000-4000-8000-000000000003',
  api5xx: '00000000-0000-4000-8000-000000000004',
  budget: '00000000-0000-4000-8000-000000000005',
  worker: '00000000-0000-4000-8000-000000000006',
  later: '00000000-0000-4000-8000-000000000007',
};

const incident = (id: string, from: number, to: number, component: string, alertnames: string[]) => ({
  incident_id: id,
  window: { from: at(from), to: at(to) },
  components: [component],
  alertnames,
});

const incidents: KubeWarningIncident[] = [
  incident(ids.controlHpa, 14, 70, CONTROL, ['KubeHpaMaxedOut']),
  incident(ids.apiHpa, 13, 65, API, ['ApiHpaMaxedOut']),
  incident(ids.schedule, 25, 45, CONTROL, ['KubePodCreateOrScheduleFailing']),
  incident(ids.api5xx, 11, 40, API, ['ApiReadyzFailing', 'ApiHigh5xxRate']),
  incident(ids.budget, 30, 90, API, ['ApiErrorBudgetBurnFast', 'ApiErrorBudgetBurnSlow']),
  incident(ids.worker, 10, 50, WORKER, ['WorkerQueueBacklog']),
  incident(ids.later, 400, 420, API, ['ApiLatencyHigh']),
];

const src = kubeEventsSource(
  {
    format: 'alloy_json',
    fields: {},
    reasons: ['Evicted', 'FailedScheduling', 'BackOff', 'EvictionThresholdMet', 'NodeHasInsufficientMemory'],
  },
  null,
);

/** Loki 按 alloy_json 的查询返回的一条序列：标签是 srx_* 字段与日志流标签 namespace；points 为 (分钟, 条数) */
function eventSeries(
  reason: string,
  kind: string,
  namespace: string,
  name: string,
  node: string,
  memory: boolean,
  points: Array<[number, number]>,
): MetricSeries {
  const labels: Record<string, string> = { srx_reason: reason, srx_kind: kind, srx_name: name };
  if (namespace) {
    labels['namespace'] = namespace;
  }
  if (node) {
    labels['srx_node'] = node;
  }
  if (memory) {
    labels['srx_memory'] = reason === 'FailedScheduling' ? 'Insufficient memory' : 'low on resource: memory';
  }
  return { labels, times: points.map(([m]) => min(m)), values: points.map(([, v]) => v) };
}

const lokiSeries: MetricSeries[] = [
  eventSeries('EvictionThresholdMet', 'Node', '', 'node-a', 'node-a', true, [
    [10, 1],
    [11, 1],
  ]),
  eventSeries('NodeHasInsufficientMemory', 'Node', '', 'node-a', 'node-a', false, [[10, 1]]),
  eventSeries('Evicted', 'Pod', 'shop', 'api-7d9f-a1', 'node-a', true, [[12, 1]]),
  eventSeries('Evicted', 'Pod', 'shop', 'control-0', 'node-a', true, [[12, 1]]),
  eventSeries('EvictionThresholdMet', 'Node', '', 'node-b', 'node-b', true, [[19, 1]]),
  eventSeries('Evicted', 'Pod', 'shop', 'api-7d9f-b2', 'node-b', true, [[20, 1]]),
  eventSeries('Evicted', 'Pod', 'shop', 'control-1', 'node-b', true, [[22, 2]]),
  eventSeries('FailedScheduling', 'Pod', 'shop', 'control-2', '', true, [
    [26, 3],
    [30, 4],
    [40, 2],
  ]),
  eventSeries('BackOff', 'Pod', 'jobs', 'worker-5c-x1', 'node-c', false, [
    [15, 6],
    [30, 6],
  ]),
  // 解析失败的行没有 reason，跳过
  { labels: { namespace: 'shop' }, times: [min(12)], values: [9] },
];

/** 拓扑历史：api 与 control 各有 Pod 在 node-a、node-b 上，control-2 没有调度成功；worker 在 node-c 上 */
const owned: Array<Omit<Placement, 'scales'>> = [
  { component: API, object: API, node: null, from: min(0), to: min(480) },
  { component: API, object: 'ReplicaSet:shop/api-7d9f', node: null, from: min(0), to: min(480) },
  { component: API, object: 'Pod:shop/api-7d9f-a1', node: 'node-a', from: min(-600), to: min(12) },
  { component: API, object: 'Pod:shop/api-7d9f-b2', node: 'node-b', from: min(-600), to: min(20) },
  { component: API, object: 'Pod:shop/api-7d9f-a3', node: 'node-a', from: min(30), to: Number.POSITIVE_INFINITY },
  { component: CONTROL, object: CONTROL, node: null, from: min(0), to: min(480) },
  { component: CONTROL, object: 'Pod:shop/control-0', node: 'node-a', from: min(-600), to: min(12) },
  { component: CONTROL, object: 'Pod:shop/control-1', node: 'node-b', from: min(-600), to: min(22) },
  { component: CONTROL, object: 'Pod:shop/control-2', node: null, from: min(0), to: min(480) },
  { component: WORKER, object: WORKER, node: null, from: min(0), to: min(480) },
  { component: WORKER, object: 'Pod:jobs/worker-5c-x1', node: 'node-c', from: min(-600), to: Number.POSITIVE_INFINITY },
];
const placements: Placement[] = owned.map((p) => ({ ...p, scales: null }));

const ok = (name: string, source: KubeWarningQuery['source']): KubeWarningQuery => ({
  name,
  source,
  query: name,
  status: 'ok',
  series: 1,
  detail: null,
  duration_ms: 1,
});

function report(
  observations: Observation[],
  queries: KubeWarningQuery[] = [ok('events', 'events'), ok('oom_killed', 'kube_state_metrics')],
) {
  const windows = incidents.map((i) => ({ from: Date.parse(i.window.from), to: Date.parse(i.window.to!) }));
  return buildKubeWarningReport({
    clusterId: 'c1',
    incidents,
    windows,
    span: { from: Math.min(...windows.map((w) => w.from)), to: Math.max(...windows.map((w) => w.to)) },
    stepMs: STEP_MS,
    observations,
    placements,
    queries,
    grouping: DEFAULT_GROUPING,
  });
}

const count = (reason: string, n: number, memory: number | null) => ({
  reason,
  source: 'events',
  unit: 'occurrences',
  count: n,
  memory,
});

describe('疑似同一根因：node_memory_eviction', () => {
  const r = report(eventObservations(src, lokiSeries));

  it('两个节点的内存驱逐与之后的 HPA 到顶、调度失败、5xx、错误预算燃烧归为一组，并列出全部关联告警', () => {
    expect(() => assertValid('schemas/kube-warnings.schema.json', r)).not.toThrow();
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0]!;
    expect(g.kind).toBe('node_memory_eviction');
    expect(g.suspected).toBe(true);
    expect(g.nodes.map((n) => n.node)).toEqual(['node-a', 'node-b']);
    expect(g.incidents.map((i) => i.incident_id).sort()).toEqual(
      [ids.controlHpa, ids.apiHpa, ids.schedule, ids.api5xx, ids.budget].sort(),
    );
    expect(g.alertnames).toEqual([
      'ApiErrorBudgetBurnFast',
      'ApiErrorBudgetBurnSlow',
      'ApiHigh5xxRate',
      'ApiHpaMaxedOut',
      'ApiReadyzFailing',
      'KubeHpaMaxedOut',
      'KubePodCreateOrScheduleFailing',
    ]);
    expect(g.window).toEqual({ from: at(9), to: at(22) });
  });

  it('依据列出节点的信号时间段与各原因计数、事件的重叠时长', () => {
    const g = r.groups[0]!;
    const a = g.nodes.find((n) => n.node === 'node-a')!;
    expect(a.signal_windows).toEqual([{ from: at(9), to: at(12) }]);
    expect(a.counts).toEqual([
      count('Evicted', 2, 2),
      count('EvictionThresholdMet', 2, 2),
      count('NodeHasInsufficientMemory', 1, 0),
    ]);
    const b = g.nodes.find((n) => n.node === 'node-b')!;
    expect(b.signal_windows).toEqual([{ from: at(18), to: at(22) }]);
    const api5xx = g.incidents.find((i) => i.incident_id === ids.api5xx)!;
    expect(api5xx.nodes).toEqual(['node-a', 'node-b']);
    // 5xx 从第 11 分钟开始：与 node-a 的 [9, 12] 重叠 1 分钟，与 node-b 的 [18, 22] 重叠 4 分钟
    expect(api5xx.overlap_seconds).toBe(300);
    // 预算燃烧在信号结束 8 分钟后开始（after 30 分钟以内）
    const budget = g.incidents.find((i) => i.incident_id === ids.budget)!;
    expect(budget.overlap_seconds).toBe(0);
    const schedule = g.incidents.find((i) => i.incident_id === ids.schedule)!;
    expect(schedule.counts).toEqual([count('FailedScheduling', 9, 9)]);
  });

  it('无关节点上的事件与时间相隔很远的事件不进组', () => {
    const inGroup = new Set(r.groups.flatMap((g) => g.incidents.map((i) => i.incident_id)));
    expect(inGroup.has(ids.worker)).toBe(false);
    expect(inGroup.has(ids.later)).toBe(false);
  });

  it('被驱逐后调度失败的组件在事件时间窗里已经不在原节点上，按信号时间段内的位置相连', () => {
    const schedule = r.groups[0]!.incidents.find((i) => i.incident_id === ids.schedule)!;
    expect(schedule.nodes).toEqual(['node-a', 'node-b']);
    expect(r.summaries.find((s) => s.incident_id === ids.schedule)!.nodes).toEqual([]);
  });

  it('只有一个事件与信号相连时不成组', () => {
    const single = buildKubeWarningReport({
      clusterId: 'c1',
      incidents: [incidents[5]!],
      windows: [{ from: min(10), to: min(50) }],
      span: { from: min(10), to: min(50) },
      stepMs: STEP_MS,
      observations: eventObservations(src, [
        eventSeries('Evicted', 'Pod', 'jobs', 'worker-5c-x1', 'node-c', true, [[20, 1]]),
      ]),
      placements,
      queries: [],
      grouping: DEFAULT_GROUPING,
    });
    expect(single.groups).toEqual([]);
  });

  it('不是内存原因的驱逐与容器自身的 OOMKilled 不算节点信号', () => {
    const withoutMemory = lokiSeries.map((s) =>
      s.labels['srx_reason'] === 'BackOff' ? s : { ...s, labels: { ...s.labels, srx_memory: '' } },
    );
    const notMemory = eventObservations(src, withoutMemory).filter((o) => o.reason !== 'NodeHasInsufficientMemory');
    const oom: Observation[] = [min(12), min(20)].map((t) => ({
      t,
      reason: 'OOMKilled',
      source: 'kube_state_metrics',
      unit: 'occurrences',
      object: { kind: 'Pod', namespace: 'shop', name: 'api-7d9f-a1' },
      node: 'node-a',
      memory: null,
      count: 1,
    }));
    expect(report([...notMemory, ...oom]).groups).toEqual([]);
  });
});

describe('每个事件的 Warning 摘要', () => {
  const r = report(eventObservations(src, lokiSeries));
  const summary = (id: string) => r.summaries.find((s) => s.incident_id === id)!;

  it('顺序与请求相同，计数完整', () => {
    expect(r.summaries.map((s) => s.incident_id)).toEqual(incidents.map((i) => i.incident_id));
    expect(r.complete).toBe(true);
    expect(r.summaries.every((s) => s.complete)).toBe(true);
  });

  it('组件对象上的计数与组件所在节点上的计数，节点注明依据', () => {
    const s = summary(ids.api5xx);
    expect(s.counts).toEqual([count('Evicted', 2, 2)]);
    expect(s.nodes.map((n) => [n.node, n.via])).toEqual([
      ['node-a', ['topology', 'events']],
      ['node-b', ['topology', 'events']],
    ]);
    const b = s.nodes.find((n) => n.node === 'node-b')!;
    expect(b.counts).toEqual([count('Evicted', 3, 3), count('EvictionThresholdMet', 1, 1)]);
    expect(s.objects.map((o) => [o.name, o.nodes])).toEqual([
      ['api-7d9f-a1', ['node-a']],
      ['api-7d9f-b2', ['node-b']],
    ]);
  });

  it('没有节点的调度失败计入组件，不归到节点', () => {
    const s = summary(ids.schedule);
    expect(s.counts).toEqual([count('FailedScheduling', 9, 9)]);
    expect(s.objects).toEqual([
      { kind: 'Pod', namespace: 'shop', name: 'control-2', nodes: [], counts: [count('FailedScheduling', 9, 9)] },
    ]);
  });

  it('组件是节点时以节点本身为依据', () => {
    const r2 = buildKubeWarningReport({
      clusterId: 'c1',
      incidents: [incident('00000000-0000-4000-8000-000000000008', 0, 30, 'Node:node-a', ['NodeMemoryHigh'])],
      windows: [{ from: min(0), to: min(30) }],
      span: { from: min(0), to: min(30) },
      stepMs: STEP_MS,
      observations: eventObservations(src, lokiSeries),
      placements: [],
      queries: [],
      grouping: DEFAULT_GROUPING,
    });
    const s = r2.summaries[0]!;
    expect(s.nodes.map((n) => [n.node, n.via])).toEqual([['node-a', ['component', 'events']]]);
    expect(s.counts.map((c) => [c.reason, c.count])).toEqual([
      ['EvictionThresholdMet', 2],
      ['NodeHasInsufficientMemory', 1],
    ]);
  });

  it('查询失败或截断时报告与每条摘要都标明不完整', () => {
    const failed: KubeWarningQuery = { ...ok('events', 'events'), status: 'failed', series: 0, detail: 'HTTP 400' };
    const r2 = report([], [failed, ok('oom_killed', 'kube_state_metrics')]);
    expect(r2.complete).toBe(false);
    expect(r2.summaries.every((s) => !s.complete)).toBe(true);
    expect(r2.queries[0]).toEqual(failed);
    expect(() => assertValid('schemas/kube-warnings.schema.json', r2)).not.toThrow();
  });
});

describe('组件是 HPA：从伸缩对象展开', () => {
  const HPA = 'HorizontalPodAutoscaler:shop/control';
  // control 的 HPA 到顶告警以 HPA 为组件；拓扑历史在事件时间窗内没有 scales 边，placements 取最近一次已知的 scales 边
  const hpaIncidents = incidents.map((i) => (i.incident_id === ids.controlHpa ? { ...i, components: [HPA] } : i));
  const viaHpa = (basis: 'in_window' | 'last_known'): Placement[] =>
    placements
      .filter((p) => p.component === CONTROL)
      .map((p) => ({ ...p, component: HPA, scales: { target: CONTROL, basis } }));
  const build = (extra: Placement[]) => {
    const windows = hpaIncidents.map((i) => ({ from: Date.parse(i.window.from), to: Date.parse(i.window.to!) }));
    return buildKubeWarningReport({
      clusterId: 'c1',
      incidents: hpaIncidents,
      windows,
      span: { from: Math.min(...windows.map((w) => w.from)), to: Math.max(...windows.map((w) => w.to)) },
      stepMs: STEP_MS,
      observations: eventObservations(src, lokiSeries),
      placements: [...placements, ...extra],
      queries: [ok('events', 'events'), ok('oom_killed', 'kube_state_metrics')],
      grouping: DEFAULT_GROUPING,
    });
  };

  it('最近已知的伸缩关系：HPA 事件得到伸缩对象的节点与计数并进组，摘要标明关系的依据', () => {
    const r = build(viaHpa('last_known'));
    expect(() => assertValid('schemas/kube-warnings.schema.json', r)).not.toThrow();
    const s = r.summaries.find((x) => x.incident_id === ids.controlHpa)!;
    expect(s.scale_targets).toEqual([{ hpa: HPA, target: CONTROL, basis: 'last_known' }]);
    expect(s.nodes.map((n) => [n.node, n.via])).toEqual([['node-b', ['topology', 'events']]]);
    expect(s.counts).toEqual([count('Evicted', 2, 2), count('FailedScheduling', 9, 9)]);
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0]!.incidents.find((i) => i.incident_id === ids.controlHpa)!;
    expect(g.nodes).toEqual(['node-a', 'node-b']);
    // 组件不是 HPA 的事件没有伸缩对象
    expect(r.summaries.find((x) => x.incident_id === ids.schedule)!.scale_targets).toEqual([]);
  });

  it('时间窗内的伸缩关系标为 in_window', () => {
    const s = build(viaHpa('in_window')).summaries.find((x) => x.incident_id === ids.controlHpa)!;
    expect(s.scale_targets).toEqual([{ hpa: HPA, target: CONTROL, basis: 'in_window' }]);
  });

  it('拓扑里从来没有这个 HPA 的 scales 边时，HPA 事件没有对象与节点，不进组', () => {
    const r = build([]);
    const s = r.summaries.find((x) => x.incident_id === ids.controlHpa)!;
    expect(s.scale_targets).toEqual([]);
    expect(s.nodes).toEqual([]);
    expect(s.objects).toEqual([]);
    expect(r.groups[0]!.incidents.map((i) => i.incident_id)).not.toContain(ids.controlHpa);
  });
});

describe('事件日志的查询与解析', () => {
  it('alloy_json：日志流选择器加集群标签，字段提取到带前缀的标签，命名空间取日志流标签', () => {
    const s = kubeEventsSource(
      { format: 'alloy_json', stream: { job: 'kubernetes-events' }, fields: {}, reasons: ['Evicted', 'BackOff'] },
      'cluster',
    );
    expect(eventsLogql(s, 'c1', 180)).toBe(
      'sum by (srx_reason, srx_kind, namespace, srx_name, srx_node, srx_memory) (count_over_time(' +
        '{job="kubernetes-events", cluster="c1"} |~ "Evicted|BackOff"' +
        ' | json srx_reason="reason", srx_kind="kind", srx_name="name", srx_node="sourcehost"' +
        ' | srx_reason=~"Evicted|BackOff"' +
        ' | regexp "(?P<srx_memory>low on resource: memory|Insufficient memory|reclaim memory)" [180s]))',
    );
  });

  it('kubernetes_event_exporter 与 eventrouter 取 Event 对象的嵌套字段，必须配置日志流', () => {
    expect(() =>
      kubeEventsSource({ format: 'kubernetes_event_exporter', fields: {}, reasons: ['Evicted'] }, null),
    ).toThrow(/kube_events\.stream/);
    const exporter = kubeEventsSource(
      { format: 'kubernetes_event_exporter', stream: { app: 'event-exporter' }, fields: {}, reasons: ['Evicted'] },
      null,
    );
    expect(eventsLogql(exporter, 'c1', 60)).toContain(
      '| json srx_reason="reason", srx_kind="involvedObject.kind", srx_namespace="involvedObject.namespace", ' +
        'srx_name="involvedObject.name", srx_node="source.host"',
    );
    const router = kubeEventsSource(
      {
        format: 'eventrouter',
        stream: { app: 'eventrouter' },
        fields: { node: { label: 'host' } },
        reasons: ['Evicted'],
      },
      null,
    );
    const q = eventsLogql(router, 'c1', 60);
    expect(q).toContain('srx_reason="event.reason"');
    expect(q).toContain('sum by (srx_reason, srx_kind, srx_namespace, srx_name, host, srx_memory)');
    expect(q).not.toContain('srx_node=');
  });

  it('alloy_logfmt 用 logfmt 解析器', () => {
    const s = kubeEventsSource({ format: 'alloy_logfmt', fields: {}, reasons: ['Evicted'] }, null);
    expect(eventsLogql(s, 'c1', 60)).toContain(
      '{job="loki.source.kubernetes_events"} |~ "Evicted" | logfmt srx_reason="reason"',
    );
  });

  it('节点对象的事件以对象名为节点、没有命名空间', () => {
    const series = eventSeries('EvictionThresholdMet', 'Node', 'default', 'node-a', '', true, [[1, 2]]);
    expect(eventObservations(src, [series])).toEqual([
      {
        t: min(1),
        reason: 'EvictionThresholdMet',
        source: 'events',
        unit: 'occurrences',
        object: { kind: 'Node', namespace: null, name: 'node-a' },
        node: 'node-a',
        memory: true,
        count: 2,
      },
    ]);
  });
});

describe('kube-state-metrics 的查询与降级', () => {
  const profile: LabelProfile = {
    namespace: 'namespace',
    pod: 'pod',
    container: 'container',
    node: 'node',
    cluster: 'cluster',
    scrape_interval_seconds: 30,
    tenant: null,
  };

  it('Loki 可用时只查 OOMKilled，不可用时另查驱逐、调度失败、CrashLoopBackOff 与 MemoryPressure', () => {
    expect(ksmQueries(profile, 'c1', 60, false).map((q) => q.name)).toEqual(['oom_killed']);
    const all = ksmQueries(profile, 'c1', 60, true);
    expect(all.map((q) => [q.name, q.reason, q.unit])).toEqual([
      ['oom_killed', 'OOMKilled', 'occurrences'],
      ['evicted', 'Evicted', 'pods'],
      ['unschedulable', 'FailedScheduling', 'pods'],
      ['crash_loop', 'BackOff', 'pods'],
      ['memory_pressure', 'NodeHasInsufficientMemory', 'seconds'],
    ]);
    const restarts = 'kube_pod_container_status_restarts_total{cluster="c1"}';
    expect(all[0]!.expr).toBe(
      `sum by (namespace, pod, node) ((((${restarts} - ${restarts} offset 60s) > 0)` +
        ' and on (namespace, pod, container)' +
        ' (max_over_time(kube_pod_container_status_last_terminated_reason{cluster="c1", reason="OOMKilled"}[60s]) == 1))' +
        ' * on (namespace, pod) group_left (node)' +
        ' topk by (namespace, pod) (1, max by (namespace, pod, node) (kube_pod_info{cluster="c1"})))',
    );
  });

  it('被驱逐的 Pod 只在第一次出现的分桶计一次，范围开始前已经被驱逐的不计', () => {
    const q = ksmQueries(profile, 'c1', 60, true).find((x) => x.name === 'evicted')!;
    const series: MetricSeries[] = [
      { labels: { namespace: 'shop', pod: 'old', node: 'node-a' }, times: [min(0), min(1), min(2)], values: [1, 1, 1] },
      { labels: { namespace: 'shop', pod: 'new', node: 'node-a' }, times: [min(5), min(6)], values: [1, 1] },
    ];
    expect(ksmObservations(q, profile, series, 60, min(0))).toEqual([
      {
        t: min(5),
        reason: 'Evicted',
        source: 'kube_state_metrics',
        unit: 'pods',
        object: { kind: 'Pod', namespace: 'shop', name: 'new' },
        node: 'node-a',
        memory: null,
        count: 1,
      },
    ]);
  });

  it('MemoryPressure 的秒数按分桶计算，并作为节点内存信号成组', () => {
    const q = ksmQueries(profile, 'c1', 60, true).find((x) => x.name === 'memory_pressure')!;
    const series = [{ labels: { node: 'node-a' }, times: [min(9), min(10), min(11)], values: [1, 1, 1] }];
    const obs = ksmObservations(q, profile, series, 60, min(0));
    expect(obs.map((o) => [o.node, o.count])).toEqual([
      ['node-a', 60],
      ['node-a', 60],
      ['node-a', 60],
    ]);
    const r = report(obs);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.nodes[0]!.counts).toEqual([
      { reason: 'NodeHasInsufficientMemory', source: 'kube_state_metrics', unit: 'seconds', count: 180, memory: null },
    ]);
  });
});

describe('分桶宽度与配置', () => {
  it('3 天用 3 分钟的 step，短时间窗不小于 60 秒', () => {
    expect(stepSecondsFor(3 * 86_400_000)).toBe(180);
    expect(stepSecondsFor(10 * 60_000)).toBe(60);
  });

  const minimal = (loki: Record<string, unknown>) => ({
    cluster_id: 'c1',
    profile: 'observe',
    public_url: 'https://srenautix.example.com',
    ingest: { sources: [{ id: 'am', kind: 'alertmanager', token_file: '/t' }] },
    datasources: { prometheus: { url: 'http://127.0.0.1:9' }, loki },
    packs: { dirs: ['/packs'] },
    callers: { tokens_file: '/callers.yaml' },
    identity: { bindings_dir: '/bindings' },
    audit: { checkpoint_key_file: '/checkpoint.pem' },
  });

  it('datasources.loki.kube_events 默认是 Alloy 的 json 格式', () => {
    const k = parseServerConfig(minimal({ url: 'http://loki:3100' })).datasources.loki!.kube_events;
    expect(k.format).toBe('alloy_json');
    expect(k.stream).toBeUndefined();
    expect(k.reasons).toContain('Evicted');
    expect(k.max_series).toBe(5000);
  });

  it('没有约定日志流的格式必须填写 stream', () => {
    const exporter = { format: 'kubernetes_event_exporter' };
    expect(() => parseServerConfig(minimal({ url: 'http://loki:3100', kube_events: exporter }))).toThrow(
      /kube_events\.stream/,
    );
    const k = parseServerConfig(
      minimal({
        url: 'http://loki:3100',
        kube_events: { ...exporter, stream: { app: 'event-exporter' }, fields: { node: { label: 'host' } } },
      }),
    ).datasources.loki!.kube_events;
    expect(kubeEventsSource(k, null).fields.node).toEqual({ label: 'host' });
  });
});
