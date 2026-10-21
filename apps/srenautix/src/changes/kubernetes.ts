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
  /** ReplicaSet 与 Job 的属主（owned_by）；其他为 null */
  owner: string | null;
  /** 属主在这个 ReplicaSet 出现之前就已经在拓扑中（首次同步时同时出现的旧 ReplicaSet 不算发布） */
  ownerSeenBefore?: boolean;
  /**
   * 管理这个对象的应用（managed_by），例如 Application.argoproj.io:argocd/shop。ReplicaSet 取它的属主的，
   * Job 取它自己的
   */
  managers: string[];
}

export interface RolloutOptions {
  clusterId: string;
  revisionLabels: readonly string[];
  /** 合成一次发布的时间范围 */
  groupWithinMs: number;
  /** 发布之前多久之内新建的 Job 可以作为它的前置步骤（默认 30 分钟，ADR 0104 §13） */
  preStepWithinMs?: number;
  /**
   * 属于这个对象（Job 或 ReplicaSet，沿 owned_by）的 Pod 的镜像，已按 normalizeImage 规整；没有数据时为 null。
   * 不提供时第 2 档（镜像）始终没有数据
   */
  images?: (owner: string) => readonly string[] | null;
  /**
   * 拓扑中的 Argo CD Application 键。Job 没有 managed_by 边、但带 Argo 的标签跟踪 `app.kubernetes.io/instance` 时，
   * 按名称唯一匹配到 Application 作为它的管理应用（PreSync 等 hook 不在 Application 的 status.resources 里）
   */
  argoApplications?: readonly string[];
  /**
   * 前置 Job 按版本标签关联时比较的标签（changes.kubernetes.pre_step_labels，例如 CCHP 的 cchp.io/release-id），
   * 默认不启用。Job 上的取值与发布的新 ReplicaSet（Pod 模板）或工作负载上的同名标签比较
   */
  preStepLabels?: readonly string[];
}

/** 前置 Job 关联到发布的依据（changes/v1 的 attachments.basis） */
export type AttachmentBasis = 'managed_by' | 'revision_label' | 'image' | 'namespace_window';

/** Argo CD 标签跟踪方式写入的标签，值是 Application 的名称 */
export const ARGO_INSTANCE_LABEL = 'app.kubernetes.io/instance';

export const DEFAULT_PRE_STEP_WITHIN_MS = 30 * 60_000;

export const DEFAULT_REVISION_LABELS = ['app.kubernetes.io/version', 'helm.sh/chart'] as const;
export const WORKLOAD_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'] as const;

