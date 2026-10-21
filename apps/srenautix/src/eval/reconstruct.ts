import type {
  Alert,
  ChangeEvent,
  EvalSnapshot,
  EvidenceResult,
  Incident,
  TopologyEdge,
  TopologyNode,
} from '@srenautix/contract';
import {
  changeInputFrom,
  computeIncidents,
  isIgnorable,
  parseKey,
  sameKind,
  reconcileIncidents,
  TopologyGraph,
  type ResolvedRcaParams,
} from '@srenautix/core';
import { resolveAlert, type NodeLookup } from '../alerts/resolve.js';
import { deriveRollouts, WORKLOAD_KINDS, type WorkloadEvent } from '../changes/kubernetes.js';
import { STATEFULSET_REVISION_DEDUPE_MS } from '../changes/ksm-rollouts.js';
import { alertId } from '../ingest/normalize.js';
import type { Catalog } from '../proposals/catalog.js';
import type { QueryRunner } from '../research/checks.js';
import { toSubgraph } from '../research/service.js';
import type { TaskContext } from '../research/hub.js';
import { parseStoredKey } from '../topology/keys.js';
import type { PackEvidence, PackRules } from '../stage-a/pack-evidence.js';
import type { PackRuntime } from '../stage-a/packs.js';
import { buildReport, verdictFingerprint } from '../stage-a/report.js';
import { agreeAlerts, type AlertAgreement } from './agreement.js';
import type { AlertInstance, Bundle, TopologyRow } from './bundle.js';
import { matchesFault, type Label } from './labels.js';
import { cardChecks, parseCardCheckId } from '../stage-a/card-checks.js';
import { stableUuid } from './import-seed.js';

// 重建（DESIGN §14.2 reconstructed，ADR 0110）：用重建包按 server 的同一套代码重放一段时间。
// - 拓扑：时刻 t 的节点与边取 valid_from ≤ t < valid_to 的行（与状态库的 at 查询相同），同一个键状态库的行优先于
//   kube-state-metrics 历史；状态库在 t 时知道的节点，它的出边只取状态库的；
// - 告警：实例在第一次观察到 firing 时接入（resolveAlert 在那一刻查拓扑），firing_to 之后为 resolved；
// - 事件：每个步长按 IncidentEngine.recompute 的方式重算——取触发中与相邻时间内结束的告警、窗口内的变更
//   （变更源的变更加上从拓扑事件推导的发布），computeIncidents 后与上一步的事件 reconcileIncidents；
// - 分析：在 as_of 取包含故障告警最多的事件，按阶段 A 的代码路径出证据卡与报告，按 worker 的方式组装研判输入。

const TOMBSTONE_MS = 24 * 3600_000;

interface Interval<T> {
  seq: number;
  from: number;
  to: number | null;
  ksm: boolean;
  body: T;
  kind: string | null;
  namespace: string | null;
  name: string | null;
}

const ms = (s: string) => Date.parse(s);
const live = (iv: { from: number; to: number | null }, t: number) => iv.from <= t && (iv.to === null || t < iv.to);

/** 重建包中的拓扑：按时刻取节点与边，实现与状态库相同的节点查找 */
export class BundleTopology implements NodeLookup {
  private readonly nodes = new Map<string, Array<Interval<TopologyNode>>>();
  private readonly edges = new Map<string, Array<Interval<TopologyEdge>>>();
  /** owned_by 边按起点（属主查找用） */
  private readonly ownedBy = new Map<string, Array<Interval<TopologyEdge>>>();
  private readonly boundaries: number[];
  private readonly stateNodes: TopologyRow[];
  private readonly stateEdges: TopologyRow[];
  private cache: { version: number; graph: TopologyGraph; nodes: TopologyNode[]; edges: TopologyEdge[] } | null = null;
  /** 节点查找时的"现在"（server 中是 now()）；重放时由调用方设为当前步的时刻 */
  now = 0;

