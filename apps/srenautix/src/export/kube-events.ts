// Kubernetes Warning 的聚合查询（ADR 0185）：Loki 里事件采集器写入的事件日志按 (reason, 对象, 节点) 分桶计数，
// kube-state-metrics 的指标给出 OOMKilled 与 Loki 不可用时的降级计数。查询数固定，与事件数无关；
// 结果解析成与来源无关的观测（Observation），由 kube-warnings.ts 归到各事件。
import type { KubeWarningSource, KubeWarningUnit, LabelProfile, MetricSeries } from '@srenautix/contract';
import { logqlString, re2Escape } from '@srenautix/integration-sdk';

/** Loki 与 Prometheus 的标签名 */
export const LOKI_LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 默认计数的事件 reason：驱逐、调度失败、重启退避、容器 OOM，以及 kubelet 在节点内存不足时记录的
 * EvictionThresholdMet（Warning）、NodeHasInsufficientMemory（kubelet 记为 Normal）、SystemOOM，
 * 和 node-problem-detector 的 OOMKilling
 */
export const DEFAULT_KUBE_WARNING_REASONS = [
  'Evicted',
  'OOMKilled',
  'OOMKilling',
  'SystemOOM',
  'FailedScheduling',
  'BackOff',
  'EvictionThresholdMet',
  'NodeHasInsufficientMemory',
] as const;

/** 事件消息里表示与内存有关的片段：驱逐（low on resource: memory）、调度（Insufficient memory）、回收（reclaim memory） */
export const MEMORY_MESSAGE = 'low on resource: memory|Insufficient memory|reclaim memory';

export type KubeEventField = { line: string } | { label: string };

export interface KubeEventFormat {
  parser: 'json' | 'logfmt';
  /** 约定的日志流选择器（标签名 → 取值）；没有约定时为 null，部署方必须填写 */
  stream: Readonly<Record<string, string>> | null;
  fields: Readonly<Record<'reason' | 'kind' | 'namespace' | 'name' | 'node', KubeEventField>>;
}

/**
 * 常见事件采集器的格式：
 * - alloy_json、alloy_logfmt：Grafana Alloy 的 loki.source.kubernetes_events（log_format 为 json 或 fmt），
 *   日志行的字段为 name、kind、reason、type、sourcehost、msg 等，命名空间是日志流标签 namespace，默认 job 为组件名；
 * - kubernetes_event_exporter：kubernetes-event-exporter 的 Loki 接收器，日志行是整个 Event 对象；
 * - eventrouter：eventrouter 的 json 输出，Event 对象在 event 字段下。
 * 节点取 kubelet 记录事件时的 source.host；节点对象的事件以对象名为节点
 */
export const KUBE_EVENT_FORMATS = {
  alloy_json: {
    parser: 'json',
    stream: { job: 'loki.source.kubernetes_events' },
    fields: {
      reason: { line: 'reason' },
      kind: { line: 'kind' },
      namespace: { label: 'namespace' },
      name: { line: 'name' },
      node: { line: 'sourcehost' },
    },
  },
  alloy_logfmt: {
    parser: 'logfmt',
    stream: { job: 'loki.source.kubernetes_events' },
    fields: {
      reason: { line: 'reason' },
      kind: { line: 'kind' },
      namespace: { label: 'namespace' },
      name: { line: 'name' },
      node: { line: 'sourcehost' },
    },
  },
  kubernetes_event_exporter: {
    parser: 'json',
    stream: null,
    fields: {
      reason: { line: 'reason' },
      kind: { line: 'involvedObject.kind' },
      namespace: { line: 'involvedObject.namespace' },
      name: { line: 'involvedObject.name' },
      node: { line: 'source.host' },
    },
  },
  eventrouter: {
    parser: 'json',
    stream: null,
    fields: {
      reason: { line: 'event.reason' },
      kind: { line: 'event.involvedObject.kind' },
      namespace: { line: 'event.involvedObject.namespace' },
      name: { line: 'event.involvedObject.name' },
      node: { line: 'event.source.host' },
    },
  },
} as const satisfies Record<string, KubeEventFormat>;

