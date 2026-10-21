import type { Alert, ChangeEvent, TopologyEdge, TopologyNode } from '@srenautix/contract';
import { describe, expect, it } from 'vitest';
import { computeIncidents, DEFAULT_RCA_PARAMS, TopologyGraph } from '../src/index.js';
import { CLUSTER } from './fixtures.js';

// 发布的前置 Job 作用在它写入的组件上（ADR 0104 §13）：2026-10-19 的发布先跑迁移 Job，迁移与线上流量互锁，数据库报死锁。
// 数据库不依赖发布的任何目标，按依赖方向解释不了；迁移 Job 经 egress_to 访问数据库，按强依据挂到发布时，数据库在变更窗口内
// 开始的告警由这次发布解释。

const T = (hhmm: string) => Date.parse(`2026-10-19T${hhmm}:00Z`);
const APP = 'Application.argoproj.io:argocd/cchp-prod';
const CONTROL = 'Deployment:cchp-prod/control';
const DB = 'Cluster.postgresql.cnpg.io:cchp-data/cchp-postgres';
const MIGRATE = 'Job:cchp-prod/cchp-migrate-f7c0';
const BACKUP = 'Job:cchp-prod/report-export';
const BARE = 'Job:cchp-prod/cchp-migrate-bare';

const node = (key: string): TopologyNode => {
  const [kind, rest] = key.split(':') as [string, string];
  const [ns, name] = rest.split('/') as [string, string];
  return { key, kind, namespace: ns, name, uid: null, labels: {}, component_type: null, hub: false };
};
const edge = (from: string, to: string, relation: string, confidence = 1, provenance = 'structural'): TopologyEdge => ({
  from,
  to,
  relation,
  provenance: provenance as TopologyEdge['provenance'],
  confidence,
  scope: 'service',
  evidence: 't',
});
const graph = new TopologyGraph(
  [APP, CONTROL, DB, MIGRATE, BACKUP, BARE].map(node),
  [
    edge(CONTROL, APP, 'managed_by'),
    // 网络策略推断的访问关系（Kind 与 CCHP 中置信度 0.6）
    edge(MIGRATE, DB, 'egress_to', 0.6, 'network_policy'),
    edge(BACKUP, DB, 'egress_to', 0.6, 'network_policy'),
  ],
  1,
);

let n = 0;
const alert = (alertname: string, at: string, component: string, kind: string, name: string): Alert => {
  const id = (++n).toString(16).padStart(16, '0');
  const [ns] = component.split(':')[1]!.split('/');
  return {
    alert_id: `${id}@${T(at) / 1000}`,
    cluster_id: CLUSTER,
    source: 'alertmanager',
    fingerprint: id,
    alertname,
    labels: { alertname },
    annotations: {},
    severity: 'warning',
    status: 'firing',
    suppressed: 'none',
    starts_at: new Date(T(at)).toISOString(),
    ends_at: null,
    generator_url: null,
    classification: { role: 'cause', source: 'catalog', confidence: 1, catalog_entry: null, chronic: false },
    entity: { cluster_id: CLUSTER, kind, namespace: ns!, name, uid: null },
    entity_resolution: 'informer',
    component,
    received_at: new Date(T(at)).toISOString(),
  };
};
const rollout = (job: string, basis: 'image' | 'namespace_window', at = '06:20'): ChangeEvent => ({
  change_id: 'kubernetes:cchp:431',
  source: 'kubernetes',
  kind: 'rollout',
  refs: [APP],
  revision: null,
  actor: null,
  time: new Date(T(at)).toISOString(),
  link: null,
  targets: [CONTROL, job, APP],
  summary: 'control 的发布',
  attachments: [{ target: job, basis }],
});
const controlDown = alert('KubeDeploymentReplicasMismatch', '06:28', CONTROL, 'Deployment', 'control');
const deadlocks = (at = '06:21') => alert('CNPGDeadlocks', at, DB, 'Cluster', 'cchp-postgres');
const together = (changes: ChangeEvent[], alerts: Alert[]) =>
  computeIncidents({ alerts, changes, graph, params: DEFAULT_RCA_PARAMS, now: T('06:50') }).some(
    (i) =>
      i.group.alerts.some((a) => a.alert.alertname === 'CNPGDeadlocks') &&
      i.group.alerts.some((a) => a.alert.alertname === 'KubeDeploymentReplicasMismatch'),
  );

describe('发布的前置 Job 作用在它写入的组件上（ADR 0104 §13）', () => {
  it('按镜像挂上的迁移 Job 经 egress_to 访问数据库：数据库在变更窗口内开始的告警归到这次发布', () => {
    expect(together([rollout(MIGRATE, 'image')], [controlDown, deadlocks()])).toBe(true);
  });

  it('按命名空间与时间窗（第 4 档）挂上的备份类 Job：不拉进数据库告警', () => {
    expect(together([rollout(BACKUP, 'namespace_window')], [controlDown, deadlocks()])).toBe(false);
  });

  it('Job 没有 egress_to 边：不生效', () => {
    expect(together([rollout(BARE, 'image')], [controlDown, deadlocks()])).toBe(false);
  });

  it('数据库告警早于 Job（发布开始之前已经在触发）：不解释', () => {
    expect(together([rollout(MIGRATE, 'image')], [controlDown, deadlocks('06:15')])).toBe(false);
  });
});
