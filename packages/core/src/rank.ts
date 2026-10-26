// 根因排序（DESIGN §5）。得分 = 0.40×症状覆盖率（按路径置信度加权）+ 0.15×先于症状触发 + 0.20×角色先验
//   + 0.15×30 分钟内的变更 − 0.10×长期告警惩罚；深度只用于平分。
// 覆盖率规则：能解释全部症状的候选排在没有解释全部症状的候选之前，不受其余各项影响。
// 第一与第二候选同层且分差小于 δ 时根因有歧义，两者的证据链都执行。
// 变更的作用对象（变更目标中的 Job 经 egress_to 访问的组件，ADR 0140）也是候选，来源记为 change，角色先验与近期变更两项
// 按访问边的置信度打折，排在变更本身之后。
// 晚于自己目标上已经开始的问题（加容差）的变更不参与排序（ADR 0142）。
// 退役变更的候选是管理被退役工作负载的应用；只因"已合并、尚未同步"在分组里的提交只让未同步的应用成为候选（ADR 0161）。
// 近期变更一项按变更与事件关联的分级取值：high 1、medium 0.5、low 0.2；作用对象再乘访问边的置信度；
// 有 change 角色告警的候选取 1（ADR 0169）。
import type {
  AlertRole,
  ChangeEvent,
  ChangeLink,
  ComponentKey,
  EntityRef,
  IncidentRoot,
  RootCandidate,
} from '@srenautix/contract';
import { CHANGE_GRADE_WEIGHT, changeLinks } from './change-grade.js';
import {
  actsOn,
  changeComponents,
  changeExplains,
  dependsOn,
  lateChange,
  pendingExplains,
  type AlertGroup,
  type PreparedAlert,
} from './converge.js';
import { isNamespacePseudo } from './keys.js';
import type { ResolvedRcaParams } from './params.js';
import { parseTime } from './time.js';
import type { TopologyGraph } from './topology/graph.js';

export interface ProbeResult {
  component: ComponentKey;
  abnormal: boolean;
  card_id: string;
  /** 异常起始时间（unix 毫秒）；不知道时为 null */
  anomaly_started_at: number | null;
}

export interface RankInput {
  group: AlertGroup;
  graph: TopologyGraph;
  params: ResolvedRcaParams;
  /** 沉默根因探测卡的结果（见 silentRootTargets） */
  probes?: readonly ProbeResult[];
  /** 分组变更的关联分级（changeLinks）；省略时按分组计算 */
  links?: readonly ChangeLink[];
}

export interface RankedCandidate extends RootCandidate {
  /** 0：解释了全部症状；1：没有 */
  layer: number;
  entity: EntityRef | null;
}

export interface Ranking {
  candidates: RankedCandidate[];
  root: IncidentRoot;
}

interface Draft {
  component: ComponentKey;
  source: RootCandidate['source'];
  roles: Set<AlertRole>;
  own: PreparedAlert[];
  changes: ChangeEvent[];
  /** 以它为作用对象的变更与访问边的置信度（ADR 0140）；变更直接触及的组件不在这里 */
  actedOnBy: Array<{ change: ChangeEvent; confidence: number }>;
  probe: ProbeResult | undefined;
}

const SOURCE_RANK: Record<RootCandidate['source'], number> = { alert: 0, change: 1, hub: 2, probe: 3, symptom: 4 };