export type KubeEventFormatName = keyof typeof KUBE_EVENT_FORMATS;
export const KUBE_EVENT_FORMAT_NAMES = Object.keys(KUBE_EVENT_FORMATS) as [
  KubeEventFormatName,
  ...KubeEventFormatName[],
];

/** 解析后的事件日志来源：选择器、解析器、字段来源与计数的 reason */
export interface KubeEventsSource {
  parser: 'json' | 'logfmt';
  stream: Readonly<Record<string, string>>;
  fields: KubeEventFormat['fields'];
  reasons: readonly string[];
  /** 日志流上的集群标签（datasources.loki.labels.cluster）；单集群时为 null */
  clusterLabel: string | null;
}

/** server 配置 datasources.loki.kube_events → 事件日志来源（格式的默认值叠加部署方的覆盖） */
export function kubeEventsSource(
  cfg: {
    format: KubeEventFormatName;
    stream?: Record<string, string> | undefined;
    fields: Partial<Record<keyof KubeEventFormat['fields'], KubeEventField | undefined>>;
    reasons: readonly string[];
  },
  clusterLabel: string | null,
): KubeEventsSource {
  const f: KubeEventFormat = KUBE_EVENT_FORMATS[cfg.format];
  const stream = cfg.stream ?? f.stream;
  if (stream === null || !Object.keys(stream).length) {
    throw new TypeError(`事件日志格式 ${cfg.format} 没有约定的日志流标签，必须配置 kube_events.stream`);
  }
  const pick = (k: keyof KubeEventFormat['fields']) => cfg.fields[k] ?? f.fields[k];
  return {
    parser: f.parser,
    stream,
    fields: {
      reason: pick('reason'),
      kind: pick('kind'),
      namespace: pick('namespace'),
      name: pick('name'),
      node: pick('node'),
    },
    reasons: cfg.reasons,
    clusterLabel,
  };
}

/** 查询结果里各字段所在的标签：解析器提取的字段用带前缀的名字，避免与日志流标签、structured metadata 同名 */
const EXTRACTED: Record<keyof KubeEventFormat['fields'], string> = {
  reason: 'srx_reason',
  kind: 'srx_kind',
  namespace: 'srx_namespace',
  name: 'srx_name',
  node: 'srx_node',
};
const MEMORY_LABEL = 'srx_memory';

function resultLabel(src: KubeEventsSource, field: keyof KubeEventFormat['fields']): string {
  const f = src.fields[field];
  return 'label' in f ? f.label : EXTRACTED[field];
}

/**
 * 事件计数的 LogQL：每个求值时刻统计前一个 step 内的事件条数，按 reason、对象、节点与消息是否提到内存分组。
 * 先用行过滤只读含有这些 reason 的行，再解析与精确匹配 reason
 */
