// 事件的确定性重算与持久化对账（DESIGN §2.2）。
// 每次对账先按收敛与根因排序重算出分组，再和已持久化的事件按共享的成员告警对账：
//   - 一对一：沿用 incident_id，成员或根因变化时 incident_version 加一；
//   - 多个已有事件对应一个分组（合并）：最早创建的事件保留，其余标为 merged 并写入别名（from → into）；
//   - 一个已有事件对应多个分组（拆分）：重叠最多的分组沿用原 id，其余分组成为新事件，split_from 指向原事件；
//   - 没有对应已有事件的分组，与超出回看窗口的 resolved 事件共享成员或稳定标签：重开那个事件（ADR 0132）。
// incident_id 是 UUID；稳定标签 <根组件>:<首次触发时间取整到 10 分钟> 在事件创建时确定，之后不再改变。
import type {
  Alert,
  ChangeEvent,
  ClusterId,
  ComponentKey,
  Incident,
  IncidentMember,
  Severity,
} from '@srenautix/contract';
import { converge, type ConvergeInput, type AlertGroup } from './converge.js';
import { rankRoot, silentRootTargets, type ProbeResult, type Ranking } from './rank.js';
import { floorTo, formatTime, parseTime } from './time.js';

export const LABEL_BUCKET_MS = 10 * 60_000;

export interface ComputedIncident {
  group: AlertGroup;
  ranking: Ranking;
}

export interface ComputeInput extends ConvergeInput {
  /** 沉默根因探测卡的结果；只对把该组件列为探测目标的分组生效 */
  probes?: readonly ProbeResult[];
}

/** 确定性重算：收敛 + 根因排序。结果按首次触发时间与根因排序 */
export function computeIncidents(input: ComputeInput): ComputedIncident[] {
  const groups = converge(input);
  return groups
    .map((group) => {
      const targets = new Set(silentRootTargets(group, input.graph).map((t) => t.component));
      const probes = (input.probes ?? []).filter((p) => targets.has(p.component));
      return { group, ranking: rankRoot({ group, graph: input.graph, params: input.params, probes }) };
    })
    .sort(
      (a, b) =>
        firstFiring(a) - firstFiring(b) ||
        (a.ranking.root.component ?? '').localeCompare(b.ranking.root.component ?? ''),
    );
}

function firstFiring(c: ComputedIncident): number {
  return Math.min(...c.group.alerts.map((x) => x.start));
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };

export function incidentLabel(root: ComponentKey | null, firstFiringMs: number): string {
  return `${root ?? 'unlabelled'}:${formatTime(floorTo(firstFiringMs, LABEL_BUCKET_MS))}`;
}

/** 分组新建为事件时使用的稳定标签（去重后缀之前） */
export function computedLabel(c: ComputedIncident): string {
  return incidentLabel(c.ranking.root.component, Math.min(...c.group.alerts.map((x) => parseTime(x.alert.starts_at))));
}

export type IncidentChange =
  | { type: 'incident.created'; incident: Incident }
  | { type: 'incident.updated'; incident: Incident }
  | { type: 'incident.resolved'; incident: Incident }
  | { type: 'incident.merged'; from_incident_id: string; into_incident_id: string; into_version: number }
  | { type: 'incident.split'; from_incident_id: string; from_version: number; new_incident_ids: string[] };

export interface ReconcileInput {
  clusterId: ClusterId;
  /** 已持久化、未合并的事件 */
  previous: readonly Incident[];
  /**
   * 已持久化、不在 previous 里的事件（超出回看窗口的 resolved 与 merged），只取与本轮分组共享成员告警或稳定标签的。
   * 它们的标签与别名照样占用；没有分到已有事件的分组与其中一个 resolved 事件共享成员（否则标签相同）时，重开那个事件
   * 而不是新建（ADR 0132）。merged 的事件不重开，只占用标签
   */
  dormant?: readonly Incident[];
  computed: readonly ComputedIncident[];
  topologyVersion: number;
  now: number;
  newId?: () => string;
}

export interface ReconcileResult {
  /** 新建或有变化的事件（含被合并的事件），按 incident_id 排序 */
  incidents: Incident[];
  changes: IncidentChange[];
}

function memberIds(i: Incident): Set<string> {
  return new Set(i.members.filter((m) => m.left_version === null).map((m) => m.alert_id));
}

