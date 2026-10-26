import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Alert, EvidenceResult, Incident, IncidentMember, StageAReport } from '@srenautix/contract';
import type { ComposeInput } from '../../src/notify/compose.js';
import { REPORT_LINKS } from './report-fixture.js';

/**
 * 业务关键信号的黄金用例（ADR 0148）：按 cchp-k8s-ops#249 那一类 gateway OOM 事件重建的卡片组合——
 * gateway StatefulSet 内存峰值 94% 且有容器被 OOM 终止，CrashLoop、指标端点不可达与发布未就绪的告警反复触发，
 * 70 个成员告警、53 张阶段 A 证据卡（cchp 包的卡还没有 category，按证据链名推断；内置包的卡带 category）。
 * 数值、时间与对象名是按那次事件整理的样例值，命名空间与集群沿用 CCHP 的写法。
 */

const OTHER_CARDS = resolve(import.meta.dirname, '../fixtures/report/gateway-oom-2026-10-23.other-cards.json');
const CLUSTER = 'cchp';
const NS = 'cchp-prod';
const T0 = Date.parse('2026-10-23T15:48:30Z');
const iso = (ms: number) => new Date(ms).toISOString();
const at = (min: number) => iso(T0 + min * 60_000);

interface CardSpec {
  card_id: string;
  title: [string, string];
  kind: string;
  name: string;
  namespace?: string | null;
  verdict: 'abnormal' | 'normal' | 'undeterminable';
  value: string | null;
  value_number?: number | null;
  threshold?: number | null;
  unit?: EvidenceResult['unit'];
  say?: string;
  category?: EvidenceResult['category'];
  /** 异常起点（相对首个告警的分钟数） */
  since?: number;
}

const WINDOW = { from: at(1344), to: at(1377) };

function card(n: number, s: CardSpec): EvidenceResult {
  const abnormal = s.verdict === 'abnormal';
  return {
    ref: `card:${n}`,
    card_id: s.card_id,
    title: { 'zh-CN': s.title[0], en: s.title[1] },
    threshold: s.threshold ?? null,
    series: [],
    entity: {
      cluster_id: CLUSTER,
      kind: s.kind,
      namespace: s.namespace === undefined ? NS : s.namespace,
      name: s.name,
      uid: null,
    },
    window: WINDOW,
    verdict: s.verdict,
    display_state: s.verdict,
    reason: abnormal
      ? { kind: 'rule', text: s.say ?? '' }
      : s.verdict === 'normal'
        ? { kind: 'all_clear', text: '没有命中任何异常条件' }
        : { kind: 'no_data', text: '查询没有返回数据' },
    value: s.value,
    table: null,
    queries: [],
    egress: 'allow',
    anomaly_started_at: abnormal && s.since !== undefined ? at(s.since) : null,
    evaluated_at: at(1377),
    unit: s.unit ?? 'none',
    observations: {},
    params: {},
    conditions: abnormal ? [{ kind: 'abnormal', cel: 'x', outcome: 'hit', say: s.say ?? null }] : [],
    baseline: null,
    impact: false,
    category: s.category ?? null,
    value_number: s.value_number ?? null,
  };
}

const MEM: [string, string] = ['内存占 limit 与 OOM', 'Memory vs limit and OOM'];
const THR: [string, string] = ['CPU 限流', 'CPU throttling'];
const RESTARTS: [string, string] = ['重启与终止原因', 'Restarts and termination reasons'];
const READY: [string, string] = ['就绪', 'Readiness'];
const PENDING: [string, string] = ['持续 Pending', 'Stuck pending'];