interface Atom {
  time: number;
  seq: number;
  target: string;
  /** 新 ReplicaSet 时是它的键（镜像比较用） */
  replicaSet: string | null;
  managers: string[];
  /** 版本标签的新取值（只取第一个变化的标签）；新 ReplicaSet 时为 Pod 模板的哈希 */
  revision: string | null;
  fromLabel: boolean;
  /** 工作负载或新 ReplicaSet 上 preStepLabels 的取值（有值的），用于按版本标签关联前置 Job */
  stepLabels: Record<string, string>;
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

interface PreStep {
  time: number;
  seq: number;
  key: string;
  namespace: string | null;
  managers: string[];
  labels: Readonly<Record<string, string | undefined>>;
}

/** 对象标签中 keys 里有值的部分 */
const labelValues = (labels: Readonly<Record<string, string | undefined>> | undefined, keys: readonly string[]) =>
  Object.fromEntries(keys.flatMap((k) => (labels?.[k] ? [[k, labels[k]!]] : [])));

const namespaceOf = (key: string): string | null => {
  const rest = key.slice(key.indexOf(':') + 1);
  return rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : null;
};

/** 拓扑事件 → 发布变更；结果按时间排序，change_id 只依赖输入，重复计算结果相同 */
export function deriveRollouts(events: readonly WorkloadEvent[], o: RolloutOptions): ChangeEvent[] {
  const atoms: Atom[] = [];
  const jobs: PreStep[] = [];
  for (const e of events) {
    if (e.op !== 'node_upsert') {
      continue;
    }
    const time = Date.parse(e.valid_from);
    // 新建的 Job（CronJob 创建的除外）：可能是发布的前置步骤（迁移、预检），在下面按三档依据关联
    if (e.kind === 'Job') {
      if (e.previous === null && !(e.owner ?? '').startsWith('CronJob:') && !jobs.some((j) => j.key === e.key)) {
        // 没有 managed_by 边时，按 Argo 的标签跟踪找管理应用：名称唯一匹配拓扑中的 Application
        let managers = e.managers;
        const instance = e.body.labels?.[ARGO_INSTANCE_LABEL];
        if (!managers.length && instance && o.argoApplications) {
          const hits = o.argoApplications.filter((k) => k.slice(k.lastIndexOf('/') + 1) === instance);
          managers = hits.length === 1 ? hits : [];
        }
        jobs.push({
          time,
          seq: e.seq,
          key: e.key,
          namespace: e.body.namespace ?? namespaceOf(e.key),
          managers,
          labels: e.body.labels ?? {},
        });
      }
      continue;
    }
    if ((WORKLOAD_KINDS as readonly string[]).includes(e.kind)) {
      const r = revisionChange(e, o.revisionLabels);
      if (r) {
        atoms.push({
          time,
          seq: e.seq,
          target: e.key,
          replicaSet: null,
          managers: e.managers,
          revision: r.to || null,
          fromLabel: true,
          stepLabels: labelValues(e.body.labels, o.preStepLabels ?? []),
          describe: `${short(e.key)}：${r.label} ${r.from || '（无）'} → ${r.to || '（无）'}`,
        });
      }
    } else if (e.kind === 'ReplicaSet' && e.previous === null && e.owner && e.ownerSeenBefore !== false) {
      atoms.push({
        time,
        seq: e.seq,
        target: e.owner,
        replicaSet: e.key,
        managers: e.managers,
        revision: e.body.labels?.['pod-template-hash'] ?? null,
        fromLabel: false,
        // 新 ReplicaSet 的 Pod 模板标签带着这次发布的版本标签（例如 CCHP 的 cchp.io/release-id）
        stepLabels: labelValues(e.body.labels, o.preStepLabels ?? []),
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
  const attached = attachPreSteps(groups, jobs, o);
  return groups.map((g, gi) => {
    const first = g[0]!;
    const workloads = [...new Set(g.map((a) => a.target))];
    const managers = [...new Set(g.flatMap((a) => a.managers))].sort();
    const pre = attached.get(gi) ?? [];
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
    const lines = [
      ...pre.map((p) => `前置 Job ${short(p.job.key)}（${BASIS_TEXT[p.basis]}）`),
      ...new Set(g.map((a) => a.describe)),
    ];
    const start = Math.min(first.time, ...pre.map((p) => p.job.time));
    const change: ChangeEvent = {
      // change_id 仍取第一个工作负载变化的序号：挂上前置 Job 不改变变更的身份
      change_id: `kubernetes:${o.clusterId}:${first.seq}`,
      source: 'kubernetes',
      kind: 'rollout',
      refs: managers,
      revision: revisions.length === 1 ? revisions[0]! : null,
      actor: null,
      time: new Date(start).toISOString(),
      link: null,
      targets: [...workloads.sort(), ...pre.map((p) => p.job.key).sort(), ...managers],
      summary: lines.join('；').slice(0, 500),
    };
    if (pre.length) {
      change.attachments = pre.map((p) => ({ target: p.job.key, basis: p.basis }));
    }
    return change;
  });
}

const BASIS_TEXT: Record<AttachmentBasis, string> = {
  managed_by: '与发布由同一个应用管理',
  revision_label: '版本标签与发布的相同',
  image: '镜像与发布的新 ReplicaSet 相同',
  namespace_window: '只按同一命名空间与时间窗推断',
};

/**
 * 发布之前的 Job 关联到发布（ADR 0104 §13）。Job 在发布开始之前 preStepWithinMs 之内新建，依次判定，有数据的一档决定结果：
 * 1. Job 有管理应用（managed_by 边，或 Argo 的 instance 标签）：必须与发布的一致，不一致就不挂；
 * 2. Job 带配置的版本标签（preStepLabels，例如 cchp.io/release-id），发布的工作负载或新 ReplicaSet 也带：取值相同就挂，
 *    不同就不挂；
 * 3. Job 的 Pod 镜像与发布新 ReplicaSet 的 Pod 镜像有相同的（digest 或 tag）就挂，没有相同的不挂；
 * 4. 以上都没有数据：同一命名空间，并且这次发布的窗口里只有这一个候选 Job 时才挂（弱推导，attachments 标为
 *    namespace_window）。
 * 一个 Job 只挂到它之后最近的、判定通过的那次发布。
 */
function attachPreSteps(
  groups: Atom[][],
  jobs: readonly PreStep[],
  o: RolloutOptions,
): Map<number, Array<{ job: PreStep; basis: AttachmentBasis }>> {
  const within = o.preStepWithinMs ?? DEFAULT_PRE_STEP_WITHIN_MS;
  const out = new Map<number, Array<{ job: PreStep; basis: AttachmentBasis }>>();
  const used = new Set<string>();
  const order = groups.map((g, i) => ({ g, i })).sort((a, b) => a.g[0]!.time - b.g[0]!.time || a.i - b.i);
  for (const { g, i } of order) {
    const start = g[0]!.time;
    const managers = new Set(g.flatMap((a) => a.managers));
    const namespaces = new Set(g.map((a) => namespaceOf(a.target)).filter((n): n is string => n !== null));
    const rsImages = (() => {
      if (!o.images) {
        return null;
      }
      const all = g.flatMap((a) => (a.replicaSet ? [...(o.images!(a.replicaSet) ?? [])] : []));
      return all.length ? new Set(all) : null;
    })();
    // 发布的版本标签取值：同一个标签在这次发布里有多个取值时不用它判定
    const values = new Map<string, Set<string>>();
    for (const a of g) {
      for (const [k, v] of Object.entries(a.stepLabels)) {
        values.set(k, (values.get(k) ?? new Set()).add(v));
      }
    }
    const releaseLabels = new Map([...values].flatMap(([k, s]) => (s.size === 1 ? [[k, [...s][0]!] as const] : [])));
    const candidates = jobs.filter((j) => !used.has(j.key) && j.time <= start && start - j.time <= within);
    const strong: Array<{ job: PreStep; basis: AttachmentBasis }> = [];
    const weak: PreStep[] = [];
    let considered = 0;
    for (const j of candidates) {
      if (j.managers.length) {
        considered++;
        if (j.managers.some((m) => managers.has(m))) {
          strong.push({ job: j, basis: 'managed_by' });
        }
        continue;
      }
      const shared = [...releaseLabels.keys()].filter((k) => j.labels[k]);
      if (shared.length) {
        considered++;
        if (shared.every((k) => j.labels[k] === releaseLabels.get(k))) {
          strong.push({ job: j, basis: 'revision_label' });
        }
        continue;
      }
      const ji = o.images?.(j.key) ?? null;
      if (ji?.length && rsImages) {
        considered++;
        if (ji.some((x) => rsImages.has(x))) {
          strong.push({ job: j, basis: 'image' });
        }
        continue;
      }
      if (j.namespace !== null && namespaces.has(j.namespace)) {
        considered++;
        weak.push(j);
      }
    }
    // 弱推导只在这次发布的窗口里只有一个候选 Job 时成立：有多个时无法判断哪一个属于这次发布
    const picked = [
      ...strong,
      ...(weak.length === 1 && considered === 1 ? [{ job: weak[0]!, basis: 'namespace_window' as const }] : []),
    ];
    if (picked.length) {
      picked.sort((a, b) => a.job.time - b.job.time || a.job.seq - b.job.seq);
      picked.forEach((p) => used.add(p.job.key));
      out.set(i, picked);
    }
  }
  return out;
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
           AND e.body->>'from' = CASE WHEN t.kind = 'ReplicaSet' THEN coalesce(own.owner, t.key) ELSE t.key END
           AND e.valid_from <= t.valid_from + interval '1 minute'
           AND (e.valid_to IS NULL OR e.valid_to > t.valid_from)) AS managers
     FROM server.topology_events t
     LEFT JOIN LATERAL (SELECT p.body FROM server.topology_events p
         WHERE p.cluster_id = t.cluster_id AND p.item = 'node' AND p.key = t.key AND p.seq < t.seq AND p.op = 'node_upsert'
         ORDER BY p.seq DESC LIMIT 1) prev ON true
     LEFT JOIN LATERAL (SELECT e.body->>'to' AS owner FROM server.topology_events e
         WHERE t.kind IN ('ReplicaSet', 'Job') AND e.cluster_id = t.cluster_id AND e.item = 'edge' AND e.op = 'edge_upsert'
           AND e.body->>'from' = t.key AND e.body->>'relation' = 'owned_by' AND e.valid_from <= t.valid_from + interval '1 minute'
         ORDER BY e.seq DESC LIMIT 1) own ON true
    WHERE t.cluster_id = $1 AND t.item = 'node' AND t.kind = ANY($2::text[])
      AND t.valid_from >= $3 AND t.valid_from <= $4
    ORDER BY t.seq`,
    [o.clusterId, [...WORKLOAD_KINDS, 'ReplicaSet', 'Job'], from, to],
  );
  // 新 Job 与新 ReplicaSet 的 Pod 镜像（Pod 节点的 images，沿 owned_by），供第 2 档比较
  const owners = r.rows
    .filter((x) => (x.kind === 'Job' || x.kind === 'ReplicaSet') && x.previous === null)
    .map((x) => x.key);
  const images = new Map<string, Set<string>>();
  if (owners.length && r.rows.some((x) => x.kind === 'Job')) {
    const im = await q.query<{ owner: string; images: string[] }>(
      `SELECT DISTINCT e.body->>'to' AS owner, n.body->'images' AS images
         FROM server.topology_events e
         JOIN server.topology_events n ON n.cluster_id = e.cluster_id AND n.item = 'node' AND n.key = e.body->>'from'
              AND n.op = 'node_upsert' AND jsonb_typeof(n.body->'images') = 'array'
        WHERE e.cluster_id = $1 AND e.item = 'edge' AND e.op = 'edge_upsert' AND e.body->>'relation' = 'owned_by'
          AND e.body->>'to' = ANY($2::text[])`,
      [o.clusterId, owners],
    );
    for (const x of im.rows) {
      const s = images.get(x.owner) ?? new Set<string>();
      x.images.forEach((i) => s.add(i));
      images.set(x.owner, s);
    }
  }
  // Argo CD Application：没有 managed_by 边的 Job 按 instance 标签找管理应用
  const apps = r.rows.some((x) => x.kind === 'Job' && x.body.labels?.[ARGO_INSTANCE_LABEL])
    ? (
        await q.query<{ key: string }>(
          `SELECT DISTINCT key FROM server.topology_events
            WHERE cluster_id = $1 AND item = 'node' AND op = 'node_upsert' AND key LIKE 'Application.argoproj.io:%'`,
          [o.clusterId],
        )
      ).rows.map((x) => x.key)
    : [];
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
    {
      ...o,
      images: (owner) => (images.has(owner) ? [...images.get(owner)!] : null),
      argoApplications: apps,
    },
  );
}