export function reconcileIncidents(input: ReconcileInput): ReconcileResult {
  const newId = input.newId ?? (() => crypto.randomUUID());
  const now = formatTime(input.now);
  const prev = [...input.previous]
    .filter((p) => p.state !== 'merged')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.incident_id.localeCompare(b.incident_id));
  const groups = input.computed.map((c) => ({ c, ids: new Set(c.group.alerts.map((x) => x.alert.alert_id)) }));
  const overlap = (p: Incident, gi: number) => [...memberIds(p)].filter((id) => groups[gi]!.ids.has(id)).length;

  // 最早创建的事件优先挑选重叠最多的分组
  const gOf = new Map<string, number>();
  const pOf = new Map<number, Incident>();
  for (const p of prev) {
    const options = groups
      .map((_, gi) => ({ gi, n: overlap(p, gi) }))
      .filter((o) => o.n > 0 && !pOf.has(o.gi))
      .sort((a, b) => b.n - a.n || a.gi - b.gi);
    if (options[0]) {
      gOf.set(p.incident_id, options[0].gi);
      pOf.set(options[0].gi, p);
    }
  }

  const labels = new Set<string>();
  for (const p of [...input.previous, ...(input.dormant ?? [])]) {
    labels.add(p.label);
    for (const a of p.aliases) {
      labels.add(a.from_label);
    }
  }
  const uniqueLabel = (base: string) => {
    let label = base;
    for (let n = 2; labels.has(label); n++) {
      label = `${base}~${n}`;
    }
    labels.add(label);
    return label;
  };

  const previousIds = new Set(input.previous.map((p) => p.incident_id));
  const dormant = (input.dormant ?? [])
    .filter((d) => d.state !== 'merged' && !previousIds.has(d.incident_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.incident_id.localeCompare(b.incident_id));
  const used = new Set<string>();
  // 共享成员的优先；只按标签认领时，分组不能是从窗口内事件拆分出来的
  const pickDormant = (gi: number, splitChild: boolean): Incident | undefined => {
    const free = dormant.filter((d) => !used.has(d.incident_id));
    const byMembers = free
      .map((d) => ({ d, n: overlap(d, gi) }))
      .filter((o) => o.n > 0)
      .sort((a, b) => b.n - a.n)[0]?.d;
    if (byMembers || splitChild) {
      return byMembers;
    }
    const label = computedLabel(groups[gi]!.c);
    return free.find((d) => d.label === label);
  };

  const out = new Map<string, Incident>();
  const changes: IncidentChange[] = [];
  const splitChildren = new Map<string, string[]>();

  groups.forEach(({ c }, gi) => {
    const p = pOf.get(gi);
    if (p) {
      const next = applyGroup(p, c, input.topologyVersion, now);
      if (next !== p) {
        out.set(next.incident_id, next);
        if (next.state === 'resolved' && p.state !== 'resolved') {
          changes.push({ type: 'incident.resolved', incident: next });
        } else {
          changes.push({ type: 'incident.updated', incident: next });
        }
      }
      return;
    }
    // 与某个已有事件重叠时是拆分出来的
    const parent = prev
      .map((q) => ({ q, n: overlap(q, gi) }))
      .filter((o) => o.n > 0)
      .sort((a, b) => b.n - a.n)[0]?.q;
    // 超出回看窗口的 resolved 事件与分组共享成员（检测器以原来的告警重新触发），或者标签就是分组的标签：重开它，
    // incident_id 与标签不变，版本加一（ADR 0132）
    const reopen = pickDormant(gi, parent !== undefined);
    if (reopen) {
      used.add(reopen.incident_id);
      const next = applyGroup(reopen, c, input.topologyVersion, now, true);
      if (next !== reopen) {
        out.set(next.incident_id, next);
        changes.push({ type: 'incident.updated', incident: next });
      }
      return;
    }
    // 新事件
    const created = createIncident(
      input.clusterId,
      newId(),
      c,
      input.topologyVersion,
      now,
      uniqueLabel,
      parent?.incident_id ?? null,
    );
    out.set(created.incident_id, created);
    changes.push({ type: 'incident.created', incident: created });
    if (parent) {
      splitChildren.set(parent.incident_id, [...(splitChildren.get(parent.incident_id) ?? []), created.incident_id]);
    }
  });

  // 没有分到分组、但成员落在别的事件的分组里：合并进那个事件
  for (const p of prev) {
    if (gOf.has(p.incident_id)) {
      continue;
    }
    const target = groups
      .map((_, gi) => ({ gi, n: overlap(p, gi) }))
      .filter((o) => o.n > 0)
      .sort((a, b) => b.n - a.n || a.gi - b.gi)[0];
    if (!target) {
      continue;
    }
    // 分组已经分给了更早的事件（否则本事件会分到它），本事件合并进去
    const intoBase = pOf.get(target.gi)!;
    const into = out.get(intoBase.incident_id) ?? intoBase;
    const version = into === intoBase ? into.incident_version + 1 : into.incident_version;
    const survivor: Incident = {
      ...into,
      incident_version: version,
      aliases: [
        ...into.aliases,
        ...p.aliases,
        { from_incident_id: p.incident_id, from_label: p.label, at_version: version, merged_at: now },
      ],
      updated_at: now,
    };
    out.set(survivor.incident_id, survivor);
    changes.push({ type: 'incident.updated', incident: survivor });
    const merged: Incident = {
      ...p,
      state: 'merged',
      merged_into: survivor.incident_id,
      incident_version: p.incident_version + 1,
      members: p.members.map((m) => (m.left_version === null ? { ...m, left_version: p.incident_version + 1 } : m)),
      updated_at: now,
    };
    out.set(merged.incident_id, merged);
    changes.push({
      type: 'incident.merged',
      from_incident_id: p.incident_id,
      into_incident_id: survivor.incident_id,
      into_version: survivor.incident_version,
    });
  }
  for (const [from, ids] of splitChildren) {
    const parent = out.get(from) ?? prev.find((q) => q.incident_id === from)!;
    changes.push({
      type: 'incident.split',
      from_incident_id: from,
      from_version: parent.incident_version,
      new_incident_ids: ids,
    });
  }
  // 合并后同一事件的 updated 只保留最新内容
  const latest = new Map<string, IncidentChange>();
  const ordered: IncidentChange[] = [];
  for (const ch of changes) {
    if (ch.type === 'incident.updated' || ch.type === 'incident.created' || ch.type === 'incident.resolved') {
      latest.set(ch.incident.incident_id, { ...ch, incident: out.get(ch.incident.incident_id)! });
    } else {
      ordered.push(ch);
    }
  }
  return {
    incidents: [...out.values()].sort((a, b) => a.incident_id.localeCompare(b.incident_id)),
    changes: [...latest.values(), ...ordered],
  };
}

