import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Alert, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { computeIncidents, TopologyGraph, type ComputedIncident } from '@srenautix/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveAlert } from '../../src/alerts/resolve.js';
import { DEFAULT_REVISION_LABELS, deriveRollouts, type WorkloadEvent } from '../../src/changes/kubernetes.js';
import { DEFAULT_CATALOG_PATH } from '../../src/proposals/catalog.js';
import { PackRuntime } from '../../src/stage-a/packs.js';
import { PACKS } from '../support/packs.js';

/**
 * 一次真实发布事故的回放（ADR 0104）：影子环境 2026-10-20 16:00–19:00Z 的告警与拓扑（只读导出，已脱敏）。
 * 16:24 的发布把 control、worker 退回旧版本，新 Pod 卡在等待迁移的 initContainer；之前影子环境把它拆成了 15 个以上的
 * 事件（按 Pod、Deployment、Argo 应用、命名空间与 unlabelled）。修复后应当收敛为不超过 2 个事件，根因是这次发布。
 * 只用内置领域包：收敛不依赖专门的告警目录。
 */
interface Fixture {
  cluster_id: string;
  alerts: Array<{
    alert_id: string;
    fingerprint: string;
    source: Alert['source'];
    alertname: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    severity: Alert['severity'];
    status: Alert['status'];
    starts_at: string;
    ends_at: string | null;
  }>;
  topology: { at: string; nodes: TopologyNode[]; edges: TopologyEdge[] };
  workload_events: Array<Omit<WorkloadEvent, 'previous' | 'owner' | 'managers'>>;
}

const FIXTURE = resolve(import.meta.dirname, '../fixtures/incidents/release-rollout-2026-10-20.json');
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
const NOW = Date.parse('2026-10-20T19:00:00Z');
const RELEASE_LABEL = 'acme.io/release-id';

let incidents: ComputedIncident[];
let changes: ReturnType<typeof deriveRollouts>;

function workloadEvents(): WorkloadEvent[] {
  const edges = fx.topology.edges;
  const ownerOf = (k: string) => edges.find((e) => e.from === k && e.relation === 'owned_by')?.to ?? null;
  const managersOf = (k: string) => edges.filter((e) => e.from === k && e.relation === 'managed_by').map((e) => e.to);
  const sorted = [...fx.workload_events].sort((a, b) => a.seq - b.seq);
  return sorted.map((e, i) => {
    const prev = sorted
      .slice(0, i)
      .reverse()
      .find((p) => p.key === e.key && p.op === 'node_upsert');
    const owner = e.kind === 'ReplicaSet' ? ownerOf(e.key) : null;
    return {
      ...e,
      previous: prev?.body ?? null,
      owner,
      managers: managersOf(owner ?? e.key),
    };
  });
}

beforeAll(async () => {
  const rt = await PackRuntime.load({
    dirs: [PACKS],
    only: null,
    lockFile: null,
    catalogPath: DEFAULT_CATALOG_PATH,
    capabilities: new Set(['metrics.query', 'metrics.query_range', 'metrics.series']),
  });
  const graph = new TopologyGraph(fx.topology.nodes, fx.topology.edges, 1);
  const byObject = new Map(fx.topology.nodes.map((n) => [`${n.kind}|${n.namespace ?? ''}|${n.name}`, n]));
  const alerts: Alert[] = [];
  for (const a of fx.alerts) {
    const raw = {
      source: a.source === 'reconcile' ? ('reconcile' as const) : ('alertmanager' as const),
      labels: a.labels,
      annotations: a.annotations,
      severity: a.severity,
      status: a.status,
      suppressed: 'none' as const,
      startsAt: new Date(a.starts_at),
      endsAt: a.ends_at ? new Date(a.ends_at) : null,
      generatorUrl: null,
      fingerprint: a.fingerprint,
      alertname: a.alertname,
    };
    const r = await resolveAlert(fx.cluster_id, raw, {
      catalog: rt.alertCatalog(),
      nodes: {
        // 与状态库的查找相同：不带 API 组的 kind 也匹配 <kind>.<组>
        find: async (_c, kind, namespace, name) => {
          const n =
            byObject.get(`${kind}|${namespace ?? ''}|${name}`) ??
            fx.topology.nodes.find(
              (x) =>
                !kind.includes('.') &&
                x.kind.startsWith(`${kind}.`) &&
                (x.namespace ?? '') === (namespace ?? '') &&
                x.name === name,
            );
          return n ? { key: n.key, uid: n.uid ?? null, tombstone: false } : null;
        },
      },
      ksm: null,
      ruleExpr: () => undefined,
      chronic: () => false,
    });
    alerts.push({
      alert_id: a.alert_id,
      cluster_id: fx.cluster_id,
      source: a.source,
      fingerprint: a.fingerprint,
      alertname: a.alertname,
      labels: a.labels,
      annotations: a.annotations,
      severity: a.severity,
      status: a.status,
      suppressed: 'none',
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      generator_url: null,
      classification: r.classification,
      entity: r.entity,
      entity_resolution: r.entityResolution,
      component: r.component,
      received_at: a.starts_at,
    } as Alert);
  }
  changes = deriveRollouts(workloadEvents(), {
    clusterId: fx.cluster_id,
    revisionLabels: [...DEFAULT_REVISION_LABELS, RELEASE_LABEL],
    groupWithinMs: 2 * 60_000,
  });
  incidents = computeIncidents({ alerts, changes, graph, params: rt.rcaParams(), now: NOW });
});