  constructor(rows: readonly TopologyRow[]) {
    const bounds: number[] = [];
    for (const r of rows) {
      if (!r.op.endsWith('_upsert')) {
        continue;
      }
      const from = ms(r.valid_from);
      const to = r.valid_to === null ? null : ms(r.valid_to);
      bounds.push(from);
      if (to !== null) {
        bounds.push(to);
      }
      const ksm = r.source === 'ksm_history';
      if (r.item === 'node') {
        const n = r.body as TopologyNode;
        const list = this.nodes.get(r.key) ?? [];
        list.push({ seq: r.seq, from, to, ksm, body: n, kind: n.kind, namespace: n.namespace, name: n.name });
        this.nodes.set(r.key, list);
      } else {
        const list = this.edges.get(r.key) ?? [];
        const iv = { seq: r.seq, from, to, ksm, body: r.body as TopologyEdge, kind: null, namespace: null, name: null };
        list.push(iv);
        this.edges.set(r.key, list);
        if (iv.body.relation === 'owned_by') {
          const o = this.ownedBy.get(iv.body.from) ?? [];
          o.push(iv);
          this.ownedBy.set(iv.body.from, o);
        }
      }
    }
    this.boundaries = bounds.sort((a, b) => a - b);
    this.stateNodes = rows.filter((r) => r.item === 'node' && r.source !== 'ksm_history').sort((a, b) => a.seq - b.seq);
    this.stateEdges = rows.filter((r) => r.item === 'edge' && r.source !== 'ksm_history').sort((a, b) => a.seq - b.seq);
    // 状态库没有记录的 ReplicaSet：用 kube-state-metrics 历史推导发布（与 reader 的 history/ksm 相同，ADR 0110）。
    // 状态库有记录的 ReplicaSet 只用状态库，两个来源不混用
    const stateKeys = new Set(this.stateNodes.map((r) => r.key));
    this.ksmReplicaSets = rows
      .filter(
        (r) =>
          r.item === 'node' &&
          r.source === 'ksm_history' &&
          r.op === 'node_upsert' &&
          (r.body as TopologyNode).kind === 'ReplicaSet' &&
          !stateKeys.has(r.key),
      )
      .sort((a, b) => ms(a.valid_from) - ms(b.valid_from) || a.seq - b.seq);
    this.ksmJobs = rows
      .filter(
        (r) =>
          r.item === 'node' &&
          r.source === 'ksm_history' &&
          r.op === 'node_upsert' &&
          (r.body as TopologyNode).kind === 'Job' &&
          !stateKeys.has(r.key),
      )
      .sort((a, b) => ms(a.valid_from) - ms(b.valid_from) || a.seq - b.seq);
    // StatefulSet 的 update revision（kube_statefulset_status_update_revision，ADR 0104 §11）：状态库从不记录 ControllerRevision
    this.ksmRevisions = rows
      .filter(
        (r) =>
          r.item === 'node' &&
          r.source === 'ksm_history' &&
          r.op === 'node_upsert' &&
          (r.body as TopologyNode).kind === 'ControllerRevision' &&
          !stateKeys.has(r.key),
      )
      .sort((a, b) => ms(a.valid_from) - ms(b.valid_from) || a.seq - b.seq);
    this.ksmOwnedBy = rows.filter(
      (r) => r.item === 'edge' && r.source === 'ksm_history' && (r.body as TopologyEdge).relation === 'owned_by',
    );
    this.firstSeen = new Map();
    for (const r of rows) {
      if (r.item === 'node' && r.op === 'node_upsert') {
        const t = ms(r.valid_from);
        if (!this.firstSeen.has(r.key) || t < (this.firstSeen.get(r.key) as number)) {
          this.firstSeen.set(r.key, t);
        }
      }
    }
    this.rangeFrom = Math.min(...[...this.firstSeen.values()]);
  }

  private readonly ksmReplicaSets: TopologyRow[];
  private readonly ksmJobs: TopologyRow[];
  private readonly ksmRevisions: TopologyRow[];
  private readonly ksmOwnedBy: TopologyRow[];
  /** 每个节点键在任一来源中第一次出现的时刻 */
  private readonly firstSeen: Map<string, number>;
  /** 重建包拓扑的起点：kube-state-metrics 区间的下限不早于它，这一刻出现的对象在导出前就已存在 */
  private readonly rangeFrom: number;