export function eventsLogql(src: KubeEventsSource, clusterId: string, stepSeconds: number): string {
  const matchers = Object.entries(src.stream)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${logqlString(v)}`);
  if (src.clusterLabel) {
    matchers.push(`${src.clusterLabel}=${logqlString(clusterId)}`);
  }
  const reasons = src.reasons.map(re2Escape).join('|');
  const extract = (Object.keys(EXTRACTED) as Array<keyof KubeEventFormat['fields']>)
    .flatMap((k) => {
      const f = src.fields[k];
      return 'line' in f ? [`${EXTRACTED[k]}=${logqlString(f.line)}`] : [];
    })
    .join(', ');
  const by = [
    ...new Set([
      resultLabel(src, 'reason'),
      resultLabel(src, 'kind'),
      resultLabel(src, 'namespace'),
      resultLabel(src, 'name'),
      resultLabel(src, 'node'),
      MEMORY_LABEL,
    ]),
  ].join(', ');
  return (
    `sum by (${by}) (count_over_time({${matchers.join(', ')}} |~ ${logqlString(reasons)}` +
    ` | ${src.parser}${extract ? ` ${extract}` : ''}` +
    ` | ${resultLabel(src, 'reason')}=~${logqlString(reasons)}` +
    ` | regexp ${logqlString(`(?P<${MEMORY_LABEL}>${MEMORY_MESSAGE})`)} [${stepSeconds}s]))`
  );
}

/** 与来源无关的一个计数观测：t 时刻结束、长度为一个 step 的分桶里，某个对象（或节点）上某个 reason 的计数 */
export interface Observation {
  /** 分桶的结束时刻（unix 毫秒），分桶为 (t - step, t] */
  t: number;
  reason: string;
  source: KubeWarningSource;
  unit: KubeWarningUnit;
  /** 事件涉及的对象；节点状态的计数没有对象 */
  object: { kind: string; namespace: string | null; name: string } | null;
  /** 数据本身给出的节点：节点对象的事件取对象名，kubelet 记录的事件取 source.host，指标取 kube_pod_info 的节点 */
  node: string | null;
  /** 消息是否提到内存；来源不带消息时为 null */
  memory: boolean | null;
  count: number;
}

const blank = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);

/** 事件计数查询的结果 → 观测；计数为 0 的点跳过，reason 或对象名缺失的序列（解析失败的行）跳过 */
export function eventObservations(src: KubeEventsSource, series: readonly MetricSeries[]): Observation[] {
  const out: Observation[] = [];
  for (const s of series) {
    const reason = blank(s.labels[resultLabel(src, 'reason')]);
    const kind = blank(s.labels[resultLabel(src, 'kind')]);
    const name = blank(s.labels[resultLabel(src, 'name')]);
    if (reason === null || name === null) {
      continue;
    }
    const isNode = kind === 'Node';
    const node = isNode ? name : blank(s.labels[resultLabel(src, 'node')]);
    const object =
      kind === null ? null : { kind, namespace: isNode ? null : blank(s.labels[resultLabel(src, 'namespace')]), name };
    const memory = blank(s.labels[MEMORY_LABEL]) !== null;
    s.times.forEach((t, i) => {
      const v = s.values[i];
      if (v !== null && v !== undefined && v > 0) {
        out.push({ t, reason, source: 'events', unit: 'occurrences', object, node, memory, count: Math.round(v) });
      }
    });
  }
  return out;
}

/** kube-state-metrics 的查询名 */
export type KsmQueryName = 'oom_killed' | 'evicted' | 'unschedulable' | 'crash_loop' | 'memory_pressure';

export interface KsmQuery {
  name: KsmQueryName;
  expr: string;
  /** 计数对应的事件 reason 与单位 */
  reason: string;
  unit: KubeWarningUnit;
}

/**
 * kube-state-metrics 的查询（标签名按数据源的标签档案改写，集群外部标签存在时按集群过滤）：
 * - oom_killed：容器在一个 step 内重启、且上次终止原因为 OOMKilled 的重启次数（Loki 可用时也执行，事件里没有容器 OOM）；
 * - evicted、unschedulable、crash_loop、memory_pressure：Loki 不可用时的降级，分别对应 Evicted、FailedScheduling、
 *   BackOff（CrashLoopBackOff）、NodeHasInsufficientMemory（节点 MemoryPressure 条件）。
 * Pod 的节点取 kube_pod_info 的节点标签（同名 Pod 只取一个节点，避免多对多匹配）
 */
export function ksmQueries(
  profile: LabelProfile,
  clusterId: string,
  stepSeconds: number,
  withFallback: boolean,
): KsmQuery[] {
  const ns = profile.namespace;
  const pod = profile.pod;
  const container = profile.container;
  const node = profile.node;
  const sel = (metric: string, extra: string[] = []) => {
    const m = [...(profile.cluster ? [`${profile.cluster}=${JSON.stringify(clusterId)}`] : []), ...extra];
    return m.length ? `${metric}{${m.join(', ')}}` : metric;
  };
  const range = `[${stepSeconds}s]`;
  const podNode = `topk by (${ns}, ${pod}) (1, max by (${ns}, ${pod}, ${node}) (${sel('kube_pod_info')}))`;
  const withNode = (perPod: string) => `(${perPod}) * on (${ns}, ${pod}) group_left (${node}) ${podNode}`;
  // 重启次数取相隔一个 step 的两个瞬时值之差：increase 会按区间外推出非整数的次数
  const restarts = sel('kube_pod_container_status_restarts_total');
  const queries: KsmQuery[] = [
    {
      name: 'oom_killed',
      reason: 'OOMKilled',
      unit: 'occurrences',
      expr: `sum by (${ns}, ${pod}, ${node}) (${withNode(
        `((${restarts} - ${restarts} offset ${stepSeconds}s) > 0)` +
          ` and on (${ns}, ${pod}, ${container})` +
          ` (max_over_time(${sel('kube_pod_container_status_last_terminated_reason', ['reason="OOMKilled"'])}${range}) == 1)`,
      )})`,
    },
  ];
  if (!withFallback) {
    return queries;
  }
  const podState = (metric: string, reason: string) =>
    `max by (${ns}, ${pod}) (max_over_time(${sel(metric, [`reason=${JSON.stringify(reason)}`])}${range})) == 1`;
  queries.push(
    {
      name: 'evicted',
      reason: 'Evicted',
      unit: 'pods',
      expr: `max by (${ns}, ${pod}, ${node}) (${withNode(podState('kube_pod_status_reason', 'Evicted'))})`,
    },
    {
      name: 'unschedulable',
      reason: 'FailedScheduling',
      unit: 'pods',
      expr: `max by (${ns}, ${pod}) (max_over_time(${sel('kube_pod_status_unschedulable')}${range})) == 1`,
    },
    {
      name: 'crash_loop',
      reason: 'BackOff',
      unit: 'pods',
      expr: `max by (${ns}, ${pod}, ${node}) (${withNode(podState('kube_pod_container_status_waiting_reason', 'CrashLoopBackOff'))})`,
    },
    {
      name: 'memory_pressure',
      reason: 'NodeHasInsufficientMemory',
      unit: 'seconds',
      expr:
        `max by (${node}) (max_over_time(${sel('kube_node_status_condition', ['condition="MemoryPressure"', 'status="true"'])}` +
        `${range})) == 1`,
    },
  );
  return queries;
}

/**
 * kube-state-metrics 查询的结果 → 观测。evicted 只在 Pod 第一次出现 Evicted 的分桶计一次（被驱逐的 Pod 对象会保留到
 * 被回收，之后的分桶不再计）；第一个求值时刻（firstT，在导出范围之前一个 step）只用来识别已经被驱逐的 Pod，不产生观测。
 * seconds 单位的计数为一个 step 的秒数
 */
export function ksmObservations(
  q: KsmQuery,
  profile: LabelProfile,
  series: readonly MetricSeries[],
  stepSeconds: number,
  firstT: number,
): Observation[] {
  const out: Observation[] = [];
  for (const s of series) {
    const namespace = blank(s.labels[profile.namespace]);
    const podName = blank(s.labels[profile.pod]);
    const node = blank(s.labels[profile.node]);
    const object = podName === null ? null : { kind: 'Pod', namespace, name: podName };
    if (q.unit === 'seconds' ? node === null : object === null) {
      continue;
    }
    let seen = false;
    s.times.forEach((t, i) => {
      const v = s.values[i];
      if (v === null || v === undefined || v <= 0) {
        return;
      }
      if (q.name === 'evicted') {
        const first = !seen;
        seen = true;
        if (!first) {
          return;
        }
      }
      if (t <= firstT) {
        return;
      }
      const count = q.unit === 'occurrences' ? Math.round(v) : q.unit === 'seconds' ? stepSeconds : 1;
      if (count > 0) {
        out.push({
          t,
          reason: q.reason,
          source: 'kube_state_metrics',
          unit: q.unit,
          object,
          node,
          memory: null,
          count,
        });
      }
    });
  }
  return out;
}