function cards(): EvidenceResult[] {
  const out: CardSpec[] = [
    // 内存：StatefulSet 汇总与三个 Pod
    {
      card_id: 'workload/pod-restarts/memory',
      title: MEM,
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'abnormal',
      value: '94.0%',
      value_number: 0.94,
      threshold: 0.9,
      unit: 'percent',
      say: '2 个容器被 OOM 终止',
      category: 'memory',
      since: 1368.5,
    },
    {
      card_id: 'workload/pod-restarts/memory',
      title: MEM,
      kind: 'Pod',
      name: 'gateway-2',
      verdict: 'abnormal',
      value: '93.1%',
      value_number: 0.931,
      threshold: 0.9,
      unit: 'percent',
      say: 'working set 峰值 93%',
      category: 'memory',
      since: 1370,
    },
    {
      card_id: 'workload/pod-restarts/memory',
      title: MEM,
      kind: 'Pod',
      name: 'gateway-1',
      verdict: 'normal',
      value: '75.4%',
      value_number: 0.754,
      threshold: 0.9,
      unit: 'percent',
      category: 'memory',
    },
    {
      card_id: 'workload/pod-restarts/memory',
      title: MEM,
      kind: 'Pod',
      name: 'gateway-0',
      verdict: 'normal',
      value: '61.2%',
      value_number: 0.612,
      threshold: 0.9,
      unit: 'percent',
      category: 'memory',
    },
    // CPU：限流不高
    {
      card_id: 'workload/pod-restarts/throttling',
      title: THR,
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'normal',
      value: '12.0%',
      value_number: 0.12,
      threshold: 0.25,
      unit: 'percent',
      category: 'cpu',
    },
    {
      card_id: 'workload/capacity/hpa-utilization',
      title: ['HPA 负载是否饱和', 'Whether the HPA load is saturated'],
      kind: 'HorizontalPodAutoscaler',
      name: 'gateway',
      verdict: 'normal',
      value: '58.0%',
      value_number: 0.58,
      threshold: 0.9,
      unit: 'percent',
      category: 'cpu',
    },
    // 重启、就绪与终止原因（不属于五类）
    {
      card_id: 'workload/pod-restarts/restarts',
      title: RESTARTS,
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'abnormal',
      value: '6',
      value_number: 6,
      unit: 'count',
      say: '1 个容器处于 CrashLoopBackOff',
      since: 1365,
    },
    {
      card_id: 'workload/pod-restarts/readiness',
      title: READY,
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'abnormal',
      value: '1',
      value_number: 1,
      unit: 'count',
      say: '1 个 Pod 在窗口内未就绪',
      since: 1344,
    },
    {
      card_id: 'cchp/runtime/exit-codes',
      title: ['重启与最近一次终止', 'Restarts and last termination'],
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'abnormal',
      value: '137',
      say: '最近一次终止原因 OOMKilled（退出码 137）',
      since: 1368.5,
    },
    {
      card_id: 'cchp/service/service-health',
      title: ['应用就绪与数据库连接池', 'App readiness and database pool'],
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'abnormal',
      value: '100.0%',
      value_number: 1,
      threshold: 0.95,
      unit: 'percent',
      say: '应用 PG 连接池峰值 100%',
    },
    // 流量负载：网关自身 5xx 正常，边缘 5xx 接近阈值
    {
      card_id: 'cchp/service/gateway-errors',
      title: ['网关自身 5xx', 'Gateway-own 5xx'],
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'normal',
      value: '0.2%',
      value_number: 0.002,
      threshold: 0.01,
      unit: 'percent',
    },
    {
      card_id: 'cchp/edge/error-split',
      title: ['5xx 来自哪一层', 'Which layer the 5xx come from'],
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'normal',
      value: '0.4%',
      value_number: 0.0042,
      threshold: 0.005,
      unit: 'percent',
    },
    {
      card_id: 'cchp/edge/traffic',
      title: ['入口流量对比基线', 'Ingress traffic against baseline'],
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'normal',
      value: '0.91',
      value_number: 0.91,
      threshold: 0.3,
      unit: 'ratio',
    },
    // 阻塞：StatefulSet 发布停在未就绪的副本上
    {
      card_id: 'workload/rollout/statefulset',
      title: ['StatefulSet 发布', 'StatefulSet rollout'],
      kind: 'StatefulSet',
      name: 'gateway',
      verdict: 'abnormal',
      value: '1',
      value_number: 1,
      unit: 'count',
      say: '窗口结束时仍有 1 个副本未就绪',
      category: 'blocking',
    },
  ];
  // 三个 Pod 上的 Pending、重启与就绪：正常
  for (const pod of ['gateway-0', 'gateway-1', 'gateway-2']) {
    out.push(
      {
        card_id: 'workload/pod-pending/pending',
        title: PENDING,
        kind: 'Pod',
        name: pod,
        verdict: 'normal',
        value: '0',
        value_number: 0,
        unit: 'count',
        category: 'blocking',
      },
      {
        card_id: 'workload/pod-restarts/throttling',
        title: THR,
        kind: 'Pod',
        name: pod,
        verdict: 'normal',
        value: '9.0%',
        value_number: 0.09,
        threshold: 0.25,
        unit: 'percent',
        category: 'cpu',
      },
      {
        card_id: 'cchp/scrape-target/up',
        title: ['目标是否在线', 'Are the targets up'],
        kind: 'Pod',
        name: pod,
        verdict: pod === 'gateway-2' ? 'abnormal' : 'normal',
        value: pod === 'gateway-2' ? '0' : '1',
        say: '指标端点不可达',
        since: 1362.5,
      },
    );
  }
  // 节点：requests、可用内存、文件系统与 CPU
  for (const node of ['appservice-01', 'appservice-02', 'appservice-03']) {
    out.push(
      {
        card_id: 'cchp/capacity/requests',
        title: ['requests 占 allocatable', 'Requests against allocatable'],
        kind: 'Node',
        name: node,
        namespace: null,
        verdict: 'normal',
        value: node === 'appservice-03' ? '86.0%' : '64.0%',
        value_number: node === 'appservice-03' ? 0.86 : 0.64,
        threshold: 0.9,
        unit: 'percent',
      },
      {
        card_id: 'cchp/capacity/memory-available',
        title: ['可用内存', 'Available memory'],
        kind: 'Node',
        name: node,
        namespace: null,
        verdict: 'normal',
        value: '31.0%',
        value_number: 0.31,
        threshold: 0.1,
        unit: 'percent',
      },
      {
        card_id: 'node/node-filesystem/space',
        title: ['文件系统余量', 'Filesystem headroom'],
        kind: 'Node',
        name: node,
        namespace: null,
        verdict: 'normal',
        value: '41.0%',
        value_number: 0.41,
        threshold: 0.85,
        unit: 'percent',
        category: 'storage',
      },
      {
        card_id: 'node/node-health/cpu-memory',
        title: ['CPU 与内存', 'CPU and memory'],
        kind: 'Node',
        name: node,
        namespace: null,
        verdict: 'normal',
        value: '44.0%',
        value_number: 0.44,
        threshold: 0.9,
        unit: 'percent',
        category: 'cpu',
      },
    );
  }
  // 数据库、缓存、发布与伸缩：正常或无法判定（数据量大，放在夹具文件里）
  out.push(...(JSON.parse(readFileSync(OTHER_CARDS, 'utf8')) as CardSpec[]));
  return out.map((s, k) => card(k + 1, s));
}