  /** 拓扑版本：t 之前（含）的区间边界数，内容不变时版本不变 */
  version(t: number): number {
    let lo = 0;
    let hi = this.boundaries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.boundaries[mid] as number) <= t) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  private pick<T>(list: Array<Interval<T>>, t: number): Interval<T> | undefined {
    let ksm: Interval<T> | undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      const iv = list[i] as Interval<T>;
      if (!live(iv, t)) {
        continue;
      }
      if (!iv.ksm) {
        return iv;
      }
      ksm ??= iv;
    }
    return ksm;
  }

  at(t: number): { version: number; graph: TopologyGraph; nodes: TopologyNode[]; edges: TopologyEdge[] } {
    const version = this.version(t);
    if (this.cache?.version === version) {
      return this.cache;
    }
    const nodes: TopologyNode[] = [];
    // 状态库在 t 时知道的节点：它的出边也以状态库为准（kube-state-metrics 不带 API 组，属主可能换一个键重复出现）
    const fromState = new Set<string>();
    for (const list of this.nodes.values()) {
      const iv = this.pick(list, t);
      if (iv) {
        nodes.push(iv.body);
        if (!iv.ksm) {
          fromState.add(iv.body.key);
        }
      }
    }
    const keys = new Set(nodes.map((n) => n.key));
    const edges: TopologyEdge[] = [];
    for (const list of this.edges.values()) {
      const iv = this.pick(list, t);
      if (!iv || (iv.ksm && fromState.has(iv.body.from))) {
        continue;
      }
      // kube-state-metrics 的 kind 不带 API 组（Cluster 与 Cluster.postgresql.cnpg.io）：端点改写成状态库中同一个对象的键，
      // 否则同一个对象在图里有两个节点，收敛把它们当成两个组件
      const e = iv.ksm
        ? { ...iv.body, from: this.sameObjectKeyCached(iv.body.from), to: this.sameObjectKeyCached(iv.body.to) }
        : iv.body;
      if (keys.has(e.from) && keys.has(e.to)) {
        edges.push(e);
      }
    }
    this.cache = { version, graph: new TopologyGraph(nodes, edges, version), nodes, edges };
    return this.cache;
  }

  /** 两跳邻域（与 server 的 TopologyStore.neighborhood 相同：边的两个方向） */
  neighborhood(keys: readonly string[], t: number, hops = 2): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
    const all = this.at(t);
    const seen = new Set(keys);
    let frontier = new Set(keys);
    const edges = new Map<string, TopologyEdge>();
    for (let h = 0; h < hops; h++) {
      const next = new Set<string>();
      for (const e of all.edges) {
        if (frontier.has(e.from) || frontier.has(e.to)) {
          edges.set(`${e.from}|${e.relation}|${e.to}`, e);
          for (const k of [e.from, e.to]) {
            if (!seen.has(k)) {
              seen.add(k);
              next.add(k);
            }
          }
        }
      }
      frontier = next;
    }
    return { nodes: all.nodes.filter((n) => seen.has(n.key)), edges: [...edges.values()] };
  }

  /** NodeLookup（与状态库的 find 相同）：当前节点，或 24 小时内删除的墓碑；不带 API 组的 kind 也匹配 <kind>.<组> */
  async find(
    _clusterId: string,
    kind: string,
    namespace: string | null,
    name: string,
    at: Date,
  ): Promise<{ key: string; uid: string | null; tombstone: boolean; owner: string | null } | null> {
    const a = at.getTime();
    const upper = Math.max(a, this.now);
    const lower = Math.min(a, this.now) - TOMBSTONE_MS;
    const hits: Array<{ key: string; iv: Interval<TopologyNode> }> = [];
    for (const [key, list] of this.nodes) {
      for (const iv of list) {
        // 与状态库的 find 相同：kind 不区分大小写，没有点的 kind 也匹配 <kind>.<组>；告警没有命名空间时也接受命名空间级对象
        const ik = (iv.kind ?? '').toLowerCase();
        const kindOk = ik === kind.toLowerCase() || (!kind.includes('.') && ik.startsWith(`${kind.toLowerCase()}.`));
        if (
          kindOk &&
          ((iv.namespace ?? null) === namespace || namespace === null) &&
          iv.name === name &&
          iv.from <= upper &&
          (iv.to === null || iv.to > lower)
        ) {
          hits.push({ key, iv });
        }
      }
    }
    if (!hits.length) {
      return null;
    }
    if (namespace === null && !hits.some((h) => (h.iv.namespace ?? null) === null)) {
      // 只按名称找到的命名空间级对象：不同命名空间里有同名对象时无法确定
      if (new Set(hits.map((h) => h.key)).size !== 1) {
        return null;
      }
    }
    const open = (iv: Interval<TopologyNode>) => iv.to === null || iv.to > this.now;
    hits.sort(
      (x, y) =>
        Number((y.iv.namespace ?? null) === namespace) - Number((x.iv.namespace ?? null) === namespace) ||
        Number(open(y.iv)) - Number(open(x.iv)) ||
        Number(y.iv.kind === kind) - Number(x.iv.kind === kind) ||
        Number(!y.iv.ksm) - Number(!x.iv.ksm) ||
        y.iv.from - x.iv.from,
    );
    const best = hits[0] as { key: string; iv: Interval<TopologyNode> };
    // 命中的是 kube-state-metrics 历史的节点（kind 不带 API 组，例如 Cluster）时，改用状态库中同一个对象的键：
    // server 的状态库里只有 informer 写入的节点（Cluster.postgresql.cnpg.io）
    const key = best.iv.ksm ? this.sameObjectKeyCached(best.key) : best.key;
    return {
      key,
      uid: best.iv.body.uid ?? null,
      tombstone: best.iv.to !== null && best.iv.to <= a,
      owner: this.ownerOf(key, upper, lower),
    };
  }

  /**
   * 时刻 t 的顶层属主（研判根因与发现根因按属主粒度比较时用，incident/research-root.ts 的 rootsAgree）：
   * 与节点查找相同，属主边在 t 之前 24 小时内有效即可；没有属主时为 null
   */
  ownerAt(key: string, t: number): string | null {
    return this.ownerOf(this.sameObjectKeyCached(key), t, t - TOMBSTONE_MS);
  }

  /**
   * 顶层属主，与状态库的 ownerOf 相同（topology/store.ts）：沿 owned_by 边向上，边在 [lower, upper] 内有效，
   * 优先未结束的、状态库的、较新的
   */
  private ownerOf(key: string, upper: number, lower: number): string | null {
    let cur = key;
    const seen = new Set([key]);
    for (let depth = 0; depth < 8; depth++) {
      let best: Interval<TopologyEdge> | null = null;
      for (const iv of this.ownedBy.get(cur) ?? []) {
        if (iv.from > upper || (iv.to !== null && iv.to <= lower)) {
          continue;
        }
        const rank = (x: Interval<TopologyEdge>) => [Number(x.to === null), Number(!x.ksm), x.from] as const;
        const [a1, b1, c1] = rank(iv);
        const [a2, b2, c2] = best ? rank(best) : ([-1, -1, -1] as const);
        if (a1 > a2 || (a1 === a2 && (b1 > b2 || (b1 === b2 && c1 > c2)))) {
          best = iv;
        }
      }
      if (!best) {
        break;
      }
      // kube-state-metrics 的属主 kind 不带 API 组（Cluster），拓扑里的对象带组（Cluster.postgresql.cnpg.io）：
      // 换成同一个对象在拓扑里的键
      const to = this.sameObjectKey(best.body.to);
      if (seen.has(to)) {
        break;
      }
      seen.add(to);
      cur = to;
    }
    return cur === key ? null : cur;
  }

  /**
   * 键对应的拓扑节点键：状态库知道这个键时原样返回；否则（只有 kube-state-metrics 历史，或没有这个键）找状态库里
   * kind（sameKind）、命名空间与名称相同、唯一的节点
   */
  private sameObjectKey(key: string): string {
    if ((this.nodes.get(key) ?? []).some((iv) => !iv.ksm)) {
      return key;
    }
    let p: { kind: string; namespace: string | null; name: string };
    try {
      p = parseKey(key);
    } catch {
      return key;
    }
    const hits = new Set<string>();
    for (const [k, list] of this.nodes) {
      const n = list.find((iv) => !iv.ksm);
      if (
        k !== key &&
        n &&
        sameKind(n.kind ?? '', p.kind) &&
        (n.namespace ?? null) === p.namespace &&
        n.name === p.name
      ) {
        hits.add(k);
      }
    }
    return hits.size === 1 ? [...hits][0]! : key;
  }

  /** 拓扑行在重建包内不变，sameObjectKey 的结果按键缓存 */
  private readonly objectKeys = new Map<string, string>();

  private sameObjectKeyCached(key: string): string {
    let k = this.objectKeys.get(key);
    if (k === undefined) {
      k = this.sameObjectKey(key);
      this.objectKeys.set(key, k);
    }
    return k;
  }

  componentType(key: string, t: number): string | null {
    const iv = this.pick(this.nodes.get(key) ?? [], t);
    return iv?.body.component_type ?? null;
  }

  /** [from, to] 内工作负载与 ReplicaSet 的拓扑事件（与 changes/kubernetes.ts 的 kubernetesRollouts 查询相同） */
  workloadEvents(from: number, to: number): WorkloadEvent[] {
    this.workloads ??= this.buildWorkloadEvents();
    return this.workloads.filter((e) => {
      const t = ms(e.valid_from);
      return t >= from && t <= to;
    });
  }

  private workloads: WorkloadEvent[] | null = null;

  /** 每个事件的前一版本、属主与管理应用只取决于事件本身的时刻，一次算出 */
  private buildWorkloadEvents(): WorkloadEvent[] {
    const kinds = new Set<string>([...WORKLOAD_KINDS, 'ReplicaSet', 'Job']);
    const byKey = new Map<string, TopologyRow[]>();
    for (const r of this.stateNodes) {
      byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
    }
    const edgesFrom = new Map<string, TopologyRow[]>();
    for (const x of this.stateEdges) {
      const b = x.body as TopologyEdge;
      if (x.op === 'edge_upsert' && (b.relation === 'owned_by' || b.relation === 'managed_by')) {
        edgesFrom.set(b.from, [...(edgesFrom.get(b.from) ?? []), x]);
      }
    }
    const out: WorkloadEvent[] = [];
    for (const r of this.stateNodes) {
      const n = r.body as TopologyNode;
      if (!kinds.has(n.kind) || (r.op !== 'node_upsert' && r.op !== 'node_delete')) {
        continue;
      }
      const t = ms(r.valid_from);
      const prev = (byKey.get(r.key) ?? []).filter((p) => p.seq < r.seq && p.op === 'node_upsert').at(-1);
      let owner: string | null = null;
      if (n.kind === 'ReplicaSet' || n.kind === 'Job') {
        const e = (edgesFrom.get(r.key) ?? [])
          .filter((x) => (x.body as TopologyEdge).relation === 'owned_by' && ms(x.valid_from) <= t + 60_000)
          .at(-1);
        owner = e ? (e.body as TopologyEdge).to : null;
      }
      const ownerSeenBefore = owner !== null && (byKey.get(owner) ?? []).some((s) => ms(s.valid_from) < t - 60_000);
      // ReplicaSet 取属主（Deployment）的管理应用，其他对象取自己的
      const managedKey = n.kind === 'ReplicaSet' ? (owner ?? r.key) : r.key;
      const managers = [
        ...new Set(
          (edgesFrom.get(managedKey) ?? [])
            .filter(
              (x) =>
                (x.body as TopologyEdge).relation === 'managed_by' &&
                ms(x.valid_from) <= t + 60_000 &&
                (x.valid_to === null || ms(x.valid_to) > t),
            )
            .map((x) => (x.body as TopologyEdge).to),
        ),
      ];
      out.push({
        seq: r.seq,
        op: r.op as WorkloadEvent['op'],
        key: r.key,
        kind: n.kind,
        valid_from: r.valid_from,
        body: n,
        previous: prev ? (prev.body as TopologyNode) : null,
        owner,
        ownerSeenBefore,
        managers,
      });
    }
    // kube-state-metrics 历史中的 ReplicaSet：第一次出现（不在重建包起点）即为新的 ReplicaSet；
    // 属主取 kube-state-metrics 的 owned_by，管理应用取状态库的 managed_by（kube-state-metrics 没有这类关系）
    const seenRs = new Set<string>();
    for (const r of this.ksmReplicaSets) {
      if (seenRs.has(r.key)) {
        continue;
      }
      seenRs.add(r.key);
      const t = ms(r.valid_from);
      if (t <= this.rangeFrom) {
        continue;
      }
      const ownerEdge = this.ksmOwnedBy.find((x) => (x.body as TopologyEdge).from === r.key);
      const owner = ownerEdge ? (ownerEdge.body as TopologyEdge).to : null;
      if (owner === null) {
        continue;
      }
      const ownerFirst = this.firstSeen.get(owner);
      const managers = [
        ...new Set(
          (edgesFrom.get(owner) ?? [])
            .filter(
              (x) =>
                (x.body as TopologyEdge).relation === 'managed_by' &&
                ms(x.valid_from) <= t + 60_000 &&
                (x.valid_to === null || ms(x.valid_to) > t),
            )
            .map((x) => (x.body as TopologyEdge).to),
        ),
      ];
      out.push({
        seq: r.seq,
        op: 'node_upsert',
        key: r.key,
        kind: 'ReplicaSet',
        valid_from: r.valid_from,
        body: r.body as TopologyNode,
        previous: null,
        owner,
        ownerSeenBefore: ownerFirst !== undefined && ownerFirst < t - 60_000,
        managers,
      });
    }
    // kube-state-metrics 历史中的 Job（状态库没有记录的）：第一次出现（不在重建包起点）即为新建；属主取
    // kube_job_owner 的 owned_by（CronJob 创建的 Job 不作为发布的前置步骤），管理应用取状态库的 managed_by
    const seenJob = new Set<string>();
    for (const r of this.ksmJobs) {
      if (seenJob.has(r.key)) {
        continue;
      }
      seenJob.add(r.key);
      const t = ms(r.valid_from);
      if (t <= this.rangeFrom) {
        continue;
      }
      const ownerEdge = this.ksmOwnedBy.find((x) => (x.body as TopologyEdge).from === r.key);
      out.push({
        seq: r.seq,
        op: 'node_upsert',
        key: r.key,
        kind: 'Job',
        valid_from: r.valid_from,
        body: r.body as TopologyNode,
        previous: null,
        owner: ownerEdge ? (ownerEdge.body as TopologyEdge).to : null,
        managers: [
          ...new Set(
            (edgesFrom.get(r.key) ?? [])
              .filter((x) => (x.body as TopologyEdge).relation === 'managed_by')
              .map((x) => (x.body as TopologyEdge).to),
          ),
        ],
      });
    }
    // kube-state-metrics 历史中 StatefulSet 的新 update revision（与 ReplicaSet 相同的规则，ADR 0104 §11）：
    // - 重建包起点就存在的 revision 不算变化；
    // - 状态库在这个时间窗里记录过这个 StatefulSet 的变化（版本标签变化）时，由状态库推导，不再用 kube-state-metrics
    const seenRev = new Set<string>();
    for (const r of this.ksmRevisions) {
      if (seenRev.has(r.key)) {
        continue;
      }
      seenRev.add(r.key);
      const t = ms(r.valid_from);
      if (t <= this.rangeFrom) {
        continue;
      }
      const ownerEdge = this.ksmOwnedBy.find((x) => (x.body as TopologyEdge).from === r.key);
      const owner = ownerEdge ? (ownerEdge.body as TopologyEdge).to : null;
      if (owner === null) {
        continue;
      }
      const recorded = out.some(
        (e) =>
          e.key === owner && e.previous !== null && Math.abs(ms(e.valid_from) - t) <= STATEFULSET_REVISION_DEDUPE_MS,
      );
      if (recorded) {
        continue;
      }
      const ownerFirst = this.firstSeen.get(owner);
      out.push({
        seq: r.seq,
        op: 'node_upsert',
        key: r.key,
        kind: 'ControllerRevision',
        valid_from: r.valid_from,
        body: r.body as TopologyNode,
        previous: null,
        owner,
        ownerSeenBefore: ownerFirst !== undefined && ownerFirst < t - 60_000,
        managers: [
          ...new Set(
            (edgesFrom.get(owner) ?? [])
              .filter(
                (x) =>
                  (x.body as TopologyEdge).relation === 'managed_by' &&
                  ms(x.valid_from) <= t + 60_000 &&
                  (x.valid_to === null || ms(x.valid_to) > t),
              )
              .map((x) => (x.body as TopologyEdge).to),
          ),
        ],
      });
    }
    return out.sort((a, b) => ms(a.valid_from) - ms(b.valid_from) || a.seq - b.seq);
  }

  /** 重建包里出现过的 Argo CD Application 键（与 kubernetesRollouts 的查询相同，不按时刻过滤） */
  argoApplications(): string[] {
    this.apps ??= [...this.nodes.keys()].filter((k) => k.startsWith('Application.argoproj.io:')).sort();
    return this.apps;
  }

  private apps: string[] | null = null;

  /**
   * 属于 owner（Job 或 ReplicaSet，沿 owned_by，任一来源）的 Pod 的镜像（Pod 节点的 images）；没有任何 Pod 带镜像时为 null。
   * 与 changes/kubernetes.ts 的 kubernetesRollouts 相同，不按时刻过滤：Pod 的镜像在它的生命周期内不变
   */
  podImages(owner: string): string[] | null {
    if (!this.imageIndex) {
      const pods = new Map<string, Set<string>>();
      for (const list of this.edges.values()) {
        for (const iv of list) {
          if (iv.body.relation === 'owned_by') {
            const s = pods.get(iv.body.to) ?? new Set<string>();
            s.add(iv.body.from);
            pods.set(iv.body.to, s);
          }
        }
      }
      const images = new Map<string, Set<string>>();
      for (const [key, list] of this.nodes) {
        for (const iv of list) {
          for (const img of iv.body.images ?? []) {
            const s = images.get(key) ?? new Set<string>();
            s.add(img);
            images.set(key, s);
          }
        }
      }
      this.imageIndex = { pods, images };
    }
    const out = new Set<string>();
    for (const p of this.imageIndex.pods.get(owner) ?? []) {
      this.imageIndex.images.get(p)?.forEach((i) => out.add(i));
    }
    return out.size ? [...out].sort() : null;
  }

  private imageIndex: { pods: Map<string, Set<string>>; images: Map<string, Set<string>> } | null = null;
}

