import { createHash } from 'node:crypto';
import type { ChangeEvent, MetricSeries, MetricsQueryRequest } from '@srenautix/contract';
import { tryNodeKey } from '@srenautix/core';
import type { Queryable } from '../store/pool.js';
import { deriveRollouts, type RolloutOptions, type WorkloadEvent } from './kubernetes.js';

/**
 * informer 空窗时从 kube-state-metrics 推导发布（ADR 0104 §11）：server 重启、与 reader 断连、刚安装时，拓扑里没有
 * 这段时间新建的 ReplicaSet，发布推导不出来，发布告警只能归到无关的变更或各自成组。kube-state-metrics 的指标保留了
 * ReplicaSet 的创建时间与属主：
 * - 在 [from, to] 内创建、属主是 Deployment、拓扑里从来没有记录过的 ReplicaSet，是 informer 漏掉的一次发布；
 * - 属主 Deployment 的创建时间早于这个 ReplicaSet 一分钟以上（新建的 Deployment 带出的第一个 ReplicaSet 不是发布）；
 * - 管理它的 Argo/Flux 应用取拓扑里属主的 managed_by 边。
 * 结果经同一个 deriveRollouts 合成发布变更，change_id 为 kubernetes:<集群>:ksm-<哈希>（与拓扑事件的序号不冲突）。
 * 拓扑里有记录的 ReplicaSet 由 kubernetesRollouts 处理，两个来源不重复。
 */
export type InstantQuery = (req: MetricsQueryRequest) => Promise<{ series: MetricSeries[] }>;

const CREATED_GAP_MS = 60_000;

function last(s: MetricSeries): number | null {
  for (let i = s.values.length - 1; i >= 0; i--) {
    const v = s.values[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
  }
  return null;
}

/** 稳定的负序号：deriveRollouts 用它排序与生成 change_id，与状态库的正序号不冲突 */
function seqOf(key: string): number {
  return -(Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 12), 16) % 2 ** 46) - 1;
}

export async function ksmRollouts(
  db: Queryable,
  query: InstantQuery,
  from: Date,
  to: Date,
  o: RolloutOptions,
): Promise<ChangeEvent[]> {
  const range = `${Math.max(60, Math.ceil((to.getTime() - from.getTime()) / 1000))}s`;
  const at = {
    time: to.toISOString(),
    clock_window: { from: from.toISOString(), to: to.toISOString() },
    timeout_ms: 10_000,
  };
  const run = (expr: string) => query({ expr, dialect: 'promql', ...at } as MetricsQueryRequest);
  const [created, owners, deployments] = await Promise.all([
    run(`max by (namespace, replicaset) (last_over_time(kube_replicaset_created[${range}]))`),
    run(
      `max by (namespace, replicaset, owner_name) (last_over_time(kube_replicaset_owner{owner_kind="Deployment"}[${range}]))`,
    ),
    run(`max by (namespace, deployment) (last_over_time(kube_deployment_created[${range}]))`),
  ]);
  const ownerOf = new Map(
    owners.series
      .filter((s) => s.labels.namespace && s.labels.replicaset && s.labels.owner_name)
      .map((s) => [`${s.labels.namespace}/${s.labels.replicaset}`, s.labels.owner_name!]),
  );
  const deploymentCreated = new Map(
    deployments.series.map((s) => [`${s.labels.namespace}/${s.labels.deployment}`, last(s)]),
  );
  const candidates: Array<{ key: string; owner: string; t: number; ns: string; name: string }> = [];
  for (const s of created.series) {
    const ns = s.labels.namespace;
    const name = s.labels.replicaset;
    const c = last(s);
    if (!ns || !name || c === null) {
      continue;
    }
    const t = c * 1000;
    if (t < from.getTime() || t > to.getTime()) {
      continue;
    }
    const ownerName = ownerOf.get(`${ns}/${name}`);
    const key = tryNodeKey('ReplicaSet', ns, name);
    const owner = ownerName ? tryNodeKey('Deployment', ns, ownerName) : null;
    const dc = ownerName ? deploymentCreated.get(`${ns}/${ownerName}`) : undefined;
    if (!key || !owner || dc === undefined || dc === null || dc * 1000 > t - CREATED_GAP_MS) {
      continue;
    }
    candidates.push({ key, owner, t, ns, name });
  }
  if (!candidates.length) {
    return [];
  }
  // 拓扑里记录过的 ReplicaSet 交给 kubernetesRollouts；属主的管理应用取拓扑里的 managed_by 边
  const known = await db.query<{ key: string }>(
    `SELECT DISTINCT key FROM server.topology_events WHERE cluster_id = $1 AND item = 'node' AND key = ANY($2::text[])`,
    [o.clusterId, candidates.map((c) => c.key)],
  );
  const seen = new Set(known.rows.map((r) => r.key));
  const missing = candidates.filter((c) => !seen.has(c.key));
  if (!missing.length) {
    return [];
  }
  const mg = await db.query<{ owner: string; app: string }>(
    `SELECT DISTINCT body->>'from' AS owner, body->>'to' AS app FROM server.topology_events
      WHERE cluster_id = $1 AND item = 'edge' AND op = 'edge_upsert' AND body->>'relation' = 'managed_by'
        AND body->>'from' = ANY($2::text[]) AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $4)`,
    [o.clusterId, [...new Set(missing.map((c) => c.owner))], to, from],
  );
  const managers = new Map<string, string[]>();
  for (const r of mg.rows) {
    managers.set(r.owner, [...(managers.get(r.owner) ?? []), r.app]);
  }
  const events: WorkloadEvent[] = missing.map((c) => ({
    seq: seqOf(c.key),
    op: 'node_upsert',
    key: c.key,
    kind: 'ReplicaSet',
    valid_from: new Date(c.t).toISOString(),
    body: {
      key: c.key,
      kind: 'ReplicaSet',
      namespace: c.ns,
      name: c.name,
      uid: null,
      labels: {},
      component_type: null,
      hub: false,
    },
    previous: null,
    owner: c.owner,
    ownerSeenBefore: true,
    managers: (managers.get(c.owner) ?? []).sort(),
  }));
  events.sort((a, b) => a.valid_from.localeCompare(b.valid_from) || a.seq - b.seq);
  return deriveRollouts(events, o).map((ch) => ({
    ...ch,
    change_id: ch.change_id.replace(/:(-\d+)$/, (_m, n: string) => `:ksm${n}`),
  }));
}