const ALERTS: Array<[string, IncidentMember['role'], IncidentMember['severity']]> = [
  ['KubeContainerOOMKilled', 'cause', 'warning'],
  ['CCHPMetricsTargetDown', 'symptom', 'warning'],
  ['KubePodCrashLooping', 'cause', 'warning'],
  ['CCHPGatewayContainerTerminated', 'cause', 'warning'],
  ['KubeStatefulSetReplicasNotReady', 'symptom', 'warning'],
];

function alertsAndMembers(): { alerts: Alert[]; members: IncidentMember[] } {
  const alerts: Alert[] = [];
  const members: IncidentMember[] = [];
  for (let k = 0; k < 70; k++) {
    const critical = k === 40;
    const [name, role, sev] = critical
      ? (['KubePodCrashLoopingCritical', 'symptom', 'critical'] as const)
      : ALERTS[k % 5]!;
    const pod = `gateway-${k % 3}`;
    const start = T0 + k * 20 * 60_000;
    const firing = k >= 66;
    const id = `${(0x1a2b3c00 + k).toString(16).padStart(16, '0')}@${Math.floor(start / 1000)}`;
    const startsAt = iso(start);
    const endsAt = firing ? null : iso(start + 6 * 60_000);
    alerts.push({
      alert_id: id,
      cluster_id: CLUSTER,
      source: 'reconcile',
      fingerprint: id.split('@')[0]!,
      alertname: name,
      labels: { alertname: name, namespace: NS, pod, severity: sev, component: 'gateway' },
      annotations: k === 40 ? { summary: `生产 ${NS}/${pod} 容器 gateway CrashLoopBackOff` } : {},
      severity: sev,
      status: firing ? 'firing' : 'resolved',
      suppressed: 'none',
      starts_at: startsAt,
      ends_at: endsAt,
      generator_url: null,
      classification: { role, source: 'label', confidence: 1, catalog_entry: null, chronic: false },
      entity: { cluster_id: CLUSTER, kind: 'Pod', namespace: NS, name: pod, uid: null },
      entity_resolution: 'labels',
      component: `StatefulSet:${NS}/gateway`,
      received_at: startsAt,
    } as Alert);
    members.push({
      alert_id: id,
      alertname: name,
      role,
      component: `StatefulSet:${NS}/gateway`,
      severity: sev,
      status: firing ? 'firing' : 'resolved',
      starts_at: startsAt,
      ends_at: endsAt,
      joined_version: 1 + Math.floor(k / 5),
      left_version: null,
    });
  }
  return { alerts, members };
}