export interface ReplayOptions {
  rt: PackRuntime;
  params: ResolvedRcaParams;
  revisionLabels: readonly string[];
  /** 与 server 的 changes.kubernetes.pre_step_labels 相同；不填时不启用 */
  preStepLabels?: readonly string[];
  groupWithinMs: number;
  stepMs: number;
}

export interface ReplayedIncident {
  incident: Incident;
  /** 第一次出现在重放中的时刻（server 中的 created_at） */
  createdMs: number;
  /** 曾经出现过的成员告警 id */
  everMembers: Set<string>;
  /** 各个版本引用过的变更（变更离开窗口后，后面的版本不再引用它） */
  everChanges: Map<string, ChangeEvent>;
}

export interface Replay {
  clusterId: string;
  topology: BundleTopology;
  /** 实例 → 接入后的告警（结束信息按 firing_to 补齐） */
  alerts: Map<string, { instance: AlertInstance; alert: Alert }>;
  incidents: Map<string, ReplayedIncident>;
  /** 每条告警第一次成为某个事件成员的时刻（检测延迟用） */
  memberSince: Map<string, number>;
  /** captureAt 之前（含）最后一步的事件状态（分析时刻 as_of 的事件）；没有给出 captureAt 时为 null */
  captured: Map<string, ReplayedIncident> | null;
  /** 最后一步的变更（变更源的变更与推导出的发布） */
  changes: ChangeEvent[];
  steps: number;
  start: number;
  end: number;
}

