import type { EvidenceResult, Feedback, Incident, StageAReport } from '@srenautix/contract';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import type { ActionCatalog } from '@srenautix/contract';
import type { ResearchCase, Subgraph } from '../../src/research/types.js';

// 研判测试用的通用级联场景（不对应任何真实集群）：shop 命名空间里 postgres 的数据卷写满，
// api 随后出现 5xx；同一时段 web 有一次无关的发布（干扰项）。

export const T0 = Date.parse('2026-09-01T10:00:00Z');
const iso = (offsetMin: number) => new Date(T0 + offsetMin * 60_000).toISOString();

const PG = 'StatefulSet:shop/postgres';
const PVC = 'PersistentVolumeClaim:shop/data-postgres-0';
const API = 'Deployment:shop/api';
const WEB = 'Deployment:shop/web';
const NODE = 'Node:node-a';

function ent(component: string): EvidenceResult['entity'] {
  const [kind, rest] = component.split(':') as [string, string];
  const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
  return { cluster_id: 'test', kind, namespace: ns, name: name as string, uid: null };
}

function card(
  n: number,
  cardId: string,
  component: string,
  verdict: EvidenceResult['verdict'],
  value: string | null,
  reason: string,
  anomalyMin: number | null,
): EvidenceResult {
  return {
    ref: `card:${n}`,
    card_id: cardId,
    title: { 'zh-CN': cardId, en: cardId },
    threshold: null,
    series: [],
    entity: ent(component),
    window: { from: iso(-60), to: iso(30) },
    verdict,
    display_state: verdict,
    reason: {
      kind: verdict === 'undeterminable' ? 'no_data' : verdict === 'abnormal' ? 'rule' : 'all_clear',
      text: reason,
    },
    value,
    table: null,
    queries: [],
    egress: 'redact',
    anomaly_started_at: anomalyMin === null ? null : iso(anomalyMin),
    evaluated_at: iso(30),
  };
}

export function stageACards(): EvidenceResult[] {
  return [
    card(1, 'workload/http/error_ratio', API, 'abnormal', '31%', 'api 5xx 比例 31%，高于阈值 5%', 6),
    card(2, 'pvc/capacity/used_ratio', PVC, 'abnormal', '99.2%', 'data-postgres-0 已用 99.2%，高于阈值 95%', -2),
    card(3, 'postgres/connections/saturation', PG, 'normal', '41%', '连接数占上限 41%', null),
    card(4, 'workload/http/error_ratio', WEB, 'normal', '0.2%', 'web 5xx 比例 0.2%', null),
    card(5, 'node/disk/pressure', NODE, 'undeterminable', null, '查询没有样本', null),
  ];
}

export function incident(): Incident {
  return {
    incident_id: '7a1b2c3d-0000-4000-8000-000000000001',
    cluster_id: 'test',
    label: `${PG}:2026-09-01T09:50:00Z`,
    incident_version: 2,
    state: 'firing',
    severity: 'critical',
    first_firing_at: iso(-1),
    ended_at: null,
    root: { component: PG, entity: ent(PG), ambiguous: false, margin: 0.3, silent_root: false },
    candidates: [
      {
        component: PG,
        score: 0.82,
        terms: { coverage: 1, precedence: 1, role_prior: 0.8, recent_change: 0, chronic_penalty: 0 },
        depth: 2,
        explains: ['a2'],
        source: 'alert',
      },
      {
        component: WEB,
        score: 0.41,
        terms: { coverage: 0, precedence: 0.5, role_prior: 0.3, recent_change: 1, chronic_penalty: 0 },
        depth: 1,
        explains: [],
        source: 'change',
      },
    ],
    members: [
      {
        alert_id: '0000000000000001@1788256740',
        alertname: 'KubePersistentVolumeFillingUp',
        role: 'cause',
        component: PVC,
        severity: 'critical',
        status: 'firing',
        starts_at: iso(-1),
        ends_at: null,
        joined_version: 1,
        left_version: null,
      },
      {
        alert_id: '0000000000000002@1788257160',
        alertname: 'ApiHighErrorRate',
        role: 'symptom',
        component: API,
        severity: 'critical',
        status: 'firing',
        starts_at: iso(6),
        ends_at: null,
        joined_version: 2,
        left_version: null,
      },
    ],
    components: [PG, PVC, API],
    changes: [
      {
        change_id: 'k8s-rollout:shop/web-5f6d',
        source: 'k8s-rollout',
        kind: 'rollout',
        refs: ['ReplicaSet/web-5f6d'],
        revision: '5f6d',
        actor: null,
        time: iso(-15),
        link: null,
        targets: [WEB],
        summary: 'web rolled out image web:2.4.1',
      },
    ],
    aliases: [],
    split_from: null,
    merged_into: null,
    suppressed: false,
    observability_blind: false,
    topology_version: 42,
    created_at: iso(0),
    updated_at: iso(7),
  };
}