export function rankRoot(input: RankInput): Ranking {
  const { group, graph, params } = input;
  const drafts = new Map<ComponentKey, Draft>();
  const draft = (component: ComponentKey, source: RootCandidate['source']): Draft => {
    let d = drafts.get(component);
    if (!d) {
      d = { component, source, roles: new Set(), own: [], changes: [], actedOnBy: [], probe: undefined };
      drafts.set(component, d);
    } else if (SOURCE_RANK[source] < SOURCE_RANK[d.source]) {
      d.source = source;
    }
    return d;
  };
  const role = (x: PreparedAlert) => x.alert.classification.role;
  // 晚于自己目标上的问题（超过容差）的变更不参与排序（ADR 0142）：问题开始之后才发生的变更不是它的原因，不产生候选，
  // 也不给变更先验与近期变更。变更仍在分组里（事件的相关变更照常列出）
  const changes = group.changes.filter((c) => !lateChange(c, group.alerts, graph, params));
  const grades = new Map((input.links ?? changeLinks(group, graph, params)).map((l) => [l.change_id, l.grade]));
  const gradeWeight = (c: ChangeEvent) => CHANGE_GRADE_WEIGHT[grades.get(c.change_id) ?? 'low'];

  for (const x of group.alerts) {
    if (x.component !== null && (role(x) === 'cause' || role(x) === 'change')) {
      draft(x.component, 'alert');
    }
  }
  for (const c of changes) {
    for (const comp of changeCandidates(c, graph)) {
      draft(comp, 'change').changes.push(c);
    }
  }
  // 只因"已合并、尚未同步"在分组里的提交（ADR 0161）：只有分组里落在它的未同步应用上的告警所在的应用成为候选。
  // 提交常常触及很多应用，其余应用与这个事件无关
  for (const c of group.pendingChanges) {
    const apps = new Set(group.alerts.filter((x) => pendingExplains(c, x)).map((x) => x.component!));
    for (const comp of [...apps].sort()) {
      draft(comp, 'change').changes.push(c);
    }
  }
  // 变更的作用对象：迁移 Job 失败时，原因可能在迁移本身，也可能在它写入的数据库（权限、锁、容量）
  for (const c of changes) {
    for (const [comp, confidence] of actsOn(c, graph)) {
      draft(comp, 'change').actedOnBy.push({ change: c, confidence });
    }
  }
  for (const h of group.hubs) {
    draft(h, 'hub');
  }
  for (const p of input.probes ?? []) {
    if (p.abnormal) {
      draft(p.component, 'probe').probe = p;
    }
  }
  if (drafts.size === 0) {
    // 没有原因、变更与探测结果：症状所在组件作为候选；只剩 forecast 时用 forecast 所在组件
    const pool = group.alerts.filter((x) => role(x) !== 'forecast');
    for (const x of pool.length > 0 ? pool : group.alerts) {
      if (x.component !== null) {
        draft(x.component, 'symptom');
      }
    }
  }
  // 候选自己的告警
  for (const x of group.alerts) {
    const d = x.component === null ? undefined : drafts.get(x.component);
    if (d) {
      d.own.push(x);
      d.roles.add(role(x));
    }
  }

  const symptoms = group.alerts.filter((x) => role(x) === 'symptom');
  const groupStart = Math.min(...group.alerts.map((x) => x.start));
  const out: RankedCandidate[] = [];
  for (const d of drafts.values()) {
    // forecast 与 meta 不能成为活动事件的根因：只有这两种自有告警、也没有变更与探测支持的组件不参与排序，
    // 整个分组只有这些告警时除外
    const onlyWeak = d.own.length > 0 && d.own.every((x) => role(x) === 'forecast' || role(x) === 'meta');
    if (
      onlyWeak &&
      d.changes.length === 0 &&
      d.actedOnBy.length === 0 &&
      !d.probe &&
      d.source !== 'symptom' &&
      d.source !== 'hub'
    ) {
      continue;
    }
    const explained: Array<{ id: string; conf: number; start: number }> = [];
    for (const s of symptoms) {
      let conf = s.component === d.component ? 1 : (s.rankReach?.components.get(d.component) ?? 0);
      for (const c of d.changes) {
        conf = Math.max(conf, changeExplains(c, s, graph, params, 'rank'), pendingExplains(c, s) ? 1 : 0);
      }
      for (const a of d.actedOnBy) {
        conf = Math.max(conf, changeExplains(a.change, s, graph, params, 'rank'));
      }
      for (const o of d.own) {
        conf = Math.max(conf, dependsOn(s, o, graph, 'rank'));
      }
      if (conf > 0) {
        explained.push({ id: s.alert.alert_id, conf, start: s.start });
      }
    }
    const causeOnsets = d.own.filter((x) => role(x) === 'cause' || role(x) === 'change').map((x) => x.start);
    const onsets = [
      ...causeOnsets,
      ...d.changes.map((c) => parseTime(c.time)),
      ...d.actedOnBy.map((a) => parseTime(a.change.time)),
      ...(d.probe?.anomaly_started_at != null ? [d.probe.anomaly_started_at] : []),
    ];
    const onset =
      onsets.length > 0 ? Math.min(...onsets) : d.own.length > 0 ? Math.min(...d.own.map((x) => x.start)) : null;
    const coverage = symptoms.length === 0 ? 0 : explained.reduce((a, e) => a + e.conf, 0) / symptoms.length;
    const precedence =
      explained.length === 0 || onset === null
        ? 0
        : explained.filter((e) => e.start >= onset).length / explained.length;
    const priors = [...d.roles].map((r) => params.rolePriors[r]);
    if (d.changes.length > 0) priors.push(params.rolePriors.change);
    // 作用对象：变更的先验按访问边的置信度打折
    const actedOn = d.actedOnBy.length > 0 ? Math.max(...d.actedOnBy.map((a) => a.confidence)) : 0;
    if (actedOn > 0) priors.push(params.rolePriors.change * actedOn);
    if (d.probe || d.source === 'hub') priors.push(params.rolePriors.cause);
    const rolePrior = priors.length > 0 ? Math.max(...priors) : 0;
    const recent = (c: ChangeEvent) => parseTime(c.time) >= groupStart - params.changeWindowMs;
    const recentChange = round(
      Math.max(
        d.roles.has('change') ? 1 : 0,
        ...d.changes.filter(recent).map(gradeWeight),
        ...d.actedOnBy.filter((a) => recent(a.change)).map((a) => gradeWeight(a.change) * a.confidence),
      ),
    );
    const chronic = d.own.length === 0 ? 0 : d.own.filter((x) => x.alert.classification.chronic).length / d.own.length;
    const w = params.weights;
    const score =
      w.coverage * coverage +
      w.precedence * precedence +
      w.role_prior * rolePrior +
      w.recent_change * recentChange -
      w.chronic_penalty * chronic;
    const fullyExplains = symptoms.length > 0 && explained.length === symptoms.length;
    out.push({
      component: d.component,
      score: round(score),
      terms: {
        coverage: round(coverage),
        precedence: round(precedence),
        role_prior: round(rolePrior),
        recent_change: recentChange,
        chronic_penalty: round(chronic),
      },
      depth: graph.depth(d.component),
      explains: explained.map((e) => e.id).sort(),
      source: d.source,
      layer: fullyExplains ? 0 : 1,
      entity: candidateEntity(d, graph, group.alerts[0]!.alert.cluster_id),
    });
  }

  out.sort(
    (a, b) =>
      a.layer - b.layer ||
      b.score - a.score ||
      b.depth - a.depth ||
      Number(isNamespacePseudo(a.component)) - Number(isNamespacePseudo(b.component)) ||
      a.component.localeCompare(b.component),
  );
  const top = out.slice(0, params.topK);
  const first = top[0];
  const second = top[1];
  const margin = first && second ? round(first.score - second.score) : null;
  return {
    candidates: top,
    root: {
      component: first?.component ?? null,
      entity: first?.entity ?? null,
      ambiguous: Boolean(first && second && first.layer === second.layer && margin! < params.ambiguityMargin),
      margin,
      silent_root: first?.source === 'probe' || first?.source === 'hub',
    },
  };
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * 变更在分组里产生的候选组件：变更触及的全部组件；退役变更（ADR 0161）有管理应用时只是管理应用（Git 合并与同步作用在
 * 应用上，工作负载是它的一部分），没有时是工作负载
 */
function changeCandidates(c: ChangeEvent, graph: TopologyGraph): ComponentKey[] {
  const all = [...changeComponents(c, graph)];
  if (c.kind === 'retire') {
    const managers = new Set(c.refs.map((r) => (graph.has(r) ? graph.componentOf(r) : r)));
    const own = all.filter((k) => managers.has(k));
    return own.length ? own : all;
  }
  return all;
}

/** 候选最具体的实体：最早的原因或变更告警的实体，其次变更目标对象，再次最早的其他告警的实体 */
function candidateEntity(d: Draft, graph: TopologyGraph, clusterId: string): EntityRef | null {
  const byStart = [...d.own].filter((x) => x.alert.entity !== null).sort((a, b) => a.start - b.start);
  const cause = byStart.find(
    (x) => x.alert.classification.role === 'cause' || x.alert.classification.role === 'change',
  );
  if (cause) {
    return cause.alert.entity;
  }
  const target = d.changes.flatMap((c) => c.targets).find((t) => graph.has(t));
  if (target) {
    const n = graph.node(target)!;
    return { cluster_id: clusterId, kind: n.kind, namespace: n.namespace, name: n.name, uid: n.uid };
  }
  if (byStart[0]) {
    return byStart[0].alert.entity;
  }
  // 作用对象（ADR 0140）：组件本身就是拓扑中的对象（CNPG Cluster 之类）
  const self = d.actedOnBy.length > 0 ? graph.node(d.component) : undefined;
  return self
    ? { cluster_id: clusterId, kind: self.kind, namespace: self.namespace, name: self.name, uid: self.uid }
    : null;
}

export interface ProbeRequest {
  /** upstream：症状上游组件的探测卡；namespace_pvc：命名空间内 StatefulSet PVC 的容量探测；namespace_logs：ENOSPC 日志卡 */
  reason: 'upstream' | 'namespace_pvc' | 'namespace_logs';
  component: ComponentKey;
  /** 具体对象，例如 PVC */
  object: ComponentKey | null;
  namespace: string | null;
  confidence: number;
}

/**
 * 沉默根因（DESIGN §5）：症状存在但没有指向原因的告警时，返回需要执行探测卡的目标。
 * 结果由阶段 A 执行对应的探测卡后，以 ProbeResult 传回 rankRoot
 */
export function silentRootTargets(group: AlertGroup, graph: TopologyGraph): ProbeRequest[] {
  const role = (x: PreparedAlert) => x.alert.classification.role;
  if (group.alerts.some((x) => role(x) === 'cause' || role(x) === 'change') || group.changes.length > 0) {
    return [];
  }
  const symptoms = group.alerts.filter((x) => role(x) === 'symptom');
  const own = new Set(group.alerts.map((x) => x.component));
  const upstream = new Map<ComponentKey, number>();
  for (const s of symptoms) {
    for (const [comp, conf] of s.rankReach?.components ?? []) {
      if (!own.has(comp)) {
        upstream.set(comp, Math.max(upstream.get(comp) ?? 0, conf));
      }
    }
  }
  const out: ProbeRequest[] = [...upstream]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([component, confidence]) => ({ reason: 'upstream', component, object: null, namespace: null, confidence }));
  const namespaces = new Set(
    symptoms.map((s) => s.alert.entity?.namespace ?? s.alert.labels.namespace).filter((n): n is string => Boolean(n)),
  );
  for (const ns of [...namespaces].sort()) {
    for (const node of graph.allNodes()) {
      if (node.kind !== 'StatefulSet' || node.namespace !== ns) {
        continue;
      }
      const pvcs = new Set<ComponentKey>();
      for (const m of graph.membersOf(node.key)) {
        for (const e of graph.dependencies(m)) {
          if (e.relation === 'mounts') {
            pvcs.add(e.to);
          }
        }
      }
      for (const pvc of [...pvcs].sort()) {
        out.push({ reason: 'namespace_pvc', component: node.key, object: pvc, namespace: ns, confidence: 1 });
      }
    }
    out.push({ reason: 'namespace_logs', component: `Namespace:${ns}`, object: null, namespace: ns, confidence: 1 });
  }
  return out;
}