async function ingest(clusterId: string, a: AlertInstance, topo: BundleTopology, rt: PackRuntime): Promise<Alert> {
  const startsAt = new Date(ms(a.active_at));
  topo.now = ms(a.firing_from);
  const raw = {
    source: 'reconcile' as const,
    labels: a.labels,
    annotations: {},
    severity: (['critical', 'warning', 'info'].includes(a.labels.severity ?? '')
      ? a.labels.severity
      : 'warning') as Alert['severity'],
    status: 'firing' as const,
    suppressed: 'none' as const,
    startsAt,
    endsAt: null,
    generatorUrl: null,
    fingerprint: a.fingerprint,
    alertname: a.alertname,
  };
  const r = await resolveAlert(clusterId, raw, {
    catalog: rt.alertCatalog(),
    nodes: topo,
    ksm: null,
    ruleExpr: () => undefined,
    chronic: () => false,
  });
  return {
    alert_id: alertId(a.fingerprint, startsAt),
    cluster_id: clusterId,
    source: 'reconcile',
    fingerprint: a.fingerprint,
    alertname: a.alertname,
    labels: a.labels,
    annotations: {},
    severity: raw.severity,
    status: 'firing',
    suppressed: 'none',
    starts_at: startsAt.toISOString(),
    ends_at: null,
    generator_url: null,
    classification: r.classification,
    entity: r.entity,
    entity_resolution: r.entityResolution,
    component: r.component,
    received_at: a.firing_from,
  } as Alert;
}

