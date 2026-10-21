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
 *
 * StatefulSet 没有 ReplicaSet：模板变化时 `kube_statefulset_status_update_revision` 换一个 revision（ControllerRevision 名称），
 * 与新 ReplicaSet 等价。窗口内第一次出现的 revision 是一次变化（窗口开始时就在的 revision 不算），StatefulSet 自己要
 * 早于它一分钟以上存在；拓扑在这个时间窗里已经记录了这个 StatefulSet 的变化（版本标签变化）时不再生成。
 */
export type InstantQuery = (req: MetricsQueryRequest) => Promise<{ series: MetricSeries[] }>;

const CREATED_GAP_MS = 60_000;
/** 子查询的步长：revision 第一次出现的时刻精确到这个粒度 */
const REVISION_STEP_S = 30;
/**
 * 子查询里的瞬时选择器还要向前回看 Prometheus 的默认回看量（5 分钟），回放时钟检查把它计入：子查询的区间比窗口短这么多。
 * 窗口最前面这 5 分钟里出现的 revision 因此当作窗口开始时就在（变更输入的窗口比最早的告警早一个变更窗口加时间相邻，
 * 这么早的变化解释不了任何告警）
 */
const PROM_LOOKBACK_S = 300;
/** 拓扑记录的 StatefulSet 变化与 kube-state-metrics 的 revision 变化相差不超过这么久时视为同一次变化 */
export const STATEFULSET_REVISION_DEDUPE_MS = 10 * 60_000;

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
  // 向下取整：向上取整会让回看比时钟窗口起点早不到一秒，回放时钟检查拒绝整个查询（Kind 里回退因此从未生效）
  const rangeS = Math.max(60, Math.floor((to.getTime() - from.getTime()) / 1000));
  const range = `${rangeS}s`;
  const at = {
    time: to.toISOString(),
    clock_window: { from: from.toISOString(), to: to.toISOString() },
    timeout_ms: 10_000,
  };
  const run = (expr: string) => query({ expr, dialect: 'promql', ...at } as MetricsQueryRequest);
  const [created, owners, deployments, revisions, statefulsets] = await Promise.all([
    run(`max by (namespace, replicaset) (last_over_time(kube_replicaset_created[${range}]))`),
    run(
      `max by (namespace, replicaset, owner_name) (last_over_time(kube_replicaset_owner{owner_kind="Deployment"}[${range}]))`,
    ),
    run(`max by (namespace, deployment) (last_over_time(kube_deployment_created[${range}]))`),
    // 每个 revision 在窗口内第一次出现的时刻（子查询从窗口起点之后的回看量开始）
    run(
      `min by (namespace, statefulset, revision) (min_over_time(timestamp(kube_statefulset_status_update_revision)[${Math.max(60, rangeS - PROM_LOOKBACK_S)}s:${REVISION_STEP_S}s]))`,
    ),
    run(`max by (namespace, statefulset) (last_over_time(kube_statefulset_created[${range}]))`),
  ]);
  const stsEvents = await statefulsetRevisions(db, o, from, to, revisions.series, statefulsets.series);
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
  // 拓扑里记录过的 ReplicaSet 交给 kubernetesRollouts；属主的管理应用取拓扑里的 managed_by 边
  const known = candidates.length
    ? await db.query<{ key: string }>(
        `SELECT DISTINCT key FROM server.topology_events WHERE cluster_id = $1 AND item = 'node' AND key = ANY($2::text[])`,
        [o.clusterId, candidates.map((c) => c.key)],
      )
    : { rows: [] };
  const seen = new Set(known.rows.map((r) => r.key));
  const missing = candidates.filter((c) => !seen.has(c.key));
  if (!missing.length && !stsEvents.length) {
    return [];
  }
  const managers = await managersOf(
    db,
    o.clusterId,
    [...new Set([...missing.map((c) => c.owner), ...stsEvents.map((e) => e.owner!)])],
    from,
    to,
  );
  for (const e of stsEvents) {
    e.managers = (managers.get(e.owner!) ?? []).sort();
  }
  const rsEvents: WorkloadEvent[] = missing.map((c) => ({
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
  const events = [...rsEvents, ...stsEvents];
  events.sort((a, b) => a.valid_from.localeCompare(b.valid_from) || a.seq - b.seq);
  return deriveRollouts(events, o).map((ch) => ({
    ...ch,
    change_id: ch.change_id.replace(/:(-\d+)$/, (_m, n: string) => `:ksm${n}`),
  }));
}

/** 工作负载在 [from, to] 内有效的 managed_by（拓扑） */
async function managersOf(
  db: Queryable,
  clusterId: string,
  owners: string[],
  from: Date,
  to: Date,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!owners.length) {
    return out;
  }
  const mg = await db.query<{ owner: string; app: string }>(
    `SELECT DISTINCT body->>'from' AS owner, body->>'to' AS app FROM server.topology_events
      WHERE cluster_id = $1 AND item = 'edge' AND op = 'edge_upsert' AND body->>'relation' = 'managed_by'
        AND body->>'from' = ANY($2::text[]) AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $4)`,
    [clusterId, owners, to, from],
  );
  for (const r of mg.rows) {
    out.set(r.owner, [...(out.get(r.owner) ?? []), r.app]);
  }
  return out;
}

/**
 * kube-state-metrics 的 StatefulSet update revision → ControllerRevision 事件（属主为 StatefulSet）。revision 在窗口开始
 * 两个步长之后才第一次出现才算变化；StatefulSet 早于它一分钟以上存在；拓扑在这个时间窗里记录过这个 StatefulSet 的变化，
 * 或者记录过这个 ControllerRevision 时跳过
 */
async function statefulsetRevisions(
  db: Queryable,
  o: RolloutOptions,
  from: Date,
  to: Date,
  revisions: MetricSeries[],
  statefulsets: MetricSeries[],
): Promise<WorkloadEvent[]> {
  const created = new Map(statefulsets.map((s) => [`${s.labels.namespace}/${s.labels.statefulset}`, last(s)]));
  const cands: Array<{ key: string; owner: string; t: number; ns: string; name: string }> = [];
  for (const s of revisions) {
    const { namespace: ns, statefulset, revision } = s.labels;
    const first = last(s);
    if (!ns || !statefulset || !revision || first === null) {
      continue;
    }
    const t = first * 1000;
    // 子查询起点（窗口起点加回看量）之后两个步长内第一次出现的，当作起点时就在
    if (t <= from.getTime() + (PROM_LOOKBACK_S + 2 * REVISION_STEP_S) * 1000 || t > to.getTime()) {
      continue;
    }
    const c = created.get(`${ns}/${statefulset}`);
    const key = tryNodeKey('ControllerRevision', ns, revision);
    const owner = tryNodeKey('StatefulSet', ns, statefulset);
    if (!key || !owner || c === undefined || c === null || c * 1000 > t - CREATED_GAP_MS) {
      continue;
    }
    cands.push({ key, owner, t, ns, name: revision });
  }
  if (!cands.length) {
    return [];
  }
  const recorded = await db.query<{ key: string; valid_from: Date }>(
    `SELECT e.key, e.valid_from FROM server.topology_events e
      WHERE e.cluster_id = $1 AND e.item = 'node' AND e.op = 'node_upsert'
        AND (e.key = ANY($2::text[]) OR (e.key = ANY($3::text[]) AND EXISTS (
          SELECT 1 FROM server.topology_events p WHERE p.cluster_id = e.cluster_id AND p.item = 'node' AND p.key = e.key
             AND p.op = 'node_upsert' AND p.seq < e.seq)))`,
    [o.clusterId, cands.map((c) => c.key), [...new Set(cands.map((c) => c.owner))]],
  );
  const keep = cands.filter(
    (c) =>
      !recorded.rows.some(
        (r) =>
          r.key === c.key ||
          (r.key === c.owner && Math.abs(r.valid_from.getTime() - c.t) <= STATEFULSET_REVISION_DEDUPE_MS),
      ),
  );
  return keep.map((c) => ({
    seq: seqOf(c.key),
    op: 'node_upsert',
    key: c.key,
    kind: 'ControllerRevision',
    valid_from: new Date(c.t).toISOString(),
    body: {
      key: c.key,
      kind: 'ControllerRevision',
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
    managers: [],
  }));
}