export const summarize = () =>
  incidents.map((i) => ({
    root: i.ranking.root.component,
    changes: i.group.changes.map((c) => c.time),
    alerts: i.group.alerts.map(
      (x) => `${x.alert.alertname}@${x.alert.component ?? '-'}@${x.alert.starts_at.slice(11, 16)}`,
    ),
  }));

const of = (inc: ComputedIncident) => inc.group.alerts.map((x) => x.alert);
const containing = (alertname: string, pred: (a: Alert) => boolean = () => true) =>
  incidents.filter((i) => of(i).some((a) => a.alertname === alertname && pred(a)));

describe('16:24 的发布事故收敛到发布这一个根因', () => {
  it('从拓扑事件推导出 16:24 的发布：control、worker、gateway 的版本标签同时变化，目标带上管理它们的 Argo 应用', () => {
    const r = changes.find((c) => c.time.startsWith('2026-10-20T16:24'));
    expect(r).toBeDefined();
    expect(r!.kind).toBe('rollout');
    expect(r!.targets).toEqual(
      expect.arrayContaining([
        'Deployment:acme-prod/control',
        'Deployment:acme-prod/worker',
        'StatefulSet:acme-prod/gateway',
        'Application.argoproj.io:argocd/acme-prod',
      ]),
    );
    expect(r!.summary).toContain(RELEASE_LABEL);
  });

  it('发布相关的告警（迁移等待、Init 过久、rollout 停滞、副本不可用、Argo 应用、PDB、发布流水线）不超过 2 个事件', () => {
    const release = (a: Alert) =>
      Date.parse(a.starts_at) >= Date.parse('2026-10-20T16:30:00Z') &&
      Date.parse(a.starts_at) <= Date.parse('2026-10-20T17:01:30Z') &&
      [
        'ACMEMigrationWaitStuck',
        'KubePodInitializingTooLong',
        'KubeDeploymentRolloutStuck',
        'KubeDeploymentReplicasUnavailable',
        'ACMEWorkerNoAvailableReplicas',
        'ArgoCDAppDegraded',
        'KubePdbBlockingEviction',
        'ACMEMetricsTargetDown',
        'ACMEReleaseFailed',
        'ACMEReleaseRollbackFailed',
        'ACMEPostDeployAnomaly',
        'ArgoWorkflowsReleaseFailed',
        'ACMEReleaseGateSkipped',
      ].includes(a.alertname);
    const groups = incidents.filter((i) => of(i).some(release));
    const summary = groups.map((g) => ({
      root: g.ranking.root.component,
      changes: g.group.changes.map((c) => c.time),
      alerts: of(g)
        .filter(release)
        .map((a) => `${a.alertname}@${a.component ?? '-'}`),
    }));
    expect(groups.length, JSON.stringify(summary, null, 1)).toBeLessThanOrEqual(2);
  });

  it('迁移等待所在的事件：根因是这次发布的目标，成员包含 control、worker、Argo 应用与迁移相关告警', () => {
    const [inc] = containing('ACMEMigrationWaitStuck');
    expect(inc).toBeDefined();
    const rollout = inc!.group.changes.find((c) => c.time.startsWith('2026-10-20T16:24'));
    expect(rollout, JSON.stringify(inc!.group.changes.map((c) => c.time))).toBeDefined();
    expect(rollout!.targets).toContain(inc!.ranking.root.component);
    const comps = new Set(of(inc!).map((a) => a.component));
    expect([...comps]).toEqual(
      expect.arrayContaining([
        'Deployment:acme-prod/control',
        'Deployment:acme-prod/worker',
        'Application.argoproj.io:argocd/acme-prod',
      ]),
    );
    const names = new Set(of(inc!).map((a) => a.alertname));
    for (const n of [
      'ACMEMigrationWaitStuck',
      'KubePodInitializingTooLong',
      'ArgoCDAppDegraded',
      'ACMEReleaseFailed',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('整个窗口的事件一览', () => {
    console.log(JSON.stringify(summarize(), null, 1));
  });

  it('Pod 级告警归到它的工作负载：没有以 Pod 为根因或组件的事件', () => {
    for (const inc of incidents) {
      expect(inc.ranking.root.component ?? '').not.toMatch(/^Pod:/);
      for (const a of of(inc)) {
        expect(a.component ?? '').not.toMatch(/^Pod:acme-prod\/(control|worker)-/);
      }
    }
  });

  it('由导出器抓取的告警（kube-state-metrics 的 pod 标签）落到 deployment 标签上的工作负载', () => {
    const ksm = of(containing('KubeDeploymentReplicasUnavailable')[0]!).filter(
      (a) => a.alertname === 'KubeDeploymentReplicasUnavailable',
    );
    expect(ksm.map((a) => a.component).sort()).toEqual(['Deployment:acme-prod/control', 'Deployment:acme-prod/worker']);
  });
});