function aggregate(c: ComputedIncident) {
  const alerts = c.group.alerts.map((x) => x.alert);
  const firing = alerts.filter((a) => a.status === 'firing');
  const first = Math.min(...alerts.map((a) => parseTime(a.starts_at)));
  const ended =
    firing.length > 0 ? null : formatTime(Math.max(...alerts.map((a) => parseTime(a.ends_at ?? a.starts_at))));
  const severity = alerts.reduce<Severity>(
    (acc, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[acc] ? a.severity : acc),
    'info',
  );
  const root = c.ranking.root.component;
  const components = [
    ...(root ? [root] : []),
    ...[...new Set(alerts.map((a) => a.component).filter((k): k is ComponentKey => k !== null && k !== root))].sort(),
  ];
  return {
    alerts,
    first,
    ended,
    severity,
    state: firing.length > 0 ? ('firing' as const) : ('resolved' as const),
    components,
    suppressed: firing.length > 0 && firing.every((a) => a.suppressed !== 'none'),
    changes: [...c.group.changes].sort(
      (a, b) => a.time.localeCompare(b.time) || a.change_id.localeCompare(b.change_id),
    ),
    candidates: c.ranking.candidates.map((x) => ({
      component: x.component,
      score: x.score,
      terms: x.terms,
      depth: x.depth,
      explains: x.explains,
      source: x.source,
    })),
  };
}

function member(a: Alert, version: number): IncidentMember {
  return {
    alert_id: a.alert_id,
    alertname: a.alertname,
    role: a.classification.role,
    component: a.component,
    severity: a.severity,
    status: a.status,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    joined_version: version,
    left_version: null,
  };
}