export function stageA(cards = stageACards()): StageAReport {
  return {
    report_id: '7a1b2c3d-0000-4000-8000-0000000000a1',
    incident_id: incident().incident_id,
    incident_version: 2,
    disposition: 'escalate',
    disposition_reason: 'default',
    candidates: incident().candidates,
    ambiguous: false,
    cards,
    evidence_fingerprint: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    observability_blind: false,
    timeline: [],
    runbooks: ['pvc/capacity.md#filling-up'],
    rule_proposals: [],
    degraded: false,
    rendered_at: iso(7),
  };
}

export function subgraph(): Subgraph {
  const node = (component: string, role: 'root' | 'candidate' | 'member' | 'neighbor', hops: number) => {
    const [kind, rest] = component.split(':') as [string, string];
    const [ns, name] = rest.includes('/') ? (rest.split('/') as [string, string]) : [null, rest];
    return { component, kind, namespace: ns, name: name as string, role, alerts: [], hops };
  };
  return {
    topology_version: 42,
    root: PG,
    nodes: [
      node(PG, 'root', 0),
      node(PVC, 'member', 1),
      node(API, 'member', 1),
      node(WEB, 'candidate', 2),
      node(NODE, 'neighbor', 1),
    ],
    edges: [
      { from: PG, to: PVC, relation: 'mounts', provenance: 'structural', confidence: 1, scope: 'instance' },
      { from: API, to: PG, relation: 'calls', provenance: 'runtime', confidence: 0.9, scope: 'service' },
      { from: WEB, to: API, relation: 'calls', provenance: 'runtime', confidence: 0.9, scope: 'service' },
      { from: PG, to: NODE, relation: 'scheduled_on', provenance: 'structural', confidence: 1, scope: 'instance' },
    ],
  };
}

export function catalogActions(ids: string[]) {
  const doc = parse(
    readFileSync(resolve(import.meta.dirname, '../../../../contract/gateway/v1/action-catalog.yaml'), 'utf8'),
  ) as ActionCatalog;
  return doc.actions.filter((a) => ids.includes(a.id));
}

export function researchCase(over: Partial<ResearchCase> = {}): ResearchCase {
  return {
    incident: incident(),
    stageA: stageA(),
    subgraph: subgraph(),
    feedback: [],
    actions: catalogActions(['workload_scale', 'pod_restart', 'rollout_pause']),
    runbooks: ['pvc/capacity.md#filling-up', 'postgres/disk.md#wal-growth'],
    knowledge: [],
    cases: [],
    templates: [],
    tools: [],
    asOf: iso(30),
    ...over,
  };
}

export function feedback(over: Partial<Feedback>): Feedback {
  return {
    feedback_id: '7a1b2c3d-0000-4000-8000-0000000000f1',
    incident_id: incident().incident_id,
    incident_version: 2,
    research_run_id: null,
    verdict: 'confirmed',
    root_component: null,
    disposition_verdict: null,
    disposition: null,
    mechanism: null,
    reason: null,
    principal_id: 'alice',
    channel: 'console',
    linked: true,
    implicit: null,
    stale: false,
    created_at: iso(40),
    ...over,
  };
}

/** 场景的指标样本（Prometheus 文本格式，毫秒时间戳）：数据卷用量与 api 错误率 */
export function metricLines(): string[] {
  const out: string[] = [];
  for (let m = -60; m <= 30; m++) {
    const t = T0 + m * 60_000;
    const used = m < -20 ? 0.8 + (m + 60) * 0.002 : Math.min(0.995, 0.88 + (m + 20) * 0.006);
    out.push(
      `kubelet_volume_stats_used_ratio{namespace="shop",persistentvolumeclaim="data-postgres-0"} ${used.toFixed(4)} ${t}`,
    );
    out.push(`http_error_ratio{namespace="shop",deployment="api"} ${m >= 6 ? 0.31 : 0.004} ${t}`);
    out.push(`http_error_ratio{namespace="shop",deployment="web"} 0.002 ${t}`);
  }
  return out;
}
