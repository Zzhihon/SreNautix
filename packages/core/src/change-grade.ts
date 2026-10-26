// 变更与事件关联的确定性分级（ADR 0169）。分组里的每个变更（含只因"已合并、尚未同步"列进来的提交）得到一条 ChangeLink：
//   - high：有成员告警满足时间条件（changeTimed），变更直接作用在它的对象上（组件就是变更目标所属的组件、是按强依据挂上的 Job
//     经 egress_to 访问的组件，或是退役带走的抓取 job），并且至少一条 symptom 或 cause 角色的成员告警落在变更的目标上、
//     开始不早于变更（新信号）；
//   - medium：满足时间条件，只经拓扑可达（置信度不低于归并阈值）关联，或直接作用但没有新信号；
//   - low：只经命名空间、逻辑归属、尚未同步关联，或变更晚于它自己目标上已经开始的问题（late）。
// 服务端与重建评测都经 computeIncidents 得到同一结果；根因排序的近期变更、研判的结论上限与通知都读这个分级。
import type { AlertRole, ChangeEvent, ChangeGrade, ChangeLink, ComponentKey } from '@srenautix/contract';
import {
  actsOn,
  changeComponents,
  changeTimed,
  lateChange,
  managersOfTargets,
  pendingExplains,
  retiredScrapeJob,
  type AlertGroup,
  type PreparedAlert,
} from './converge.js';
import type { ResolvedRcaParams } from './params.js';
import { parseTime } from './time.js';
import type { TopologyGraph } from './topology/graph.js';

export type ChangeBasis = ChangeLink['basis'][number];

/** basis 的排列顺序（与契约的枚举顺序相同） */
const BASIS_ORDER: readonly ChangeBasis[] = [
  'component_match',
  'acts_on',
  'topology_reach',
  'namespace',
  'logical_owner',
  'retire_scrape_job',
  'pending_sync',
  'late',
];

/** 根因排序中近期变更一项按分级取的值（ADR 0169） */
export const CHANGE_GRADE_WEIGHT: Readonly<Record<ChangeGrade, number>> = { high: 1, medium: 0.5, low: 0.2 };

/** 分级的高低顺序，数值越大越强 */
export const CHANGE_GRADE_RANK: Readonly<Record<ChangeGrade, number>> = { high: 2, medium: 1, low: 0 };

/** 能作为新信号的成员告警角色：报原因或症状的告警说明变更之后出现了异常；change、meta、forecast 不算 */
const NEW_SIGNAL_ROLES: ReadonlySet<AlertRole> = new Set(['symptom', 'cause']);

/**
 * 回退：变更把版本退回到更早一次变更之前的版本，即 revision 等于更早一次变更的 previous_revision，
 * previous_revision 等于那次变更的 revision。all 是同一事件里的变更
 */
export function isRollback(c: ChangeEvent, all: readonly ChangeEvent[]): boolean {
  const t = parseTime(c.time);
  return (
    c.revision !== null &&
    !!c.previous_revision &&
    all.some((o) => parseTime(o.time) < t && o.revision === c.previous_revision && o.previous_revision === c.revision)
  );
}

/** 分组的变更按时间与 change_id 排序：事件的 changes 与 change_links 都按这个顺序 */
export function groupChanges(group: AlertGroup): ChangeEvent[] {
  return [...group.changes, ...group.pendingChanges].sort(
    (a, b) => a.time.localeCompare(b.time) || a.change_id.localeCompare(b.change_id),
  );
}

/** 告警的组件沿置信度不低于归并阈值的边可达变更触及的组件（管理应用作为其他目标的属主时不算，与 changeExplains 相同） */
function reachesTargets(
  x: PreparedAlert,
  comps: ReadonlySet<ComponentKey>,
  managers: ReadonlySet<ComponentKey>,
  threshold: number,
): boolean {
  for (const comp of comps) {
    if (!managers.has(comp) && (x.mergeReach?.components.get(comp) ?? 0) >= threshold) {
      return true;
    }
  }
  return false;
}

/** 一个变更与分组的关联记录 */
export function gradeChange(
  c: ChangeEvent,
  group: AlertGroup,
  graph: TopologyGraph,
  params: ResolvedRcaParams,
  all: readonly ChangeEvent[] = groupChanges(group),
): ChangeLink {
  const t = parseTime(c.time);
  const comps = changeComponents(c, graph);
  const managers = managersOfTargets(comps, graph);
  const acts = actsOn(c, graph);
  const basis = new Set<ChangeBasis>();
  // 满足时间条件并且变更直接作用在告警的对象上；满足时间条件并且只经拓扑可达
  let direct = false;
  let reach = false;
  const signals: string[] = [];
  for (const x of group.alerts) {
    const role = x.alert.classification.role;
    if (role === 'forecast') {
      continue;
    }
    if (x.attachedTo?.changeId === c.change_id) {
      basis.add(x.attachedTo.basis);
    }
    if (pendingExplains(c, x)) {
      basis.add('pending_sync');
    }
    const match = x.component !== null && comps.has(x.component);
    const act = x.component !== null && (acts.get(x.component) ?? 0) > 0;
    const retired = retiredScrapeJob(c, x);
    if (changeTimed(c, x, params)) {
      if (match) basis.add('component_match');
      if (act) basis.add('acts_on');
      if (retired) basis.add('retire_scrape_job');
      if (match || act || retired) {
        direct = true;
      } else if (reachesTargets(x, comps, managers, params.mergeThreshold)) {
        basis.add('topology_reach');
        reach = true;
      }
    }
    if ((match || act || retired) && NEW_SIGNAL_ROLES.has(role) && x.start >= t) {
      signals.push(x.alert.alert_id);
    }
  }
  const late = lateChange(c, group.alerts, graph, params);
  if (late) {
    basis.add('late');
  }
  const grade: ChangeGrade = late ? 'low' : direct && signals.length > 0 ? 'high' : direct || reach ? 'medium' : 'low';
  return {
    change_id: c.change_id,
    grade,
    basis: BASIS_ORDER.filter((b) => basis.has(b)),
    new_signals: grade === 'high' ? [...new Set(signals)].sort() : [],
    rollback: isRollback(c, all),
  };
}

/** 分组全部变更的关联记录，顺序与 groupChanges 相同 */
export function changeLinks(group: AlertGroup, graph: TopologyGraph, params: ResolvedRcaParams): ChangeLink[] {
  const all = groupChanges(group);
  return all.map((c) => gradeChange(c, group, graph, params, all));
}