/** 按步长重放 [bundle.range.from, end]，返回每个事件的最终状态与创建时刻；captureAt 时另存一份当时的事件 */
export async function replay(
  b: Bundle,
  end: number,
  o: ReplayOptions,
  captureAt: number | null = null,
): Promise<Replay> {
  const topo = new BundleTopology(b.topology);
  const alerts = new Map<string, { instance: AlertInstance; alert: Alert }>();
  const incidents = new Map<string, ReplayedIncident>();
  let captured: Map<string, ReplayedIncident> | null = null;
  const memberSince = new Map<string, number>();
  const snapshot = () =>
    new Map(
      [...incidents].map(([k, v]) => [
        k,
        {
          incident: v.incident,
          createdMs: v.createdMs,
          everMembers: new Set(v.everMembers),
          everChanges: new Map(v.everChanges),
        },
      ]),
    );
  let seq = 0;
  const newId = () => stableUuid('replay-incident', `${b.label_id}#${++seq}`);
  const lookback = o.params.adjacencyMs;
  let changes: ChangeEvent[] = [];
  let steps = 0;
  const start = ms(b.range.from);
  for (let t = start; t <= end; t += o.stepMs) {
    steps++;
    for (const inst of b.alerts) {
      const k = `${inst.fingerprint}@${inst.active_at}`;
      // 与 server 的接入相同：Watchdog、InfoInhibitor 与 severity=none 不进入事件（core isIgnorable）
      if (!alerts.has(k) && ms(inst.firing_from) <= t && !isIgnorable({ alertname: inst.alertname, ...inst.labels })) {
        alerts.set(k, { instance: inst, alert: await ingest(b.cluster_id, inst, topo, o.rt) });
      }
    }
    topo.now = t;
    const visible: Alert[] = [];
    for (const { instance, alert } of alerts.values()) {
      const to = instance.firing_to === null ? null : ms(instance.firing_to);
      if (to === null || to > t) {
        visible.push(alert);
      } else if (to > t - lookback) {
        visible.push({ ...alert, status: 'resolved', ends_at: new Date(to).toISOString() });
      }
    }
    visible.sort((x, y) => x.starts_at.localeCompare(y.starts_at) || x.alert_id.localeCompare(y.alert_id));
    const { graph } = topo.at(t);
    // 与 server 的引擎相同（incident/engine.ts）：变更输入从最早的可见告警往前算
    const from = changeInputFrom(visible, t, o.params);
    changes = [
      ...b.changes.filter((c) => ms(c.time) >= from && ms(c.time) <= t),
      ...deriveRollouts(topo.workloadEvents(from, t), {
        clusterId: b.cluster_id,
        revisionLabels: o.revisionLabels,
        groupWithinMs: o.groupWithinMs,
        images: (owner) => topo.podImages(owner),
        argoApplications: topo.argoApplications(),
        preStepLabels: o.preStepLabels ?? [],
      }),
    ].sort((x, y) => x.time.localeCompare(y.time) || x.change_id.localeCompare(y.change_id));
    const computed = computeIncidents({ alerts: visible, changes, graph, params: o.params, now: t, probes: [] });
    const previous = [...incidents.values()]
      .map((x) => x.incident)
      .filter(
        (x) => x.state !== 'merged' && (x.state === 'firing' || (x.ended_at !== null && ms(x.ended_at) > t - lookback)),
      );
    const result = reconcileIncidents({
      clusterId: b.cluster_id,
      previous,
      computed,
      topologyVersion: graph.version,
      now: t,
      newId,
    });
    for (const inc of result.incidents) {
      const cur = incidents.get(inc.incident_id);
      const members = cur?.everMembers ?? new Set<string>();
      for (const m of inc.members) {
        members.add(m.alert_id);
        if (m.left_version === null && !memberSince.has(m.alert_id)) {
          memberSince.set(m.alert_id, t);
        }
      }
      const seen = cur?.everChanges ?? new Map<string, ChangeEvent>();
      for (const c of inc.changes) {
        seen.set(c.change_id, c);
      }
      incidents.set(inc.incident_id, {
        incident: inc,
        createdMs: cur?.createdMs ?? t,
        everMembers: members,
        everChanges: seen,
      });
    }
    if (captureAt !== null && t <= captureAt && t + o.stepMs > captureAt) {
      captured = snapshot();
    }
  }
  return {
    clusterId: b.cluster_id,
    topology: topo,
    alerts,
    incidents,
    memberSince,
    captured,
    changes,
    steps,
    start,
    end,
  };
}

