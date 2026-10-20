import type { ChangeEvent, TopologyNode } from '@srenautix/contract';
import type { Queryable } from '../store/pool.js';

// 从拓扑事件推导 Kubernetes 的发布变更（ADR 0104）：不需要额外的集成，informer 与 reader 写入的拓扑事件里
// 已经有工作负载的版本信号：
// - 工作负载（Deployment、StatefulSet、DaemonSet）的版本标签变化（默认 app.kubernetes.io/version、helm.sh/chart，
//   可配置，例如 CCHP 的 cchp.io/release-id）；回滚到旧 ReplicaSet 时没有新 ReplicaSet，只能靠这一条看出来；
// - 新出现的 ReplicaSet（Pod 模板变化），归到它的 Deployment。
// 同一时间段（默认 2 分钟内）、同一版本取值或同一个管理它们的 Argo/Flux 应用的变化合成一次发布，目标是这些工作负载
// 与管理它们的应用。结果是 changes/v1 的 ChangeEvent（source kubernetes、kind rollout），和变更源的变更一起参与收敛。

export interface WorkloadEvent {
  seq: number;
  op: 'node_upsert' | 'node_delete';
  key: string;
  kind: string;
  valid_from: string;
  body: TopologyNode;
  /** 同一个 key 在这次之前的最后一个版本；没有时为 null（第一次出现） */
  previous: TopologyNode | null;
  /** ReplicaSet 的属主（owned_by）；其他为 null */
  owner: string | null;
  /** 属主在这个 ReplicaSet 出现之前就已经在拓扑中（首次同步时同时出现的旧 ReplicaSet 不算发布） */
  ownerSeenBefore?: boolean;
  /** 管理这个工作负载的应用（managed_by），例如 Application.argoproj.io:argocd/shop */
  managers: string[];
}

export interface RolloutOptions {
  clusterId: string;
  revisionLabels: readonly string[];
  /** 合成一次发布的时间范围 */
  groupWithinMs: number;
}

export const DEFAULT_REVISION_LABELS = ['app.kubernetes.io/version', 'helm.sh/chart'] as const;
export const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'] as const;

interface Atom {
  time: number;
  seq: number;
  target: string;
  managers: string[];
  /** 版本标签的新取值（只取第一个变化的标签）；新 ReplicaSet 时为 Pod 模板的哈希 */
  revision: string | null;
  fromLabel: boolean;
  describe: string;
}

function revisionChange(
  e: WorkloadEvent,
  labels: readonly string[],
): { label: string; from: string; to: string } | null {
  if (!e.previous) {
    return null;
  }
  for (const l of labels) {
    const from = e.previous.labels?.[l] ?? '';
    const to = e.body.labels?.[l] ?? '';
    if (from !== to) {
      return { label: l, from, to };
    }
  }
  return null;
}

const short = (key: string) => key.slice(key.indexOf('/') + 1);

/** 拓扑事件 → 发布变更；结果按时间排序，change_id 只依赖输入，重复计算结果相同 */
export function deriveRollouts(events: readonly WorkloadEvent[], o: RolloutOptions): ChangeEvent[] {
  const atoms: Atom[] = [];
  for (const e of events) {
    if (e.op !== 'node_upsert') {
      continue;
    }
    const time = Date.parse(e.valid_from);
    if ((WORKLOAD_KINDS as readonly string[]).includes(e.kind)) {
      const r = revisionChange(e, o.revisionLabels);
      if (r) {
        atoms.push({
          time,
          seq: e.seq,
          target: e.key,
          managers: e.managers,
          revision: r.to || null,
          fromLabel: true,
          describe: `${short(e.key)}：${r.label} ${r.from || '（无）'} → ${r.to || '（无）'}`,
        });
      }
    } else if (e.kind === 'ReplicaSet' && e.previous === null && e.owner && e.ownerSeenBefore !== false) {
      atoms.push({
        time,
        seq: e.seq,
        target: e.owner,
        managers: e.managers,
        revision: e.body.labels?.['pod-template-hash'] ?? null,
        fromLabel: false,
        describe: `${short(e.owner)}：新的 ReplicaSet ${e.body.name}`,
      });
    }
  }
  atoms.sort((a, b) => a.time - b.time || a.seq - b.seq);
  const groups: Atom[][] = [];
  for (const a of atoms) {
    const g = groups.find(
      (x) =>
        a.time - x[0]!.time <= o.groupWithinMs &&
        x.some(
          (y) =>
            y.target === a.target ||
            (a.revision !== null && y.revision === a.revision) ||
            y.managers.some((m) => a.managers.includes(m)),
        ),
    );
    if (g) {
      g.push(a);
    } else {
      groups.push([a]);
    }
  }
  return groups.map((g) => {
    const first = g[0]!;
    const workloads = [...new Set(g.map((a) => a.target))];
    const managers = [...new Set(g.flatMap((a) => a.managers))].sort();
    // 版本：优先取版本标签的新取值，没有时取 Pod 模板哈希；不唯一时为 null
    const pick = (fromLabel: boolean) => [
      ...new Set(
        g
          .filter((a) => a.fromLabel === fromLabel)
          .map((a) => a.revision)
          .filter((r): r is string => r !== null),
      ),
    ];
    const revisions = pick(true).length ? pick(true) : pick(false);
    const lines = [...new Set(g.map((a) => a.describe))];
    return {
      change_id: `kubernetes:${o.clusterId}:${first.seq}`,
      source: 'kubernetes',
      kind: 'rollout',
      refs: managers,
      revision: revisions.length === 1 ? revisions[0]! : null,
      actor: null,
      time: new Date(first.time).toISOString(),
      link: null,
      targets: [...workloads.sort(), ...managers],
      summary: lines.join('；').slice(0, 500),
    };
  });
}