function createIncident(
  clusterId: ClusterId,
  id: string,
  c: ComputedIncident,
  topologyVersion: number,
  now: string,
  uniqueLabel: (base: string) => string,
  splitFrom: string | null,
): Incident {
  const g = aggregate(c);
  return {
    incident_id: id,
    cluster_id: clusterId,
    label: uniqueLabel(computedLabel(c)),
    incident_version: 1,
    state: g.state,
    severity: g.severity,
    first_firing_at: formatTime(g.first),
    ended_at: g.ended,
    root: c.ranking.root,
    candidates: g.candidates,
    members: g.alerts.map((a) => member(a, 1)).sort((a, b) => a.alert_id.localeCompare(b.alert_id)),
    components: g.components,
    changes: g.changes as ChangeEvent[],
    aliases: [],
    split_from: splitFrom,
    merged_into: null,
    suppressed: g.suppressed,
    observability_blind: false,
    topology_version: topologyVersion,
    created_at: now,
    updated_at: now,
  };
}

/**
 * 把重算出的分组套到已有事件上；没有任何变化时返回原对象。dormant 为 true 时 p 是超出回看窗口的事件：
 * 它从 resolved 回到 firing（重开）时版本也加一，阶段 A 按新版本重新出报告（ADR 0132）
 */
function applyGroup(p: Incident, c: ComputedIncident, topologyVersion: number, now: string, dormant = false): Incident {
  const g = aggregate(c);
  const before = memberIds(p);
  const after = new Set(g.alerts.map((a) => a.alert_id));
  const membersChanged = before.size !== after.size || [...after].some((id) => !before.has(id));
  const rootChanged = p.root.component !== c.ranking.root.component;
  const reopened = dormant && p.state === 'resolved' && g.state === 'firing';
  const version = membersChanged || rootChanged || reopened ? p.incident_version + 1 : p.incident_version;
  const byId = new Map(g.alerts.map((a) => [a.alert_id, a]));
  const members: IncidentMember[] = p.members.map((m) => {
    const a = byId.get(m.alert_id);
    if (m.left_version !== null) {
      return m;
    }
    return a
      ? { ...m, status: a.status, ends_at: a.ends_at, role: a.classification.role, component: a.component }
      : { ...m, left_version: version };
  });
  for (const a of g.alerts) {
    if (!before.has(a.alert_id)) {
      members.push(member(a, version));
    }
  }
  members.sort((a, b) => a.alert_id.localeCompare(b.alert_id) || a.joined_version - b.joined_version);
  const next: Incident = {
    ...p,
    incident_version: version,
    state: g.state,
    severity: g.severity,
    first_firing_at: formatTime(Math.min(g.first, parseTime(p.first_firing_at))),
    ended_at: g.ended,
    root: c.ranking.root,
    candidates: g.candidates,
    members,
    components: g.components,
    changes: g.changes as ChangeEvent[],
    suppressed: g.suppressed,
    topology_version: version !== p.incident_version ? topologyVersion : p.topology_version,
  };
  // 已持久化的事件从 jsonb 读回，对象键的顺序与新算出的不同：按值比较，不按序列化文本（Zzhihon/SreNautix#8）
  return sameJson(next, p) ? p : { ...next, updated_at: now };
}

/**
 * 与对象键顺序无关的 JSON 值比较。PostgreSQL 的 jsonb 按自己的规则重排对象的键，读回的事件与新算出的事件内容相同时
 * 序列化文本也可能不同。值为 undefined 的键与没有这个键相同（与 JSON 序列化一致）。
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameJson(x, (b as unknown[])[i]))
    );
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => rb[k] !== undefined && sameJson(ra[k], rb[k]));
}

/**
 * 解析事件引用：incident_id、稳定标签，或别名表中的旧 id 与旧标签；沿 merged_into 找到最终的事件
 */
export function resolveIncidentRef(ref: string, incidents: readonly Incident[]): Incident | undefined {
  const byId = new Map(incidents.map((i) => [i.incident_id, i]));
  let hit =
    byId.get(ref) ??
    incidents.find((i) => i.label === ref) ??
    incidents.find((i) => i.aliases.some((a) => a.from_incident_id === ref || a.from_label === ref));
  const seen = new Set<string>();
  while (hit && hit.merged_into !== null) {
    if (seen.has(hit.incident_id)) {
      throw new Error(`merged_into 成环：${[...seen].join(' → ')}`);
    }
    seen.add(hit.incident_id);
    hit = byId.get(hit.merged_into);
  }
  return hit;
}