/** 事件中属于这次故障的告警 id（曾经出现过的成员） */
export function faultAlertIds(r: Replay, l: Label): Set<string> {
  const out = new Set<string>();
  for (const { instance, alert } of r.alerts.values()) {
    if (matchesFault(l, instance.alertname, instance.labels)) {
      out.add(alert.alert_id);
    }
  }
  return out;
}

/**
 * 主事件：包含故障告警最多的事件（同数时取先创建的）；没有任何事件包含故障告警时为 null。
 * at 为 'captured' 时取分析时刻的事件状态
 */
export function mainIncident(r: Replay, fault: Set<string>, at: 'end' | 'captured' = 'end'): ReplayedIncident | null {
  const pool = at === 'captured' ? r.captured : r.incidents;
  if (!pool) {
    throw new Error('重放没有保存分析时刻的事件（captureAt）');
  }
  let best: { x: ReplayedIncident; n: number } | null = null;
  for (const x of pool.values()) {
    if (x.incident.state === 'merged') {
      continue;
    }
    const n = [...x.everMembers].filter((id) => fault.has(id)).length;
    if (n > 0 && (!best || n > best.n || (n === best.n && x.createdMs < best.x.createdMs))) {
      best = { x, n };
    }
  }
  return best?.x ?? null;
}

export interface AnalysisInputs {
  evidence: PackEvidence;
  rules: PackRules;
  rt: PackRuntime;
  catalog: Catalog;
  locale: 'zh-CN' | 'en';
  signal: AbortSignal;
}

export interface ReconstructedCase {
  snapshot: EvalSnapshot;
  incident: Incident;
  /** 根因匹配到的组件类型 */
  rootType: string | null;
  /** as_of 时触发中的成员告警与它们的证据卡是否一致 */
  agreement: AlertAgreement[];
  /** 证据卡覆盖：卡数、得出结论的卡数、判为异常的卡数、根因上的异常卡数 */
  cards: { total: number; determinate: number; abnormal: number; rootAbnormal: number };
}

