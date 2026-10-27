import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TopologyEdge, TopologyNode } from '@srenautix/contract';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_REVISION_LABELS } from '../../src/changes/kubernetes.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackRuntime } from '../../src/stage-a/packs.js';
import { BUNDLE_FORMAT, type Bundle, type TopologyRow } from '../../src/eval/bundle.js';
import { discoveryCase, summarizeDiscovery, type DiscoveryCase } from '../../src/eval/discovery.js';
import type { Label } from '../../src/eval/labels.js';
import { replay } from '../../src/eval/reconstruct.js';
import { PACKS } from '../support/packs.js';

/**
 * 重建重放（ADR 0110）在一次真实发布事故上的结果：影子环境 2026-10-20 16:00–19:00Z 的告警、拓扑与工作负载事件
 * （hub-server 的只读导出，已脱敏，ADR 0104 的同一份夹具）。夹具转换成重建包：告警按 starts_at/ends_at 成为实例，
 * 工作负载与 ReplicaSet 的历史按事件写成区间，其余节点与边在整个范围内存在。15:59:52 的发布与 16:24:25 的回退是同一次故障。
 */
interface Fixture {
  cluster_id: string;
  alerts: Array<{
    fingerprint: string;
    alertname: string;
    labels: Record<string, string>;
    starts_at: string;
    ends_at: string | null;
  }>;
  topology: { at: string; nodes: TopologyNode[]; edges: TopologyEdge[] };
  workload_events: Array<{
    seq: number;
    op: 'node_upsert' | 'node_delete';
    key: string;
    valid_from: string;
    body: TopologyNode;
  }>;
}

const fx = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../fixtures/incidents/release-rollout-2026-10-20.json'), 'utf8'),
) as Fixture;
const FROM = '2026-10-20T15:30:00Z';
const TO = '2026-10-20T18:50:00Z';
const BEFORE = '2026-10-19T00:00:00.000Z';
const iso = (s: string) => new Date(Date.parse(s)).toISOString();

function bundle(): Bundle {
  const historic = new Set(fx.workload_events.map((e) => e.key));
  const rows: TopologyRow[] = [];
  let seq = 0;
  for (const n of fx.topology.nodes.filter((x) => !historic.has(x.key))) {
    rows.push({
      seq: ++seq,
      op: 'node_upsert',
      item: 'node',
      key: n.key,
      valid_from: BEFORE,
      valid_to: null,
      source: 'informer',
      body: n,
    });
  }
  for (const e of fx.topology.edges) {
    rows.push({
      seq: ++seq,
      op: 'edge_upsert',
      item: 'edge',
      key: `${e.from}|${e.relation}|${e.to}`,
      valid_from: BEFORE,
      valid_to: null,
      source: 'informer',
      body: e,
    });
  }
  // 与状态库相同：新事件到达时上一条的 valid_to 设为新事件的 valid_from，删除只关闭区间
  const events = [...fx.workload_events].sort((a, b) => a.seq - b.seq);
  for (const [i, e] of events.entries()) {
    const next = events.slice(i + 1).find((x) => x.key === e.key);
    rows.push({
      seq: 100_000 + e.seq,
      op: e.op,
      item: 'node',
      key: e.key,
      valid_from: iso(e.valid_from),
      valid_to: e.op === 'node_delete' ? iso(e.valid_from) : next ? iso(next.valid_from) : null,
      source: 'informer',
      body: e.body,
    });
  }
  return {
    format: BUNDLE_FORMAT,
    version: 1,
    label_id: 'release-2026-10-20',
    cluster_id: fx.cluster_id,
    range: { from: iso(FROM), to: iso(TO) },
    alerts: fx.alerts.map((a) => ({
      alertname: a.alertname,
      labels: a.labels,
      fingerprint: a.fingerprint,
      active_at: iso(a.starts_at),
      firing_from: iso(a.starts_at),
      firing_to: a.ends_at ? iso(a.ends_at) : null,
    })),
    topology: rows,
    changes: [],
    sources: { metrics: 'fixture', state: 'fixture' },
    exported_at: '2026-10-21T00:00:00.000Z',
  };
}