/**
 * 从状态库读取 [from, to] 内工作负载与 ReplicaSet 的拓扑事件，附上前一个版本、ReplicaSet 的属主与管理应用，
 * 推导发布变更。
 */
export async function kubernetesRollouts(
  q: Queryable,
  from: Date,
  to: Date,
  o: RolloutOptions,
): Promise<ChangeEvent[]> {
  const r = await q.query<{
    seq: string;
    op: 'node_upsert' | 'node_delete';
    key: string;
    kind: string;
    valid_from: Date;
    body: TopologyNode;
    previous: TopologyNode | null;
    owner: string | null;
    owner_seen_before: boolean | null;
    managers: string[] | null;
  }>(
    `SELECT t.seq, t.op, t.key, t.kind, t.valid_from, t.body, prev.body AS previous, own.owner,
       (own.owner IS NOT NULL AND EXISTS (SELECT 1 FROM server.topology_events s
         WHERE s.cluster_id = t.cluster_id AND s.item = 'node' AND s.key = own.owner
           AND s.valid_from < t.valid_from - interval '1 minute')) AS owner_seen_before,
       (SELECT array_agg(DISTINCT e.body->>'to') FROM server.topology_events e
         WHERE e.cluster_id = t.cluster_id AND e.item = 'edge' AND e.op = 'edge_upsert' AND e.body->>'relation' = 'managed_by'
           AND e.body->>'from' = coalesce(own.owner, t.key)
           AND e.valid_from <= t.valid_from + interval '1 minute'
           AND (e.valid_to IS NULL OR e.valid_to > t.valid_from)) AS managers
     FROM server.topology_events t
     LEFT JOIN LATERAL (SELECT p.body FROM server.topology_events p
         WHERE p.cluster_id = t.cluster_id AND p.item = 'node' AND p.key = t.key AND p.seq < t.seq AND p.op = 'node_upsert'
         ORDER BY p.seq DESC LIMIT 1) prev ON true
     LEFT JOIN LATERAL (SELECT e.body->>'to' AS owner FROM server.topology_events e
         WHERE t.kind = 'ReplicaSet' AND e.cluster_id = t.cluster_id AND e.item = 'edge' AND e.op = 'edge_upsert'
           AND e.body->>'from' = t.key AND e.body->>'relation' = 'owned_by' AND e.valid_from <= t.valid_from + interval '1 minute'
         ORDER BY e.seq DESC LIMIT 1) own ON true
    WHERE t.cluster_id = $1 AND t.item = 'node' AND t.kind = ANY($2::text[])
      AND t.valid_from >= $3 AND t.valid_from <= $4
    ORDER BY t.seq`,
    [o.clusterId, [...WORKLOAD_KINDS, 'ReplicaSet'], from, to],
  );
  return deriveRollouts(
    r.rows.map((x) => ({
      seq: Number(x.seq),
      op: x.op,
      key: x.key,
      kind: x.kind,
      valid_from: x.valid_from.toISOString(),
      body: x.body,
      previous: x.previous,
      owner: x.owner,
      ownerSeenBefore: x.owner_seen_before ?? false,
      managers: x.managers ?? [],
    })),
    o,
  );
}