/** 在 as_of 为主事件出阶段 A 报告并组装研判输入（快照 context 与 worker 读到的研判输入同形） */
export async function reconstructCase(
  r: Replay,
  l: Label,
  inc: Incident,
  snapshotId: string,
  codeSha: string,
  packLock: string,
  a: AnalysisInputs,
): Promise<ReconstructedCase> {
  const asOf = ms(l.as_of);
  const memberIds = new Set(inc.members.filter((m) => m.left_version === null).map((m) => m.alert_id));
  const alerts = [...r.alerts.values()].map((x) => x.alert).filter((x) => memberIds.has(x.alert_id));
  const run = await a.evidence.run(inc, alerts, a.signal, asOf);
  const excludedBy = a.rules.excluded(inc, alerts, run);
  const report = buildReport({
    incident: inc,
    alerts,
    cards: run.cards,
    excludedBy,
    runbooks: run.runbooks,
    degraded: false,
    fingerprint: verdictFingerprint(run.cards),
    now: new Date(asOf),
    ruleActions: 0,
    ruleProposalIds: [],
  });
  const keys = [...new Set([...inc.components, ...inc.candidates.map((c) => c.component)])];
  const topo = r.topology.neighborhood(keys, asOf);
  const ctx = { incident: inc, topology: { version: r.topology.version(asOf), ...topo } } as unknown as TaskContext;
  const subgraph = toSubgraph(ctx);
  const kinds = new Set(subgraph.nodes.map((n) => n.kind));
  const actions = a.catalog.raw.actions.filter(
    (x) => kinds.has(x.target.kind) || (x.target.kinds ?? []).some((k) => kinds.has(k.kind)),
  );
  const types = new Set(
    [...topo.nodes.map((n) => n.component_type), run.rootComponentType].filter((x): x is string => !!x),
  );
  const root = inc.root.component;
  const entityKey = (c: EvidenceResult) => {
    if (!c.entity) {
      return null;
    }
    const k = parseStoredKey(root ?? '');
    return c.entity.kind === k.kind && c.entity.namespace === k.namespace && c.entity.name === k.name ? root : null;
  };
  const snapshot: EvalSnapshot = {
    snapshot_id: snapshotId,
    case_id: `label:${l.id}`,
    format_version: 1,
    window: { from: new Date(ms(l.window.from)).toISOString(), to: new Date(asOf).toISOString() },
    as_of: new Date(asOf).toISOString(),
    context: {
      incident: inc,
      stage_a: report,
      subgraph,
      alerts,
      actions: actions as unknown as EvalSnapshot['context']['actions'],
      runbooks: report.runbooks,
      knowledge: a.rt.knowledge(types, a.locale) as unknown as EvalSnapshot['context']['knowledge'],
      cases: [],
      // 领域包的查询模板，加上子图组件 × 适用的证据链卡（卡片即检查，ADR 0116），与 server 的研判输入相同
      templates: [
        ...a.rt.templates.map((x) => ({ id: x.id, description: x.description, args: x.args })),
        ...cardChecks(a.rt, inc, topo.nodes, report.cards, a.locale, topo.edges),
      ],
    },
    queries: {
      api_version: 'srenautix.io/query-snapshot/v1',
      snapshot_id: snapshotId,
      recorded_at: new Date(asOf).toISOString(),
      clock_window: { from: new Date(ms(l.window.from)).toISOString(), to: new Date(asOf).toISOString() },
      ids: { metrics: 'reconstructed', logs: null, traces: null },
      capabilities: [],
      metrics_dialects: [],
      label_profile: null,
      logs_profile: null,
      entries: [],
      cases: [],
    },
    created_at: new Date().toISOString(),
    source: { kind: 'reconstructed', ref: `label:${l.id}`, code_sha: codeSha, pack_lock: packLock },
  } as EvalSnapshot;
  const cards = run.cards;
  return {
    snapshot,
    incident: inc,
    rootType: run.rootComponentType,
    agreement: agreeAlerts(
      a.rt,
      [...r.alerts.values()]
        .filter(
          (x) =>
            memberIds.has(x.alert.alert_id) &&
            ms(x.instance.firing_from) <= asOf &&
            (x.instance.firing_to === null || ms(x.instance.firing_to) > asOf),
        )
        .map((x) => x.alert),
      run.cards,
    ),
    cards: {
      total: cards.length,
      determinate: cards.filter((c) => c.verdict === 'normal' || c.verdict === 'abnormal').length,
      abnormal: cards.filter((c) => c.verdict === 'abnormal').length,
      rootAbnormal: cards.filter((c) => c.verdict === 'abnormal' && entityKey(c) !== null).length,
    },
  };
}

/** 阶段 B 区分性检查的查询模板：与 server 的 /v1/research/tasks/{run_id}/query 相同，在组件上执行模板附带的卡，评估时刻为 as_of */
export class ReconstructedQueryRunner implements QueryRunner {
  constructor(
    private readonly evidence: PackEvidence,
    private readonly inc: Incident,
    private readonly topology: BundleTopology,
    private readonly asOf: number,
  ) {}

  async run(
    template: Parameters<QueryRunner['run']>[0],
    args: Record<string, unknown>,
    ctx: Parameters<QueryRunner['run']>[2],
  ): Promise<EvidenceResult> {
    const params: Record<string, number | string | boolean> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        params[k] = v;
      }
    }
    // 卡片检查（ADR 0116）按 id 里的组件执行；查询模板按假设的根因执行（与 server 的 /query 相同）
    const card = parseCardCheckId(template.id);
    const component = card?.component ?? ctx.rootComponent;
    const node = this.topology.at(this.asOf).nodes.find((n) => n.key === component);
    const k = parseStoredKey(component);
    const entity = node
      ? { cluster_id: this.inc.cluster_id, kind: node.kind, namespace: node.namespace, name: node.name, uid: node.uid }
      : { cluster_id: this.inc.cluster_id, kind: k.kind, namespace: k.namespace, name: k.name, uid: null };
    if (card) {
      return this.evidence.runCardCheck(this.inc, card.card, args, entity, this.asOf, ctx.signal);
    }
    return this.evidence.runTemplate(this.inc, template.id, params, entity, this.asOf, ctx.signal);
  }
}