const RELEASE_ALERTS = [
  'ACMEReleaseGateSkipped',
  'KubeStatefulSetReplicasNotReady',
  'KubeStatefulSetRolloutStuck',
  'ACMEPostDeployAnomaly',
  'ACMEWorkerNoAvailableReplicas',
  'KubePdbBlockingEviction',
  'ACMEMigrationWaitStuck',
  'KubePodInitializingTooLong',
  'KubeDeploymentReplicasUnavailable',
  'KubeDeploymentRolloutStuck',
  'ArgoWorkflowsReleaseFailed',
  'ACMEReleaseFailed',
  'ACMEReleaseRollbackFailed',
];

const label: Label = {
  id: 'release-2026-10-20',
  title: '发布迁移后回退失败',
  type: 'incident',
  window: { from: '2026-10-20T15:57:00Z', to: TO },
  as_of: '2026-10-20T17:05:00Z',
  fault_alerts: [
    ...RELEASE_ALERTS.map((alertname) => ({ alertname, labels: {} })),
    { alertname: 'ACMEMetricsTargetDown', labels: { namespace: 'acme-prod' } },
    { alertname: 'ArgoCDAppDegraded', labels: { name: 'acme-prod' } },
  ],
  roots: [
    'Application.argoproj.io:argocd/acme-prod',
    'Deployment:acme-prod/control',
    'Deployment:acme-prod/worker',
    'StatefulSet:acme-prod/gateway',
  ],
  discovery_roots: [],
  revisions: [],
  granularity: 'component',
  mechanism: null,
  mechanism_expect: [],
  mechanism_forbid: [],
  required_evidence: [],
  disposition: 'act',
  required_members: [
    ['Deployment:acme-prod/control'],
    ['Deployment:acme-prod/worker'],
    ['Application.argoproj.io:argocd/acme-prod'],
  ],
  required_change_near: '2026-10-20T16:24:25Z',
  legacy_case: null,
  legacy_roots: [],
  learned_from: [],
  fix: null,
  noise: [],
  evidence: [{ kind: 'state', ref: 'fixture' }],
};

let d: DiscoveryCase;
let replayed: Awaited<ReturnType<typeof replay>>;

beforeAll(async () => {
  const rt = await PackRuntime.load({
    dirs: [PACKS],
    only: null,
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
  });
  replayed = await replay(
    bundle(),
    Date.parse(TO),
    {
      rt,
      params: rt.rcaParams(),
      revisionLabels: [...DEFAULT_REVISION_LABELS, 'acme.io/release-id'],
      groupWithinMs: 2 * 60_000,
      stepMs: 30_000,
    },
    Date.parse(label.as_of),
  );
  d = discoveryCase(replayed, label);
}, 120_000);

describe('重建重放：2026-10-20 发布事故', () => {
  it('发布与回退的告警不超过 2 个事件，主事件的根因是发布的目标，成员与 16:24 的回退齐全', () => {
    expect(d.fault_alerts).toBeGreaterThan(20);
    expect(d.incidents, JSON.stringify(d.incident_labels)).toBeLessThanOrEqual(2);
    expect(d.root_hit, String(d.main_root)).toBe(true);
    expect(d.missing_members).toEqual([]);
    expect(d.change_found).toBe(true);
    expect(d.passed).toBe(true);
  });

  it('检测延迟按 30 秒一步计：首个故障告警的 pending 开始到第一个包含它的事件创建，不超过一步', () => {
    expect(d.first_symptom_at).toBe('2026-10-20T16:02:00.000Z');
    expect(d.detection_latency_s).not.toBeNull();
    expect(d.detection_latency_s!).toBeLessThanOrEqual(30);
  });

  it('窗口内没有 unlabelled 事件；分析时刻的主事件已经存在', () => {
    expect(d.window_unlabelled).toBe(0);
    expect(replayed.captured).not.toBeNull();
    const s = summarizeDiscovery([d]);
    expect(s.root_hit).toEqual({ n: 1, d: 1 });
    expect(s.passed).toEqual({ n: 1, d: 1 });
  });
});