/** gateway OOM 事件的报告输入：阶段 A 之后、研判之前（与 #249 一样只有确定性报告） */
export function gatewayOomInput(base: ComposeInput): ComposeInput {
  if (!base.stageA) {
    throw new Error('gatewayOomInput 需要带阶段 A 报告的输入');
  }
  const { alerts, members } = alertsAndMembers();
  const id = 'b18629a6-0000-4000-8000-b18629a6f249';
  const root = `StatefulSet:${NS}/gateway`;
  const incident: Incident = {
    ...base.incident,
    incident_id: id,
    cluster_id: CLUSTER,
    label: `${root}:2026-10-23T15:45:00Z`,
    incident_version: 15,
    state: 'firing',
    severity: 'critical',
    first_firing_at: iso(T0),
    ended_at: null,
    root: {
      component: root,
      entity: { cluster_id: CLUSTER, kind: 'StatefulSet', namespace: NS, name: 'gateway', uid: null },
      ambiguous: false,
      margin: 0.3,
      silent_root: false,
    },
    candidates: [
      {
        component: root,
        score: 0.65,
        terms: { coverage: 1, precedence: 0, role_prior: 1, recent_change: 0, chronic_penalty: 0 },
        depth: 1,
        explains: [],
        source: 'alert',
      },
    ],
    members,
    components: [root],
    changes: [],
    aliases: [],
    created_at: iso(T0 + 71_000),
    updated_at: at(1377),
  };
  const cs = cards();
  const stageA: StageAReport = {
    ...base.stageA,
    report_id: 'c2d0a1b4-0000-4000-8000-c2d0a1b4f249',
    incident_id: id,
    incident_version: 15,
    disposition: 'escalate',
    disposition_reason: 'critical_ambiguous',
    candidates: incident.candidates,
    ambiguous: false,
    cards: cs,
    observability_blind: false,
    timeline: [{ at: at(1344), kind: 'card_abnormal', text: '1', ref: 'card:8' }],
    runbooks: ['workload/workload.md'],
    rule_proposals: [],
    degraded: false,
    rendered_at: at(1377),
  };
  return {
    ...base,
    incident,
    stageA,
    researchStageA: null,
    alerts,
    research: null,
    researchRootMismatch: false,
    researchPending: false,
    stageAOnlyReason: null,
    proposals: [],
    subgraph: null,
    alertTitle: () => null,
    links: REPORT_LINKS,
  };
}
